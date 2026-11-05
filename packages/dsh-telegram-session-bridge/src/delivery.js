import { assistantFinalText, assistantReasoningTexts, userMessageText } from './host.js';
import { oneLine } from './util.js';

/** Prefixes kept short; verbosity decides which digest kinds appear. */
const USER_PREFIX = '▸ ';
const TOOL_PREFIX = '⚙ ';
const THINKING_PREFIX = '✎ ';
const ERROR_PREFIX = '⚠️ ';

function normalizePrompt(text) {
  return String(text ?? '').trim();
}

/**
 * Deterministic delivery: every outbound message is addressed by the binding
 * for the session that produced the event. The model never picks a chat, and
 * an unbound session produces no output at all.
 */
export class Delivery {
  #ownPrompts = new Map();

  constructor({ store, bot, logger = console, clock = () => Date.now() } = {}) {
    this.store = store;
    this.bot = bot;
    this.logger = logger;
    this.clock = clock;
    this.watchdog = null;
    this.presence = null;
  }

  /** Remember a prompt we sent so its user/message echo is not duplicated. */
  noteOwnPrompt(sessionId, text) {
    const now = this.clock();
    const entries = (this.#ownPrompts.get(sessionId) ?? []).filter((entry) => now - entry.at < 10 * 60 * 1000);
    entries.push({ text: normalizePrompt(text), at: now });
    this.#ownPrompts.set(sessionId, entries.slice(-5));
  }

  #consumeOwnPrompt(sessionId, text) {
    const entries = this.#ownPrompts.get(sessionId);
    if (!entries?.length) return false;
    const wanted = normalizePrompt(text);
    const index = entries.findIndex((entry) => entry.text === wanted);
    if (index === -1) return false;
    entries.splice(index, 1);
    if (entries.length === 0) this.#ownPrompts.delete(sessionId);
    return true;
  }

  async send(binding, text) {
    if (typeof text !== 'string' || text.trim() === '') return [];
    return this.bot.sendMessage({
      chatId: binding.chatId,
      threadId: binding.threadId,
      text,
    });
  }

  /**
   * Route one durable session event to the bound topic. Returns true when the
   * event was addressed through a binding.
   */
  async handleSessionEvent(session, event) {
    const sessionId = session?.id ?? session?.sessionId;
    if (typeof sessionId !== 'string' || !event || typeof event !== 'object') return false;
    const binding = this.store.getBindingForSession(sessionId);
    if (!binding) return false;

    const level = this.store.getVerbosity(binding.chatId, binding.threadId);

    // Every turn in a bound session is watched, including goal/heartbeat turns
    // that were not preceded by a human user/message.
    if (event.type === 'turn/start') {
      this.watchdog?.arm(sessionId);
      this.presence?.start(sessionId);
      return true;
    }

    const userText = userMessageText(event);
    if (userText) {
      this.watchdog?.arm(sessionId);
      if (this.#consumeOwnPrompt(sessionId, userText)) return true;
      await this.send(binding, `${USER_PREFIX}${userText}`);
      return true;
    }

    if (event.type === 'assistant/message') {
      this.watchdog?.touch(sessionId);
      if (level === 'verbose') {
        for (const reasoning of assistantReasoningTexts(event)) {
          const digest = oneLine(reasoning, 300);
          if (digest) await this.send(binding, `${THINKING_PREFIX}${digest}`);
        }
      }
      const finalText = assistantFinalText(event);
      if (finalText) {
        // Only the assistant's final answer is rendered as Telegram HTML;
        // echoes, digests, errors and command replies stay plain text.
        await this.bot.sendMarkdown({
          chatId: binding.chatId,
          threadId: binding.threadId,
          text: finalText,
        });
      }
      return true;
    }

    if (event.type === 'tool/call') {
      this.watchdog?.touch(sessionId);
      if (level !== 'quiet') {
        const name = event.data?.name ?? event.data?.toolName ?? 'tool';
        const args = oneLine(event.data?.arguments ?? event.data?.args ?? '', 120);
        await this.send(binding, `${TOOL_PREFIX}${name}${args ? ` ${args}` : ''}`);
      }
      return true;
    }

    if (event.type === 'turn/end') {
      this.watchdog?.disarm(sessionId);
      // Settles the prompt reaction: ✅ completed, ⚠️ error, 👀 otherwise.
      await this.presence?.finish(sessionId, event.data?.reason);
      // Real turn failures are durable turn/end reasons, not turn/error events.
      // Errors are not a verbosity digest: quiet still reports them.
      const reason = event.data?.reason;
      if (reason?.kind === 'error') {
        const message = reason.error?.message ?? reason.message ?? 'turn failed';
        await this.send(binding, `${ERROR_PREFIX}${oneLine(message, 500)}`);
      }
      return true;
    }

    return true;
  }
}
