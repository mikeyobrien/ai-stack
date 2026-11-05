import { DEFAULT_VERBOSITY, VERBOSITY_LEVELS, dmKey } from './state.js';

const HELP = [
  'Telegram session bridge',
  '/bind <session-id> — bind this topic to a session',
  '/new — create and bind a fresh session',
  '/unbind — detach this topic',
  '/verbosity [quiet|normal|verbose] — per-topic output level',
  '/sessions — list session ids',
  '/status — current binding and level',
  '/model [provider/model] — choose this Agent\'s model',
].join('\n');

function shortId(value) {
  return typeof value === 'string' && value.length > 8 ? value.slice(0, 8) : String(value ?? '');
}

function commandName(raw) {
  return raw.replace(/@[A-Za-z0-9_]+$/, '');
}

/**
 * The single gate emoji for a mid-turn decision, or null for idle/answer.
 * Explicit /steer and /queue both use the redirect marker.
 * @param {any} result - owner gate result.
 * @returns {string | null} emoji.
 */
export function gateReactionOf(result) {
  if (result?.gate !== true || result?.running !== true) return null;
  if (result.choice === 'answer') return null;
  if (typeof result.path === 'string' && result.path.startsWith('explicit-')) return '🔀';
  if (result.choice === 'queue') return '⏳';
  if (result.choice === 'steer') return '🔀';
  return null;
}

function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US').format(value) : String(value);
}

/** Operator commands and prompt ingestion for one bound topic. */
export class Commands {
  constructor({ store, bot, host, delivery, presence = null, allowedChatIds = [], logger = console, botId = null, model = null, statusControl = null } = {}) {
    this.store = store;
    this.bot = bot;
    this.host = host;
    this.delivery = delivery;
    this.presence = presence;
    this.allowedChatIds = new Set(allowedChatIds);
    this.logger = logger;
    this.botId = botId;
    this.model = model;
    this.statusControl = statusControl;
    // Per-DM in-flight creation chains: the race-safe latch that turns N
    // simultaneous first messages into one host create plus N adopted prompts.
    this.#dmCreating = new Map();
  }

  #dmCreating = new Map();
  #dmQueue = new Map();
  #serial(id,act){const run=(this.#dmQueue.get(id)??Promise.resolve()).then(act,act);const tail=run.then(()=>{},()=>{});this.#dmQueue.set(id,tail);tail.then(()=>{if(this.#dmQueue.get(id)===tail)this.#dmQueue.delete(id);});return run;}

  #allowed(chatId) {
    return this.allowedChatIds.size > 0 && this.allowedChatIds.has(chatId);
  }

  async #reply(chatId, threadId, text) {
    await this.bot.sendMessage({ chatId, threadId, text });
  }

  /**
   * Private-DM identity: the routing surface is legitimate only when the chat
   * really is a private chat and the human sender is that chat's counterpart
   * (sender id === chat id for ordinary DMs). Anything else fails closed to
   * the topic path. The bridge bot id (when known) completes the stable
   * bot/account + chat + sender identity.
   */
  #dmIdentity(message, chatId) {
    if (message?.chat?.type !== 'private') return null;
    const senderId = message.from?.id;
    if (!Number.isSafeInteger(senderId) || senderId !== chatId) return null;
    if (message.from?.is_bot === true) return null;
    return dmKey({ botId: this.botId, chatId, senderId });
  }

  /**
   * One private-DM turn. First text creates the personal session (exactly one
   * host create no matter how many updates race), later text resumes it, a
   * failed creation leaves the record untouched so the retry starts clean, and
   * prompt identity is the Telegram update so a redelivered update cannot
   * double-prompt.
   */
  async #dmMessage(text, { chatId, message, identity }) {
    const updateId = Number.isSafeInteger(message?.message_id) ? message.message_id : null;
    // The latch key is the DM identity: whichever invocation arrives first
    // while no chain runs performs the single create; everyone else adopts the
    // resulting record, so N racing first messages yield one host create.
    const ensure = async () => {
      const pending = this.#dmCreating.get(identity);
      if (pending) return pending;
      const chain = (async () => {
        const dm = this.store.getDm(identity);
        if (dm?.sessionId) return { sessionId: dm.sessionId, created: false };
        const sessionId = await this.host.createSession();
        const record = await this.store.setDm({ key: identity, sessionId, mode: 'created' });
        return { sessionId: record.sessionId, created: true };
      })().finally(() => {
        if (this.#dmCreating.get(identity) === chain) this.#dmCreating.delete(identity);
      });
      this.#dmCreating.set(identity, chain);
      return chain;
    };

    try {
      const { sessionId, created } = await ensure();
      const requestId = updateId !== null ? `tg-dm:${identity}:${updateId}` : undefined;
      this.delivery.noteOwnPrompt(sessionId, text);
      let gateResult
      try {
        gateResult = await this.host.prompt(sessionId, text, { requestId });
      } catch (error) {
        this.logger?.error?.(`[telegram-session-bridge] prompt failed for ${sessionId}: ${error?.message ?? error}`);
        await this.#reply(chatId, 0, `⚠️ Prompt failed: ${error?.message ?? error}`);
        return { handled: true, reason: 'prompt-failed', sessionId, created, requestId: requestId ?? null };
      }
      // Accepted prompt: one gate emoji replaces the eye for a mid-turn decision;
      // idle/answer keeps the eye. The next turn/end settles it.
      await this.#reactGate(gateResult, {
        sessionId,
        chatId,
        threadId: 0,
        messageId: message?.message_id,
      });
      return { handled: true, prompted: true, sessionId, created, requestId: requestId ?? null };
    } catch (error) {
      // Creation failed: no record was written, so the next text retries cleanly.
      this.logger?.error?.(`[telegram-session-bridge] DM session creation failed for ${identity}: ${error?.message ?? error}`);
      await this.#reply(chatId, 0, '⚠️ Could not start a session; try again in a moment.');
      return { handled: true, reason: 'create-failed', created: false };
    }
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
    if(text.startsWith('/')){const id=threadId===0?this.#dmIdentity(message,chatId):null;const act=()=>this.#command(text,{chatId,threadId,message});return id?this.#serial(id,act):act();}

    const identity = threadId === 0 ? this.#dmIdentity(message, chatId) : null;
    if (threadId === 0 && identity) {
      return this.#serial(identity,()=>this.#dmMessage(text,{chatId,message,identity}));
    }

    const binding = threadId > 0 ? this.store.getBinding(chatId, threadId) : null;
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
    // The watchdog arms on the host's turn/start, never on prompt acceptance:
    // a prompt that throws before a turn exists must not leave a timer that
    // later cancels unrelated queued work.
    let gateResult
    try {
      gateResult = await this.host.prompt(binding.sessionId, text);
    } catch (error) {
      this.logger?.error?.(`[telegram-session-bridge] prompt failed for ${binding.sessionId}: ${error?.message ?? error}`);
      await this.#reply(chatId, threadId, `⚠️ Prompt failed: ${error?.message ?? error}`);
      return { handled: true, reason: 'prompt-failed' };
    }
    // Accepted prompt: one gate emoji replaces the eye for a mid-turn decision;
    // idle/answer keeps the eye. The next turn/end settles it.
    await this.#reactGate(gateResult, {
      sessionId: binding.sessionId,
      chatId,
      threadId,
      messageId: message?.message_id,
    });
    return { handled: true, prompted: true, sessionId: binding.sessionId };
  }

  async #reactGate(result, { sessionId, chatId, threadId = 0, messageId } = {}) {
    const emoji = gateReactionOf(result);
    if (emoji !== null) {
      return this.presence?.reactDecision?.({ sessionId, chatId, threadId, messageId, emoji }) ?? false;
    }
    return this.presence?.reactPrompt?.({ sessionId, chatId, threadId, messageId }) ?? false;
  }

  async #command(text, { chatId, threadId, message }) {
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
        return this.#new(chatId, threadId, { message });
      case '/unbind':
        return this.#unbind(chatId, threadId, { message });
      case '/verbosity':
        return this.#verbosity(chatId, threadId, args);
      case '/status':
        return this.#status(chatId, threadId);
      case '/sessions':
        return this.#sessions(chatId, threadId);
      case '/model':
        return this.#model(chatId, threadId, args, message);
      default:
        await this.#reply(chatId, threadId, 'Unknown command. /help');
        return { handled: true, command: 'unknown' };
    }
  }

  async #model(chatId, threadId, args, message) {
    if (this.model === null || this.model.available !== true) {
      await this.#reply(chatId, threadId, 'Model control is only available for the sidebar Agent.');
      return { handled: true, command: '/model', reason: 'unavailable' };
    }
    if (args.length === 0) return this.model.present({ message });
    if (args.length > 1) {
      await this.#reply(chatId, threadId, 'Use /model (picker) or /model provider/model.');
      return { handled: true, command: '/model', reason: 'bad-form' };
    }
    return this.model.selectCanonical({ message, argument: args[0] });
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

  async #new(chatId, threadId, { message } = {}) {
    // In a private DM, /new replaces only this user's mapping; the old session
    // stays on the host and in the record's previousSessionId.
    if (threadId === 0) {
      const identity = this.#dmIdentity(message, chatId);
      if (!identity) {
        await this.#reply(chatId, threadId, 'Private chats only: the bridge starts a session on your first message.');
        return { handled: true, command: '/new', reason: 'not-private' };
      }
      try {
        const previous = this.store.getDm(identity);
        const sessionId = await this.host.createSession();
        const record = await this.store.setDm({ key: identity, sessionId, mode: 'replaced' });
        if (record.previousSessionId) this.presence?.stopSession(record.previousSessionId);
        await this.#reply(chatId, threadId, `✅ New session ${shortId(sessionId)}`);
        return { handled: true, command: '/new', sessionId, previousSessionId: record.previousSessionId ?? previous?.sessionId ?? null };
      } catch (error) {
        this.logger?.error?.(`[telegram-session-bridge] /new failed for ${identity}: ${error?.message ?? error}`);
        await this.#reply(chatId, threadId, '⚠️ Could not start a new session; try again in a moment.');
        return { handled: true, command: '/new', reason: 'create-failed' };
      }
    }
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
    if (previous?.sessionId) this.presence?.stopSession(previous.sessionId);
    await this.#reply(chatId, threadId, `✅ New session ${shortId(sessionId)}`);
    return { handled: true, command: '/new', binding: result.binding };
  }

  async #unbind(chatId, threadId, { message } = {}) {
    // In a private DM this detaches the personal record; nothing is deleted
    // and the next plain text creates a fresh session.
    if (threadId === 0) {
      const identity = this.#dmIdentity(message, chatId);
      if (!identity) return { handled: true, command: '/unbind', reason: 'not-private' };
      const result = await this.store.unbindDm(identity);
      if (result.removed) this.presence?.stopSession(result.sessionId);
      await this.#reply(chatId, threadId, result.removed ? 'Unbound. Your next message starts a fresh session.' : 'Not bound.');
      return { handled: true, command: '/unbind', removed: result.removed };
    }
    const result = await this.store.unbind({ chatId, threadId });
    if (result.removed) this.presence?.stopSession(result.binding.sessionId);
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
    if (this.statusControl !== null && this.statusControl.available === true
      && typeof this.statusControl.isOwnerSession === 'function'
      && this.statusControl.isOwnerSession(binding.sessionId) === true) {
      let data;
      try {
        data = await this.statusControl.status();
      } catch (error) {
        this.logger?.warn?.(`[telegram-session-bridge] agent status failed: ${error?.message ?? error}`);
        await this.#reply(chatId, threadId, `Binding ${shortId(binding.sessionId)} · ${level}\nAgent status unavailable`);
        return { handled: true, command: '/status', bound: true, binding, agent: true, error: 'status-unavailable' };
      }
      await this.#reply(chatId, threadId, this.#agentStatusText(binding, level, data));
      return { handled: true, command: '/status', bound: true, binding, agent: true };
    }
    await this.#reply(chatId, threadId, `Session ${shortId(binding.sessionId)} · ${level}`);
    return { handled: true, command: '/status', bound: true, binding };
  }

  #agentStatusText(binding, level, data) {
    const lines = [`Binding ${shortId(binding.sessionId)} · ${level}`];
    const model = data?.model;
    lines.push(model === null || model === undefined
      ? 'Model: Unknown'
      : `Model: ${model.provider}/${model.model}${typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '' ? ` · ${model.reasoningEffort}` : ''}`);
    const usage = data?.usage;
    if (usage !== null && usage !== undefined && Number.isFinite(usage.used)) {
      const source = typeof usage.source === 'string' && usage.source !== ''
        ? ` · ${usage.source}${Number.isInteger(usage.seq) ? ` #${usage.seq}` : ''}`
        : '';
      if (Number.isFinite(usage.window) && usage.window > 0) {
        const percent = Number.isFinite(usage.percent) ? usage.percent : Math.round((usage.used / usage.window) * 100);
        const route = typeof usage.provider === 'string' && typeof usage.model === 'string' && model !== null
          && (usage.provider !== model.provider || usage.model !== model.model)
          ? ` · last call ${usage.provider}/${usage.model}`
          : '';
        lines.push(`Context: ${formatNumber(usage.used)} / ${formatNumber(usage.window)} (${percent}%)${source}${route}`);
      } else {
        lines.push(`Context: ${formatNumber(usage.used)} tokens · window unknown${source}`);
      }
    } else {
      const reason = data?.usageReason === 'no-context-window' ? 'context window unavailable' : 'no assistant/message usage';
      lines.push(`Context: Unknown (${reason})`);
    }
    const state = data?.agent?.state;
    lines.push(`Agent: ${state === 'busy' ? 'Busy' : state === 'offline' ? 'Offline' : 'Idle'}`);
    const count = Number.isInteger(data?.delegations?.count) ? data.delegations.count : 0;
    const titles = Array.isArray(data?.delegations?.titles) ? data.delegations.titles.filter((title) => typeof title === 'string' && title !== '') : [];
    const more = Number.isInteger(data?.delegations?.more) ? data.delegations.more : 0;
    lines.push(`Delegations: ${count} running${titles.length === 0 ? '' : ` — ${titles.join(', ')}`}${more > 0 ? ` +${more} more` : ''}`);
    return lines.join('\n');
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
