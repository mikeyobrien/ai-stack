import { pairKey } from './state.js';

/** Telegram drops a chat action after ~5 s; 4 s keeps the indicator lit. */
export const TYPING_INTERVAL_MS = 4000;

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

const REACTION_EYES = [{ type: 'emoji', emoji: '👀' }];
const REACTION_DONE = [{ type: 'emoji', emoji: '✅' }];
const REACTION_FAILED = [{ type: 'emoji', emoji: '⚠️' }];

function reactionFor(reason) {
  if (reason?.kind === 'completed') return REACTION_DONE;
  if (reason?.kind === 'error') return REACTION_FAILED;
  return null;
}

/**
 * Ephemeral presence for a bound session: one typing loop per chat/topic while
 * a turn runs, plus the eye/settled reaction on the prompt message the turn
 * answers. Everything here is best-effort: a Bot API failure in this layer can
 * never break prompt ingestion or delivery.
 */
export class Presence {
  #loops = new Map(); // chat/topic key -> { sessionId, chatId, threadId, timer, warned }
  #prompts = new Map(); // sessionId -> { chatId, threadId, messageId } for the last prompt only
  #reactionWarned = new Set(); // chat:message ids already warned about

  constructor({
    store,
    bot,
    intervalMs = TYPING_INTERVAL_MS,
    timers = defaultTimers,
    logger = console,
  } = {}) {
    if (typeof store?.getBindingForSession !== 'function') throw new TypeError('Presence requires a binding store');
    if (typeof bot?.sendChatAction !== 'function') throw new TypeError('Presence requires a bot');
    if (!(Number.isFinite(intervalMs) && intervalMs > 0)) throw new TypeError('Presence requires a positive intervalMs');
    this.store = store;
    this.bot = bot;
    this.intervalMs = intervalMs;
    this.timers = timers;
    this.logger = logger;
    this.stopped = false;
  }

  isActive(chatId, threadId = 0) {
    return this.#loops.has(pairKey(chatId, threadId));
  }

  /**
   * Arm the loop for a session's bound chat/topic and refresh immediately. One
   * loop per chat/topic: a repeated turn/start for the same bound surface is a
   * no-op, and a different session taking over the same topic replaces it.
   */
  start(sessionId) {
    if (this.stopped || typeof sessionId !== 'string') return false;
    const binding = this.store.getBindingForSession(sessionId);
    if (!binding) return false;
    const key = pairKey(binding.chatId, binding.threadId);
    const existing = this.#loops.get(key);
    if (existing?.sessionId === sessionId) return true;
    if (existing) this.#clear(key);

    const loop = {
      sessionId,
      chatId: binding.chatId,
      threadId: binding.threadId,
      timer: null,
      warned: false,
    };
    this.#loops.set(key, loop);
    void this.#beat(key, loop);
    return true;
  }

  /** Stop typing for one session and forget its pending reaction (unbind/new). */
  stopSession(sessionId) {
    if (typeof sessionId !== 'string') return;
    this.#prompts.delete(sessionId);
    for (const [key, loop] of this.#loops) {
      if (loop.sessionId === sessionId) this.#clear(key);
    }
  }

  /**
   * A turn ended for any reason: stop the loop, then settle the prompt reaction
   * when the reason is a clean completion or a real error. Other endings leave
   * the eye in place. Missing prompt tracking is not an error (goal/heartbeat
   * turns start without a Telegram message).
   */
  async finish(sessionId, reason) {
    if (typeof sessionId !== 'string') return false;
    for (const [key, loop] of this.#loops) {
      if (loop.sessionId === sessionId) this.#clear(key);
    }
    const prompt = this.#prompts.get(sessionId);
    if (!prompt) return false;
    this.#prompts.delete(sessionId);
    const reaction = reactionFor(reason);
    if (!reaction) return false;
    return this.#react(prompt, reaction);
  }

  /**
   * One gate-decision reaction on the prompt message. Unlike the eye, this
   * replaces any prior gate emoji and still tracks the prompt for the terminal
   * reaction. Best-effort; never throws into prompt ingestion.
   */
  async reactDecision({ sessionId, chatId, threadId = 0, messageId, emoji } = {}) {
    if (typeof emoji !== 'string' || emoji === '') return false;
    if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return false;
    if (typeof sessionId === 'string') this.#prompts.set(sessionId, { chatId, threadId, messageId });
    return this.#react({ chatId, messageId }, [{ type: 'emoji', emoji }]);
  }

  /** React to the prompt message a turn is answering and remember it. */
  async reactPrompt({ sessionId, chatId, threadId = 0, messageId } = {}) {
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) {
      return false;
    }
    this.#prompts.set(sessionId, { chatId, threadId, messageId });
    return this.#react({ chatId, messageId }, REACTION_EYES);
  }

  /** Terminal stop: no loop may outlive the bridge. */
  stop() {
    this.stopped = true;
    for (const key of [...this.#loops.keys()]) this.#clear(key);
    this.#prompts.clear();
  }

  #schedule(key, loop) {
    if (this.stopped || this.#loops.get(key) !== loop) return;
    loop.timer = this.timers.setTimeout(() => {
      loop.timer = null;
      if (this.stopped || this.#loops.get(key) !== loop) return;
      void this.#beat(key, loop);
    }, this.intervalMs);
  }

  async #beat(key, loop) {
    if (this.stopped || this.#loops.get(key) !== loop) return;
    // Schedule before the network hop so a slow call cannot stretch the
    // refresh past the ~5 s Telegram keeps the indicator visible.
    this.#schedule(key, loop);
    try {
      await this.bot.sendChatAction({ chatId: loop.chatId, threadId: loop.threadId, action: 'typing' });
    } catch (error) {
      if (loop.warned) return;
      loop.warned = true;
      this.logger?.warn?.(
        `[telegram-session-bridge] typing action failed for chat ${loop.chatId} topic ${loop.threadId}: ${error?.message ?? error}`,
      );
    }
  }

  async #react({ chatId, messageId }, reaction) {
    try {
      await this.bot.setMessageReaction({ chatId, messageId, reaction });
      return true;
    } catch (error) {
      const key = `${chatId}:${messageId}`;
      if (!this.#reactionWarned.has(key)) {
        this.#reactionWarned.add(key);
        this.logger?.warn?.(
          `[telegram-session-bridge] reaction update failed for chat ${chatId} message ${messageId}: ${error?.message ?? error}`,
        );
      }
      return false;
    }
  }

  #clear(key) {
    const loop = this.#loops.get(key);
    if (!loop) return;
    if (loop.timer !== null) this.timers.clearTimeout(loop.timer);
    this.#loops.delete(key);
  }
}
