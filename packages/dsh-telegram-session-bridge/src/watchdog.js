import { formatDuration } from './util.js';

const defaultScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Stuck-turn recovery. A turn that produces no session activity for the stall
 * timeout gets a Telegram notice, then `session.cancel` (the host's
 * keepInbox:true cancel) so the queued work survives and the next prompt can
 * proceed. One fire per stall; a later prompt re-arms it.
 */
export class Watchdog {
  #timers = new Map();

  constructor({
    store,
    bot,
    cancel,
    timeoutMs,
    scheduler = defaultScheduler,
    logger = console,
  } = {}) {
    if (typeof store?.getBindingForSession !== 'function') throw new TypeError('Watchdog requires a binding store');
    if (typeof bot?.sendMessage !== 'function') throw new TypeError('Watchdog requires a bot');
    if (typeof cancel !== 'function') throw new TypeError('Watchdog requires a cancel function');
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new TypeError('Watchdog requires a positive timeoutMs');
    this.store = store;
    this.bot = bot;
    this.cancel = cancel;
    this.timeoutMs = timeoutMs;
    this.scheduler = scheduler;
    this.logger = logger;
    this.stopped = false;
  }

  isArmed(sessionId) {
    return this.#timers.has(sessionId);
  }

  arm(sessionId) {
    if (this.stopped || typeof sessionId !== 'string') return false;
    const binding = this.store.getBindingForSession(sessionId);
    if (!binding) return false;
    this.#clear(sessionId);
    const timer = this.scheduler.setTimeout(() => {
      this.#timers.delete(sessionId);
      void this.#fire(sessionId);
    }, this.timeoutMs);
    this.#timers.set(sessionId, timer);
    return true;
  }

  /** Extend an armed watchdog after activity; never arms an idle session. */
  touch(sessionId) {
    if (!this.#timers.has(sessionId)) return false;
    return this.arm(sessionId);
  }

  disarm(sessionId) {
    this.#clear(sessionId);
  }

  #clear(sessionId) {
    const timer = this.#timers.get(sessionId);
    if (timer !== undefined) {
      this.scheduler.clearTimeout(timer);
      this.#timers.delete(sessionId);
    }
  }

  async #fire(sessionId) {
    if (this.stopped) return;
    const binding = this.store.getBindingForSession(sessionId);
    if (!binding) return;
    const notice = `⌛ No activity for ${formatDuration(this.timeoutMs)}. Cancelling this turn; queued input is kept.`;
    try {
      await this.bot.sendMessage({
        chatId: binding.chatId,
        threadId: binding.threadId,
        text: notice,
      });
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] stall notice failed: ${error?.message ?? error}`);
    }
    try {
      await this.cancel(sessionId);
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] stall cancel failed: ${error?.message ?? error}`);
    }
  }

  stop() {
    this.stopped = true;
    for (const sessionId of [...this.#timers.keys()]) this.#clear(sessionId);
  }
}
