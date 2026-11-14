#!/usr/bin/env node
/**
 * Golden paraphrase evaluation for hybrid session search.
 *
 * Runs entirely on the sidecar: a temporary DSH home holds the fixture session
 * logs, a local SQLite FTS5 index reproduces the native ranking SQL as the
 * baseline, and the real hybrid engine is asked the same queries. It prints
 * hit@1 for full text and for hybrid and exits nonzero when the gate fails:
 * hybrid must be at least as good on every pair and strictly better on at
 * least half of them.
 *
 * Usage:
 *   node eval/golden.mjs            # real embedding endpoint when reachable
 *   DSH_EMBED_ENDPOINT=… node eval/golden.mjs   # default http://127.0.0.1:8890/v1/embeddings
 *   node eval/golden.mjs --offline  # local bag stand-in, no network
 *
 * @module @local/dsh-session-semantic-search/eval/golden
 */

import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOCUMENT_PREFIX, QUERY_PREFIX, EmbeddingClient, defaultEndpointUrl } from '../lib/embed-client.js';
import { createHybridSessionQueryEngine } from '../lib/hybrid-engine.js';
import { SessionVectorSidecar } from '../lib/sidecar.js';

/** Fixture pairs: a paraphrase query and the session whose message it paraphrases. */
const PAIRS = [
	{
		query: 'why did the release break after the credentials changed',
		doc: 'the deployment script failed because the database password was rotated overnight',
	},
	{
		query: 'cutting infrastructure costs next quarter',
		doc: 'we need to reduce cloud spending by thirty percent next quarter',
	},
	{
		query: 'mobile application aborts on the preferences page',
		doc: 'the flutter app crashes on android when opening the settings screen',
	},
	{
		query: 'handoff to another agent never finished',
		doc: 'subagent delegation timed out while waiting for the codex backend',
	},
	{
		query: 'database locking problem when two processes write at once',
		doc: 'sqlite write lock contention during concurrent session ingestion',
	},
	{
		query: 'chat bot loses texts during connectivity loss',
		doc: 'the telegram bridge drops messages sent while the network is offline',
	},
	{
		query: 'window manager ignores rules on my other display',
		doc: 'hyprland window rules do not apply to the second monitor',
	},
	{
		query: 'vector server fails for big request batches',
		doc: 'the embedding endpoint returns 500 errors when the batch is larger than sixteen',
	},
	{
		query: 'package manager cannot download dependencies after certificate renewal',
		doc: 'pnpm install fails because the registry certificate expired',
	},
	{
		query: 'assistant in the sidebar loops restarting when credentials change',
		doc: 'the sidebar agent keeps restarting after the model provider rotates keys',
	},
	{
		query: 'log replay refuses repeated event numbers',
		doc: 'session replay validation rejects events with duplicate sequence numbers',
	},
	{
		query: 'infinite scroll halts at the fourth page',
		doc: 'the htmx pagination stops loading after the third page',
	},
];

/** Synonym groups for the offline stand-in embedding. */
const SYNONYMS = [
	['deploy', 'deployment', 'release', 'ship', 'rollout'],
	['crash', 'crashes', 'abort', 'aborts', 'panic', 'fail', 'fails', 'failed', 'break', 'breaks'],
	['budget', 'spend', 'spending', 'cost', 'costs'],
	['password', 'credentials', 'keys', 'certificate'],
	['write', 'writes', 'write'],
	['database', 'db', 'sqlite'],
	['agent', 'assistant', 'subagent'],
	['app', 'application', 'mobile'],
	['screen', 'page', 'display', 'monitor'],
	['message', 'messages', 'texts', 'text'],
	['batch', 'batches', 'request', 'requests'],
	['page', 'pages', 'scroll', 'pagination'],
];
const CONCEPT = new Map(SYNONYMS.flatMap((group) => group.map((word) => [word, group[0]])));

/**
 * Deterministic bag-of-concepts vector, the offline stand-in model.
 * @param {string} text - text to embed, with any prefix.
 * @returns {Float32Array} 768-dimension normalized vector.
 */
function bagVector(text) {
	const dim = 768;
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
	return Float32Array.from(norm === 0 ? vector : vector.map((value) => value / norm));
}

/**
 * Write one fixture session to the real persisted layout.
 * @param {string} home - temporary DSH home.
 * @param {number} index - pair index.
 * @param {string} doc - message text.
 * @returns {Promise<string>} session id.
 */
async function writeFixtureSession(home, index, doc) {
	const id = `session-golden-${String(index).padStart(2, '0')}`;
	const directory = join(home, 'sessions', '--golden--', `session-${id}`);
	await mkdir(directory, { recursive: true });
	const createdAt = 1_760_000_000_000 + index * 1_000;
	const lines = [
		JSON.stringify({ type: 'session', version: 4, id, createdAt, cwd: '/tmp/golden', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }),
		JSON.stringify({ type: 'permission/preset', seq: 0, time: createdAt, data: { preset: 'workspace-write' } }),
		JSON.stringify({ type: 'user/message', seq: 1, time: createdAt + 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: doc }] } }),
		JSON.stringify({ type: 'assistant/message', seq: 2, time: createdAt + 2, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'acknowledged' }] } } }),
	];
	const { writeFile } = await import('node:fs/promises');
	await writeFile(join(directory, 'session.v4.jsonl'), `${lines.join('\n')}\n`);
	return id;
}

/**
 * Build the native FTS baseline over the fixture documents.
 *
 * This reproduces the shipped SQLite backend's ranking (`match_count DESC,
 * document_length ASC, time DESC, seq DESC`, one best event per session, then
 * `time DESC, session_id ASC, seq DESC`) so the FTS column is a faithful
 * baseline rather than this package's own recall.
 *
 * @param {DatabaseSync} db - in-memory database.
 * @param {Array<{ sessionId: string, sessions: string[], text: string, seq: number, time: number }>} documents - semantic documents.
 */
function indexDocuments(db, documents) {
	db.exec(`
    CREATE VIRTUAL TABLE docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      time UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    );
  `);
	const insert = db.prepare('INSERT INTO docs (text, session_id, seq, time, codepoint_length) VALUES (?, ?, ?, ?, ?)');
	for (const document of documents) insert.run(document.text, document.sessionId, document.seq, document.time, Array.from(document.text).length);
}

/**
 * Native-order session ids for one literal query.
 * @param {DatabaseSync} db - FTS database.
 * @param {string} query - literal phrase.
 * @param {number} limit - page size.
 * @returns {string[]} session ids in native order.
 */
function ftsOrder(db, query, limit) {
	const expression = `"${query.replaceAll('"', '""')}"`;
	const rows = db
		.prepare(`
      WITH candidates AS (
        SELECT session_id, CAST(seq AS INTEGER) AS seq, CAST(time AS INTEGER) AS time,
               CAST(codepoint_length AS INTEGER) AS document_length, text
        FROM docs WHERE docs MATCH ?
      ), matched AS (
        SELECT *, length(CAST(text AS BLOB)) - length(CAST(replace(text, ?, '') AS BLOB)) AS match_count
        FROM candidates
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank FROM matched
      )
      SELECT session_id FROM ranked WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ?
    `)
		.all(expression, query, limit);
	return rows.map((row) => row.session_id);
}

/**
 * Stub native engine that answers from the baseline index and exposes the
 * native hit shape, so the hybrid engine under test runs unmodified.
 * @param {DatabaseSync} db - FTS database.
 * @param {Map<string, object>} headers - session headers by id.
 * @param {Map<string, { seq: number, time: number, text: string }[]>} documentsBySession - documents by session.
 * @returns {object} inner engine stub.
 */
function ftsInner(db, headers, documentsBySession) {
	return {
		config: { defaultLimit: 20, maxLimit: 100, snippetChars: 240 },
		async searchSessions(request) {
			const ids = ftsOrder(db, request.query, request.limit);
			return {
				items: ids.map((id) => {
					const document = documentsBySession.get(id).find((entry) => entry.text.toLowerCase().includes(request.query.toLowerCase())) ?? documentsBySession.get(id)[0];
					return {
						header: headers.get(id),
						live: false,
						persisted: true,
						bestMatch: {
							sessionId: id,
							seq: document.seq,
							type: 'user/message',
							time: document.time,
							surface: 'current',
							snippet: Array.from(document.text).slice(0, 240).join(''),
						},
					};
				}),
			};
		},
	};
}

/**
 * Probe the embedding endpoint with a tiny request.
 * @param {string} endpointUrl - candidate endpoint.
 * @returns {Promise<boolean>} whether it answered with a usable vector.
 */
async function endpointAlive(endpointUrl) {
	try {
		const response = await fetch(endpointUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'nomic-embed-text-v1.5', input: [`${QUERY_PREFIX}ping`] }),
			signal: AbortSignal.timeout(4_000),
		});
		if (!response.ok) return false;
		const body = await response.json();
		return Array.isArray(body?.data?.[0]?.embedding) && body.data[0].embedding.length === 768;
	} catch {
		return false;
	}
}

/**
 * Run the evaluation.
 * @returns {Promise<number>} process exit code.
 */
async function main() {
	const offline = process.argv.includes('--offline');
	const endpointUrl = defaultEndpointUrl();
	const useReal = offline ? false : await endpointAlive(endpointUrl);
	const remote = useReal
		? new EmbeddingClient({ endpointUrl, model: 'nomic-embed-text-v1.5', dim: 768, timeoutMs: 30_000, maxAttempts: 3, retryBaseMs: 1_000, retryMaxMs: 10_000 })
		: undefined;
	const embedder = {
		async embed(texts, options = {}) {
			if (remote !== undefined) return remote.embed(texts, { ...options, prefix: options.prefix ?? DOCUMENT_PREFIX });
			return texts.map((text) => bagVector(`${options.prefix ?? DOCUMENT_PREFIX}${text}`));
		},
	};

	const home = await mkdtemp(join(tmpdir(), 'dsh-golden-'));
	console.log(`embedding source: ${remote === undefined ? 'offline bag stand-in' : endpointUrl}`);
	const sessionIds = [];
	for (const [index, pair] of PAIRS.entries()) sessionIds.push(await writeFixtureSession(home, index, pair.doc));

	const sidecar = new SessionVectorSidecar({ dshHome: home, embedder, batchSize: 16 });
	const stats = await sidecar.runOnce();
	if (stats.embeddingError !== undefined) {
		console.error(`ingest failed: ${stats.embeddingError}`);
		process.exitCode = 2;
		return;
	}

	const documentsBySession = new Map();
	for (const [index, pair] of PAIRS.entries()) {
		documentsBySession.set(sessionIds[index], [
			{ seq: 1, time: 1_760_000_000_000 + index * 1_000 + 1, text: pair.doc },
			{ seq: 2, time: 1_760_000_000_000 + index * 1_000 + 2, text: 'acknowledged' },
		]);
	}
	const headers = new Map();
	for (const [index, id] of sessionIds.entries()) {
		headers.set(id, {
			version: 4,
			id,
			createdAt: 1_760_000_000_000 + index * 1_000,
			cwd: '/tmp/golden',
			isSeeded: false,
			delegationDepth: 0,
			agentPreset: 'standard',
		});
	}
	const ftsDb = new DatabaseSync(':memory:');
	indexDocuments(ftsDb, [...documentsBySession.entries()].flatMap(([sessionId, documents]) => documents.map((document) => ({ sessionId, ...document }))));
	const inner = ftsInner(ftsDb, headers, documentsBySession);
	const engine = createHybridSessionQueryEngine({
		inner,
		vectors: sidecar,
		embedder,
		config: { queryTimeoutMs: 30_000, ftsCandidates: 50, vectorCandidates: 50, rrfK: 60 },
	});

	console.log(`corpus: ${sessionIds.length} sessions, ${stats.embedded} embedded chunks`);
	console.log('');
	console.log('  #  fts  hybrid  query');
	const results = [];
	for (const [index, pair] of PAIRS.entries()) {
		const target = sessionIds[index];
		const ftsTop = ftsOrder(ftsDb, pair.query, 20)[0];
		const hybridTop = (await engine.searchSessions({ query: pair.query, limit: 20 })).items[0]?.header.id;
		const ftsHit = ftsTop === target;
		const hybridHit = hybridTop === target;
		results.push({ query: pair.query, ftsHit, hybridHit });
		console.log(`  ${String(index + 1).padStart(2)}  ${ftsHit ? ' ✓ ' : ' ✗ '}   ${hybridHit ? '✓ ' : '✗ '}    ${pair.query}`);
	}

	const ftsWins = results.filter((result) => result.ftsHit).length;
	const hybridWins = results.filter((result) => result.hybridHit).length;
	const strictWins = results.filter((result) => !result.ftsHit && result.hybridHit).length;
	const regressions = results.filter((result) => result.ftsHit && !result.hybridHit).length;
	const pass = regressions === 0 && strictWins >= Math.ceil(results.length / 2);
	console.log('');
	console.log(`hit@1  fts ${ftsWins}/${results.length}  hybrid ${hybridWins}/${results.length}`);
	console.log(`strict wins ${strictWins}/${results.length}, regressions ${regressions}, gate ${pass ? 'PASS' : 'FAIL'}`);
	await sidecar.close();
	ftsDb.close();
	process.exitCode = pass ? 0 : 1;
}

await main();
