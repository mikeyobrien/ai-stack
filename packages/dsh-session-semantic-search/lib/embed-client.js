/**
 * Embedding HTTP client for the semantic session-search sidecar.
 *
 * Document batches go through a single-flight queue with the design's retry
 * policy: 429/5xx/network retry with a 30 s delay doubling to 5 min, or the
 * server's `Retry-After` when it sends one. Every other 4xx is fatal for the
 * current call and never retried. The backoff between attempts runs outside the
 * queue, and query embeddings bypass it entirely under their own short budget,
 * so a search never waits behind an indexer batch. Nothing here logs or throws
 * into the host: the indexer catches these errors and the hybrid engine
 * degrades to FTS.
 *
 * @module @local/dsh-session-semantic-search/embed-client
 */

import { setTimeout as sleepFor } from 'node:timers/promises';

/** Prefix the embedding model expects in front of indexed documents. */
export const DOCUMENT_PREFIX = 'search_document: ';

/** Prefix the embedding model expects in front of search queries. */
export const QUERY_PREFIX = 'search_query: ';

/** Default base delay for the first retry, in milliseconds. */
export const DEFAULT_RETRY_BASE_MS = 30_000;

/** Default cap for the doubling retry delay, in milliseconds. */
export const DEFAULT_RETRY_MAX_MS = 300_000;

/** Default total budget for one query embedding, in milliseconds. */
export const DEFAULT_QUERY_TIMEOUT_MS = 1_500;

/** Built-in embeddings endpoint: an OpenAI-compatible server on this machine. */
export const DEFAULT_ENDPOINT_URL = 'http://127.0.0.1:8890/v1/embeddings';

/** Environment variable that overrides {@link DEFAULT_ENDPOINT_URL}. */
export const ENDPOINT_ENV = 'DSH_EMBED_ENDPOINT';

/** Marks the queue-full rejection, which is never retried with backoff. */
const QUEUE_FULL = Symbol('embed-client/queue-full');

/**
 * Resolve the embeddings endpoint used when the plugin config sets none.
 * @param {Record<string, string | undefined>} [env] - environment to inspect.
 * @returns {string} `$DSH_EMBED_ENDPOINT`, or {@link DEFAULT_ENDPOINT_URL}.
 */
export function defaultEndpointUrl(env = process.env) {
	const configured = env[ENDPOINT_ENV]?.trim();
	return configured === undefined || configured === '' ? DEFAULT_ENDPOINT_URL : configured;
}

/**
 * One embedding-call failure, tagged with whether repeating the call can help.
 */
export class EmbeddingError extends Error {
	/**
	 * @param {string} message - human-readable failure.
	 * @param {{ retryable?: boolean, status?: number, cause?: unknown }} [options] - retry class and HTTP status.
	 */
	constructor(message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'EmbeddingError';
		if (options.retryable !== undefined) this.retryable = options.retryable;
		if (options.status !== undefined) this.status = options.status;
	}

	/** Whether repeating the same request may succeed. */
	retryable = false;

	/** HTTP status of the rejected request, when one was received. */
	status = undefined;

	/** Server-requested delay before a retry, from `Retry-After`. */
	retryAfterMs = undefined;
}

/**
 * Build the failure for a caller-cancelled request.
 * @param {unknown} cause - abort reason or the error it produced.
 * @returns {EmbeddingError} non-retryable abort failure.
 */
function abortedError(cause) {
	return new EmbeddingError('embedding request aborted', { cause });
}

/**
 * Parse an HTTP `Retry-After` header as a millisecond delay.
 * @param {string | null | undefined} value - header value (delta-seconds or HTTP-date).
 * @param {number} [now] - epoch milliseconds used for date deltas.
 * @returns {number | undefined} delay in milliseconds, or `undefined` when absent/unusable.
 */
export function parseRetryAfterMs(value, now = Date.now()) {
	if (typeof value !== 'string' || value.trim() === '') return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const at = Date.parse(value);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, at - now);
}

/**
 * Project one embedding response body into float vectors.
 * @param {unknown} body - parsed JSON response.
 * @param {number} dim - expected vector dimension.
 * @param {number} expected - expected input count.
 * @returns {Float32Array[]} one vector per input, in input order.
 * @throws {EmbeddingError} when the response is malformed or the wrong shape.
 */
function readEmbeddings(body, dim, expected) {
	const data = body?.data;
	if (!Array.isArray(data)) throw new EmbeddingError('embedding response has no data array', { retryable: false });
	if (data.length !== expected) throw new EmbeddingError(`embedding response returned ${data.length} vectors for ${expected} inputs`, { retryable: false });
	const ordered = [...data].sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0));
	return ordered.map((item) => {
		const embedding = item?.embedding;
		if (!Array.isArray(embedding)) throw new EmbeddingError('embedding response item has no embedding array', { retryable: false });
		if (embedding.length !== dim) throw new EmbeddingError(`embedding response returned ${embedding.length} dimensions; configured dim is ${dim}`, { retryable: false });
		return Float32Array.from(embedding);
	});
}

/**
 * Read at most 300 characters of a response body for an error message.
 * @param {Response} response - rejected response.
 * @returns {Promise<string>} bounded body text.
 */
async function bodyText(response) {
	try {
		const text = await response.text();
		return text.length > 300 ? `${text.slice(0, 300)}…` : text;
	} catch {
		return '';
	}
}

/**
 * Embedding client with the design's single-flight retry policy.
 *
 * The caller drives batching (at most 16 inputs). `embed` attempts never run
 * two at a time; `queryEmbed` is the foreground path and never queues.
 */
export class EmbeddingClient {
	/**
	 * @param {object} options - endpoint and retry configuration.
	 * @param {string} options.endpointUrl - absolute `/v1/embeddings` URL.
	 * @param {string} [options.model] - embedding model name.
	 * @param {number} [options.dim] - expected vector dimension.
	 * @param {number} [options.timeoutMs] - per-request timeout.
	 * @param {number} [options.maxAttempts] - attempts per call, including the first.
	 * @param {number} [options.retryBaseMs] - first retry delay before doubling.
	 * @param {number} [options.retryMaxMs] - retry delay cap.
	 * @param {(ms: number, options?: object) => Promise<void>} [options.sleep] - delay implementation.
	 * @param {{ warn?: Function, debug?: Function }} [options.logger] - optional logger.
	 * @param {number} [options.maxQueue] - bound on queued-but-not-yet-dispatched requests.
	 */
	constructor(options) {
		this.endpointUrl = options.endpointUrl;
		this.model = options.model ?? 'nomic-embed-text-v1.5';
		this.dim = options.dim ?? 768;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.maxAttempts = options.maxAttempts ?? 3;
		this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
		this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
		this._sleep = options.sleep ?? ((ms, sleepOptions) => sleepFor(ms, undefined, sleepOptions));
		this._logger = options.logger;
		this._maxQueue = Math.max(0, options.maxQueue ?? 8);
		this._queueLength = 0;
		this._queueTail = Promise.resolve();
	}

	/**
	 * Serialize one embedding attempt so only one queued HTTP call is in flight.
	 *
	 * Each caller chains its dispatch onto the previous caller's, so two queued
	 * HTTP calls never overlap. The queue is bounded: when it is full the next
	 * caller is rejected immediately instead of piling up. A caller whose signal
	 * aborts is released at once and its request is never dispatched; its abort
	 * listener is removed as soon as the call settles.
	 *
	 * @param {(signal?: AbortSignal) => Promise<Float32Array[]>} dispatch - one in-flight call.
	 * @param {{ signal?: AbortSignal, maxQueue?: number }} [options] - cancellation and queue bound.
	 * @returns {Promise<Float32Array[]>} the dispatched result.
	 */
	_serialize(dispatch, options = {}) {
		const signal = options.signal;
		const maxQueue = options.maxQueue ?? this._maxQueue;
		// An already-aborted signal rejects before it ever enters the queue, so it
		// neither holds a queue slot nor blocks the in-flight request it was
		// supposed to cancel.
		if (signal?.aborted) return Promise.reject(abortedError(signal.reason));
		if (this._queueLength > maxQueue) {
			const error = new EmbeddingError('embedding queue is full', { retryable: true });
			error[QUEUE_FULL] = true;
			return Promise.reject(error);
		}
		this._queueLength += 1;
		const { promise, resolve, reject } = Promise.withResolvers();
		let settled = false;
		const onAbort = () => finish(reject, abortedError(signal.reason));
		const finish = (settle, value) => {
			if (settled) return;
			settled = true;
			this._queueLength = Math.max(0, this._queueLength - 1);
			signal?.removeEventListener('abort', onAbort);
			settle(value);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		const chain = this._queueTail.then(async () => {
			// Released while waiting: the request is never dispatched.
			if (settled) return;
			try {
				finish(resolve, await dispatch(signal));
			} catch (error) {
				finish(reject, error);
			}
		});
		this._queueTail = chain.catch(() => {});
		return promise;
	}

	/**
	 * Delay before one retry.
	 * @param {number} attempt - 1-based failed attempt number.
	 * @param {number | undefined} retryAfterMs - server-requested delay.
	 * @returns {number} delay in milliseconds.
	 */
	_retryDelay(attempt, retryAfterMs) {
		if (retryAfterMs !== undefined) return retryAfterMs;
		return Math.min(this.retryBaseMs * 2 ** (attempt - 1), this.retryMaxMs);
	}

	/**
	 * Run one call under the retry policy. The delay between attempts runs
	 * outside the serial queue and ends early when `signal` aborts.
	 * @param {() => Promise<Float32Array[]>} attempt - one HTTP attempt.
	 * @param {{ maxAttempts: number, signal?: AbortSignal }} options - attempt cap and cancellation.
	 * @returns {Promise<Float32Array[]>} the first successful attempt's vectors.
	 * @throws {EmbeddingError} the first non-retryable failure, or a retryable give-up.
	 */
	async _withRetries(attempt, { maxAttempts, signal }) {
		let lastError;
		for (let count = 1; count <= maxAttempts; count += 1) {
			if (signal?.aborted) throw abortedError(signal.reason);
			try {
				return await attempt();
			} catch (error) {
				if (signal?.aborted) throw abortedError(signal.reason);
				if (!(error instanceof EmbeddingError) || error.retryable !== true || error[QUEUE_FULL] === true) throw error;
				lastError = error;
			}
			if (count < maxAttempts) {
				try {
					await this._sleep(this._retryDelay(count, lastError.retryAfterMs), { signal });
				} catch (error) {
					throw abortedError(signal?.reason ?? error);
				}
			}
		}
		throw new EmbeddingError(`embedding request gave up after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown failure'}`, {
			retryable: true,
			status: lastError?.status,
			cause: lastError,
		});
	}

	/**
	 * Embed a batch of texts, applying the model prefix here.
	 *
	 * Each attempt takes the per-instance serial queue, so at most one queued
	 * request is in flight; the retry backoff does not hold the queue. A caller
	 * whose signal aborts is released without its request being dispatched, and
	 * an abort during backoff ends the wait at once.
	 *
	 * @param {string[]} texts - texts to embed, at most 16 for the indexer.
	 * @param {{ prefix?: string, signal?: AbortSignal, timeoutMs?: number, maxAttempts?: number }} [options] - prefix, cancellation, and overrides.
	 * @returns {Promise<Float32Array[]>} one vector per input, in input order.
	 * @throws {EmbeddingError} when the request fails or is rejected.
	 */
	async embed(texts, options = {}) {
		if (!Array.isArray(texts) || texts.length === 0) return [];
		const prefix = options.prefix ?? DOCUMENT_PREFIX;
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		const maxAttempts = options.maxAttempts ?? this.maxAttempts;
		const signal = options.signal;
		const input = texts.map((text) => `${prefix}${text}`);
		return this._withRetries(() => this._serialize(() => this._request(input, { timeoutMs, signal }), { signal }), { maxAttempts, signal });
	}

	/**
	 * Embed a search query under one total budget so a foreground search
	 * degrades to full text quickly. The query never joins the document queue,
	 * so an indexer batch or its retry backoff cannot delay it; the budget
	 * covers every attempt and any delay between them.
	 *
	 * @param {string} text - the query to embed.
	 * @param {{ signal?: AbortSignal, timeoutMs?: number, maxAttempts?: number }} [options] - cancellation, total budget, and attempt cap.
	 * @returns {Promise<Float32Array | undefined>} the query vector, or `undefined` when unavailable within the budget (the caller should degrade to FTS).
	 */
	async queryEmbed(text, options = {}) {
		const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
		const maxAttempts = options.maxAttempts ?? 1;
		const budget = AbortSignal.timeout(timeoutMs);
		const signal = options.signal === undefined ? budget : AbortSignal.any([budget, options.signal]);
		const input = [`${QUERY_PREFIX}${text}`];
		try {
			const [vector] = await this._withRetries(() => this._request(input, { timeoutMs, signal }), { maxAttempts, signal });
			return vector;
		} catch {
			return undefined;
		}
	}

	/**
	 * Perform one raw embedding HTTP attempt.
	 * @param {string[]} input - already-prefixed input texts.
	 * @param {{ timeoutMs: number, signal?: AbortSignal }} options - attempt timeout and cancellation.
	 * @returns {Promise<Float32Array[]>} one vector per input, in input order.
	 * @throws {EmbeddingError} tagged `retryable` for 429, 5xx, and network failures, with `retryAfterMs` when the server sent one.
	 */
	async _request(input, { timeoutMs, signal }) {
		if (signal?.aborted) throw abortedError(signal.reason);
		let response;
		try {
			const timeout = AbortSignal.timeout(timeoutMs);
			response = await fetch(this.endpointUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: this.model, input }),
				signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
			});
		} catch (error) {
			if (signal?.aborted) throw abortedError(error);
			throw new EmbeddingError(`embedding request failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true, cause: error });
		}

		if (response.ok) {
			let body;
			try {
				body = await response.json();
			} catch (error) {
				if (signal?.aborted) throw abortedError(error);
				throw new EmbeddingError('embedding response is not valid JSON', { retryable: false, cause: error });
			}
			return readEmbeddings(body, this.dim, input.length);
		}

		const detail = await bodyText(response);
		if (response.status === 429 || response.status >= 500) {
			const error = new EmbeddingError(`embedding request failed with HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`, { retryable: true, status: response.status });
			error.retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
			throw error;
		}
		throw new EmbeddingError(`embedding request rejected with HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`, { retryable: false, status: response.status });
	}
}
