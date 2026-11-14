/**
 * Hybrid engine tests: fusion ordering, native hit shape, pagination, cursor
 * binding, and every silent fallback to full text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';
import { EmbeddingClient } from '../lib/embed-client.js';
import { createHybridSessionQueryEngine } from '../lib/hybrid-engine.js';
import { SessionVectorSidecar } from '../lib/sidecar.js';
import { bagVector, collectPages, embedOptions, fakeInner, keysOf, makeTempHome, nativeHit, startEmbedServer, writeSessionFile } from './helpers.js';

/**
 * Build the corpus used by the fusion tests.
 * @param {string} home - temporary DSH home.
 * @returns {Promise<{ target: string, other: string }>} session ids.
 */
async function fusionCorpus(home) {
	await writeSessionFile(home, {
		id: 'session-deploy',
		cwd: '/tmp/deploy',
		messages: [
			{ role: 'user', text: 'deploy the app to production' },
			{ role: 'assistant', text: 'the release is live and healthy' },
		],
	});
	await writeSessionFile(home, {
		id: 'session-weather',
		cwd: '/tmp/weather',
		messages: [{ role: 'user', text: 'the weather is nice today' }],
	});
	return { target: 'session-deploy', other: 'session-weather' };
}

test('a paraphrase query reaches the vector match while full text has no hit', async () => {
	const home = await makeTempHome();
	const { target } = await fusionCorpus(home);
	const server = await startEmbedServer();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })) });
	const embedder = new EmbeddingClient(embedOptions({ url: server.url }));
	const inner = fakeInner({
		hits: [{ text: 'the weather is nice today', hit: nativeHit({ id: 'session-weather' }) }],
	});
	const engine = createHybridSessionQueryEngine({ inner, vectors: sidecar, embedder, config: { queryTimeoutMs: 2000 } });
	try {
		await sidecar.runOnce();
		const page = await engine.searchSessions({ query: 'release the application' });
		assert.ok(page.items.length >= 1, 'the vector side supplied the only hit');
		assert.equal(page.items[0].header.id, target, 'the paraphrase target outranks the weakly related session');
		assert.equal(page.items[0].bestMatch.sessionId, target);
		assert.equal(page.items[0].bestMatch.surface, 'current');
		assert.equal(page.items[0].live, false);
		assert.equal(page.items[0].persisted, true);
		assert.equal(page.nextCursor, undefined);
	} finally {
		await sidecar.close();
		await server.close();
	}
});

test('a keyword query keeps the exact native hit on top', async () => {
	const home = await makeTempHome();
	const { target } = await fusionCorpus(home);
	const server = await startEmbedServer();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })) });
	const embedder = new EmbeddingClient(embedOptions({ url: server.url }));
	const exact = nativeHit({ id: target, text: 'deploy the app to production', seq: 1, snippet: 'deploy the app to production' });
	const inner = fakeInner({ hits: [{ text: 'deploy the app to production', hit: exact }] });
	const engine = createHybridSessionQueryEngine({ inner, vectors: sidecar, embedder, config: { queryTimeoutMs: 2000 } });
	try {
		await sidecar.runOnce();
		const page = await engine.searchSessions({ query: 'deploy the app' });
		assert.deepEqual(page.items[0], exact, 'the native hit is returned unchanged and stays on top');
	} finally {
		await sidecar.close();
		await server.close();
	}
});

test('a session found by both sides appears once and outranks a full-text-only hit', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-shared', messages: [{ role: 'user', text: 'deploy notes for the release' }] });
	const server = await startEmbedServer();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })) });
	const embedder = new EmbeddingClient(embedOptions({ url: server.url }));
	const first = nativeHit({ id: 'session-fts-first', text: 'deploy notes' });
	const shared = nativeHit({ id: 'session-shared', text: 'deploy notes for the release' });
	const inner = fakeInner({
		hits: [
			{ text: 'deploy notes', hit: first },
			{ text: 'deploy notes for the release', hit: shared },
		],
	});
	const engine = createHybridSessionQueryEngine({ inner, vectors: sidecar, embedder, config: { queryTimeoutMs: 2000 } });
	try {
		await sidecar.runOnce();
		const page = await engine.searchSessions({ query: 'deploy notes' });
		assert.equal(page.items.length, 2);
		const ids = page.items.map((hit) => hit.header.id);
		assert.equal(new Set(ids).size, ids.length, 'no session is returned twice');
		assert.deepEqual(ids, ['session-shared', 'session-fts-first'], 'agreement between recall sides outranks a full-text-only hit');
	} finally {
		await sidecar.close();
		await server.close();
	}
});

test('vector-only hits carry exactly the native hit shape', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, {
		id: 'session-shape',
		cwd: '/tmp/shape',
		messages: [{ role: 'user', text: 'deploy the app to production' }],
	});
	const server = await startEmbedServer();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })) });
	const embedder = new EmbeddingClient(embedOptions({ url: server.url }));
	const engine = createHybridSessionQueryEngine({ inner: fakeInner({ hits: [] }), vectors: sidecar, embedder, config: { queryTimeoutMs: 2000 } });
	try {
		await sidecar.runOnce();
		const page = await engine.searchSessions({ query: 'release the application' });
		const hit = page.items[0];
		const reference = nativeHit({ id: 'session-shape', text: 'deploy the app to production', cwd: '/tmp/shape', delegationDepth: 0, agentPreset: 'standard' });
		assert.deepEqual(keysOf(hit), keysOf(reference));
		assert.deepEqual(keysOf(hit.header), keysOf(reference.header));
		assert.deepEqual(keysOf(hit.bestMatch), keysOf(reference.bestMatch));
		assert.equal(typeof hit.bestMatch.seq, 'number');
		assert.equal(typeof hit.bestMatch.snippet, 'string');
	} finally {
		await sidecar.close();
		await server.close();
	}
});

test('pagination reports hasMore and resumes through the opaque cursor', async () => {
	const hits = Array.from({ length: 5 }, (_value, index) => ({
		text: `shared phrase ${index}`,
		hit: nativeHit({ id: `session-${index}`, text: `shared phrase ${index}`, time: 1_760_000_000_000 + index }),
	}));
	const engine = createHybridSessionQueryEngine({ inner: fakeInner({ hits }), config: {} });
	const first = await engine.searchSessions({ query: 'shared phrase', limit: 2 });
	assert.deepEqual(first.items.map((hit) => hit.header.id), ['session-0', 'session-1']);
	assert.equal(typeof first.nextCursor, 'string');
	const second = await engine.searchSessions({ query: 'shared phrase', limit: 2, cursor: first.nextCursor });
	assert.deepEqual(second.items.map((hit) => hit.header.id), ['session-2', 'session-3']);
	const third = await engine.searchSessions({ query: 'shared phrase', limit: 2, cursor: second.nextCursor });
	assert.deepEqual(third.items.map((hit) => hit.header.id), ['session-4']);
	assert.equal(third.nextCursor, undefined);
});

test('a cursor is bound to its request and its corpus generation', async () => {
	const hits = Array.from({ length: 3 }, (_value, index) => ({
		text: `corpus phrase ${index}`,
		hit: nativeHit({ id: `session-${index}`, text: `corpus phrase ${index}` }),
	}));
	const inner = fakeInner({ hits });
	const engine = createHybridSessionQueryEngine({ inner, config: {} });
	const first = await engine.searchSessions({ query: 'corpus phrase', limit: 1 });
	assert.equal(typeof first.nextCursor, 'string');
	await assert.rejects(engine.searchSessions({ query: 'corpus phrase', limit: 1, cursor: 'not-a-cursor' }), (error) => {
		assert.equal(error.code, 'SESSION_QUERY_INVALID_CURSOR');
		return true;
	});
	await assert.rejects(engine.searchSessions({ query: 'different query', limit: 1, cursor: first.nextCursor }), (error) => {
		assert.equal(error.code, 'SESSION_QUERY_INVALID_CURSOR');
		return true;
	});
	hits.splice(0, 1);
	await assert.rejects(engine.searchSessions({ query: 'corpus phrase', limit: 1, cursor: first.nextCursor }), (error) => {
		assert.equal(error.code, 'SESSION_QUERY_STALE_CURSOR');
		return true;
	});
});

test('a slow query embedding falls back to full text inside the budget', async () => {
	const server = await startEmbedServer((body, _request, call) => (call === 1 ? { delayMs: 3_000 } : { body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) } }));
	const embedder = new EmbeddingClient(embedOptions({ url: server.url }));
	const hits = Array.from({ length: 2 }, (_value, index) => ({
		text: `slow query ${index}`,
		hit: nativeHit({ id: `session-${index}`, text: `slow query ${index}` }),
	}));
	const engine = createHybridSessionQueryEngine({ inner: fakeInner({ hits }), embedder, vectors: { vectorSearch: () => [] }, config: { queryTimeoutMs: 500 } });
	try {
		const startedAt = Date.now();
		const page = await engine.searchSessions({ query: 'slow query' });
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 2_000, `fallback took ${elapsed} ms`);
		assert.deepEqual(page.items.map((hit) => hit.header.id), ['session-0', 'session-1']);
	} finally {
		await server.close();
	}
});

test('an unreachable endpoint and an empty index both degrade to pure full text', async () => {
	const hits = [{ text: 'deploy the app', hit: nativeHit({ id: 'session-only', text: 'deploy the app' }) }];
	const down = createHybridSessionQueryEngine({
		inner: fakeInner({ hits }),
		embedder: new EmbeddingClient(embedOptions({ url: 'http://127.0.0.1:1/v1/embeddings' })),
		vectors: { vectorSearch: () => [] },
		config: {},
	});
	const downPage = await down.searchSessions({ query: 'deploy the app' });
	assert.deepEqual(downPage.items.map((hit) => hit.header.id), ['session-only']);

	const home = await makeTempHome();
	const server = await startEmbedServer();
	const emptySidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })) });
	const empty = createHybridSessionQueryEngine({
		inner: fakeInner({ hits }),
		embedder: new EmbeddingClient(embedOptions({ url: server.url })),
		vectors: emptySidecar,
		config: { queryTimeoutMs: 2000 },
	});
	try {
		const emptyPage = await empty.searchSessions({ query: 'deploy the app' });
		assert.deepEqual(emptyPage.items.map((hit) => hit.header.id), ['session-only']);
	} finally {
		await emptySidecar.close();
		await server.close();
	}
});

test('a disabled inner full-text index still serves vector matches', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-vector-only', messages: [{ role: 'user', text: 'deploy the app to production' }] });
	const server = await startEmbedServer();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })) });
	const embedder = new EmbeddingClient(embedOptions({ url: server.url }));
	const disabled = fakeInner({ hits: [], failWith: new SessionQueryError('search disabled', 'SESSION_QUERY_SEARCH_DISABLED') });
	const engine = createHybridSessionQueryEngine({ inner: disabled, vectors: sidecar, embedder, config: { queryTimeoutMs: 2000 } });
	try {
		await sidecar.runOnce();
		const page = await engine.searchSessions({ query: 'release the application' });
		assert.deepEqual(page.items.map((hit) => hit.header.id), ['session-vector-only']);
	} finally {
		await sidecar.close();
		await server.close();
	}
});

test('request validation matches the native failure codes', async () => {
	const engine = createHybridSessionQueryEngine({ inner: fakeInner({ hits: [] }), config: {} });
	await assert.rejects(engine.searchSessions({ query: '   ' }), (error) => error.code === 'SESSION_QUERY_INVALID_QUERY');
	await assert.rejects(engine.searchSessions({ query: 'ok', limit: 0 }), (error) => error.code === 'SESSION_QUERY_INVALID_LIMIT');
	await assert.rejects(engine.searchSessions({ query: 'ok', limit: 101 }), (error) => error.code === 'SESSION_QUERY_INVALID_LIMIT');
	await assert.rejects(engine.searchSessions({ query: 'ok', eventFilters: [{ kind: 'text', text: 'x' }] }), (error) => error.code === 'SESSION_QUERY_INVALID_FILTER');
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(engine.searchSessions({ query: 'ok' }, { signal: controller.signal }), (error) => error.code === 'SESSION_QUERY_ABORTED');
});

test('materialized filters reach the vector side', async () => {
	const seen = [];
	const vectors = {
		vectorSearch: (_vector, filters) => {
			seen.push(filters);
			return [];
		},
	};
	const engine = createHybridSessionQueryEngine({
		inner: fakeInner({ hits: [] }),
		vectors,
		embedder: { embed: async () => [Float32Array.from(bagVector('query'))] },
		config: {},
	});
	await engine.searchSessions({
		query: 'anything',
		sessionFilters: [{ kind: 'cwd', values: ['/tmp/a'] }],
		eventFilters: [{ kind: 'type', values: ['user/message'] }],
	});
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0].sessionFilters, [{ kind: 'cwd', values: ['/tmp/a'] }]);
	assert.deepEqual(seen[0].eventFilters, [{ kind: 'type', values: ['user/message'] }]);
});

/**
 * Native fixtures whose text all contains one phrase, in native order.
 * @param {number} count - hit count.
 * @param {string} phrase - shared phrase.
 * @returns {Array<{ text: string, hit: object }>} fixtures.
 */
function phraseHits(count, phrase) {
	return Array.from({ length: count }, (_value, index) => {
		const id = `session-${String(index).padStart(3, '0')}`;
		return { text: `${phrase} ${index}`, hit: nativeHit({ id, text: `${phrase} ${index}` }) };
	});
}

/**
 * Sidecar-shaped vector row for a stub vector side.
 * @param {string} sessionId - session id.
 * @param {number} score - cosine score.
 * @returns {object} candidate row.
 */
function vectorRow(sessionId, score) {
	return {
		session_id: sessionId,
		seq: 1,
		chunk_index: 0,
		text: `vector text for ${sessionId}`,
		type: 'user/message',
		time: 1_760_000_000_000,
		surface: 'current',
		version: 4,
		created_at: 1_760_000_000_000,
		cwd: null,
		parent_session: null,
		is_seeded: 0,
		delegation_depth: 0,
		agent_preset: 'standard',
		score,
	};
}

/**
 * Stub embedder: a fixed query vector while `up`, unavailable otherwise.
 * @returns {{ up: boolean, embed: Function, queryEmbed: Function }} embedder.
 */
function switchableEmbedder() {
	const state = {
		up: true,
		async embed(texts) {
			if (!state.up) throw new Error('embedding endpoint down');
			return texts.map((text) => Float32Array.from(bagVector(text)));
		},
		async queryEmbed(text) {
			return state.up ? Float32Array.from(bagVector(text)) : undefined;
		},
	};
	return state;
}

test('a search during an indexer retry backoff falls back to full text within the query budget', async () => {
	// The endpoint is down (503) and an indexer batch is waiting out its retry
	// backoff. The search must not queue behind that batch.
	const server = await startEmbedServer(() => ({ status: 503, body: { error: 'overloaded' } }));
	const embedder = new EmbeddingClient({ endpointUrl: server.url, dim: 768, timeoutMs: 5_000, maxAttempts: 3, retryBaseMs: 5_000, retryMaxMs: 5_000 });
	const indexer = new AbortController();
	const batch = embedder.embed(['an indexer document'], { signal: indexer.signal });
	batch.catch(() => {});
	const engine = createHybridSessionQueryEngine({
		inner: fakeInner({ hits: phraseHits(3, 'budget phrase') }),
		embedder,
		vectors: { vectorSearch: () => [], generation: () => 'g' },
		config: { queryTimeoutMs: 300 },
	});
	try {
		for (let wait = 0; server.calls === 0 && wait < 100; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(server.calls >= 1, 'the indexer batch reached the endpoint and is now backing off');
		const startedAt = Date.now();
		const outcome = await Promise.race([engine.searchSessions({ query: 'budget phrase' }), new Promise((resolve) => setTimeout(() => resolve('timed out'), 3_000))]);
		const elapsed = Date.now() - startedAt;
		assert.notEqual(outcome, 'timed out', 'the search waited behind the indexer batch');
		assert.ok(elapsed < 1_500, `search took ${elapsed} ms against a 300 ms query budget`);
		assert.deepEqual(outcome.items.map((hit) => hit.header.id), ['session-000', 'session-001', 'session-002']);
	} finally {
		indexer.abort();
		await batch.catch(() => {});
		await server.close();
	}
});

test('a full-text page served while vectors return nothing continues on the next page', async () => {
	const inner = fakeInner({ hits: phraseHits(5, 'native phrase'), cursors: true });
	const engine = createHybridSessionQueryEngine({
		inner,
		embedder: switchableEmbedder(),
		vectors: { vectorSearch: () => [], generation: () => 'g' },
		config: {},
	});
	const ids = await collectPages(engine, { query: 'native phrase', limit: 2 });
	assert.deepEqual(ids, ['session-000', 'session-001', 'session-002', 'session-003', 'session-004']);
});

test('a hybrid page continues after the endpoint goes down, and a lost vector side restarts cleanly', async () => {
	const hits = phraseHits(6, 'hybrid phrase');
	const candidates = [vectorRow('session-vector-a', 0.9), vectorRow('session-003', 0.8), vectorRow('session-vector-b', 0.7)];
	const vectors = { fail: false, vectorSearch: async () => (vectors.fail ? Promise.reject(new Error('database is locked')) : candidates), generation: () => 'g' };
	const embedder = switchableEmbedder();
	const engine = createHybridSessionQueryEngine({ inner: fakeInner({ hits, cursors: true }), embedder, vectors, config: {} });
	const reference = await collectPages(engine, { query: 'hybrid phrase', limit: 3 });
	assert.equal(reference.length, 8);
	assert.equal(new Set(reference).size, 8);

	const first = await engine.searchSessions({ query: 'hybrid phrase', limit: 3 });
	embedder.up = false;
	const second = await engine.searchSessions({ query: 'hybrid phrase', limit: 3, cursor: first.nextCursor });
	assert.deepEqual(
		[...first.items, ...second.items].map((hit) => hit.header.id),
		reference.slice(0, 6),
		'page 2 continues the fused order with the first page\'s query vector',
	);

	vectors.fail = true;
	await assert.rejects(engine.searchSessions({ query: 'hybrid phrase', limit: 3, cursor: second.nextCursor }), (error) => {
		assert.equal(error.code, 'SESSION_QUERY_STALE_CURSOR', 'a hybrid stream that cannot be reproduced asks the caller to restart');
		return true;
	});
	const restarted = await collectPages(engine, { query: 'hybrid phrase', limit: 3 });
	assert.deepEqual(restarted, hits.map((entry) => entry.hit.header.id), 'the restarted search pages the full-text stream');
});

test('with the endpoint down, every full-text match pages through exactly once', async () => {
	const hits = phraseHits(90, 'outage phrase');
	for (const cursors of [false, true]) {
		const engine = createHybridSessionQueryEngine({
			inner: fakeInner({ hits, cursors }),
			embedder: new EmbeddingClient(embedOptions({ url: 'http://127.0.0.1:1/v1/embeddings', maxAttempts: 1 })),
			vectors: { vectorSearch: () => [], generation: () => 'g' },
			config: { queryTimeoutMs: 500 },
		});
		const ids = await collectPages(engine, { query: 'outage phrase', limit: 20 });
		assert.deepEqual(ids, hits.map((entry) => entry.hit.header.id), `every page is served in native order (native cursors: ${cursors})`);
	}
});

test('hybrid pages serve every match exactly once past the candidate pool', async () => {
	const hits = phraseHits(90, 'pool phrase');
	// 50 vector candidates: every fifth is a session full text never saw; the
	// rest are full-text hits ranked 51-90, outside the fused head, best last.
	const candidates = Array.from({ length: 50 }, (_value, index) =>
		index % 5 === 0 ? vectorRow(`session-vector-${String(index).padStart(2, '0')}`, 0.99 - index * 0.01) : vectorRow(`session-${String(89 - index).padStart(3, '0')}`, 0.99 - index * 0.01),
	);
	for (const cursors of [false, true]) {
		const engine = createHybridSessionQueryEngine({
			inner: fakeInner({ hits, cursors }),
			embedder: switchableEmbedder(),
			vectors: { vectorSearch: () => candidates, generation: () => 'g' },
			config: {},
		});
		const ids = await collectPages(engine, { query: 'pool phrase', limit: 20 });
		const expected = new Set([...hits.map((entry) => entry.hit.header.id), ...candidates.map((row) => row.session_id)]);
		assert.equal(new Set(ids).size, ids.length, `no session is served twice (native cursors: ${cursors})`);
		assert.deepEqual(new Set(ids), expected, `every match is served (native cursors: ${cursors})`);
	}
});

test('a search does not recompute the sidecar generation', async () => {
	const home = await makeTempHome();
	await fusionCorpus(home);
	const server = await startEmbedServer();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })) });
	const engine = createHybridSessionQueryEngine({
		inner: fakeInner({ hits: [] }),
		vectors: sidecar,
		embedder: new EmbeddingClient(embedOptions({ url: server.url })),
		config: { queryTimeoutMs: 2000 },
	});
	try {
		await sidecar.runOnce();
		const prepare = sidecar._db.prepare.bind(sidecar._db);
		let scans = 0;
		sidecar._db.prepare = (sql) => {
			if (/SELECT text_hash FROM chunks ORDER BY id/u.test(sql)) scans += 1;
			return prepare(sql);
		};
		for (let index = 0; index < 3; index += 1) {
			const page = await engine.searchSessions({ query: 'release the application' });
			assert.equal(page.items[0].header.id, 'session-deploy');
		}
		assert.ok(scans <= 1, `three unchanged searches re-hashed every chunk ${scans} times`);
	} finally {
		await sidecar.close();
		await server.close();
	}
});
