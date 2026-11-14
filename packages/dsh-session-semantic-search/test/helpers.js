/**
 * Shared test fixtures for the semantic session-search package.
 *
 * Every fixture is local: a temporary DSH home with real session log files, an
 * in-process embedding server on an ephemeral port, and a stub native engine
 * that reproduces the documented native hit shape and ordering.
 *
 * @module @local/dsh-session-semantic-search/test/helpers
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';

/** Synonym groups the stub embedding model treats as the same concept. */
export const SYNONYMS = [
	['deploy', 'release', 'ship', 'rollout'],
	['crash', 'segfault', 'panic', 'abort'],
	['budget', 'spend', 'cost', 'budgeting'],
	['search', 'lookup', 'query', 'find'],
	['delegate', 'subagent', 'handoff', 'delegation'],
	['plugin', 'extension', 'addon'],
];

/** Map from one word to its concept representative. */
const CONCEPT = new Map(SYNONYMS.flatMap((group) => group.map((word) => [word, group[0]])));

/**
 * Deterministic bag-of-concepts embedding: the stand-in for a semantic model
 * that knows the fixture's synonyms.
 * @param {string} text - text to embed, with any model prefix.
 * @param {number} [dim] - vector dimension.
 * @returns {number[]} normalized embedding.
 */
export function bagVector(text, dim = 768) {
	const vector = new Array(dim).fill(0);
	for (const raw of text.toLowerCase().replace(/^search_(?:document|query):\s*/u, '').split(/[^\p{L}\p{N}]+/u)) {
		if (raw === '') continue;
		const token = CONCEPT.get(raw) ?? raw;
		let hash = 0x811c9dc5;
		for (let index = 0; index < token.length; index += 1) {
			hash ^= token.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		vector[hash % dim] += 1;
	}
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	return norm === 0 ? vector : vector.map((value) => value / norm);
}

/**
 * Create a temporary DSH home directory.
 * @returns {Promise<string>} absolute temporary home.
 */
export async function makeTempHome() {
	const home = await mkdtemp(join(tmpdir(), 'dsh-semantic-search-'));
	await mkdir(join(home, 'embeddings'), { recursive: true });
	return home;
}

/**
 * A session log fixture.
 * @typedef {object} SessionFixture
 * @property {string} id - session id.
 * @property {number} [createdAt] - creation time.
 * @property {string} [cwd] - working directory.
 * @property {Array<{ role: 'user' | 'assistant', text: string, time?: number }>} messages - message events in order.
 */

/**
 * Build the JSONL lines for one session fixture.
 * @param {SessionFixture} fixture - session content.
 * @returns {string[]} header line followed by event lines.
 */
export function sessionLines(fixture) {
	const createdAt = fixture.createdAt ?? 1_760_000_000_000;
	const lines = [
		JSON.stringify({
			type: 'session',
			version: 4,
			id: fixture.id,
			createdAt,
			...(fixture.cwd === undefined ? {} : { cwd: fixture.cwd }),
			isSeeded: false,
			delegationDepth: 0,
			agentPreset: 'standard',
		}),
		// A real log starts at seq 0 with a structural event; surface folding
		// requires the event log to be contiguous from there.
		JSON.stringify({ type: 'permission/preset', seq: 0, time: createdAt, data: { preset: 'workspace-write' } }),
	];
	fixture.messages.forEach((message, index) => {
		const seq = index + 1;
		const time = message.time ?? createdAt + index * 1000;
		const event =
			message.role === 'user'
				? { type: 'user/message', seq, time, surfaceOp: 'append', data: { content: [{ type: 'text', text: message.text }] } }
				: {
						type: 'assistant/message',
						seq,
						time,
						surfaceOp: 'append',
						data: {
							turn: 1,
							step: 1,
							message: { role: 'assistant', content: [{ type: 'text', text: message.text }] },
						},
					};
		lines.push(JSON.stringify(event));
	});
	return lines;
}

/**
 * Write one fixture to the real persisted layout:
 * `sessions/<slug>/session-<id>/session.v4.jsonl[.zstd]`.
 * @param {string} home - temporary DSH home.
 * @param {SessionFixture} fixture - session content.
 * @param {{ compressed?: boolean, slug?: string }} [options] - encoding and directory slug.
 * @returns {Promise<string>} absolute file path.
 */
export async function writeSessionFile(home, fixture, options = {}) {
	const slug = options.slug ?? '--workspace--';
	const directory = join(home, 'sessions', slug, `session-${fixture.id}`);
	await mkdir(directory, { recursive: true });
	const text = `${sessionLines(fixture).join('\n')}\n`;
	const file = options.compressed === true ? join(directory, 'session.v4.jsonl.zstd') : join(directory, 'session.v4.jsonl');
	await writeFile(file, options.compressed === true ? zstdCompressSync(Buffer.from(text, 'utf8')) : text);
	return file;
}

/**
 * Append one message to an existing plain-JSONL fixture file.
 * @param {string} file - absolute file path.
 * @param {SessionFixture} fixture - the session the file belongs to.
 * @param {{ role: 'user' | 'assistant', text: string, time?: number }} message - appended message.
 * @returns {Promise<void>} resolves once appended.
 */
export async function appendMessage(file, fixture, message) {
	const extended = { ...fixture, messages: [...fixture.messages, message] };
	await writeFile(file, `${sessionLines(extended).join('\n')}\n`);
}

/**
 * Build one native-shaped session hit.
 * @param {object} input - hit fields.
 * @param {string} input.id - session id.
 * @param {string} input.text - searchable text used by the stub matcher.
 * @param {number} [input.createdAt] - creation time.
 * @param {number} [input.seq] - best-match event seq.
 * @param {number} [input.time] - best-match event time.
 * @param {'user/message' | 'assistant/message'} [input.type] - best-match event type.
 * @param {string} [input.snippet] - best-match excerpt.
 * @param {string} [input.cwd] - working directory.
 * @param {string} [input.parentSession] - forked parent.
 * @param {number} [input.delegationDepth] - subagent depth.
 * @param {string} [input.agentPreset] - agent preset name.
 * @returns {object} `SessionSearchHit` in the documented shape.
 */
export function nativeHit(input) {
	const time = input.time ?? 1_760_000_000_000;
	const header = {
		version: 4,
		id: input.id,
		createdAt: input.createdAt ?? 1_760_000_000_000,
	};
	if (input.cwd !== undefined) header.cwd = input.cwd;
	if (input.parentSession !== undefined) header.parentSession = input.parentSession;
	header.isSeeded = false;
	if (input.delegationDepth !== undefined) header.delegationDepth = input.delegationDepth;
	if (input.agentPreset !== undefined) header.agentPreset = input.agentPreset;
	return {
		header,
		live: false,
		persisted: true,
		bestMatch: {
			sessionId: input.id,
			seq: input.seq ?? 1,
			type: input.type ?? 'user/message',
			time,
			surface: 'current',
			snippet: input.snippet ?? (input.text ?? '').slice(0, 240),
		},
	};
}

/**
 * Stub native engine: literal case-insensitive phrase matching over fixtures,
 * preserving the documented `bestMatch` shape. With `cursors: true` it pages
 * like the native SQLite backend: opaque cursors bound to its own instance and
 * request, and `SESSION_QUERY_INVALID_CURSOR` for any cursor it did not issue.
 * @param {{ hits?: Array<{ hit: object, text: string }>, config?: object, failWith?: Error, cursors?: boolean }} [options] - corpus and behavior.
 * @returns {object} inner engine stub.
 */
export function fakeInner(options = {}) {
	const corpus = options.hits ?? [];
	const calls = [];
	const instance = randomUUID();
	const inner = {
		config: { defaultLimit: 20, maxLimit: 100, snippetChars: 240, ...options.config },
		calls,
		async searchSessions(request) {
			calls.push(request);
			if (options.failWith !== undefined) throw options.failWith;
			const needle = request.query.toLowerCase();
			const items = corpus.filter((entry) => entry.text.toLowerCase().includes(needle)).map((entry) => entry.hit);
			if (options.cursors !== true) return { items: items.slice(0, request.limit) };
			const fingerprint = JSON.stringify([request.query, request.sessionFilters ?? [], request.eventFilters ?? [], request.limit]);
			let offset = 0;
			if (request.cursor !== undefined) {
				let decoded;
				try {
					decoded = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
				} catch {
					decoded = undefined;
				}
				if (decoded?.instance !== instance || decoded?.fingerprint !== fingerprint) {
					throw new SessionQueryError('session-search cursor is invalid', 'SESSION_QUERY_INVALID_CURSOR');
				}
				offset = decoded.offset;
			}
			const page = { items: items.slice(offset, offset + request.limit) };
			if (items.length > offset + request.limit) {
				page.nextCursor = Buffer.from(JSON.stringify({ instance, fingerprint, offset: offset + request.limit }), 'utf8').toString('base64url');
			}
			return page;
		},
		async searchEvents() {
			throw new Error('searchEvents is not part of these fixtures');
		},
		async listSessions() {
			throw new Error('listSessions is not part of these fixtures');
		},
	};
	return inner;
}

/**
 * Follow `nextCursor` until the last page.
 * @param {{ searchSessions: Function }} engine - hybrid engine.
 * @param {object} request - first-page request.
 * @returns {Promise<string[]>} session ids in served order, across every page.
 */
export async function collectPages(engine, request) {
	const ids = [];
	let cursor;
	for (let page = 0; page < 1_000; page += 1) {
		const result = await engine.searchSessions(cursor === undefined ? request : { ...request, cursor });
		ids.push(...result.items.map((hit) => hit.header.id));
		cursor = result.nextCursor;
		if (cursor === undefined) return ids;
	}
	throw new Error('pagination did not terminate');
}

/**
 * Start an in-process embedding endpoint.
 * @param {(body: { input: string[] }, request: import('node:http').IncomingMessage, call: number) => { status?: number, headers?: object, body?: object, delayMs?: number, destroy?: boolean }} respond - response plan per call.
 * @returns {Promise<{ url: string, calls: number, close: () => Promise<void> }>} running server.
 */
export async function startEmbedServer(respond = () => ({})) {
	let calls = 0;
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		calls += 1;
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			body = { input: [] };
		}
		const plan = respond(body, request, calls) ?? {};
		if (plan.destroy === true) {
			request.socket.destroy();
			return;
		}
		if (plan.delayMs !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
		}
		const payload = plan.body ?? {
			model: body.model,
			object: 'list',
			data: (body.input ?? []).map((text, index) => ({ index, embedding: bagVector(text) })),
		};
		response.writeHead(plan.status ?? 200, { 'content-type': 'application/json', ...(plan.headers ?? {}) });
		response.end(JSON.stringify(payload));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	return {
		url: `http://127.0.0.1:${address.port}/v1/embeddings`,
		get calls() {
			return calls;
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/**
 * Embedding client options for a test server, with instant retries.
 * @param {{ url: string, dim?: number, retryBaseMs?: number, maxAttempts?: number }} input - endpoint and policy.
 * @returns {object} `EmbeddingClient` options.
 */
export function embedOptions(input) {
	return {
		endpointUrl: input.url,
		model: 'nomic-embed-text-v1.5',
		dim: input.dim ?? 768,
		timeoutMs: 5_000,
		maxAttempts: input.maxAttempts ?? 3,
		retryBaseMs: input.retryBaseMs ?? 1,
		retryMaxMs: 5,
		sleep: async () => {},
	};
}

/**
 * Collect the sorted own-key list of one value.
 * @param {object} value - object to inspect.
 * @returns {string[]} sorted keys.
 */
export function keysOf(value) {
	return Object.keys(value).sort();
}
