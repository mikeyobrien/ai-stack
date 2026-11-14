/**
 * Dense-vector sidecar for hybrid session search.
 *
 * One SQLite file under `$DSH_HOME/embeddings` holds the semantic corpus: one
 * row per searchable message event chunk plus its embedding. Ingest scans the
 * persisted session logs, builds the same semantic documents the native FTS
 * index uses, chunks long messages at whitespace, and embeds only chunks that
 * have no vector yet.
 *
 * Ingest is a full per-pass reconciliation, not an append: it diffs every
 * stored log against its recorded per-event content hashes, deletes stale
 * chunks, prunes sessions and source files that vanished from the corpus, and
 * records a file only after its write succeeded — a failed pass simply repeats
 * the work later, so the index always converges to what is on disk.
 *
 * Node's builtin `node:sqlite` is the only database dependency. Embedding
 * failure never throws into the host: an outage stops the pass and leaves the
 * chunks pending for the next poll, and a chunk the endpoint refuses is
 * isolated and skipped so it cannot block the rest. Only the process holding
 * the writer lock writes; others open the same file to search it.
 *
 * @module @local/dsh-session-semantic-search/sidecar
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { zstdDecompressSync } from 'node:zlib';
import { buildSessionEventSearchDocuments } from '@deepseek-ai/dsh-session-query';
import { DOCUMENT_PREFIX } from './embed-client.js';
import { cosineSimilarity } from './fusion.js';

/** Sidecar schema version; a mismatch resets the derived state in place. */
export const SIDECAR_SCHEMA_VERSION = 1;

/** Maximum characters in one chunk before splitting at whitespace. */
export const CHUNK_CHARS = 1200;

/** Default relative path of the vector database under the DSH home. */
export const SIDECAR_RELATIVE_PATH = join('embeddings', 'session-vectors.sqlite');

/** Default relative path of the single-writer lock under the DSH home. */
export const LOCK_RELATIVE_PATH = join('embeddings', 'session-vectors.lock');

/** Message event types whose text is indexed as a vector document. */
export const MESSAGE_TYPES = new Set(['user/message', 'assistant/message']);

/** How long a chunk the endpoint refused waits before it is offered again. */
export const FAILED_CHUNK_RETRY_MS = 24 * 60 * 60 * 1000;

/** Short input used to tell a refused chunk from an endpoint that refuses everything. */
const ENDPOINT_PROBE_TEXT = 'ping';

/** Chunk columns added after the first v1 release, created in place on open. */
const ADDED_CHUNK_COLUMNS = [
	['embed_failed_at', 'INTEGER'],
	['embed_error', 'TEXT'],
];

/**
 * Resolve the DSH home directory the host uses.
 * @param {Record<string, string | undefined>} [env] - environment to inspect.
 * @returns {string} absolute DSH home.
 */
export function resolveDshHome(env = process.env) {
	const configured = env.DSH_HOME?.trim();
	return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured;
}

/**
 * Split one message text into chunks no longer than `maxChars` code points,
 * breaking at whitespace and hard-splitting a single oversized token.
 * @param {string} text - text to split.
 * @param {number} [maxChars] - chunk bound in code points.
 * @returns {string[]} chunks in order; empty when the text has no content.
 */
export function chunkText(text, maxChars = CHUNK_CHARS) {
	const points = Array.from(text);
	const chunks = [];
	let start = 0;
	while (points.length - start > maxChars) {
		// Break at the last space inside the bound; a space at the very start, or
		// none at all, hard-splits the oversized token at the bound.
		let cut = maxChars - 1;
		while (cut > 0 && points[start + cut] !== ' ') cut -= 1;
		if (cut <= 0) cut = maxChars;
		chunks.push(points.slice(start, start + cut).join(''));
		start += cut;
		// Drop the delimiter (the space) so it never re-enters a chunk.
		if (points[start] === ' ') start += 1;
	}
	if (start < points.length) chunks.push(points.slice(start).join(''));
	return chunks;
}

/**
 * Parse one persisted session log into its header and event stream.
 * @param {Buffer | string} buffer - raw log bytes.
 * @param {string} file - log path, used to detect the compressed form.
 * @returns {{ header: object | undefined, events: object[], complete: boolean }} parsed log.
 */
export function parseSessionFile(buffer, file) {
	const raw = file.endsWith('.zstd') ? zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8');
	const complete = raw.endsWith('\n');
	const lines = raw.split('\n');
	if (!complete) lines.pop();
	let header;
	const events = [];
	for (const line of lines) {
		if (line.trim() === '') continue;
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (value?.type === 'session') {
			header ??= value;
			continue;
		}
		if (typeof value?.type === 'string' && typeof value?.seq === 'number') events.push(value);
	}
	events.sort((left, right) => left.seq - right.seq);
	return { header, events, complete };
}

/**
 * Discover persisted session logs under the sessions root.
 * @param {string} root - `$DSH_HOME/sessions`.
 * @returns {Promise<string[]>} absolute file paths, sorted for determinism.
 */
export async function discoverSessionFiles(root) {
	const found = [];
	const walk = async (directory) => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			if (/\.jsonl(?:\.zstd)?$/u.test(entry.name)) found.push(path);
		}
	};
	await walk(root);
	found.sort();
	return found;
}

/**
 * Whether a process id currently exists.
 * @param {number} pid - candidate process id.
 * @returns {boolean} true when the process exists and is signalable.
 */
function processExists(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === 'EPERM';
	}
}

/**
 * Create any missing sidecar tables and columns, and seed `meta` for a new
 * database. Never discards stored state.
 * @param {DatabaseSync} db - read-write handle.
 * @param {string} model - configured embedding model.
 * @param {number} dim - configured embedding dimension.
 */
function createSchema(db, model, dim) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      model          TEXT NOT NULL,
      dim            INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      session_id       TEXT PRIMARY KEY,
      version          INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      cwd              TEXT,
      parent_session   TEXT,
      is_seeded        INTEGER NOT NULL DEFAULT 0,
      delegation_depth INTEGER,
      agent_preset     TEXT,
      ingested_at      INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS chunks (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL,
      chunk_index     INTEGER NOT NULL,
      text            TEXT NOT NULL,
      text_hash       TEXT NOT NULL DEFAULT '',
      vec             BLOB,
      embedded_at     INTEGER,
      type            TEXT NOT NULL,
      time            INTEGER NOT NULL,
      surface         TEXT NOT NULL,
      embed_failed_at INTEGER,
      embed_error     TEXT,
      UNIQUE (session_id, seq, chunk_index)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS files (
      source_path  TEXT PRIMARY KEY,
      session_id   TEXT,
      size         INTEGER NOT NULL,
      mtime        INTEGER NOT NULL,
      offset       INTEGER NOT NULL,
      event_hashes TEXT NOT NULL DEFAULT ''
    ) STRICT;
  `);
	const present = new Set(db.prepare('PRAGMA table_info(chunks)').all().map((column) => column.name));
	for (const [column, type] of ADDED_CHUNK_COLUMNS) {
		if (present.has(column)) continue;
		try {
			db.exec(`ALTER TABLE chunks ADD COLUMN ${column} ${type}`);
		} catch (error) {
			// A concurrent opener added it first.
			if (!/duplicate column/iu.test(error instanceof Error ? error.message : '')) throw error;
		}
	}
	db.prepare('INSERT OR IGNORE INTO meta (id, schema_version, model, dim) VALUES (1, ?, ?, ?)').run(SIDECAR_SCHEMA_VERSION, model, dim);
}

/**
 * Discard every derived row and stamp `meta` with the current configuration.
 * Only the lock-holding writer calls this.
 * @param {DatabaseSync} db - read-write handle.
 * @param {string} model - configured embedding model.
 * @param {number} dim - configured embedding dimension.
 */
function resetState(db, model, dim) {
	db.exec('BEGIN');
	try {
		db.exec('DELETE FROM chunks');
		db.exec('DELETE FROM files');
		db.exec('DELETE FROM sessions');
		db.prepare('UPDATE meta SET schema_version = ?, model = ?, dim = ? WHERE id = 1').run(SIDECAR_SCHEMA_VERSION, model, dim);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

/**
 * Backfill per-chunk text hashes for v1 databases created before they existed.
 * @param {DatabaseSync} db - read-write handle.
 */
function backfillTextHashes(db) {
	try {
		const missing = db.prepare("SELECT COUNT(*) AS total FROM chunks WHERE text_hash = ''").get().total;
		if (missing === 0) return;
		const hashText = (text) => createHash('sha256').update(text, 'utf8').digest('base64url');
		const rows = db.prepare("SELECT id, text FROM chunks WHERE text_hash = ''").all();
		const update = db.prepare('UPDATE chunks SET text_hash = ? WHERE id = ?');
		db.exec('BEGIN');
		for (const row of rows) update.run(hashText(row.text), row.id);
		db.exec('COMMIT');
	} catch {
		try {
			db.exec('ROLLBACK');
		} catch {
			// The database state is already unusable; the next open recreates it.
		}
	}
}

/**
 * Whether an embedding failure is the endpoint refusing this input, as
 * opposed to an outage worth retrying later.
 * @param {unknown} error - embedding failure.
 * @returns {boolean} true for a non-retryable rejection (4xx, malformed or mismatched response).
 */
function isRefusal(error) {
	return error instanceof Error && error.retryable === false;
}

/**
 * Message text of any thrown value.
 * @param {unknown} error - thrown value.
 * @returns {string} message.
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Compile one SQL predicate set from materialized session and event filters.
 *
 * The sidecar only knows persisted sessions, so `availability` matches when
 * the clause admits persisted sessions and rejects the clause otherwise. Any
 * clause kind it cannot express compiles to no match.
 *
 * @param {readonly object[]} sessionFilters - materialized logical-session clauses.
 * @param {readonly object[]} eventFilters - materialized event metadata clauses.
 * @returns {{ sql: string, params: unknown[] }} predicate fragment and bindings.
 */
export function buildFilterSql(sessionFilters, eventFilters) {
	const clauses = [];
	const params = [];
	for (const filter of sessionFilters) {
		switch (filter.kind) {
			case 'id':
				clauses.push(`c.session_id IN (${placeholders(params, filter.values)})`);
				break;
			case 'cwd':
				clauses.push(nullableListSql('s.cwd', params, filter.values));
				break;
			case 'created-at':
				rangeSql('s.created_at', params, clauses, filter);
				break;
			case 'parent':
				clauses.push(nullableListSql('s.parent_session', params, filter.values));
				break;
			case 'availability': {
				const persisted = filter.values.includes('persisted');
				const live = filter.values.includes('live');
				if (!persisted && !live) clauses.push('0');
				else if (!persisted) clauses.push('0');
				break;
			}
			default:
				clauses.push('0');
		}
	}
	for (const filter of eventFilters) {
		switch (filter.kind) {
			case 'type':
				clauses.push(`c.type IN (${placeholders(params, filter.values)})`);
				break;
			case 'surface':
				clauses.push(`c.surface IN (${placeholders(params, filter.values)})`);
				break;
			case 'seq':
				rangeSql('c.seq', params, clauses, filter);
				break;
			case 'time':
				rangeSql('c.time', params, clauses, filter);
				break;
			default:
				// A clause the sidecar cannot express matches nothing here, so a
				// vector-only hit can never violate the caller's filter.
				clauses.push('0');
		}
	}
	return { sql: clauses.length === 0 ? '' : ` AND ${clauses.join(' AND ')}`, params };
}

/**
 * Build `IN (?, ?, ...)` placeholder text and append the values.
 * @param {unknown[]} params - parameter list.
 * @param {readonly unknown[]} values - clause values.
 * @returns {string} placeholder list.
 */
function placeholders(params, values) {
	const marks = values.map(() => '?').join(', ');
	params.push(...values);
	return marks;
}

/**
 * Build an `IS NULL`-aware equality list for a nullable column.
 * @param {string} column - column to compare.
 * @param {unknown[]} params - parameter list.
 * @param {readonly unknown[]} values - clause values.
 * @returns {string} predicate.
 */
function nullableListSql(column, params, values) {
	const nonNull = values.filter((value) => value !== null);
	const parts = [];
	if (values.includes(null)) parts.push(`${column} IS NULL`);
	if (nonNull.length > 0) parts.push(`${column} IN (${placeholders(params, nonNull)})`);
	return parts.length === 0 ? '0' : `(${parts.join(' OR ')})`;
}

/**
 * Append one bounded range clause.
 * @param {string} column - column to compare.
 * @param {unknown[]} params - parameter list.
 * @param {string[]} clauses - clause sink.
 * @param {{ from?: number, to?: number }} filter - bounds.
 */
function rangeSql(column, params, clauses, { from, to } = {}) {
	if (from === undefined && to === undefined) return;
	const parts = [];
	if (from !== undefined) parts.push(`${column} >= ?`);
	if (to !== undefined) parts.push(`${column} <= ?`);
	const values = [];
	if (from !== undefined) values.push(from);
	if (to !== undefined) values.push(to);
	params.push(...values);
	clauses.push(`(${parts.join(' AND ')})`);
}

/** How long an empty or unparseable lock file is left alone before it is reclaimed. */
export const LOCK_GRACE_MS = 10_000;

/**
 * Single-writer lock: one `{ pid, startedAt }` file.
 *
 * A lock whose pid no longer exists, or one left empty or unparseable for
 * longer than the grace period (a crash between create and write), is
 * reclaimed. A live holder is never displaced. The holder re-checks the file
 * on every pass, so a process that lost a reclaim race steps down.
 */
class WriterLock {
	/**
	 * @param {string} path - lock file path.
	 * @param {{ graceMs?: number }} [options] - empty-lock grace period.
	 */
	constructor(path, options = {}) {
		this.path = path;
		this._graceMs = options.graceMs ?? LOCK_GRACE_MS;
		/** @type {string | undefined} exact file content this process wrote */
		this._held = undefined;
	}

	/**
	 * Take the lock when free or stale, or confirm this process still holds it.
	 * @returns {boolean} whether this process now holds the lock.
	 */
	acquire() {
		if (this._held !== undefined) {
			if (this._readRaw() === this._held) return true;
			// Deleted or replaced under us: compete for it again like anyone else.
			this._held = undefined;
		}
		const existing = this._inspect();
		if (existing.state === 'live') return false;
		if (existing.state === 'stale' && !this._reclaim(existing.raw)) return false;
		return this._create();
	}

	/** Release the lock if this process still holds it. */
	release() {
		const held = this._held;
		this._held = undefined;
		if (held === undefined) return;
		try {
			if (readFileSync(this.path, 'utf8') === held) unlinkSync(this.path);
		} catch {
			// Already gone, or never readable: nothing of ours to remove.
		}
	}

	/**
	 * Read the lock file's raw content.
	 * @returns {string | undefined} content, or undefined when unreadable.
	 */
	_readRaw() {
		try {
			return readFileSync(this.path, 'utf8');
		} catch {
			return undefined;
		}
	}

	/**
	 * Classify the current lock file.
	 * @returns {{ state: 'absent' | 'live' | 'stale', raw?: string }} holder state; `raw` is what a reclaim must still find.
	 */
	_inspect() {
		let raw;
		try {
			raw = readFileSync(this.path, 'utf8');
		} catch (error) {
			// An unreadable lock is someone else's: never steal it.
			return { state: error?.code === 'ENOENT' ? 'absent' : 'live' };
		}
		let record;
		try {
			record = JSON.parse(raw);
		} catch {
			record = undefined;
		}
		if (Number.isSafeInteger(record?.pid) && record.pid > 0) {
			return processExists(record.pid) ? { state: 'live' } : { state: 'stale', raw };
		}
		let ageMs;
		try {
			ageMs = Date.now() - statSync(this.path).mtimeMs;
		} catch {
			return { state: 'absent' };
		}
		return ageMs >= this._graceMs ? { state: 'stale', raw } : { state: 'live' };
	}

	/**
	 * Remove a stale lock only if it still holds exactly what was judged stale.
	 * @param {string} raw - content observed by {@link WriterLock#_inspect}.
	 * @returns {boolean} whether the path is now free.
	 */
	_reclaim(raw) {
		try {
			if (readFileSync(this.path, 'utf8') !== raw) return false;
			unlinkSync(this.path);
			return true;
		} catch (error) {
			return error?.code === 'ENOENT';
		}
	}

	/**
	 * Create the lock file exclusively and record this process as holder.
	 * @returns {boolean} whether the file was created and written.
	 */
	_create() {
		const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
		let handle;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			handle = openSync(this.path, 'wx', 0o600);
		} catch {
			return false;
		}
		try {
			writeSync(handle, content);
		} catch {
			closeSync(handle);
			try {
				unlinkSync(this.path);
			} catch {
				// A leftover empty lock is reclaimed after the grace period.
			}
			return false;
		}
		closeSync(handle);
		this._held = content;
		return true;
	}
}

/**
 * The sidecar: one vector corpus over the persisted session logs.
 */
export class SessionVectorSidecar {
	/**
	 * @param {object} options - configuration.
	 * @param {string} [options.dshHome] - DSH home.
	 * @param {string} [options.dbPath] - vector database path.
	 * @param {string} [options.lockPath] - writer lock path.
	 * @param {string} [options.model] - embedding model name.
	 * @param {number} [options.dim] - embedding dimension.
	 * @param {number} [options.chunkChars] - chunk bound.
	 * @param {number} [options.batchSize] - inputs per embedding request, at most 16.
	 * @param {{ embed: Function }} options.embedder - embedding client.
	 * @param {{ warn?: Function, debug?: Function }} [options.logger] - optional logger.
	 * @param {{ [key: string]: any }} [options.corpus] - live-preferred session records used to validate vector hits.
	 */
	constructor(options) {
		const dshHome = options.dshHome ?? resolveDshHome();
		this.dshHome = dshHome;
		this.dbPath = options.dbPath ?? join(dshHome, SIDECAR_RELATIVE_PATH);
		this.lockPath = options.lockPath ?? join(dshHome, LOCK_RELATIVE_PATH);
		this.sessionsRoot = join(dshHome, 'sessions');
		this.model = options.model ?? 'nomic-embed-text-v1.5';
		this.dim = options.dim ?? 768;
		this.chunkChars = options.chunkChars ?? CHUNK_CHARS;
		this.batchSize = Math.max(1, Math.min(options.batchSize ?? 16, 16));
		this.pollMs = Math.max(1, options.pollSeconds ?? 120) * 1000;
		this._embedder = options.embedder;
		this._logger = options.logger;
		this._corpus = options.corpus;
		this._db = undefined;
		this._readOnly = false;
		this._compatible = false;
		this._metaVersion = undefined;
		this._generation = undefined;
		this._lock = new WriterLock(this.lockPath);
		this._writer = undefined;
		this._lockWarned = false;
		this._reportedErrors = new Set();
		this._loop = undefined;
		this._stopped = false;
		this._controller = new AbortController();
		this._discarded = false;
	}

	/**
	 * Open the database read-write and create any missing schema. Stored state
	 * from a different model or dimension is kept until this process holds the
	 * writer lock; until then it is not searched.
	 * @returns {this} this sidecar.
	 */
	open() {
		if (this._db !== undefined && !this._readOnly) return this;
		this._closeHandle();
		mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(this.dbPath);
		try {
			db.exec('PRAGMA busy_timeout = 5000');
			db.exec('PRAGMA foreign_keys = ON');
			db.exec('PRAGMA journal_mode = WAL');
			createSchema(db, this.model, this.dim);
		} catch (error) {
			db.close();
			throw error;
		}
		this._db = db;
		this._readOnly = false;
		this._loadMeta();
		if (this._compatible) backfillTextHashes(db);
		return this;
	}

	/**
	 * Open an existing database read-only for search, without creating or
	 * changing anything. Used when this process does not run the indexer.
	 * @returns {boolean} whether a handle is now open.
	 */
	_openReadOnly() {
		if (!existsSync(this.dbPath)) return false;
		let db;
		try {
			db = new DatabaseSync(this.dbPath, { readOnly: true });
			db.exec('PRAGMA busy_timeout = 5000');
			this._db = db;
			this._readOnly = true;
			this._loadMeta();
			return true;
		} catch {
			try {
				db?.close();
			} catch {
				// Nothing usable was opened.
			}
			this._db = undefined;
			this._readOnly = false;
			return false;
		}
	}

	/** Close the current handle, if any, and forget per-handle caches. */
	_closeHandle() {
		if (this._db !== undefined) {
			try {
				this._db.close();
			} catch {
				// A failed close leaves no usable handle and requires no retry.
			}
		}
		this._db = undefined;
		this._readOnly = false;
		this._metaVersion = undefined;
		this._generation = undefined;
	}

	/**
	 * Commit counter of other connections: changes when another process writes.
	 * @returns {number} SQLite `data_version`.
	 */
	_dataVersion() {
		return this._db.prepare('PRAGMA data_version').get().data_version;
	}

	/** Re-read `meta` and record whether it matches this configuration. */
	_loadMeta() {
		const state = this._db.prepare('SELECT schema_version, model, dim FROM meta WHERE id = 1').get();
		this._compatible = state !== undefined && state.schema_version === SIDECAR_SCHEMA_VERSION && state.model === this.model && state.dim === this.dim;
		this._metaVersion = this._dataVersion();
	}

	/** Re-read `meta` only when another connection committed since the last read. */
	_refreshMeta() {
		if (this._dataVersion() !== this._metaVersion) this._loadMeta();
	}

	/** Whether the sidecar holds an open database handle. */
	get ready() {
		return this._db !== undefined;
	}

	/** Whether this process currently owns the writer lock. */
	get writable() {
		return this._writer === true;
	}

	/**
	 * Take, or confirm, the single-writer lock. Never throws.
	 *
	 * A failed attempt is not cached: a peer may close at any time, and the next
	 * poll should be able to take over. A holder whose lock file was replaced
	 * steps down. Taking the lock is the only point where state stored for a
	 * different model or dimension is discarded.
	 * @returns {boolean} whether this process is the writer.
	 */
	ensureWriter() {
		if (this._lock.acquire()) {
			if (this._writer === true) return true;
			try {
				this._claimWriter();
			} catch (error) {
				this._lock.release();
				this._log('warn', `vector index writer setup failed: ${messageOf(error)}`);
				return false;
			}
			this._writer = true;
			this._lockWarned = false;
			return true;
		}
		if (this._writer === true) {
			this._writer = false;
			this._log('warn', 'the vector index writer lock was taken over; serving read-only candidates');
		} else if (this._lockWarned !== true) {
			this._lockWarned = true;
			this._log('debug', 'another process owns the vector index; serving read-only candidates');
		}
		return false;
	}

	/** Reset state stored for a different model or dimension, as the writer. */
	_claimWriter() {
		this.open();
		this._loadMeta();
		if (this._compatible) return;
		resetState(this._db, this.model, this.dim);
		this._discarded = true;
		this._compatible = true;
	}

	/**
	 * Log through an optional Cordis logger without ever throwing.
	 * @param {'debug' | 'warn'} level - log level.
	 * @param {string} message - message text.
	 */
	_log(level, message) {
		try {
			const sink = this._logger?.[level] ?? this._logger?.info;
			sink?.call(this._logger, message);
		} catch {
			// Logging must never disturb ingest or search.
		}
	}

	/**
	 * Reconcile one parsed session log against the stored chunks: a full
	 * per-session delete + rewrite, which is correct for every change shape
	 * (append, rewrite, shorten, shadow op) and cheap at log size. Only new
	 * or changed chunks come back unembedded.
	 *
	 * @param {{ header: object, events: object[] }} parsed - parsed log.
	 * @returns {{ sessionId: string | undefined, chunks: number, newChunks: number }} written identity, chunk count, and count needing a vector.
	 */
	_writeSession(parsed) {
		const db = this._db;
		const sessionId = parsed.header?.id;
		if (typeof sessionId !== 'string') return { sessionId: undefined, chunks: 0, newChunks: 0 };
		const documents = buildSessionEventSearchDocuments(sessionId, parsed.events).filter(
			(document) => MESSAGE_TYPES.has(document.type) && document.surface === 'current' && document.text.trim() !== '',
		);
		const hashText = (text) => createHash('sha256').update(text, 'utf8').digest('base64url');
		const now = Date.now();
		const header = parsed.header;
		const seen = new Map();
		for (const document of documents) {
			const pieces = chunkText(document.text, this.chunkChars);
			pieces.forEach((text, chunkIndex) => {
				seen.set(`${document.seq}:${chunkIndex}`, {
					seq: document.seq,
					chunkIndex,
					text,
					textHash: hashText(text),
					type: document.type,
					time: document.time,
					surface: document.surface,
				});
			});
		}
		const existing = new Map(
			db.prepare('SELECT seq, chunk_index, text, text_hash, vec FROM chunks WHERE session_id = ?').all(sessionId).map((row) => [
				`${row.seq}:${row.chunk_index}`,
				row,
			]),
		);
		const unchanged = new Set();
		for (const [key, value] of seen) {
			const row = existing.get(key);
			if (row !== undefined && row.text_hash === value.textHash && row.text === value.text) unchanged.add(key);
		}
		db.exec('BEGIN');
		try {
			db.prepare(`
        INSERT INTO sessions (session_id, version, created_at, cwd, parent_session, is_seeded, delegation_depth, agent_preset, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET
          version = excluded.version,
          created_at = excluded.created_at,
          cwd = excluded.cwd,
          parent_session = excluded.parent_session,
          is_seeded = excluded.is_seeded,
          delegation_depth = excluded.delegation_depth,
          agent_preset = excluded.agent_preset,
          ingested_at = excluded.ingested_at
      `).run(
				sessionId,
				Number.isSafeInteger(header.version) ? header.version : 0,
				Number.isSafeInteger(header.createdAt) ? header.createdAt : 0,
				typeof header.cwd === 'string' ? header.cwd : null,
				typeof header.parentSession === 'string' ? header.parentSession : null,
				header.isSeeded === true ? 1 : 0,
				Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : null,
				typeof header.agentPreset === 'string' ? header.agentPreset : null,
				now,
			);
			// Delete only the chunks that no longer exist in the current document set
			// (shortened logs, rewritten/shadow events). Chunks whose text is unchanged
			// are left in place so the upsert's CASE-WHEN can retain their stored vector
			// and embedded_at; a changed or new chunk comes back with NULL vec for re-embed.
			const obsoleteKeys = [...existing.keys()].filter((key) => !seen.has(key));
			if (obsoleteKeys.length > 0) {
				const seqs = obsoleteKeys.map((key) => Number(key.split(':')[0]));
				const chunkIndices = obsoleteKeys.map((key) => Number(key.split(':')[1]));
				const placeholders = seqs.map(() => '(?, ?)').join(', ');
				db.prepare(`
          DELETE FROM chunks
          WHERE session_id = ? AND (seq, chunk_index) IN (${placeholders})
        `).run([sessionId, ...seqs, ...chunkIndices]);
			}
			const upsertChunk = db.prepare(`
        INSERT INTO chunks (id, session_id, seq, role, chunk_index, text, text_hash, vec, embedded_at, type, time, surface)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
        ON CONFLICT (session_id, seq, chunk_index) DO UPDATE SET
          text = CASE
            WHEN chunks.text_hash = excluded.text_hash AND chunks.vec IS NOT NULL THEN chunks.text
            ELSE excluded.text
          END,
          text_hash = CASE
            WHEN chunks.text_hash = excluded.text_hash AND chunks.vec IS NOT NULL THEN chunks.text_hash
            ELSE excluded.text_hash
          END,
          vec = CASE
            WHEN chunks.text_hash = excluded.text_hash AND chunks.vec IS NOT NULL THEN chunks.vec
            ELSE NULL
          END,
          embedded_at = CASE
            WHEN chunks.text_hash = excluded.text_hash AND chunks.vec IS NOT NULL THEN chunks.embedded_at
            ELSE NULL
          END,
          embed_failed_at = CASE
            WHEN chunks.text_hash = excluded.text_hash THEN chunks.embed_failed_at
            ELSE NULL
          END,
          embed_error = CASE
            WHEN chunks.text_hash = excluded.text_hash THEN chunks.embed_error
            ELSE NULL
          END,
          role = excluded.role,
          type = excluded.type,
          time = excluded.time,
          surface = excluded.surface
      `);
			let chunks = 0;
			let newChunks = 0;
			for (const [key, value] of seen) {
				const [seq, chunkIndex] = key.split(':');
				upsertChunk.run(
					`${sessionId}:${seq}:${chunkIndex}`,
					sessionId,
					Number(seq),
					value.type === 'user/message' ? 'user' : 'assistant',
					Number(chunkIndex),
					value.text,
					value.textHash,
					value.type,
					value.time,
					value.surface,
				);
				chunks += 1;
				if (!unchanged.has(key)) newChunks += 1;
			}
			db.exec('COMMIT');
			return { sessionId, chunks, newChunks };
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	}

	/**
	 * Reconcile the whole corpus: every persisted log is diffed by per-event
	 * content hash, vanished sessions and files are pruned, and a file is only
	 * recorded after its write committed — a failed pass leaves no bookkeeping
	 * and the same work repeats on the next pass.
	 *
	 * @param {{ signal?: AbortSignal }} [options] - cancellation.
	 * @returns {Promise<{ files: number, changed: number, chunks: number, newChunks: number, removedSessions: number, errors: string[] }>} counters.
	 */
	async ingestOnce({ signal } = {}) {
		this.open();
		const stats = { files: 0, changed: 0, chunks: 0, newChunks: 0, removedSessions: 0, errors: [] };
		const files = await discoverSessionFiles(this.sessionsRoot);
		stats.files = files.length;
		const present = new Set();
		const fileState = this._db.prepare('SELECT session_id, size, mtime, event_hashes FROM files WHERE source_path = ?');
		const recordFile = this._db.prepare(`
      INSERT INTO files (source_path, session_id, size, mtime, offset, event_hashes) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_path) DO UPDATE SET
        session_id = excluded.session_id,
        size = excluded.size,
        mtime = excluded.mtime,
        offset = excluded.offset,
        event_hashes = excluded.event_hashes
    `);
		const deleteFile = this._db.prepare('DELETE FROM files WHERE source_path = ?');
		for (const file of files) {
			if (signal?.aborted) break;
			let info;
			try {
				info = await stat(file);
			} catch {
				continue;
			}
			const prior = fileState.get(file);
			const mtime = Math.trunc(info.mtimeMs);
			if (prior !== undefined && prior.size === info.size && prior.mtime === mtime) {
				present.add(prior.session_id);
				continue;
			}
			stats.changed += 1;
			let parsed;
			try {
				parsed = parseSessionFile(await readFile(file), file);
			} catch (error) {
				stats.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const sessionId = parsed.header?.id;
			if (typeof sessionId !== 'string') continue;
			present.add(sessionId);
			try {
				const written = this._writeSession(parsed);
				stats.chunks += written.chunks;
				stats.newChunks += written.newChunks;
				const eventHashes = written.sessionId === sessionId
					? this._db.prepare('SELECT seq, text_hash FROM chunks WHERE session_id = ? ORDER BY seq, chunk_index').all(sessionId).map((row) => `${row.seq}:${row.text_hash}`).join('\u0000')
					: '';
				recordFile.run(file, sessionId, info.size, mtime, info.size, eventHashes);
			} catch (error) {
				// No bookkeeping on failure: the file keeps its previous record, so the
				// next pass retries the identical work instead of marking it processed.
				stats.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const staleFiles = this._db.prepare('SELECT source_path FROM files').all();
		for (const row of staleFiles) {
			if (!files.includes(row.source_path)) {
				deleteFile.run(row.source_path);
				stats.removedSessions += 1;
			}
		}
		const staleSessions = this._db.prepare('SELECT session_id FROM sessions').all();
		for (const row of staleSessions) {
			if (!present.has(row.session_id)) {
				this._db.prepare('DELETE FROM sessions WHERE session_id = ?').run(row.session_id);
				stats.removedSessions += 1;
			}
		}
		return stats;
	}

	/**
	 * Read the next chunks that still need a vector. A chunk the endpoint
	 * refused is left out until {@link FAILED_CHUNK_RETRY_MS} has passed or its
	 * text changes.
	 * @param {number} limit - maximum rows.
	 * @returns {Array<{ id: string, text: string }>} pending chunks.
	 */
	pendingChunks(limit) {
		this.open();
		return this._db
			.prepare('SELECT id, text FROM chunks WHERE vec IS NULL AND (embed_failed_at IS NULL OR embed_failed_at <= ?) ORDER BY session_id, seq, chunk_index LIMIT ?')
			.all(Date.now() - FAILED_CHUNK_RETRY_MS, limit);
	}

	/**
	 * Persist one batch of embeddings.
	 * @param {Array<{ id: string }>} rows - chunk rows in embedding order.
	 * @param {Float32Array[]} vectors - one vector per row.
	 * @returns {number} rows updated.
	 */
	storeVectors(rows, vectors) {
		this.open();
		const update = this._db.prepare('UPDATE chunks SET vec = ?, embedded_at = ?, embed_failed_at = NULL, embed_error = NULL WHERE id = ?');
		const now = Date.now();
		this._db.exec('BEGIN');
		try {
			rows.forEach((row, index) => {
				const vector = vectors[index];
				update.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), now, row.id);
			});
			this._db.exec('COMMIT');
		} catch (error) {
			this._db.exec('ROLLBACK');
			throw error;
		}
		return rows.length;
	}

	/**
	 * Record that the endpoint refused one chunk, so later batches skip it.
	 * @param {string} id - chunk id.
	 * @param {unknown} error - the refusal.
	 */
	markFailed(id, error) {
		this.open();
		this._db
			.prepare('UPDATE chunks SET embed_failed_at = ?, embed_error = ? WHERE id = ? AND vec IS NULL')
			.run(Date.now(), messageOf(error).slice(0, 500), id);
	}

	/**
	 * Embed and store one batch. When the endpoint refuses the batch, the batch
	 * is split in half until each refused chunk stands alone; that chunk is
	 * marked failed and the rest are stored. Before anything is marked, a probe
	 * confirms the endpoint accepts some input, so a misconfigured endpoint
	 * never marks the corpus failed. An outage (429, 5xx, network) or an abort
	 * is rethrown and ends the pass.
	 * @param {Array<{ id: string, text: string }>} rows - pending chunks.
	 * @param {AbortSignal | undefined} signal - pass cancellation.
	 * @param {{ endpointOk: boolean }} pass - whether the endpoint accepted input this pass.
	 * @param {{ embedded: number, skippedChunks: number }} stats - pass counters.
	 * @returns {Promise<void>} resolves once every row is stored or marked.
	 */
	async _embedRows(rows, signal, pass, stats) {
		let vectors;
		try {
			vectors = await this._embedder.embed(
				rows.map((row) => row.text),
				{ prefix: DOCUMENT_PREFIX, signal },
			);
		} catch (error) {
			if (signal?.aborted || !isRefusal(error)) throw error;
			if (!pass.endpointOk) {
				await this._probeEndpoint(error, signal);
				pass.endpointOk = true;
			}
			if (rows.length === 1) {
				this.markFailed(rows[0].id, error);
				stats.skippedChunks += 1;
				this._log('warn', `chunk ${rows[0].id} skipped; the embedding endpoint refuses it: ${messageOf(error)}`);
				return;
			}
			const middle = Math.ceil(rows.length / 2);
			await this._embedRows(rows.slice(0, middle), signal, pass, stats);
			await this._embedRows(rows.slice(middle), signal, pass, stats);
			return;
		}
		this.storeVectors(rows, vectors);
		pass.endpointOk = true;
		stats.embedded += rows.length;
	}

	/**
	 * Confirm the endpoint accepts a trivial input before blaming a chunk.
	 * @param {unknown} cause - the refusal being investigated.
	 * @param {AbortSignal | undefined} signal - pass cancellation.
	 * @returns {Promise<void>} resolves when the endpoint accepts the probe.
	 * @throws {Error} when the probe is refused too, or fails transiently.
	 */
	async _probeEndpoint(cause, signal) {
		try {
			await this._embedder.embed([ENDPOINT_PROBE_TEXT], { prefix: DOCUMENT_PREFIX, signal });
		} catch (error) {
			if (signal?.aborted || !isRefusal(error)) throw error;
			throw new Error(`the embedding endpoint refuses every input; no chunk was skipped: ${messageOf(cause)}`, { cause });
		}
	}

	/**
	 * Log ingest failures, each once until it stops recurring.
	 * @param {readonly string[]} errors - this pass's ingest failures.
	 */
	_reportIngestErrors(errors) {
		const previous = this._reportedErrors;
		this._reportedErrors = new Set(errors);
		for (const error of errors) {
			if (!previous.has(error)) this._log('warn', `session log skipped: ${error}`);
		}
	}

	/**
	 * One bounded pass: reconcile the corpus, then embed pending chunks in
	 * batches of at most `maxBatches`, yielding to the event loop between each.
	 * A failed write never records the file, so the next pass repeats it. An
	 * endpoint outage ends the pass with every unembedded chunk still pending;
	 * a chunk the endpoint refuses is isolated and skipped. Ingest failures are
	 * logged once each.
	 *
	 * @param {{ signal?: AbortSignal, maxBatches?: number }} [options] - cancellation and batch cap.
	 * @returns {Promise<object>} pass counters.
	 */
	async runOnce({ signal, maxBatches = Number.POSITIVE_INFINITY } = {}) {
		this.open();
		const writer = this.ensureWriter();
		const stats = {
			locked: !writer,
			files: 0,
			changedFiles: 0,
			chunks: 0,
			newChunks: 0,
			embedded: 0,
			skippedChunks: 0,
			batches: 0,
			removedSessions: 0,
			errors: [],
			embeddingError: undefined,
			discardedStaleState: this._discarded,
		};
		if (!writer) return stats;
		const ingest = await this.ingestOnce({ signal });
		stats.files = ingest.files;
		stats.changedFiles = ingest.changed;
		stats.chunks = ingest.chunks;
		stats.newChunks = ingest.newChunks;
		stats.removedSessions = ingest.removedSessions;
		stats.errors = ingest.errors;
		this._reportIngestErrors(stats.errors);
		const pass = { endpointOk: false };
		while (stats.batches < maxBatches) {
			if (signal?.aborted) break;
			const rows = this.pendingChunks(this.batchSize);
			if (rows.length === 0) break;
			try {
				await this._embedRows(rows, signal, pass, stats);
			} catch (error) {
				stats.embeddingError = messageOf(error);
				this._log('warn', `embedding batch left pending: ${stats.embeddingError}`);
				break;
			}
			stats.batches += 1;
			// One macrotask per batch keeps a large backlog from starving the
			// event loop, so a concurrent query can interleave between batches.
			await new Promise((resolve) => setImmediate(resolve));
		}
		return stats;
	}

	/** Start the background ingest/embed loop. Never throws. */
	async start() {
		this.open();
		this.ensureWriter();
		if (this._loop !== undefined) return;
		this._stopped = false;
		this._loop = this._poll();
	}

	/** One background pass, then wait for the configured poll interval. */
	async _poll() {
		while (!this._stopped) {
			const startedAt = Date.now();
			try {
				await this.runOnce({ signal: this._controller.signal });
			} catch (error) {
				this._log('warn', `vector index pass failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (this._stopped) break;
			const remaining = Math.max(250, this.pollMs - (Date.now() - startedAt));
			try {
				await sleepFor(remaining, undefined, { signal: this._controller.signal });
			} catch {
				break;
			}
		}
	}

	/** Stop the background loop and wait for the current pass. */
	async stop() {
		this._stopped = true;
		this._controller.abort();
		const loop = this._loop;
		this._loop = undefined;
		if (loop !== undefined) await loop.catch(() => {});
	}

	/** Close the background loop, release the lock, and close the database. */
	async close() {
		await this.stop();
		this._lock.release();
		this._writer = undefined;
		this._closeHandle();
	}

	/**
	 * Score every stored vector against one query vector and keep the best
	 * chunk per session. Async and bounded: one macrotask is yielded every
	 * 256 rows, and an aborted signal stops the scan promptly — so a large
	 * corpus cannot freeze the event loop while a query waits for recall.
	 * Opens an existing index read-only when this process never started the
	 * indexer, and returns nothing while the index belongs to another model.
	 *
	 * @param {Float32Array} queryVector - normalized query embedding.
	 * @param {{ sessionFilters?: readonly object[], eventFilters?: readonly object[], limitSessions?: number, signal?: AbortSignal }} [filters] - materialized clauses, candidate bound, and cancellation.
	 * @returns {Promise<object[]>} best chunk rows per session, best first.
	 */
	async vectorSearch(queryVector, filters = {}) {
		if (this._db === undefined && !this._openReadOnly()) return [];
		this._refreshMeta();
		if (!this._compatible || queryVector?.length !== this.dim) return [];
		const signal = filters.signal;
		const { sql, params } = buildFilterSql(filters.sessionFilters ?? [], filters.eventFilters ?? []);
		const statement = this._db.prepare(`
      SELECT c.session_id, c.seq, c.chunk_index, c.text, c.vec, c.type, c.time, c.surface,
             s.version, s.created_at, s.cwd, s.parent_session, s.is_seeded, s.delegation_depth, s.agent_preset
      FROM chunks AS c
      JOIN sessions AS s ON s.session_id = c.session_id
      WHERE c.vec IS NOT NULL${sql}
    `);
		const best = new Map();
		const iterator = statement.iterate(...params);
		let rows = 0;
		try {
			for (;;) {
				if (signal?.aborted) break;
				const next = iterator.next();
				if (next?.done === true) break;
				const row = next.value;
				if ((rows & 0xff) === 0) await new Promise((resolve) => setImmediate(resolve));
				rows += 1;
				const stored = row.vec;
				if (!stored || stored.length !== this.dim * 4) continue;
				// View the blob in place when aligned; copy only when it is not.
				const vector = stored.byteOffset % 4 === 0 ? new Float32Array(stored.buffer, stored.byteOffset, this.dim) : new Float32Array(Uint8Array.from(stored).buffer);
				const score = cosineSimilarity(queryVector, vector);
				const current = best.get(row.session_id);
				if (current !== undefined && (current.score > score || (current.score === score && current.seq <= row.seq))) continue;
				best.set(row.session_id, {
					session_id: row.session_id,
					seq: row.seq,
					chunk_index: row.chunk_index,
					text: row.text,
					type: row.type,
					time: row.time,
					surface: row.surface,
					version: row.version,
					created_at: row.created_at,
					cwd: row.cwd,
					parent_session: row.parent_session,
					is_seeded: row.is_seeded,
					delegation_depth: row.delegation_depth,
					agent_preset: row.agent_preset,
					score,
				});
			}
		} finally {
			// The iterator is a live database handle; release it the moment the scan
			// ends (aborted or exhausted) so a later close() cannot race it.
			iterator.return?.();
		}
		const ranked = [...best.values()].sort((left, right) => right.score - left.score || (left.session_id < right.session_id ? -1 : 1));
		return ranked.slice(0, Math.max(1, filters.limitSessions ?? 50));
	}

	/**
	 * Drop vector-only sessions that are no longer in the live-preferred
	 * corpus: a hit whose session vanished from the native index (file deleted,
	 * log rewritten under a new id) is stale by definition.
	 *
	 * @param {Iterable<{ id?: unknown, live?: boolean, persisted?: boolean }>} records - current corpus records.
	 * @returns {number} sessions pruned.
	 */
	pruneVanished(records) {
		this.open();
		const present = new Set();
		for (const record of records) {
			if (typeof record?.id === 'string') present.add(record.id);
		}
		const stale = this._db.prepare('SELECT session_id FROM sessions').all();
		const remove = this._db.prepare('DELETE FROM sessions WHERE session_id = ?');
		this._db.exec('BEGIN');
	try {
			let removed = 0;
			for (const row of stale) {
				if (!present.has(row.session_id)) {
					remove.run(row.session_id);
					removed += 1;
				}
			}
			this._db.exec('COMMIT');
			return removed;
		} catch (error) {
			this._db.exec('ROLLBACK');
			throw error;
		}
	}

	/**
	 * Current index counters, used for generation binding and diagnostics.
	 * @returns {{ chunks: number, embedded: number, sessions: number, files: number }} counts.
	 */
	stats() {
		if (this._db === undefined) return { chunks: 0, embedded: 0, sessions: 0, files: 0 };
		const chunk = this._db.prepare('SELECT COUNT(*) AS total, COUNT(vec) AS embedded FROM chunks').get();
		const session = this._db.prepare('SELECT COUNT(*) AS total FROM sessions').get();
		const file = this._db.prepare('SELECT COUNT(*) AS total FROM files').get();
		return { chunks: chunk.total, embedded: chunk.embedded, sessions: session.total, files: file.total };
	}

	/**
	 * Stable identity of the currently stored corpus generation: a digest of
	 * every chunk's per-event content hash, so a rewrite that keeps chunk and
	 * session counts but changes any event text still changes the generation.
	 * Cached until this connection or another one writes the database.
	 * @returns {string} digest that changes when any chunk content or count changes.
	 */
	generation() {
		if (this._db === undefined) return '';
		const state = this._db.prepare('SELECT data_version AS version, total_changes() AS changes FROM pragma_data_version').get();
		const key = `${state.version}:${state.changes}`;
		if (this._generation?.key === key) return this._generation.value;
		const rows = this._db.prepare('SELECT text_hash FROM chunks ORDER BY id').all();
		const hash = createHash('sha256');
		hash.update(`${rows.length}\u0000`);
		for (const row of rows) hash.update(row.text_hash);
		const value = hash.digest('base64url');
		this._generation = { key, value };
		return value;
	}
}
