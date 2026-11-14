/**
 * Semantic session search — the Host half.
 *
 * Replaces `ctx.sessionQuery` with a hybrid engine: the native SQLite
 * full-text backend keeps owning every exact read, trace, and filter, while a
 * dense-vector sidecar adds paraphrase recall that full-text cannot see. The
 * two candidate lists are fused by reciprocal rank, and any failure in the
 * vector path (endpoint down, empty index, slow embedding, foreign database)
 * silently degrades the search to the native full-text result.
 *
 * Mount it by replacing the host `session-query-sqlite` row: disable that row
 * by id and insert this package. The SQLite engine is still constructed here,
 * on an isolated `sessionQuery` realm, so the native backend remains the inner
 * engine rather than a second provider.
 *
 * @module @local/dsh-session-semantic-search
 */

import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import SessionQueryEngine from '@deepseek-ai/dsh-session-query';
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite';
import { EmbeddingClient, defaultEndpointUrl } from './lib/embed-client.js';
import { createHybridSessionQueryEngine } from './lib/hybrid-engine.js';
import { SessionVectorSidecar, resolveDshHome } from './lib/sidecar.js';

/** Cordis plugin name. */
export const name = 'dsh-session-semantic-search';

/** Discoverable plugin configuration. */
export const Config = z.object({
	/** Dedicated native SQLite full-text index path. */
	ftsPath: z.string().description('Path of the inner SQLite full-text index.'),
	/** When the inner SQLite module opens: startup, first search, or never. */
	ftsOpenAt: z.union(['startup', 'first-search', 'never']).default('startup'),
	/** Absolute embeddings endpoint URL; defaults to `$DSH_EMBED_ENDPOINT` or a local server. */
	endpointUrl: z.string().default(defaultEndpointUrl()),
	/** Embedding model name. */
	model: z.string().default('nomic-embed-text-v1.5'),
	/** Embedding dimension that the sidecar stores. */
	dim: z.number().step(1).min(1).default(768),
	/** Native full-text candidates fetched before fusion. */
	ftsCandidates: z.number().step(1).min(1).default(50),
	/** Vector candidate sessions kept before fusion. */
	vectorCandidates: z.number().step(1).min(1).default(50),
	/** Reciprocal-rank-fusion smoothing constant. */
	rrfK: z.number().step(1).min(1).default(60),
	/** Background ingest/embed poll interval in seconds. */
	pollSeconds: z.number().step(1).min(1).default(120),
	/** Query-embedding budget in milliseconds; expiry falls back to full text. */
	queryTimeoutMs: z.number().step(1).min(1).default(1500),
	/** Document-embedding request timeout in milliseconds. */
	embedTimeoutMs: z.number().step(1).min(1).default(30_000),
	/** Inputs per document-embedding request, at most 16. */
	embedBatchSize: z.number().step(1).min(1).max(16).default(16),
	/** Attempts per document-embedding call before the batch is left pending. */
	embedMaxAttempts: z.number().step(1).min(1).default(3),
	/** First retry delay before doubling, in milliseconds. */
	retryBaseMs: z.number().step(1).min(0).default(30_000),
	/** Retry delay cap, in milliseconds. */
	retryMaxMs: z.number().step(1).min(0).default(300_000),
	/** Run the background ingest/embed loop; when off, an existing index is still searched read-only. */
	indexer: z.boolean().default(true),
	/** DSH home override; defaults to `$DSH_HOME` or `~/.dsh`. */
	dshHome: z.string(),
	/** Sidecar database path override. */
	dbPath: z.string(),
	/** Single-writer lock path override. */
	lockPath: z.string(),
});

/**
 * Apply defaults and derive the paths the plugin owns.
 * @param {object} [config] - raw or already-defaulted plugin configuration.
 * @returns {object} resolved configuration.
 */
export function resolveConfig(config = {}) {
	const dshHome = config.dshHome ?? resolveDshHome();
	return {
		dshHome,
		ftsPath: config.ftsPath ?? join(dshHome, 'embeddings', 'session-query.sqlite'),
		ftsOpenAt: config.ftsOpenAt ?? 'startup',
		endpointUrl: config.endpointUrl ?? defaultEndpointUrl(),
		model: config.model ?? 'nomic-embed-text-v1.5',
		dim: config.dim ?? 768,
		ftsCandidates: config.ftsCandidates ?? 50,
		vectorCandidates: config.vectorCandidates ?? 50,
		rrfK: config.rrfK ?? 60,
		pollSeconds: config.pollSeconds ?? 120,
		queryTimeoutMs: config.queryTimeoutMs ?? 1500,
		embedTimeoutMs: config.embedTimeoutMs ?? 30_000,
		embedBatchSize: config.embedBatchSize ?? 16,
		embedMaxAttempts: config.embedMaxAttempts ?? 3,
		retryBaseMs: config.retryBaseMs ?? 30_000,
		retryMaxMs: config.retryMaxMs ?? 300_000,
		indexer: config.indexer ?? true,
		dbPath: config.dbPath ?? join(dshHome, 'embeddings', 'session-vectors.sqlite'),
		lockPath: config.lockPath ?? join(dshHome, 'embeddings', 'session-vectors.lock'),
	};
}

/**
 * The hybrid `ctx.sessionQuery` service.
 */
export default class SemanticSessionQueryEngine extends SessionQueryEngine {
	/** The inherited corpus reader needs the session service. */
	static inject = ['sessions'];

	/** Validated configuration schema. */
	static Config = Config;

	/**
	 * Construct the inner native engine, the vector sidecar, and the facade.
	 * @param {object} ctx - Cordis context owning the plugin fiber.
	 * @param {object} [config] - plugin configuration.
	 */
	constructor(ctx, config) {
		super(ctx, config ?? {});
		const resolved = resolveConfig(config ?? {});
		this.config = resolved;
		const logger = typeof ctx.logger === 'function' ? ctx.logger('session-semantic-search') : ctx.logger;
		const innerCtx = ctx.isolate('sessionQuery', Symbol('dsh-session-semantic-search/inner'));
		this._inner = new SqliteSessionQueryEngine(innerCtx, {
			path: resolved.ftsPath,
			openAt: resolved.ftsOpenAt,
			journalMode: 'wal',
		});
		const embedder = new EmbeddingClient({
			endpointUrl: resolved.endpointUrl,
			model: resolved.model,
			dim: resolved.dim,
			timeoutMs: resolved.embedTimeoutMs,
			maxAttempts: resolved.embedMaxAttempts,
			retryBaseMs: resolved.retryBaseMs,
			retryMaxMs: resolved.retryMaxMs,
			logger,
		});
		this._sidecar = new SessionVectorSidecar({
			dshHome: resolved.dshHome,
			dbPath: resolved.dbPath,
			lockPath: resolved.lockPath,
			model: resolved.model,
			dim: resolved.dim,
			batchSize: resolved.embedBatchSize,
			pollSeconds: resolved.pollSeconds,
			embedder,
			logger,
		});
		this._embedder = embedder;
		this._hybrid = createHybridSessionQueryEngine({
			inner: this._inner,
			vectors: this._sidecar,
			embedder,
			config: resolved,
			logger,
		});
		ctx.effect(
			() => async () => {
				await this._sidecar.close();
				await this._hybrid.close();
			},
			'dsh-session-semantic-search/dispose',
		);
	}

	/**
	 * Start the background indexer without delaying or failing activation.
	 * @returns {Promise<void>} resolves once the loop is scheduled.
	 */
	async [SessionQueryEngine.init]() {
		if (!this.config.indexer) return;
		try {
			await this._sidecar.start();
		} catch {
			// The sidecar is optional: search degrades to native full text.
		}
	}

	/** @inheritdoc */
	observeSession(sessionId, options) {
		return this._hybrid.observeSession(sessionId, options);
	}

	/** @inheritdoc */
	searchSessions(request, exec) {
		return this._hybrid.searchSessions(request, exec);
	}

	/** @inheritdoc */
	searchEvents(request, exec) {
		return this._hybrid.searchEvents(request, exec);
	}

	/** @inheritdoc */
	listSessions(signal) {
		return this._hybrid.listSessions(signal);
	}

	/** @inheritdoc */
	readSession(sessionId) {
		return this._hybrid.readSession(sessionId);
	}

	/** @inheritdoc */
	filterSessions(filters, signal) {
		return this._hybrid.filterSessions(filters, signal);
	}

	/** @inheritdoc */
	readTitle(sessionId, signal) {
		return this._hybrid.readTitle(sessionId, signal);
	}

	/** @inheritdoc */
	readTitleSnapshot(sessionId, signal) {
		return this._hybrid.readTitleSnapshot(sessionId, signal);
	}

	/** @inheritdoc */
	readTitleSnapshots(sessionIds, signal) {
		return this._hybrid.readTitleSnapshots(sessionIds, signal);
	}

	/** @inheritdoc */
	listEvents(sessionId) {
		return this._hybrid.listEvents(sessionId);
	}

	/** @inheritdoc */
	filterEvents(sessionId, filters) {
		return this._hybrid.filterEvents(sessionId, filters);
	}

	/** @inheritdoc */
	readSurface(sessionId) {
		return this._hybrid.readSurface(sessionId);
	}

	/** @inheritdoc */
	traceSession(sessionId, signal) {
		return this._hybrid.traceSession(sessionId, signal);
	}

	/** @inheritdoc */
	traceEvent(request, signal) {
		return this._hybrid.traceEvent(request, signal);
	}

	/** @inheritdoc */
	readEvent(request, signal) {
		return this._hybrid.readEvent(request, signal);
	}

	/** Stop the indexer, close the vector index, then close the inner index once its operations settle. */
	async close() {
		await this._sidecar.close();
		return this._hybrid.close();
	}
}
