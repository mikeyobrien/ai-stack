/**
 * Hybrid session-query engine: native FTS recall fused with dense-vector
 * recall by reciprocal rank, with a transparent FTS-only fallback.
 *
 * Every method except `searchSessions` delegates to the concrete SQLite engine
 * instance, so exact reads, traces, and filters keep the native behavior. The
 * hybrid path is additive: it never removes a native hit, only reorders around
 * vector matches it did not have, and degrades silently when the sidecar or the
 * embedding endpoint is unavailable.
 *
 * One search serves one stream of sessions. The `hybrid` stream is the
 * reciprocal-rank fusion of the first `ftsCandidates` native hits with the
 * vector candidates, followed by the remaining native hits in native order;
 * the `fts` stream is the native order alone. Both are fixed by the corpus,
 * not by the page offset, so every match is served exactly once across pages,
 * and a cursor records which stream it continues.
 *
 * @module @local/dsh-session-semantic-search/hybrid-engine
 */

import { randomUUID } from 'node:crypto';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import {
	SessionQueryError,
	materializeSessionEventResultFilters,
	materializeSessionResultFilters,
} from '@deepseek-ai/dsh-session-query';
import { QUERY_PREFIX } from './embed-client.js';
import { CURSOR_VERSION, RRF_K, decodeCursor, digest, encodeCursor, excerpt, rrfFuse } from './fusion.js';

/** Default page size matching the native SQLite backend. */
export const DEFAULT_LIMIT = 20;

/** Default maximum page size matching the native SQLite backend. */
export const DEFAULT_MAX_LIMIT = 100;

/** Largest limit a native SQLite page accepts. */
const MAX_SAFE_PAGE_LIMIT = Number.MAX_SAFE_INTEGER - 1;

/** Query vectors kept so a later page reuses its first page's vector. */
const QUERY_VECTOR_CACHE_SIZE = 32;

/** Cursor stream: native full-text order only. */
const FTS_STREAM = 'fts';

/** Cursor stream: fused head, then the native tail. */
const HYBRID_STREAM = 'hybrid';

/** Methods that pass through to the inner engine unchanged. */
const DELEGATED_METHODS = [
	'observeSession',
	'searchEvents',
	'listSessions',
	'readSession',
	'filterSessions',
	'readTitle',
	'readTitleSnapshot',
	'readTitleSnapshots',
	'listEvents',
	'filterEvents',
	'readSurface',
	'traceSession',
	'traceEvent',
	'readEvent',
];

/**
 * Throw the native abort failure when the caller cancelled.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 */
function assertNotAborted(signal) {
	if (signal?.aborted) throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', { cause: signal.reason });
}

/**
 * Validate and canonicalize a search query exactly like the native backend.
 * @param {unknown} value - caller query.
 * @returns {string} normalized query text.
 */
export function normalizeQuery(value) {
	if (typeof value !== 'string') throw new SessionQueryError('session-search query must be text', 'SESSION_QUERY_INVALID_QUERY');
	const query = value.trim().replace(/\s+/gu, ' ');
	if (query.length === 0) throw new SessionQueryError('session-search query must contain non-whitespace text', 'SESSION_QUERY_INVALID_QUERY');
	if (query.includes('\0')) throw new SessionQueryError('session-search query must not contain NUL', 'SESSION_QUERY_INVALID_QUERY');
	return query;
}

/**
 * Validate and default a page size exactly like the native backend.
 * @param {unknown} value - caller limit.
 * @param {{ defaultLimit?: number, maxLimit?: number }} limits - inner backend limits.
 * @returns {number} accepted page size.
 */
export function normalizeLimit(value, limits) {
	const limit = value ?? limits.defaultLimit ?? DEFAULT_LIMIT;
	const maxLimit = Math.min(limits.maxLimit ?? DEFAULT_MAX_LIMIT, MAX_SAFE_PAGE_LIMIT);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
		throw new SessionQueryError(`session-search limit must be an integer between 1 and ${maxLimit}`, 'SESSION_QUERY_INVALID_LIMIT');
	}
	return limit;
}

/**
 * Materialize and reject unsupported metadata clauses.
 * @param {readonly object[]} filters - caller event filters.
 * @returns {object[]} detached, validated clauses.
 */
export function materializeEventFilters(filters) {
	const materialized = materializeSessionEventResultFilters(filters);
	for (const filter of materialized) {
		if (filter.kind === 'text') throw new SessionQueryError('session-search metadata filters do not accept text clauses', 'SESSION_QUERY_INVALID_FILTER');
	}
	return materialized;
}

/**
 * Build the public stale-cursor failure.
 * @returns {SessionQueryError} typed failure.
 */
function staleCursor() {
	return new SessionQueryError('session-search cursor is stale because its relevant corpus changed', 'SESSION_QUERY_STALE_CURSOR');
}

/**
 * Whether an inner failure means full-text search is intentionally disabled.
 * @param {unknown} error - inner failure.
 * @returns {boolean} true for `SESSION_QUERY_SEARCH_DISABLED`.
 */
function isSearchDisabled(error) {
	return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SEARCH_DISABLED';
}

/**
 * Project one sidecar row into the native grouped-hit shape.
 * @param {object} row - best sidecar chunk row.
 * @param {number} snippetChars - native snippet bound.
 * @returns {object} `SessionSearchHit` with no extra keys.
 */
function vectorHit(row, snippetChars) {
	const header = {
		version: Number.isSafeInteger(row.version) && row.version > 0 ? row.version : SESSION_FORMAT_VERSION,
		id: row.session_id,
		createdAt: row.created_at,
	};
	if (row.cwd !== null && row.cwd !== undefined) header.cwd = row.cwd;
	if (row.parent_session !== null && row.parent_session !== undefined) header.parentSession = row.parent_session;
	header.isSeeded = row.is_seeded === 1;
	if (row.delegation_depth !== null && row.delegation_depth !== undefined) header.delegationDepth = row.delegation_depth;
	if (row.agent_preset !== null && row.agent_preset !== undefined) header.agentPreset = row.agent_preset;
	return {
		header,
		live: false,
		persisted: true,
		bestMatch: {
			sessionId: row.session_id,
			seq: row.seq,
			type: row.type,
			time: row.time,
			surface: row.surface,
			snippet: excerpt(row.text, snippetChars),
		},
	};
}

/**
 * Whether an inner failure is the native stale-cursor failure.
 * @param {unknown} error - inner failure.
 * @returns {boolean} true for `SESSION_QUERY_STALE_CURSOR`.
 */
function isStaleCursor(error) {
	return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_STALE_CURSOR';
}

/**
 * Settle with `undefined` once a budget or the caller's signal expires.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} run - work bound to the combined signal.
 * @param {number} ms - budget in milliseconds.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<T | undefined>} the result, or `undefined` past the budget.
 */
async function withinBudget(run, ms, signal) {
	const budget = AbortSignal.timeout(ms);
	const combined = signal === undefined ? budget : AbortSignal.any([budget, signal]);
	if (combined.aborted) return undefined;
	let onAbort;
	const expired = new Promise((resolve) => {
		onAbort = () => resolve(undefined);
		combined.addEventListener('abort', onAbort, { once: true });
	});
	try {
		return await Promise.race([run(combined), expired]);
	} finally {
		combined.removeEventListener('abort', onAbort);
	}
}

/**
 * Create the hybrid engine facade over one concrete inner engine.
 *
 * @param {object} options - composition inputs.
 * @param {object} options.inner - concrete session-query engine to delegate to.
 * @param {object | undefined} [options.vectors] - sidecar exposing `vectorSearch`.
 * @param {object | undefined} [options.embedder] - embedding client exposing `queryEmbed` (preferred) or `embed`.
 * @param {object} [options.config] - resolved plugin configuration.
 * @param {{ warn?: Function, debug?: Function }} [options.logger] - optional logger.
 * @returns {object} facade with every `SessionQueryEngine` method.
 */
export function createHybridSessionQueryEngine(options) {
	const inner = options.inner;
	const vectors = options.vectors;
	const embedder = options.embedder;
	const config = options.config ?? {};
	const logger = options.logger;
	const instance = randomUUID();
	const snippetChars = Math.max(1, inner?.config?.snippetChars ?? 240);
	const ftsCandidates = Math.max(1, config.ftsCandidates ?? 50);
	const vectorCandidates = Math.max(1, config.vectorCandidates ?? 50);
	const rrfK = Math.max(1, config.rrfK ?? RRF_K);
	const queryTimeoutMs = Math.max(1, config.queryTimeoutMs ?? 1500);
	const limits = { defaultLimit: inner?.config?.defaultLimit, maxLimit: inner?.config?.maxLimit };
	const maxLimit = Math.min(limits.maxLimit ?? DEFAULT_MAX_LIMIT, MAX_SAFE_PAGE_LIMIT);
	/** @type {Map<string, Float32Array>} least recently used first */
	const queryVectors = new Map();

	/**
	 * Log a debug line without disturbing search.
	 * @param {string} message - message text.
	 */
	const debug = (message) => {
		try {
			(logger?.debug ?? logger?.info)?.call(logger, message);
		} catch {
			// Diagnostics never affect a search result.
		}
	};

	/**
	 * Embed one query text within the configured query budget. A vector this
	 * engine already embedded for the same text is reused, so later pages of a
	 * hybrid stream keep their first page's vector even if the endpoint is gone.
	 * @param {string} query - normalized query text.
	 * @param {AbortSignal | undefined} signal - caller cancellation.
	 * @returns {Promise<Float32Array | undefined>} query vector, or undefined when unavailable.
	 */
	async function embedQuery(query, signal) {
		if (embedder === undefined) return undefined;
		const cached = queryVectors.get(query);
		if (cached !== undefined) {
			queryVectors.delete(query);
			queryVectors.set(query, cached);
			return cached;
		}
		let vector;
		try {
			vector =
				typeof embedder.queryEmbed === 'function'
					? await embedder.queryEmbed(query, { timeoutMs: queryTimeoutMs, signal })
					: await withinBudget(
							async (budget) => (await embedder.embed([query], { prefix: QUERY_PREFIX, timeoutMs: queryTimeoutMs, maxAttempts: 1, signal: budget }))[0],
							queryTimeoutMs,
							signal,
						);
		} catch (error) {
			debug(`query embedding unavailable; serving full-text results: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
		if (vector === undefined) {
			debug(`query embedding unavailable within ${queryTimeoutMs} ms; serving full-text results`);
			return undefined;
		}
		queryVectors.set(query, vector);
		if (queryVectors.size > QUERY_VECTOR_CACHE_SIZE) queryVectors.delete(queryVectors.keys().next().value);
		return vector;
	}

	/**
	 * Read the first `depth` native hits in native order, walking native pages
	 * when `depth` exceeds the inner page cap. A disabled inner index is an
	 * empty full-text side.
	 * @param {{ query: string, sessionFilters: object[], eventFilters: object[] }} base - normalized request.
	 * @param {number} depth - hits wanted.
	 * @param {AbortSignal | undefined} signal - caller cancellation.
	 * @returns {Promise<object[]>} up to `depth` hits; fewer means the native result ends there.
	 */
	async function readFts(base, depth, signal) {
		const pageLimit = Math.min(maxLimit, depth);
		for (let attempt = 1; ; attempt += 1) {
			const items = [];
			let cursor;
			try {
				do {
					const page = await inner.searchSessions({ ...base, limit: pageLimit, ...(cursor === undefined ? {} : { cursor }) }, { signal });
					items.push(...page.items);
					cursor = page.items.length === 0 ? undefined : page.nextCursor;
				} while (cursor !== undefined && items.length < depth);
				return items.slice(0, depth);
			} catch (error) {
				if (isSearchDisabled(error)) return [];
				// The corpus changed between two internal native pages: read again once.
				if (isStaleCursor(error) && cursor !== undefined && attempt === 1) continue;
				throw error;
			}
		}
	}

	/**
	 * Build the served stream from native hits and vector candidates.
	 *
	 * The head fuses the first `ftsCandidates` native hits with the vector
	 * candidates; the tail is every later native hit the head does not already
	 * hold, in native order. With no vector candidates the stream is the native
	 * order itself.
	 * @param {readonly object[]} ftsItems - native hits in native order.
	 * @param {readonly object[]} candidates - vector candidates, best first.
	 * @returns {{ entries: object[], headLength: number, ftsHeadLength: number }} stream entries; tail entries carry `ftsIndex`.
	 */
	function buildStream(ftsItems, candidates) {
		const ftsHead = ftsItems.slice(0, ftsCandidates);
		const head = rrfFuse({ ftsItems: ftsHead, vectorCandidates: candidates, k: rrfK });
		const inHead = new Set(head.map((entry) => entry.sessionId));
		const entries = [...head];
		for (let index = ftsHead.length; index < ftsItems.length; index += 1) {
			const hit = ftsItems[index];
			if (!inHead.has(hit.header.id)) entries.push({ sessionId: hit.header.id, ftsHit: hit, ftsIndex: index });
		}
		return { entries, headLength: head.length, ftsHeadLength: ftsHead.length };
	}

	/**
	 * How many leading native hits fix the order of `stream.entries[0, end)`.
	 * @param {'fts' | 'hybrid'} mode - stream mode.
	 * @param {{ entries: object[], headLength: number, ftsHeadLength: number }} stream - built stream.
	 * @param {number} end - served prefix length.
	 * @returns {number} native-hit prefix length.
	 */
	function coverage(mode, stream, end) {
		if (mode === FTS_STREAM) return Math.min(end, stream.entries.length);
		const last = stream.entries[Math.min(end, stream.entries.length) - 1];
		return end > stream.headLength && last !== undefined ? last.ftsIndex + 1 : stream.ftsHeadLength;
	}

	/**
	 * Digest the ids that fix a served prefix: the leading native hits and, for
	 * the hybrid stream, the head size and the vector candidate order.
	 * @param {'fts' | 'hybrid'} mode - stream mode.
	 * @param {readonly object[]} ftsItems - native hits in native order.
	 * @param {readonly object[]} candidates - vector candidates, best first.
	 * @param {number} covered - native-hit prefix length from {@link coverage}.
	 * @returns {string} ordering identity.
	 */
	function streamIdentity(mode, ftsItems, candidates, covered) {
		const ftsIds = JSON.stringify(ftsItems.slice(0, covered).map((hit) => hit.header.id));
		if (mode === FTS_STREAM) return digest(FTS_STREAM, ftsIds);
		const vectorIds = JSON.stringify(candidates.map((row) => row.session_id));
		return digest(HYBRID_STREAM, Math.min(ftsCandidates, ftsItems.length), ftsIds, vectorIds);
	}

	/**
	 * Search the live-preferred corpus, fusing native and vector recall.
	 *
	 * The native read and the query embedding run concurrently. A first page
	 * becomes a `hybrid` stream when the vector side returns candidates and an
	 * `fts` stream otherwise; a cursor continues the stream it names. A hybrid
	 * cursor whose vector side cannot be reproduced, or any cursor whose served
	 * prefix changed, fails with `SESSION_QUERY_STALE_CURSOR`.
	 *
	 * @param {object} request - native cross-session search request.
	 * @param {{ signal?: AbortSignal }} [exec] - caller cancellation.
	 * @returns {Promise<object>} native-shaped session page.
	 */
	async function searchSessions(request, exec) {
		const signal = exec?.signal;
		assertNotAborted(signal);
		const limit = normalizeLimit(request?.limit, limits);
		const query = normalizeQuery(request?.query);
		const sessionFilters = materializeSessionResultFilters(request?.sessionFilters ?? []);
		const eventFilters = materializeEventFilters(request?.eventFilters ?? []);
		const fingerprint = digest('sessions', query, JSON.stringify(sessionFilters), JSON.stringify(eventFilters), limit);
		const cursor = request?.cursor === undefined ? undefined : decodeCursor(request.cursor, { instance, fingerprint });
		const offset = cursor?.o ?? 0;
		const end = offset + limit;
		const wantVectors = vectors !== undefined && (cursor === undefined || cursor.m === HYBRID_STREAM);

		const [ftsItems, queryVector] = await Promise.all([
			readFts({ query, sessionFilters, eventFilters }, Math.max(ftsCandidates, end + 1), signal),
			wantVectors ? embedQuery(query, signal) : undefined,
		]);
		assertNotAborted(signal);

		let candidates = [];
		if (queryVector !== undefined) {
			try {
				candidates = await vectors.vectorSearch(queryVector, { sessionFilters, eventFilters, limitSessions: vectorCandidates, signal });
			} catch (error) {
				debug(`vector recall unavailable; serving full-text results: ${error instanceof Error ? error.message : String(error)}`);
				candidates = [];
			}
			assertNotAborted(signal);
		}

		const mode = cursor?.m ?? (candidates.length > 0 ? HYBRID_STREAM : FTS_STREAM);
		if (mode === HYBRID_STREAM && candidates.length === 0) {
			debug('hybrid cursor cannot continue without vector recall; the search must restart');
			throw staleCursor();
		}
		if (cursor !== undefined && streamIdentity(mode, ftsItems, candidates, cursor.n) !== cursor.g) throw staleCursor();

		const stream = buildStream(ftsItems, candidates);
		const items = stream.entries.slice(offset, end).map((entry) => entry.ftsHit ?? vectorHit(entry.vectorRow, snippetChars));
		if (stream.entries.length <= end) return { items };
		const covered = coverage(mode, stream, end);
		return { items, nextCursor: makeCursor(fingerprint, mode, end, covered, streamIdentity(mode, ftsItems, candidates, covered)) };
	}

	/**
	 * Encode one cursor payload.
	 * @param {string} fingerprint - request identity.
	 * @param {'fts' | 'hybrid'} mode - stream the cursor continues.
	 * @param {number} offset - next offset.
	 * @param {number} covered - native-hit prefix length the served prefix depends on.
	 * @param {string} generation - ordering identity of that prefix.
	 * @returns {string} opaque cursor.
	 */
	function makeCursor(fingerprint, mode, offset, covered, generation) {
		return encodeCursor({ v: CURSOR_VERSION, i: instance, s: 'sessions', f: fingerprint, m: mode, o: offset, n: covered, g: generation });
	}

	/** @type {Record<string, Function>} */
	const facade = { searchSessions };
	for (const method of DELEGATED_METHODS) {
		facade[method] = (...args) => {
			if (typeof inner[method] !== 'function') throw new Error(`hybrid session-query engine: inner engine does not implement ${method}`);
			return inner[method](...args);
		};
	}
	facade.close = async () => (typeof inner.close === 'function' ? inner.close() : undefined);
	facade.instanceId = instance;
	return facade;
}
