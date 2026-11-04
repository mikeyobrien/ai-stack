import { DEFAULT_VERBOSITY, VERBOSITY_LEVELS } from './state.js';

const HELP = [
  'Telegram session bridge',
  '/bind <session-id> — bind this topic to a session',
  '/new — create and bind a fresh session',
  '/unbind — detach this topic',
  '/verbosity [quiet|normal|verbose] — per-topic output level',
  '/sessions — list session ids',
  '/status — current binding and level',
].join('\n');

function shortId(value) {
  return typeof value === 'string' && value.length > 8 ? value.slice(0, 8) : String(value ?? '');
}

function commandName(raw) {
  return raw.replace(/@[A-Za-z0-9_]+$/, '');
}

/** Operator commands and prompt ingestion for one bound topic. */
export class Commands {
  constructor({ store, bot, host, delivery, watchdog = null, allowedChatIds = [], logger = console } = {}) {
    this.store = store;
    this.bot = bot;
    this.host = host;
    this.delivery = delivery;
    this.watchdog = watchdog;
    this.allowedChatIds = new Set(allowedChatIds);
    this.logger = logger;
  }

  #allowed(chatId) {
    return this.allowedChatIds.size > 0 && this.allowedChatIds.has(chatId);
  }

  async #reply(chatId, threadId, text) {
    await this.bot.sendMessage({ chatId, threadId, text });
  }

  async handleMessage(message) {
    const chatId = message?.chat?.id;
    if (!Number.isSafeInteger(chatId)) return { handled: false, reason: 'bad-chat' };
    const threadId = message?.message_thread_id ?? 0;
    if (!this.#allowed(chatId)) {
      this.logger?.warn?.(`[telegram-session-bridge] ignoring chat ${chatId}: not in allowedChatIds`);
      return { handled: false, reason: 'not-allowed' };
    }
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (!text) return { handled: false, reason: 'empty' };
    if (text.startsWith('/')) return this.#command(text, { chatId, threadId });

    const binding = this.store.getBinding(chatId, threadId);
    if (!binding) {
      await this.#reply(
        chatId,
        threadId,
        threadId > 0
          ? 'This topic is not bound. /bind <session-id> or /new.'
          : 'This is the DM lobby. Create a forum topic, then /bind <session-id> there.',
      );
      return { handled: true, reason: 'unbound' };
    }
    this.delivery.noteOwnPrompt(binding.sessionId, text);
    this.watchdog?.arm(binding.sessionId);
    try {
      await this.host.prompt(binding.sessionId, text);
    } catch (error) {
      this.logger?.error?.(`[telegram-session-bridge] prompt failed for ${binding.sessionId}: ${error?.message ?? error}`);
      await this.#reply(chatId, threadId, `⚠️ Prompt failed: ${error?.message ?? error}`);
      return { handled: true, reason: 'prompt-failed' };
    }
    return { handled: true, prompted: true, sessionId: binding.sessionId };
  }

  async #command(text, { chatId, threadId }) {
    const [raw, ...args] = text.split(/\s+/);
    const command = commandName(raw);
    switch (command) {
      case '/start':
      case '/help':
        await this.#reply(chatId, threadId, HELP);
        return { handled: true, command };
      case '/bind':
        return this.#bind(chatId, threadId, args);
      case '/new':
        return this.#new(chatId, threadId);
      case '/unbind':
        return this.#unbind(chatId, threadId);
      case '/verbosity':
        return this.#verbosity(chatId, threadId, args);
      case '/status':
        return this.#status(chatId, threadId);
      case '/sessions':
        return this.#sessions(chatId, threadId);
      default:
        await this.#reply(chatId, threadId, 'Unknown command. /help');
        return { handled: true, command: 'unknown' };
    }
  }

  async #bind(chatId, threadId, args) {
    if (threadId < 1) {
      await this.#reply(chatId, threadId, 'Bind inside a forum topic, not the DM lobby.');
      return { handled: true, command: '/bind', reason: 'lobby' };
    }
    const sessionId = args[0];
    if (!sessionId) {
      const sessions = await this.host.listSessions();
      if (sessions.length === 0) {
        await this.#reply(chatId, threadId, 'No sessions. /new');
        return { handled: true, command: '/bind', reason: 'no-args' };
      }
      const lines = sessions.slice(0, 15).map((session) => {
        const title = session?.projections?.values?.title;
        return `- ${session.sessionId}${title ? ` — ${title}` : ''}`;
      });
      await this.#reply(chatId, threadId, `Sessions:\n${lines.join('\n')}\n\n/bind <session-id>`);
      return { handled: true, command: '/bind', reason: 'no-args' };
    }
    const sessions = await this.host.listSessions();
    if (!sessions.some((session) => session.sessionId === sessionId)) {
      await this.#reply(chatId, threadId, `Unknown session ${shortId(sessionId)}.`);
      return { handled: true, command: '/bind', reason: 'not-found' };
    }
    try {
      const result = await this.store.restore({
        chatId,
        threadId,
        sessionId,
        replay: (id) => this.host.readLastAssistant(id),
      });
      if (result.replayed) {
        await this.bot.sendMessage({
          chatId,
          threadId,
          text: `↩︎ Restored ${shortId(sessionId)}\n\n${result.replay}`,
        });
      } else {
        await this.#reply(chatId, threadId, `✅ Bound ${shortId(sessionId)}`);
      }
      return { handled: true, command: '/bind', binding: result.binding, replayed: result.replayed };
    } catch (error) {
      if (error?.code === 'session-already-linked') {
        const linked = error.details?.binding;
        const where = linked ? `chat ${linked.chatId} topic ${linked.threadId}` : 'another topic';
        await this.#reply(chatId, threadId, `That session is already linked to ${where}.`);
        return { handled: true, command: '/bind', reason: 'already-linked' };
      }
      throw error;
    }
  }

  async #new(chatId, threadId) {
    if (threadId < 1) {
      await this.#reply(chatId, threadId, 'Create sessions inside a forum topic, not the DM lobby.');
      return { handled: true, command: '/new', reason: 'lobby' };
    }
    const previous = this.store.getBinding(chatId, threadId);
    const sessionId = await this.host.createSession();
    const result = await this.store.bind({
      chatId,
      threadId,
      sessionId,
      managedMode: previous ? 'new_replaced' : 'auto',
    });
    await this.#reply(chatId, threadId, `✅ New session ${shortId(sessionId)}`);
    return { handled: true, command: '/new', binding: result.binding };
  }

  async #unbind(chatId, threadId) {
    const result = await this.store.unbind({ chatId, threadId });
    await this.#reply(chatId, threadId, result.removed ? 'Unbound.' : 'Not bound.');
    return { handled: true, command: '/unbind', removed: result.removed };
  }

  async #verbosity(chatId, threadId, args) {
    const requested = args[0]?.toLowerCase();
    if (!requested) {
      const level = this.store.getVerbosity(chatId, threadId) ?? DEFAULT_VERBOSITY;
      await this.#reply(chatId, threadId, `Verbosity: ${level} (${VERBOSITY_LEVELS.join(', ')})`);
      return { handled: true, command: '/verbosity', level };
    }
    if (!VERBOSITY_LEVELS.includes(requested)) {
      await this.#reply(chatId, threadId, `Verbosity must be one of ${VERBOSITY_LEVELS.join(', ')}.`);
      return { handled: true, command: '/verbosity', reason: 'invalid' };
    }
    await this.store.setVerbosity({ chatId, threadId, level: requested });
    await this.#reply(chatId, threadId, `Verbosity: ${requested}`);
    return { handled: true, command: '/verbosity', level: requested };
  }

  async #status(chatId, threadId) {
    const binding = this.store.getBinding(chatId, threadId);
    if (!binding) {
      await this.#reply(chatId, threadId, 'Not bound.');
      return { handled: true, command: '/status', bound: false };
    }
    const level = this.store.getVerbosity(chatId, threadId);
    await this.#reply(chatId, threadId, `Session ${shortId(binding.sessionId)} · ${level}`);
    return { handled: true, command: '/status', bound: true, binding };
  }

  async #sessions(chatId, threadId) {
    const sessions = await this.host.listSessions();
    if (sessions.length === 0) {
      await this.#reply(chatId, threadId, 'No sessions.');
      return { handled: true, command: '/sessions', count: 0 };
    }
    const lines = sessions.slice(0, 15).map((session) => {
      const title = session?.projections?.values?.title;
      return `- ${session.sessionId}${title ? ` — ${title}` : ''}`;
    });
    await this.#reply(chatId, threadId, `Sessions:\n${lines.join('\n')}`);
    return { handled: true, command: '/sessions', count: sessions.length };
  }
}
