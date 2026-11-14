/**
 * Loopback relay between the Claude Code CLI and the Anthropic Messages API.
 *
 * Why this exists: `claude -p --max-turns 1` turns the first model response
 * into an internal `error_max_turns` result and can discard or reshape it. The
 * relay sits at `ANTHROPIC_BASE_URL`, forwards exactly one
 * `POST .../v1/messages` per turn to the real API while streaming the raw SSE
 * back to the CLI untouched, and hands the parsed events (tool_use inputs,
 * thinking, usage, native stop reason) to the adapter.
 *
 * Auth headers arrive from the CLI per request and are forwarded in memory
 * only; nothing about credentials is persisted or logged here.
 *
 * Protocol behavior modeled on earendil-works/pi-claude-code
 * (MIT, (c) 2026 Armin Ronacher, commit d5b5e04c314d3452d357174d16d10dda34daa2d2);
 * this is a reimplementation against the documented Messages API, not a copy.
 *
 * @module relay
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

/** Parse one SSE byte stream into `{event, data}` objects. */
export function parseSse(chunk, state = { buffer: '', event: null, data: [] }) {
	state.buffer += chunk;
	let newline;
	const out = [];
	while ((newline = state.buffer.indexOf('\n')) !== -1) {
		const line = state.buffer.slice(0, newline).replace(/\r$/, '');
		state.buffer = state.buffer.slice(newline + 1);
		if (line === '') {
			if (state.event !== null || state.data.length > 0) {
				out.push({ event: state.event, data: state.data.join('\n') });
				state.event = null;
				state.data = [];
			}
		} else if (line.startsWith('event:')) {
			// Tolerate a missing blank-line separator between events.
			if (state.event !== null || state.data.length > 0) {
				out.push({ event: state.event, data: state.data.join('\n') });
				state.event = null;
				state.data = [];
			}
			state.event = line.slice(6).trim();
		} else if (line.startsWith('data:')) {
			state.data.push(line.slice(5).trimStart());
		}
	}
	return out;
}

/**
 * Reconstruct Anthropic content blocks, stop reason, and usage from a
 * `message_start … message_stop` SSE sequence.
 */
export class SseResponseBuilder {
	#blocks = [];
	#stopReason;
	#error;
	#usage;
	#model;

	get result() {
		return { blocks: this.#blocks, stopReason: this.#stopReason, error: this.#error, usage: this.#usage, model: this.#model };
	}

	apply(event, data) {
		let parsed;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		const type = event ?? parsed.type;
		if (type === 'message_start') {
			this.#model = parsed.message?.model;
			this.#usage = usageFromAnthropic(parsed.message?.usage);
		} else if (type === 'content_block_start') {
			const b = parsed.content_block ?? {};
			const block = { index: parsed.index, type: b.type };
			if (b.type === 'tool_use') {
				block.id = b.id;
				block.name = b.name;
				block.json = '';
			} else if (b.type === 'thinking') {
				block.thinking = '';
				block.signature = '';
			} else if (b.type === 'redacted_thinking') {
				block.redactedData = b.data;
			} else if (b.type === 'text') {
				block.text = '';
			}
			this.#blocks[parsed.index] = block;
		} else if (type === 'content_block_delta') {
			const block = this.#blocks[parsed.index];
			const d = parsed.delta ?? {};
			if (!block) return;
			if (d.type === 'text_delta') block.text = (block.text ?? '') + (d.text ?? '');
			else if (d.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + (d.thinking ?? '');
			else if (d.type === 'signature_delta') block.signature = (block.signature ?? '') + (d.signature ?? '');
			else if (d.type === 'input_json_delta') block.json = (block.json ?? '') + (d.partial_json ?? '');
		} else if (type === 'message_delta') {
			if (parsed.delta?.stop_reason !== undefined) this.#stopReason = parsed.delta.stop_reason;
			if (parsed.usage) {
				const next = usageFromAnthropic(parsed.usage);
				// message_delta usage carries cumulative output counts.
				this.#usage = { ...this.#usage, ...next, inputTokens: this.#usage?.inputTokens ?? next.inputTokens };
			}
		} else if (type === 'error') {
			this.#error = parsed.error ?? { type: 'api_error', message: 'unknown upstream error' };
		}
	}
}

/** Map Anthropic usage counters onto the disjoint DSH token vocabulary. */
export function usageFromAnthropic(u) {
	if (!u || typeof u !== 'object') return undefined;
	const cacheWrite = typeof u.cache_creation === 'object' && u.cache_creation !== null
		? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) + (u.cache_creation.ephemeral_1h_input_tokens ?? 0)
		: u.cache_creation_input_tokens;
	return {
		inputTokens: Number(u.input_tokens ?? 0),
		outputTokens: Number(u.output_tokens ?? 0),
		...(u.cache_read_input_tokens !== undefined ? { cacheReadTokens: Number(u.cache_read_input_tokens) } : {}),
		...(cacheWrite !== undefined ? { cacheWriteTokens: Number(cacheWrite) } : {}),
	};
}

// Hop-by-hop and transport headers never cross the relay. The CLI's own
// identity (user-agent, x-app, anthropic-beta, auth) passes through untouched.
const STRIPPED_REQUEST_HEADERS = new Set([
	'host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'upgrade',
	'expect', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'accept-encoding',
]);
// Rate-limit headers must reach the CLI: it derives `rate_limit_event`
// (including overage state) from them.
const STRIPPED_RESPONSE_HEADERS = new Set([
	'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding', 'server', 'date',
]);

function forwardedResponseHeaders(headers) {
	const out = {};
	for (const [name, value] of headers) {
		if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out[name] = value;
	}
	return out;
}

/** One turn's capture: exactly one upstream request, forwarded once, parsed once. */
export class TurnRelay {
	#server;
	#port;
	#token = randomBytes(16).toString('hex');
	#upstream;
	#requestOverlay;
	#transformBody;
	#logger;
	#requests = 0;
	#used = false;
	#sockets = new Set();
	#subscribers = new Set();
	#done = false;
	#capture;
	#resolveCapture;
	#closed = false;
	#upstreamAbort = new AbortController();

	/**
	 * @param options.upstream base origin forwarded to (tests point this at a stub).
	 * @param options.requestOverlay JSON fields merged into the outgoing body
	 *   (temperature, max_tokens, stop_sequences) — documented Messages fields
	 *   the CLI argv does not expose.
	 */
	constructor({ upstream = DEFAULT_UPSTREAM, requestOverlay = {}, transformBody, logger = () => {} } = {}) {
		this.#upstream = upstream;
		this.#requestOverlay = { ...requestOverlay };
		this.#transformBody = transformBody;
		this.#logger = (level, msg) => logger(level, msg);
		this.#capture = new Promise((resolve) => { this.#resolveCapture = resolve; });
		// The handler is async and the server ignores its promise: every failure
		// (CLI disconnect mid-body, write after destroy) must settle here, never
		// escape as an unhandled rejection that takes the host process down.
		this.#server = createServer((req, res) => {
			this.#handle(req, res).catch((error) => this.#failRequest(res, error));
		});
		this.#server.on('connection', (socket) => {
			this.#sockets.add(socket);
			socket.on('close', () => this.#sockets.delete(socket));
		});
	}

	/** Wait for the single upstream response this relay serves. */
	get capture() {
		return this.#capture;
	}

	/** Number of turn requests the relay has received (generation guard). */
	get requestCount() {
		return this.#requests;
	}

	/** True once the single turn capture has resolved. */
	get settled() {
		return this.#settled;
	}

	/** Observe every parsed SSE event as it is forwarded. Returns unsubscriber. */
	onEvent(subscriber) {
		this.#subscribers.add(subscriber);
		return () => this.#subscribers.delete(subscriber);
	}

	#emitEvent(event) {
		for (const subscriber of [...this.#subscribers]) {
			try {
				subscriber(event);
			} catch { /* a broken observer must not break the relay */ }
		}
	}

	/** Async iterator over live SSE events; ends with `{event:'__done'}`. */
	async *events() {
		const queue = [];
		let wake;
		const push = (event) => {
			queue.push(event);
			wake?.();
		};
		const unsubscribe = this.onEvent(push);
		try {
			for (;;) {
				if (queue.length > 0) {
					yield queue.shift();
					continue;
				}
				if (this.#done) return;
				await new Promise((resolve) => { wake = resolve; });
			}
		} finally {
			unsubscribe();
		}
	}

	/** Public loopback URL for `ANTHROPIC_BASE_URL`. */
	get url() {
		return `http://127.0.0.1:${this.#port}/turn/${this.#token}`;
	}

	start() {
		return new Promise((resolve, reject) => {
			this.#server.once('error', reject);
			this.#server.listen(0, '127.0.0.1', () => {
				this.#port = this.#server.address().port;
				resolve(this.url);
			});
		});
	}

	/** Cancel the upstream request, kill in-flight sockets and close the listener; idempotent. */
	close() {
		if (this.#closed) return;
		this.#closed = true;
		// Stop generation upstream too, so an aborted turn is not billed to the end.
		this.#upstreamAbort.abort();
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		this.#server.close();
		this.#settle({ kind: 'relay-closed' });
	}

	#settle(value) {
		if (this.#settled) return;
		this.#settled = true;
		this.#done = true;
		this.#emitEvent({ event: '__done' });
		this.#resolveCapture(value);
	}

	#settled = false;

	/** Close out a request whose handler threw; settles the turn as a relay error. */
	#failRequest(res, error) {
		const detail = String(error?.message ?? error);
		this.#logger('warn', `dsh-llm-claude-code: relay request failed: ${detail}`);
		try {
			if (!res.headersSent) res.writeHead(this.#closed ? 499 : 502).end();
			else res.destroy();
		} catch { /* socket already gone */ }
		this.#settle({ kind: 'relay-error', error: detail });
	}

	async #handle(req, res) {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		// Exactly one route: the CLI's generation request. Anything else (other
		// methods, count_tokens, model lists, browser traffic) is not a turn.
		if (req.method !== 'POST' || url.pathname !== `/turn/${this.#token}/v1/messages` || req.headers.origin !== undefined) {
			res.writeHead(404).end();
			return;
		}
		this.#requests += 1;
		// One generation per turn. A second request (a CLI retry after an
		// upstream error, or a concurrent post) is refused; DSH owns retries
		// through the classified error.
		if (this.#used || this.#closed) {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'DSH turn relay already consumed for this turn' } }));
			return;
		}
		this.#used = true;
		// Writes after the CLI disconnects must not raise an unhandled 'error'.
		res.on('error', () => {});
		// The CLI went away before the response finished: stop generating.
		res.on('close', () => {
			if (!res.writableFinished) this.#upstreamAbort.abort();
		});
		let body = '';
		req.setEncoding('utf8');
		for await (const chunk of req) body += chunk;
		let parsedBody;
		try {
			parsedBody = JSON.parse(body);
		} catch {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid JSON body' }));
			this.#settle({ kind: 'bad-request' });
			return;
		}
		let outgoing = { ...parsedBody, ...this.#requestOverlay };
		if (this.#transformBody) {
			try {
				// Canonical history rebuild: DSH owns user/tool-result content.
				outgoing = { ...outgoing, ...this.#transformBody(parsedBody) };
			} catch (error) {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: `canonical body rebuild failed: ${String(error?.message ?? error)}` }));
				this.#settle({ kind: 'bad-request', error: String(error?.message ?? error) });
				return;
			}
		}
		const headers = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (typeof value === 'string' && !STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
		}
		// Uncompressed upstream bytes, so the forwarded SSE is exactly what we parse.
		headers['accept-encoding'] = 'identity';
		headers['content-type'] = 'application/json';

		let upstream;
		try {
			upstream = await fetch(new URL(`/v1/messages${url.search}`, this.#upstream), {
				method: 'POST',
				headers,
				body: JSON.stringify(outgoing),
				signal: this.#upstreamAbort.signal,
			});
		} catch (error) {
			if (!res.headersSent && !res.destroyed) {
				res.writeHead(this.#closed ? 499 : 502, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `upstream unreachable: ${String(error?.cause ?? error)}` } }));
			}
			this.#settle({ kind: 'transport-error', error: String(error?.cause ?? error) });
			return;
		}
		const meta = {
			status: upstream.status,
			retryAfter: upstream.headers.get('retry-after') ?? undefined,
			requestId: upstream.headers.get('request-id') ?? upstream.headers.get('x-request-id') ?? undefined,
		};
		if (!upstream.ok || !upstream.body) {
			const text = await upstream.text().catch(() => '');
			res.writeHead(upstream.status, forwardedResponseHeaders(upstream.headers));
			res.end(text);
			this.#settle({ kind: 'upstream-error', ...meta, body: text });
			return;
		}
		res.writeHead(upstream.status, {
			'content-type': 'text/event-stream',
			...forwardedResponseHeaders(upstream.headers),
		});
		const builder = new SseResponseBuilder();
		const state = { buffer: '', event: null, data: [] };
		const reader = upstream.body.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true });
				res.write(value);
				for (const event of parseSse(text, state)) {
					this.#emitEvent(event);
					builder.apply(event.event, event.data);
					if ((event.event ?? '') === 'message_stop') this.#settle({ kind: 'ok', response: builder.result });
				}
			}
		} catch (error) {
			this.#settle({ kind: 'stream-broken', ...meta, error: String(error) });
		} finally {
			// Flush a terminal event left without its blank-line terminator.
			for (const event of parseSse('\n\n', state)) {
				this.#emitEvent(event);
				builder.apply(event.event, event.data);
				if ((event.event ?? '') === 'message_stop') this.#settle({ kind: 'ok', response: builder.result });
			}
			res.end();
		}
		if (!this.#settled) this.#settle({ kind: 'incomplete-stream', response: builder.result });
	}
}
