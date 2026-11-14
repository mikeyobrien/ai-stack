/**
 * Sidecar tests: real temporary DSH homes, incremental ingest, chunk bounds,
 * crash convergence, and the single-writer lock.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { EmbeddingClient } from '../lib/embed-client.js';
import { CHUNK_CHARS, SessionVectorSidecar, buildFilterSql, chunkText } from '../lib/sidecar.js';
import { appendMessage, bagVector, embedOptions, makeTempHome, startEmbedServer, writeSessionFile } from './helpers.js';

/**
 * Counting deterministic embedder.
 * @param {{ failFromCall?: number, dim?: number }} [options] - failure injection.
 * @returns {{ embed: Function, calls: string[][], textCount: number }} embedder.
 */
function countingEmbedder(options = {}) {
	const state = {
		calls: [],
		failFromCall: options.failFromCall ?? Number.POSITIVE_INFINITY,
		dim: options.dim ?? 768,
		textCount: 0,
		async embed(texts) {
			state.textCount += texts.length;
			state.calls.push(texts);
			if (state.calls.length >= state.failFromCall) throw new Error('embedding endpoint down');
			return texts.map((text) => Float32Array.from(bagVector(text, state.dim)));
		},
	};
	return state;
}

test('chunkText bounds every chunk and preserves the words', () => {
	const text = Array.from({ length: 400 }, (_value, index) => `word${index}`).join(' ');
	const chunks = chunkText(text, CHUNK_CHARS);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) assert.ok(Array.from(chunk).length <= CHUNK_CHARS, `chunk of ${Array.from(chunk).length} code points exceeds the bound`);
	assert.deepEqual(chunks.join(' ').split(' '), text.split(' '));
	const longToken = 'x'.repeat(CHUNK_CHARS * 2 + 7);
	const tokenChunks = chunkText(longToken, CHUNK_CHARS);
	assert.ok(tokenChunks.length >= 3);
	for (const chunk of tokenChunks) assert.ok(Array.from(chunk).length <= CHUNK_CHARS);
});

test('ingest indexes the real nested session layout once and never duplicates', async () => {
	const home = await makeTempHome();
	const file = await writeSessionFile(home, {
		id: 'session-one',
		cwd: '/tmp/work',
		messages: [
			{ role: 'user', text: 'deploy the app to production' },
			{ role: 'assistant', text: 'deployed and verified' },
		],
	});
	const embedder = countingEmbedder();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder });
	try {
		const first = await sidecar.runOnce();
		assert.equal(first.files, 1);
		assert.equal(first.changedFiles, 1);
		assert.equal(first.chunks, 2);
		assert.equal(first.embedded, 2);
		assert.deepEqual(first.errors, []);
		assert.deepEqual(sidecar.stats(), { chunks: 2, embedded: 2, sessions: 1, files: 1 });

		const second = await sidecar.runOnce();
		assert.equal(second.changedFiles, 0);
		assert.equal(second.chunks, 0);
		assert.equal(second.embedded, 0, 'an unchanged log embeds nothing');
		assert.equal(embedder.textCount, 2);

		// The file really was read from the documented on-disk shape.
		const raw = await readFile(file, 'utf8');
		assert.match(raw, /"type":"session"/u);
	} finally {
		await sidecar.close();
	}
});

test('an appended message is ingested without re-embedding existing chunks', async () => {
	const home = await makeTempHome();
	const fixture = {
		id: 'session-append',
		messages: [
			{ role: 'user', text: 'first message about budgets' },
			{ role: 'assistant', text: 'acknowledged the budget' },
		],
	};
	const file = await writeSessionFile(home, fixture);
	const embedder = countingEmbedder();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder });
	try {
		await sidecar.runOnce();
		const before = sidecar.stats();
		assert.equal(before.chunks, 2);
		assert.equal(embedder.textCount, 2);

		await appendMessage(file, fixture, { role: 'user', text: 'a later note about the rollout' });
		const again = await sidecar.runOnce();
		assert.equal(again.changedFiles, 1);
		assert.equal(again.chunks, 3, 'the whole log is re-read, but only the appended event is new');
		assert.equal(again.embedded, 1, 'only the new chunk is embedded');
		assert.equal(embedder.textCount, 3);
		assert.equal(sidecar.stats().chunks, 3);
		const duplicate = sidecar._db.prepare('SELECT COUNT(*) AS total, COUNT(DISTINCT session_id || \':\' || seq || \':\' || chunk_index) AS unique_keys FROM chunks').get();
		assert.deepEqual({ total: duplicate.total, unique: duplicate.unique_keys }, { total: 3, unique: 3 });
	} finally {
		await sidecar.close();
	}
});

test('a compressed log is ingested and a rewritten compressed log converges without duplicates', async () => {
	const home = await makeTempHome();
	const fixture = { id: 'session-zstd', messages: [{ role: 'user', text: 'compressed log about release planning' }] };
	const file = await writeSessionFile(home, fixture, { compressed: true });
	const embedder = countingEmbedder();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder });
	try {
		await sidecar.runOnce();
		assert.equal(sidecar.stats().chunks, 1);
		await writeSessionFile(
			home,
			{ ...fixture, messages: [...fixture.messages, { role: 'assistant', text: 'release scheduled' }] },
			{ compressed: true },
		);
		const again = await sidecar.runOnce();
		assert.equal(again.changedFiles, 1);
		assert.equal(again.embedded, 1);
		assert.equal(sidecar.stats().chunks, 2);
		assert.match(file, /\.jsonl\.zstd$/u);
	} finally {
		await sidecar.close();
	}
});

test('a crash mid-batch converges on the next pass with no duplicates', async () => {
	const home = await makeTempHome();
	const longText = (label) => `${label} ${'filler '.repeat(300)}`;
	await writeSessionFile(home, {
		id: 'session-crash',
		messages: [
			{ role: 'user', text: longText('alpha') },
			{ role: 'assistant', text: longText('bravo') },
			{ role: 'user', text: longText('charlie') },
		],
	});
	const embedder = countingEmbedder({ failFromCall: 3 });
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder, batchSize: 2 });
	try {
		const first = await sidecar.runOnce();
		assert.equal(first.chunks, 6);
		assert.equal(first.embedded, 4, 'two batches landed before the failure');
		assert.match(first.embeddingError, /endpoint down/u);
		assert.equal(sidecar.pendingChunks(10).length, 2);

		embedder.failFromCall = Number.POSITIVE_INFINITY;
		const second = await sidecar.runOnce();
		assert.equal(second.embedded, 2);
		assert.equal(sidecar.pendingChunks(10).length, 0);
		const counts = sidecar._db.prepare('SELECT COUNT(*) AS total, COUNT(vec) AS embedded, COUNT(DISTINCT session_id || \':\' || seq || \':\' || chunk_index) AS unique_keys FROM chunks').get();
		assert.deepEqual({ total: counts.total, embedded: counts.embedded, unique: counts.unique_keys }, { total: 6, embedded: 6, unique: 6 });
	} finally {
		await sidecar.close();
	}
});

test('only one writer may ingest at a time', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-lock', messages: [{ role: 'user', text: 'lock holder' }] });
	const first = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	const second = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		const firstRun = await first.runOnce();
		assert.equal(firstRun.locked, false);
		const secondRun = await second.runOnce();
		assert.equal(secondRun.locked, true, 'the second sidecar is not the writer');
		assert.equal(secondRun.embedded, 0);
		assert.equal(second.stats().chunks, 1, 'the second sidecar still reads the shared index');
		await first.close();
		const thirdRun = await second.runOnce();
		assert.equal(thirdRun.locked, false, 'the lock is available after the writer closes');
	} finally {
		await first.close();
		await second.close();
	}
});

test('a changed model discards vectors and re-embeds with the new model', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-model', messages: [{ role: 'user', text: 'model switch' }] });
	const first = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder(), model: 'model-a' });
	await first.runOnce();
	assert.equal(first.stats().embedded, 1);
	await first.close();
	const second = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder(), model: 'model-b' });
	try {
		const run = await second.runOnce();
		assert.equal(run.discardedStaleState, true);
		assert.equal(second.stats().embedded, 1);
		assert.equal(run.embedded, 1);
	} finally {
		await second.close();
	}
});

test('vector search honors session and event filters', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, {
		id: 'session-keep',
		cwd: '/tmp/keep',
		messages: [{ role: 'user', text: 'budget planning for the quarter' }],
	});
	await writeSessionFile(home, {
		id: 'session-drop',
		cwd: '/tmp/drop',
		messages: [{ role: 'user', text: 'budget planning for the weekend' }],
	});
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		await sidecar.runOnce();
		const query = Float32Array.from(bagVector('search_query: budget planning'));
		const all = await sidecar.vectorSearch(query, { limitSessions: 10 });
		assert.equal(all.length, 2);
		const filtered = await sidecar.vectorSearch(query, { sessionFilters: [{ kind: 'cwd', values: ['/tmp/keep'] }], limitSessions: 10 });
		assert.deepEqual(filtered.map((row) => row.session_id), ['session-keep']);
		const byAvailability = await sidecar.vectorSearch(query, { sessionFilters: [{ kind: 'availability', values: ['live'] }], limitSessions: 10 });
		assert.deepEqual(byAvailability, [], 'the sidecar holds persisted sessions only');
		const byType = await sidecar.vectorSearch(query, { eventFilters: [{ kind: 'type', values: ['assistant/message'] }], limitSessions: 10 });
		assert.deepEqual(byType, []);
	} finally {
		await sidecar.close();
	}
});

test('a session directory with no readable log is skipped without failing the pass', async () => {
	const home = await makeTempHome();
	await mkdir(join(home, 'sessions', '--broken--', 'session-broken'), { recursive: true });
	await writeFileRaw(join(home, 'sessions', '--broken--', 'session-broken', 'session.v4.jsonl'), '{"type":"session"\nnot json\n');
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		const run = await sidecar.runOnce();
		assert.equal(run.chunks, 0);
		assert.equal(sidecar.stats().chunks, 0);
	} finally {
		await sidecar.close();
	}
});

/**
 * Write text to a path, creating the parent directory.
 * @param {string} file - destination path.
 * @param {string} text - file content.
 * @returns {Promise<void>} resolves once written.
 */
async function writeFileRaw(file, text) {
	const { writeFile } = await import('node:fs/promises');
	await writeFile(file, text);
}

/**
 * Start a process that stays alive until killed.
 * @returns {import('node:child_process').ChildProcess} running child.
 */
function liveProcess() {
	return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
}

/**
 * A pid that belonged to a process which has already exited.
 * @returns {number} dead pid.
 */
function deadPid() {
	const { pid } = spawnSync(process.execPath, ['-e', '']);
	return pid;
}

test('a lock left by a dead process is reclaimed', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-stale-lock', messages: [{ role: 'user', text: 'stale lock holder' }] });
	const lockPath = join(home, 'embeddings', 'session-vectors.lock');
	writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: Date.now() - 60_000 }));
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		const run = await sidecar.runOnce();
		assert.equal(run.locked, false, 'the dead holder lock was reclaimed');
		assert.equal(run.embedded, 1);
		const record = JSON.parse(await readFile(lockPath, 'utf8'));
		assert.equal(record.pid, process.pid);
	} finally {
		await sidecar.close();
	}
	assert.equal(existsSync(lockPath), false, 'close removes the reclaimed lock');
});

test('an empty lock is reclaimed only after its grace period', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-empty-lock', messages: [{ role: 'user', text: 'empty lock holder' }] });
	const lockPath = join(home, 'embeddings', 'session-vectors.lock');
	writeFileSync(lockPath, '');
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		const fresh = await sidecar.runOnce();
		assert.equal(fresh.locked, true, 'a just-created empty lock may still be mid-write');
		const past = new Date(Date.now() - 60_000);
		utimesSync(lockPath, past, past);
		const stale = await sidecar.runOnce();
		assert.equal(stale.locked, false, 'an old empty lock is a crash leftover');
		assert.equal(stale.embedded, 1);
	} finally {
		await sidecar.close();
	}
});

test('a live holder is never displaced, and the lock records pid and startedAt', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-live-lock', messages: [{ role: 'user', text: 'live lock holder' }] });
	const lockPath = join(home, 'embeddings', 'session-vectors.lock');
	const child = liveProcess();
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		const own = await sidecar.runOnce();
		assert.equal(own.locked, false);
		assert.deepEqual(Object.keys(JSON.parse(await readFile(lockPath, 'utf8'))).sort(), ['pid', 'startedAt']);

		// Another live process takes the file over: this writer steps down.
		const foreign = JSON.stringify({ pid: child.pid, startedAt: Date.now() });
		writeFileSync(lockPath, foreign);
		const after = await sidecar.runOnce();
		assert.equal(after.locked, true, 'a writer whose lock file was replaced stops writing');
		assert.equal(sidecar.writable, false);
		await sidecar.close();
		assert.equal(await readFile(lockPath, 'utf8'), foreign, 'the live holder keeps its lock');
	} finally {
		child.kill();
		await sidecar.close();
	}
});

test('a chunk the endpoint refuses is skipped and the rest are embedded', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, {
		id: 'session-a',
		messages: [
			{ role: 'user', text: 'POISON input the endpoint cannot embed' },
			{ role: 'assistant', text: 'a normal reply' },
			{ role: 'user', text: 'another normal message' },
		],
	});
	await writeSessionFile(home, { id: 'session-b', messages: [{ role: 'user', text: 'deploy the app to production' }] });
	const server = await startEmbedServer((body) =>
		body.input.some((text) => text.includes('POISON')) ? { status: 413, body: { error: 'input is too large' } } : {},
	);
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })), batchSize: 16 });
	try {
		const first = await sidecar.runOnce();
		assert.equal(first.embeddingError, undefined);
		assert.equal(first.embedded, 3, 'every chunk except the refused one is embedded');
		assert.equal(first.skippedChunks, 1);
		assert.equal(sidecar.stats().embedded, 3);
		const callsAfterFirst = server.calls;

		const second = await sidecar.runOnce();
		assert.equal(second.embedded, 0);
		assert.equal(server.calls, callsAfterFirst, 'the refused chunk is not sent again on the next pass');
		const hits = await sidecar.vectorSearch(Float32Array.from(bagVector('search_query: release the application')), { limitSessions: 5 });
		assert.equal(hits[0].session_id, 'session-b');
	} finally {
		await sidecar.close();
		await server.close();
	}
});

test('an endpoint that refuses every input skips nothing', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, {
		id: 'session-refused',
		messages: [
			{ role: 'user', text: 'first message' },
			{ role: 'assistant', text: 'second message' },
		],
	});
	let refuse = true;
	const server = await startEmbedServer(() => (refuse ? { status: 400, body: { error: 'unknown model' } } : {}));
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: new EmbeddingClient(embedOptions({ url: server.url })) });
	try {
		const refused = await sidecar.runOnce();
		assert.equal(refused.embedded, 0);
		assert.equal(refused.skippedChunks, 0, 'a misconfigured endpoint does not mark the corpus failed');
		assert.match(refused.embeddingError, /refuses every input/u);
		assert.equal(sidecar.pendingChunks(10).length, 2);
		refuse = false;
		const fixed = await sidecar.runOnce();
		assert.equal(fixed.embedded, 2);
	} finally {
		await sidecar.close();
		await server.close();
	}
});

test('vector search applies the seq range and treats unknown event filters as no match', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, {
		id: 'session-two-turns',
		messages: [
			{ role: 'user', text: 'budget planning for the quarter' },
			{ role: 'user', text: 'budget planning follow up' },
		],
	});
	await writeSessionFile(home, { id: 'session-one-turn', messages: [{ role: 'user', text: 'budget planning for the weekend' }] });
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		await sidecar.runOnce();
		const query = Float32Array.from(bagVector('search_query: budget planning'));
		const bySeq = await sidecar.vectorSearch(query, { eventFilters: [{ kind: 'seq', from: 2, to: 2 }], limitSessions: 10 });
		assert.deepEqual(bySeq.map((row) => [row.session_id, row.seq]), [['session-two-turns', 2]]);
		const unknown = await sidecar.vectorSearch(query, { eventFilters: [{ kind: 'not-a-filter' }], limitSessions: 10 });
		assert.deepEqual(unknown, [], 'a clause the sidecar cannot express never admits a vector-only hit');
		assert.match(buildFilterSql([], [{ kind: 'not-a-filter' }]).sql, /\b0\b/u);
	} finally {
		await sidecar.close();
	}
});

test('generation() is cached until this or another connection writes', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-generation', messages: [{ role: 'user', text: 'generation cache' }] });
	const writer = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	const reader = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		await writer.runOnce();
		reader.open();
		const prepare = reader._db.prepare.bind(reader._db);
		let scans = 0;
		reader._db.prepare = (sql) => {
			if (/SELECT text_hash FROM chunks ORDER BY id/u.test(sql)) scans += 1;
			return prepare(sql);
		};
		const before = reader.generation();
		assert.equal(reader.generation(), before);
		assert.equal(scans, 1, 'an unchanged index is hashed once');
		await writeSessionFile(home, { id: 'session-generation', messages: [{ role: 'user', text: 'generation cache, rewritten' }] });
		await writer.runOnce();
		assert.notEqual(reader.generation(), before, 'another process\'s write changes the generation');
		assert.equal(scans, 2);
	} finally {
		await writer.close();
		await reader.close();
	}
});

test('chunkText bounds chunks by code points for astral text', () => {
	const text = Array.from({ length: 900 }, () => '\u{1F600}\u{1F680}\u{1F4A5}').join(' ');
	const chunks = chunkText(text, CHUNK_CHARS);
	for (const chunk of chunks) assert.ok(Array.from(chunk).length <= CHUNK_CHARS, `chunk of ${Array.from(chunk).length} code points exceeds the bound`);
	assert.equal(chunks.join(' '), text);
});

test('ingest failures are logged once each', async () => {
	const home = await makeTempHome();
	const directory = join(home, 'sessions', '--broken--', 'session-corrupt');
	await mkdir(directory, { recursive: true });
	const corrupt = join(directory, 'session.v4.jsonl.zstd');
	writeFileSync(corrupt, 'not a zstd frame');
	const warnings = [];
	const logger = { warn: (message) => warnings.push(message), debug: () => {} };
	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder(), logger });
	try {
		const first = await sidecar.runOnce();
		assert.equal(first.errors.length, 1);
		assert.equal(warnings.filter((message) => message.includes(corrupt)).length, 1, 'the skipped log is reported');
		await sidecar.runOnce();
		assert.equal(warnings.filter((message) => message.includes(corrupt)).length, 1, 'a recurring failure is not reported every pass');
	} finally {
		await sidecar.close();
	}
});

test('an index is searchable read-only without starting the indexer', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-indexed', messages: [{ role: 'user', text: 'budget planning for the quarter' }] });
	const writer = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	await writer.runOnce();
	await writer.close();
	const searcher = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder() });
	try {
		const hits = await searcher.vectorSearch(Float32Array.from(bagVector('search_query: budget planning')), { limitSessions: 5 });
		assert.deepEqual(hits.map((row) => row.session_id), ['session-indexed']);
		assert.equal(searcher.writable, false);
		assert.equal(existsSync(join(home, 'embeddings', 'session-vectors.lock')), false, 'searching never takes the writer lock');
	} finally {
		await searcher.close();
	}
});

test('a process with another model never wipes the index it does not write', async () => {
	const home = await makeTempHome();
	await writeSessionFile(home, { id: 'session-shared-index', messages: [{ role: 'user', text: 'budget planning for the quarter' }] });
	const writer = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder(), model: 'model-a' });
	const other = new SessionVectorSidecar({ dshHome: home, embedder: countingEmbedder(), model: 'model-b' });
	try {
		await writer.runOnce();
		const blocked = await other.runOnce();
		assert.equal(blocked.locked, true);
		assert.equal(writer.stats().embedded, 1, 'the writer keeps its vectors');
		const query = Float32Array.from(bagVector('search_query: budget planning'));
		assert.deepEqual(await other.vectorSearch(query, { limitSessions: 5 }), [], 'vectors from another model are not served');
		assert.equal((await writer.vectorSearch(query, { limitSessions: 5 })).length, 1);

		await writer.close();
		const takeover = await other.runOnce();
		assert.equal(takeover.locked, false);
		assert.equal(takeover.discardedStaleState, true, 'the new writer discards the other model and re-embeds');
		assert.equal(takeover.embedded, 1);
	} finally {
		await writer.close();
		await other.close();
	}
});
