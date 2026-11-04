import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const STATE_VERSION = 1;
export const VERBOSITY_LEVELS = Object.freeze(['quiet', 'normal', 'verbose']);
export const DEFAULT_VERBOSITY = 'quiet';
export const MANAGED_MODES = Object.freeze(['auto', 'restored', 'new_replaced']);

export class BindingStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BindingStoreError';
    this.code = code;
    this.details = details;
  }
}

/** Address key for one Telegram conversation surface. */
export function pairKey(chatId, threadId = 0) {
  return `${chatId}:${threadId ?? 0}`;
}

export function assertTopicId(threadId) {
  if (threadId === undefined || threadId === null) return 0;
  if (!Number.isSafeInteger(threadId) || threadId < 0) {
    throw new BindingStoreError('bad-topic-id', `topic id must be a non-negative integer (got ${JSON.stringify(threadId)})`);
  }
  return threadId;
}

function emptyState() {
  return { version: STATE_VERSION, bindings: {}, verbosity: {}, offset: 0, dedupe: {}, updatedAt: null };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBinding(entry) {
  if (!isPlainObject(entry)) return null;
  const chatId = entry.chatId;
  const threadId = entry.threadId;
  const sessionId = entry.sessionId;
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId) || threadId < 1) return null;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const managedMode = MANAGED_MODES.includes(entry.managedMode) ? entry.managedMode : 'auto';
  return {
    chatId,
    threadId,
    sessionId,
    managedMode,
    boundAt: typeof entry.boundAt === 'string' ? entry.boundAt : new Date(0).toISOString(),
  };
}

function normalizeState(parsed) {
  if (!isPlainObject(parsed)) throw new BindingStoreError('state-corrupt', 'state root must be an object');
  if (parsed.version !== STATE_VERSION) {
    throw new BindingStoreError(
      'state-version',
      `unsupported state version ${JSON.stringify(parsed.version)}; this bridge writes version ${STATE_VERSION}`,
    );
  }
  const state = emptyState();
  if (isPlainObject(parsed.bindings)) {
    for (const [key, entry] of Object.entries(parsed.bindings)) {
      const binding = normalizeBinding(entry);
      if (!binding) continue;
      if (pairKey(binding.chatId, binding.threadId) !== key) continue;
      state.bindings[key] = binding;
    }
  }
  if (isPlainObject(parsed.verbosity)) {
    for (const [key, level] of Object.entries(parsed.verbosity)) {
      if (VERBOSITY_LEVELS.includes(level)) state.verbosity[key] = level;
    }
  }
  if (Number.isSafeInteger(parsed.offset) && parsed.offset >= 0) state.offset = parsed.offset;
  if (isPlainObject(parsed.dedupe)) {
    for (const [key, at] of Object.entries(parsed.dedupe)) {
      if (typeof at === 'number' && Number.isFinite(at)) state.dedupe[key] = at;
    }
  }
  state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
  return state;
}

/**
 * Durable side-table for the bridge. The file is versioned JSON, replaced with
 * an atomic tmp+rename, and owns only bridge state: bindings, per-surface
 * verbosity, the Telegram update offset, and the inbound dedupe ledger. It
 * never mutates a DSH store, and nothing is written until an operator binds.
 */
export class BindingStore {
  #data = null;
  #loadPromise = null;
  #queue = Promise.resolve();
  #tmpCounter = 0;

  constructor({ file, clock = () => Date.now(), logger = console, dedupeRetentionMs = 7 * 24 * 60 * 60 * 1000, dedupeMaxEntries = 5000 } = {}) {
    if (typeof file !== 'string' || !file) throw new TypeError('BindingStore requires a state file path');
    this.file = file;
    this.clock = clock;
    this.logger = logger;
    this.dedupeRetentionMs = dedupeRetentionMs;
    this.dedupeMaxEntries = dedupeMaxEntries;
  }

  get loaded() {
    return this.#data !== null;
  }

  async load() {
    if (this.#loadPromise) return this.#loadPromise;
    this.#loadPromise = this.#loadInternal();
    return this.#loadPromise;
  }

  async #loadInternal() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#data = emptyState();
        return this;
      }
      throw new BindingStoreError('state-unreadable', `cannot read ${this.file}: ${error?.message ?? error}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return this.#quarantine(`invalid JSON (${error?.message ?? error})`);
    }
    try {
      this.#data = normalizeState(parsed);
      return this;
    } catch (error) {
      // A version we do not know is not corruption: refuse to touch it.
      if (error?.code === 'state-version') throw error;
      return this.#quarantine(error?.message ?? String(error));
    }
  }

  async #quarantine(reason) {
    const backup = `${this.file}.corrupt-${this.clock()}`;
    try {
      await rename(this.file, backup);
    } catch {
      // Keep going with an empty store; the unreadable original stays in place.
    }
    this.logger?.error?.(`[telegram-session-bridge] state file unreadable (${reason}); moved to ${backup}`);
    this.#data = emptyState();
    return this;
  }

  #assertLoaded() {
    if (!this.#data) throw new BindingStoreError('state-not-loaded', 'call await store.load() before using the store');
    return this.#data;
  }

  #enqueue(task) {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #mutate(fn) {
    return this.#enqueue(async () => {
      await this.load();
      const draft = structuredClone(this.#data);
      const result = fn(draft);
      draft.version = STATE_VERSION;
      draft.updatedAt = new Date(this.clock()).toISOString();
      await this.#write(draft);
      this.#data = draft;
      return result;
    });
  }

  async #write(state) {
    await mkdir(dirname(this.file), { recursive: true });
    this.#tmpCounter += 1;
    const tmp = `${this.file}.${process.pid}.${this.#tmpCounter}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    try {
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw new BindingStoreError('state-write-failed', `cannot write ${this.file}: ${error?.message ?? error}`);
    }
    // Best-effort directory fsync so the rename is durable across power loss.
    try {
      const handle = await open(dirname(this.file), 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Not supported on every platform; the rename itself already succeeded.
    }
  }

  // ---- bindings -----------------------------------------------------------

  listBindings() {
    return Object.values(this.#assertLoaded().bindings).map((binding) => ({ ...binding }));
  }

  getBinding(chatId, threadId = 0) {
    const binding = this.#assertLoaded().bindings[pairKey(chatId, assertTopicId(threadId))];
    return binding ? { ...binding } : null;
  }

  getBindingForSession(sessionId) {
    const found = Object.values(this.#assertLoaded().bindings).find((binding) => binding.sessionId === sessionId);
    return found ? { ...found } : null;
  }

  /**
   * Bind one topic to one session. Idempotent for the same pair; rejects a
   * second topic for a session already linked elsewhere (Hermes UNIQUE(session)).
   */
  async bind({ chatId, threadId, sessionId, managedMode = 'auto' } = {}) {
    if (!Number.isSafeInteger(chatId)) {
      throw new BindingStoreError('bad-chat-id', `chat id must be an integer (got ${JSON.stringify(chatId)})`);
    }
    const topicId = assertTopicId(threadId);
    if (topicId < 1) {
      throw new BindingStoreError('bad-topic-id', 'topic id 0 is the DM lobby: create a forum topic and bind there');
    }
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new BindingStoreError('bad-session-id', 'sessionId must be a non-empty string');
    }
    if (!MANAGED_MODES.includes(managedMode)) {
      throw new BindingStoreError('bad-managed-mode', `managedMode must be one of ${MANAGED_MODES.join(', ')}`);
    }
    return this.#mutate((draft) => {
      const key = pairKey(chatId, topicId);
      const linked = Object.values(draft.bindings).find((binding) => binding.sessionId === sessionId);
      if (linked && pairKey(linked.chatId, linked.threadId) !== key) {
        throw new BindingStoreError(
          'session-already-linked',
          `session "${sessionId}" is already linked to chat ${linked.chatId} topic ${linked.threadId}`,
          { sessionId, binding: { ...linked } },
        );
      }
      const existing = draft.bindings[key];
      if (existing && existing.sessionId === sessionId) {
        const changed = existing.managedMode !== managedMode;
        if (changed) existing.managedMode = managedMode;
        return { created: false, changed, replacedSessionId: null, binding: { ...existing } };
      }
      const replacedSessionId = existing?.sessionId ?? null;
      draft.bindings[key] = {
        chatId,
        threadId: topicId,
        sessionId,
        managedMode,
        boundAt: new Date(this.clock()).toISOString(),
      };
      return { created: true, changed: true, replacedSessionId, binding: { ...draft.bindings[key] } };
    });
  }

  async unbind({ chatId, threadId = 0 } = {}) {
    if (!Number.isSafeInteger(chatId)) {
      throw new BindingStoreError('bad-chat-id', `chat id must be an integer (got ${JSON.stringify(chatId)})`);
    }
    const key = pairKey(chatId, assertTopicId(threadId));
    return this.#mutate((draft) => {
      const existing = draft.bindings[key];
      if (!existing) return { removed: false, binding: null };
      delete draft.bindings[key];
      delete draft.verbosity[key];
      return { removed: true, binding: { ...existing } };
    });
  }

  /**
   * Restore a topic to an existing session and replay the last assistant
   * message. Hermes' "restore-with-replay": the binding is the authority, the
   * replay is what makes the restored surface catch up.
   */
  async restore({ chatId, threadId, sessionId, replay } = {}) {
    const result = await this.bind({ chatId, threadId, sessionId, managedMode: 'restored' });
    let text = null;
    if (typeof replay === 'function') {
      try {
        text = await replay(sessionId);
      } catch (error) {
        this.logger?.warn?.(`[telegram-session-bridge] replay failed for ${sessionId}: ${error?.message ?? error}`);
      }
    }
    const replayText = typeof text === 'string' && text.trim() ? text : null;
    return { ...result, replayed: replayText !== null, replay: replayText };
  }

  // ---- verbosity ----------------------------------------------------------

  getVerbosity(chatId, threadId = 0) {
    return this.#assertLoaded().verbosity[pairKey(chatId, assertTopicId(threadId))] ?? DEFAULT_VERBOSITY;
  }

  async setVerbosity({ chatId, threadId = 0, level } = {}) {
    if (!Number.isSafeInteger(chatId)) {
      throw new BindingStoreError('bad-chat-id', `chat id must be an integer (got ${JSON.stringify(chatId)})`);
    }
    if (!VERBOSITY_LEVELS.includes(level)) {
      throw new BindingStoreError('bad-verbosity', `verbosity must be one of ${VERBOSITY_LEVELS.join(', ')}`);
    }
    const key = pairKey(chatId, assertTopicId(threadId));
    return this.#mutate((draft) => {
      draft.verbosity[key] = level;
      return level;
    });
  }

  // ---- transport cursor and dedupe ---------------------------------------

  getOffset() {
    return this.#assertLoaded().offset;
  }

  /**
   * Durably acknowledge one update: record its (chat, thread)-keyed dedupe
   * entry and advance the offset in the same atomic write, before the handler
   * runs. A restart therefore suppresses replayed updates even though the Bot
   * API only promises at-least-once.
   */
  async ackInbound({ key, updateId } = {}) {
    await this.load();
    if (typeof key === 'string' && key && Object.hasOwn(this.#data.dedupe, key)) {
      return { duplicate: true, offset: this.#data.offset };
    }
    return this.#mutate((draft) => {
      if (typeof key === 'string' && key) draft.dedupe[key] = this.clock();
      if (Number.isSafeInteger(updateId) && updateId >= 0 && updateId + 1 > draft.offset) {
        draft.offset = updateId + 1;
      }
      const now = this.clock();
      const keys = Object.keys(draft.dedupe);
      if (keys.length > this.dedupeMaxEntries) {
        for (const entryKey of keys.slice(0, keys.length - this.dedupeMaxEntries)) delete draft.dedupe[entryKey];
      }
      for (const [entryKey, at] of Object.entries(draft.dedupe)) {
        if (now - at > this.dedupeRetentionMs) delete draft.dedupe[entryKey];
      }
      return { duplicate: false, offset: draft.offset };
    });
  }

  snapshot() {
    return structuredClone(this.#assertLoaded());
  }

  /** Wait for every queued write to settle (tests and shutdown). */
  async flush() {
    await this.load();
    await this.#queue;
  }
}

export async function openBindingStore(options) {
  const store = new BindingStore(options);
  await store.load();
  return store;
}
