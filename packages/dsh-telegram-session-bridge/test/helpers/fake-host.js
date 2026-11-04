export class FakeSessionController {
  constructor({ sessions = [] } = {}) {
    this.sessions = sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.title ?? null,
      events: session.events ?? [],
    }));
    this.prompts = [];
    this.cancels = [];
    this.created = 0;
  }

  addSession({ sessionId, title = null, events = [] }) {
    this.sessions.push({ sessionId, title, events });
  }

  async list() {
    return {
      items: this.sessions.map((session) => ({
        sessionId: session.sessionId,
        projections: { values: { title: session.title } },
      })),
    };
  }

  async prompt(request) {
    this.prompts.push(request);
    return { accepted: true };
  }

  /** Mirrors 0.2.1-rc.5: session/cancel always keeps the pending inbox. */
  cancel(request) {
    this.cancels.push({ sessionId: request.sessionId, keepInbox: true });
    return { accepted: true };
  }

  async inspect(sessionId) {
    const session = this.sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    return { events: session.events };
  }

  async page(request) {
    const session = this.sessions.find((entry) => entry.sessionId === request.address.sessionId);
    return {
      records: (session?.events ?? []).map((event) => ({ type: 'event', event })),
      hasMore: false,
    };
  }

  async create() {
    this.created += 1;
    const sessionId = `session-new-${this.created}`;
    this.sessions.push({ sessionId, title: null, events: [] });
    return { sessionId };
  }
}

/** Small cordis-shaped context: on/effect/emit plus the session service. */
export class FakeHostContext {
  constructor({ sessions = [] } = {}) {
    this.handlers = new Map();
    this.effects = [];
    this.natives = new Map();
    this.sessionController = new FakeSessionController({ sessions });
    this.logs = [];
    this.logger = {
      info: (message) => this.logs.push(['info', String(message)]),
      warn: (message) => this.logs.push(['warn', String(message)]),
      error: (message) => this.logs.push(['error', String(message)]),
      debug: (message) => this.logs.push(['debug', String(message)]),
    };
  }

  on(name, handler) {
    const entries = this.handlers.get(name) ?? [];
    const entry = { handler };
    entries.push(entry);
    this.handlers.set(name, entries);
    return () => {
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    };
  }

  /**
   * Matches cordis's `_execute`: the callback runs immediately and whatever
   * disposer it returns is collected (a plain function directly, or the
   * resolved function of a promise). Storing the callback itself would drop
   * the returned disposer and leak the bridge's watchdog timer.
   */
  effect(fn) {
    const entry = { disposer: null, pending: null, disposed: false };
    const collect = (value) => {
      if (typeof value === 'function') entry.disposer = value;
      else if (value != null) throw new TypeError('Invalid effect');
    };
    const collected = fn();
    if (typeof collected === 'function') collect(collected);
    else if (collected != null && typeof collected.then === 'function') {
      entry.pending = collected.then((value) => collect(value));
    }
    this.effects.push(entry);
    return () => this.#disposeEffect(entry);
  }

  async #disposeEffect(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.pending && (await entry.pending);
    await entry.disposer?.();
  }

  /** Asynchronous event delivery for session/event handlers. */
  async emit(name, ...args) {
    for (const { handler } of this.handlers.get(name) ?? []) await handler(...args);
  }

  /** Waterfall (approval/question) delivery in registration order. */
  async emitWaterfall(name, request) {
    const entries = this.handlers.get(name) ?? [];
    let index = -1;
    const next = () => {
      index += 1;
      const entry = entries[index];
      if (!entry) return this.natives.get(name)?.(request);
      return entry.handler(request, next);
    };
    return next();
  }

  async dispose() {
    for (const entry of [...this.effects].reverse()) await this.#disposeEffect(entry);
    this.effects = [];
  }
}
