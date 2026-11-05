import { randomUUID } from 'node:crypto';

/** Callback data namespace for an owner model picker. */
export const MODEL_CALLBACK_PREFIX = 'm';

/** How long a presented picker remains usable. */
export const MODEL_PICKER_TTL_MS = 10 * 60 * 1000;

const MAX_PENDING = 64;
const MAX_PENDING_GLOBAL = 256;

function safeInt(value) {
  return Number.isSafeInteger(value);
}

function buttonLabel(name, id) {
  const label = typeof name === 'string' && name.trim() !== '' ? name.trim() : String(id);
  return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}

function currentText(current, groups) {
  if (current === null || current === undefined || typeof current.provider !== 'string' || typeof current.model !== 'string') {
    return 'Model: unknown';
  }
  const found = (groups ?? []).flatMap((group) => group.models.map((model) => ({ group: group.id, model })))
    .find((entry) => entry.group === current.provider && entry.model.id === current.model);
  const bits = [`${current.provider}/${current.model}`];
  if (found !== undefined && found.model.name !== current.model) bits.push(`(${found.model.name})`);
  if (typeof current.reasoningEffort === 'string' && current.reasoningEffort !== '') bits.push(`· ${current.reasoningEffort}`);
  return `Model: ${bits.join(' ')}`;
}

/**
 * One short-lived inline picker for the sidebar Agent's model catalog. The
 * callback data carries only a random token and an index; the authoritative
 * chat/sender/thread/message/session coordinates and the offered choices stay
 * in this map. The owner control provides the actual current selection and the
 * same setter/persistence the GUI uses.
 */
export class ModelPicker {
  #pending = new Map();

  constructor({ control = null, store, bot, allowedChatIds = [], logger = console, clock = () => Date.now(), ttlMs = MODEL_PICKER_TTL_MS } = {}) {
    this.control = control;
    this.store = store;
    this.bot = bot;
    this.allowedChatIds = new Set(allowedChatIds);
    this.logger = logger;
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  get available() {
    return this.control !== null && this.control !== undefined;
  }

  #allowed(chatId) {
    return safeInt(chatId) && this.allowedChatIds.size > 0 && this.allowedChatIds.has(chatId);
  }

  #authorize(message) {
    if (!this.available) return null;
    const chatId = message?.chat?.id;
    const threadId = message?.message_thread_id ?? 0;
    const senderId = message?.from?.id;
    if (!safeInt(chatId) || !safeInt(senderId) || !safeInt(threadId)) return null;
    if (!this.#allowed(chatId)) return null;
    if (threadId === 0 && (message.chat.type !== 'private' || senderId !== chatId)) return null;
    let binding;
    try {
      binding = this.store.getBinding(chatId, threadId);
    } catch {
      return null;
    }
    if (binding === null || binding === undefined) return null;
    const owner = this.control.sessionId();
    if (typeof owner !== 'string' || binding.sessionId !== owner || this.control.isOwnerSession(binding.sessionId) !== true) return null;
    return { chatId, threadId, senderId, binding };
  }

  #sweep() {
    const now = this.clock();
    for (const [token, pending] of this.#pending) {
      if (now - pending.at > this.ttlMs) this.#pending.delete(token);
    }
    while (this.#pending.size > MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value);
  }

  #remember(pending) {
    this.#pending.set(pending.token, pending);
    this.#sweep();
    while (this.#pending.size > MAX_PENDING_GLOBAL) this.#pending.delete(this.#pending.keys().next().value);
  }

  async #choices() {
    const catalog = await this.control.catalog();
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    const choices = [];
    for (const group of groups) {
      for (const model of Array.isArray(group.models) ? group.models : []) {
        if (typeof group.id !== 'string' || typeof model.id !== 'string') continue;
        choices.push({ provider: group.id, model: model.id, name: model.name, reasoning: model.reasoning });
      }
    }
    return { groups, choices, current: this.control.current() };
  }

  async present({ message } = {}) {
    const auth = this.#authorize(message);
    if (auth === null) {
      await this.#reply(message, 'Model control is only available for the bound sidebar Agent.');
      return { handled: true, command: '/model', reason: 'not-agent-binding' };
    }
    let model;
    try {
      model = await this.#choices();
    } catch (error) {
      await this.#reply(message, `⚠️ Could not read models: ${error?.message ?? error}`);
      return { handled: true, command: '/model', reason: 'catalog-failed' };
    }
    if (model.choices.length === 0) {
      await this.#reply(message, 'No models available.');
      return { handled: true, command: '/model', reason: 'no-models' };
    }
    const token = randomUUID();
    const rows = [];
    for (let index = 0; index < model.choices.length; index += 2) {
      rows.push(model.choices.slice(index, index + 2).map((choice, offset) => ({
        text: buttonLabel(choice.name, choice.model),
        callback_data: `m:${token}:${index + offset}`,
      })));
    }
    const pending = {
      token,
      chatId: auth.chatId,
      threadId: auth.threadId,
      senderId: auth.senderId,
      messageId: undefined,
      sessionId: this.control.sessionId(),
      choices: model.choices,
      at: this.clock(),
    };
    try {
      const sent = await this.bot.sendMessage({
        chatId: auth.chatId,
        threadId: auth.threadId,
        text: currentText(model.current, model.groups),
        replyMarkup: { inline_keyboard: rows },
      });
      pending.messageId = safeInt(sent?.[0]?.message_id) ? sent[0].message_id : undefined;
      this.#remember(pending);
      return { handled: true, command: '/model', presented: true, messageId: pending.messageId, choices: model.choices.length };
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] model picker delivery failed: ${error?.message ?? error}`);
      await this.#reply(message, `⚠️ Could not show models: ${error?.message ?? error}`);
      return { handled: true, command: '/model', reason: 'picker-failed' };
    }
  }

  #effortFor(choice, current) {
    const reasoning = choice?.reasoning;
    if (reasoning === null || reasoning === undefined) return null;
    const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts.map((effort) => effort.id) : [];
    if (typeof current?.reasoningEffort === 'string' && current.reasoningEffort !== '' && efforts.includes(current.reasoningEffort)) {
      return current.reasoningEffort;
    }
    if (typeof reasoning.defaultEffort === 'string' && efforts.includes(reasoning.defaultEffort)) return reasoning.defaultEffort;
    return null;
  }

  async selectCanonical({ message, argument } = {}) {
    const auth = this.#authorize(message);
    if (auth === null) {
      await this.#reply(message, 'Model control is only available for the bound sidebar Agent.');
      return { handled: true, command: '/model', reason: 'not-agent-binding' };
    }
    const text = typeof argument === 'string' ? argument.trim() : '';
    const slash = text.indexOf('/');
    if (slash <= 0 || slash === text.length - 1) {
      await this.#reply(message, 'Use /model (picker) or /model provider/model.');
      return { handled: true, command: '/model', reason: 'bad-form' };
    }
    const provider = text.slice(0, slash);
    const model = text.slice(slash + 1);
    let catalog;
    try {
      catalog = await this.#choices();
    } catch (error) {
      await this.#reply(message, `⚠️ Could not read models: ${error?.message ?? error}`);
      return { handled: true, command: '/model', reason: 'catalog-failed' };
    }
    const choice = catalog.choices.find((entry) => entry.provider === provider && entry.model === model);
    if (choice === undefined) {
      await this.#reply(message, `Unknown model ${JSON.stringify(text)}. Use /model to choose.`);
      return { handled: true, command: '/model', reason: 'unknown-model' };
    }
    try {
      const result = await this.control.select({ provider, model, reasoningEffort: this.#effortFor(choice, catalog.current) });
      await this.#reply(message, this.#successText(result?.model ?? { provider, model }));
      return { handled: true, command: '/model', selected: result?.model };
    } catch (error) {
      await this.#reply(message, `⚠️ Model switch failed: ${error?.message ?? error}`);
      return { handled: true, command: '/model', reason: 'setter-failed' };
    }
  }

  #successText(selection) {
    if (selection === null || selection === undefined) return '✅ Model set.';
    const effort = typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '' ? ` · ${selection.reasoningEffort}` : '';
    return `✅ Model set: ${selection.provider}/${selection.model}${effort}`;
  }

  async #reply(message, text) {
    const chatId = message?.chat?.id;
    const threadId = message?.message_thread_id ?? 0;
    if (!safeInt(chatId)) return;
    try {
      await this.bot.sendMessage({ chatId, threadId, text });
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] model reply failed: ${error?.message ?? error}`);
    }
  }

  async #answer(query, text, showAlert = false) {
    if (!query?.id) return;
    try {
      await this.bot.answerCallbackQuery({ callbackQueryId: query.id, text, showAlert });
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] model callback answer failed: ${error?.message ?? error}`);
    }
  }

  async #editButtonMessage(query, text) {
    const message = query?.message;
    const chatId = message?.chat?.id;
    if (!safeInt(chatId) || !safeInt(message?.message_id)) return;
    try {
      await this.bot.editMessageText({
        chatId,
        threadId: message.message_thread_id ?? 0,
        messageId: message.message_id,
        text,
        replyMarkup: { inline_keyboard: [] },
      });
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] model picker edit failed: ${error?.message ?? error}`);
    }
  }

  async handleCallback(query) {
    const data = typeof query?.data === 'string' ? query.data : '';
    const [kind, token, indexText] = data.split(':');
    if (kind !== MODEL_CALLBACK_PREFIX || typeof token !== 'string' || token === '') {
      await this.#answer(query, 'Unsupported model response', true);
      return { accepted: false, reason: 'bad-callback' };
    }
    this.#sweep();
    const pending = this.#pending.get(token);
    if (pending === undefined) {
      await this.#answer(query, 'This model picker is no longer active', true);
      return { accepted: false, reason: 'not-pending' };
    }
    const chatId = query?.message?.chat?.id;
    const threadId = query?.message?.message_thread_id ?? 0;
    const senderId = query?.from?.id;
    const messageId = query?.message?.message_id;
    if (!safeInt(chatId) || !safeInt(senderId) || !this.#allowed(chatId)
      || chatId !== pending.chatId || threadId !== pending.threadId || senderId !== pending.senderId
      || !safeInt(pending.messageId) || messageId !== pending.messageId) {
      await this.#answer(query, 'This model picker is not active for this chat', true);
      return { accepted: false, reason: 'wrong-scope' };
    }
    let binding;
    try {
      binding = this.store.getBinding(chatId, threadId);
    } catch {
      binding = null;
    }
    const owner = this.control.sessionId();
    if (binding?.sessionId !== pending.sessionId || owner !== pending.sessionId || this.control.isOwnerSession(pending.sessionId) !== true) {
      await this.#answer(query, 'This model picker belongs to a previous Agent binding', true);
      return { accepted: false, reason: 'stale' };
    }
    const index = Number(indexText);
    const choice = Number.isInteger(index) && index >= 0 ? pending.choices[index] : undefined;
    if (choice === undefined) {
      await this.#answer(query, 'Unsupported model choice', true);
      return { accepted: false, reason: 'bad-choice' };
    }
    // One-shot before the async setter: a replayed callback cannot apply twice.
    this.#pending.delete(token);
    try {
      const result = await this.control.select({
        provider: choice.provider,
        model: choice.model,
        reasoningEffort: this.#effortFor(choice, this.control.current()),
      });
      await this.#answer(query, 'Model set');
      await this.#editButtonMessage(query, this.#successText(result?.model ?? choice));
      return { accepted: true, kind: 'model', selection: result?.model, provider: choice.provider, model: choice.model };
    } catch (error) {
      await this.#answer(query, `Model switch failed: ${error?.message ?? error}`, true);
      await this.#editButtonMessage(query, `⚠️ Model switch failed: ${error?.message ?? error}`);
      return { accepted: false, reason: 'setter-failed' };
    }
  }
}

/** The slash command discovery entry for the owner model picker. */
export const MODEL_COMMAND = Object.freeze({ command: 'model', description: "Choose this Agent's model" });

/**
 * Merge our command into an existing Telegram command list without dropping
 * custom commands. An existing `model` entry keeps its position but gets the
 * description that matches the owner implementation now serving it.
 * @param {Array<{command: string, description: string}>} existing - current commands.
 * @param {{command: string, description: string}} [addition] - owner command.
 * @returns {Array<{command: string, description: string}>} merged command list.
 */
export function mergeCommands(existing, addition = MODEL_COMMAND) {
  const merged = [];
  const seen = new Set();
  for (const entry of Array.isArray(existing) ? existing : []) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.command !== 'string' || entry.command === '') continue;
    if (seen.has(entry.command)) continue;
    seen.add(entry.command);
    merged.push({
      command: entry.command,
      description: entry.command === addition.command ? addition.description : String(entry.description ?? ''),
    });
  }
  if (!seen.has(addition.command)) merged.push({ ...addition });
  return merged;
}

async function getCommands(api, params) {
  const result = await api.call('getMyCommands', params);
  return Array.isArray(result) ? result : [];
}

/**
 * Publish the owner model command into each authorized Agent-bound private
 * chat's command scope. Reads default/private/chat lists first, merges all
 * existing names, and sets only the individual chat scope. It never writes the
 * default, all-private, administrator or group scopes, and leaves a custom
 * web-app menu button untouched. Uses the bridge's existing public Bot API.
 * @param {object} options - registration inputs.
 * @param {any} options.api - composed TelegramBotApi.
 * @param {any} options.store - binding store.
 * @param {any} options.control - owner modelControl.
 * @param {Iterable<number>} [options.allowedChatIds] - fail-closed allowlist.
 * @param {Record<string, any>} [options.logger] - logger.
 * @param {number} [options.chatId] - explicit chat to register (tests).
 * @returns {Promise<{registered: boolean, chats: Array<Record<string, any>>, reason?: string}>} outcome.
 */
export async function registerModelCommands({ api, store, control, allowedChatIds = [], logger = console, chatId, clock = () => Date.now() } = {}) {
  if (control === null || control === undefined || typeof control.sessionId !== 'function') {
    return { registered: false, chats: [], reason: 'no-owner-control' };
  }
  const owner = control.sessionId();
  if (typeof owner !== 'string') return { registered: false, chats: [], reason: 'no-owner-session' };
  const allowed = new Set(allowedChatIds);
  const records = (() => {
    try {
      return store.listBindings();
    } catch {
      return [];
    }
  })();
  const targets = [];
  if (Number.isSafeInteger(chatId)) {
    targets.push(chatId);
  } else {
    for (const record of records) {
      if (typeof record?.key !== 'string' || !record.key.startsWith('dm:')) continue;
      if (record.sessionId !== owner) continue;
      if (!Number.isSafeInteger(record.chatId) || record.senderId !== record.chatId) continue;
      if (allowed.size > 0 && !allowed.has(record.chatId)) continue;
      if (!targets.includes(record.chatId)) targets.push(record.chatId);
    }
  }
  if (targets.length === 0) return { registered: false, chats: [], reason: 'no-agent-bound-dm' };

  const chats = [];
  for (const target of targets) {
    try {
      const [defaults, privateScope, chatScope] = await Promise.all([
        getCommands(api, {}),
        getCommands(api, { scope: { type: 'all_private_chats' } }),
        getCommands(api, { scope: { type: 'chat', chat_id: target } }),
      ]);
      // Chat scope wins by name, then the private scope, then default. This
      // keeps every custom command visible even when a chat scope is partial.
      const combined = [];
      const seen = new Set();
      for (const entry of [...chatScope, ...privateScope, ...defaults]) {
        if (typeof entry?.command !== 'string' || entry.command === '' || seen.has(entry.command)) continue;
        seen.add(entry.command);
        combined.push(entry);
      }
      const merged = mergeCommands(combined);
      await api.call('setMyCommands', { commands: merged, scope: { type: 'chat', chat_id: target } });
      // Never trust the setter's boolean: read the effective chat scope back.
      const readback = await getCommands(api, { scope: { type: 'chat', chat_id: target } });
      const modelEntry = readback.find((entry) => entry?.command === MODEL_COMMAND.command) ?? null;
      const confirmed = modelEntry?.description === MODEL_COMMAND.description;
      let menu = null;
      try {
        menu = await api.call('getChatMenuButton', { chat_id: target });
      } catch (error) {
        logger?.warn?.(`[telegram-session-bridge] getChatMenuButton failed for ${target}: ${error?.message ?? error}`);
      }
      chats.push({
        chatId: target,
        scope: `chat:${target}`,
        commands: readback.length,
        modelCommand: modelEntry === null ? null : { command: modelEntry.command, description: modelEntry.description },
        confirmed,
        menu: menu?.type ?? 'unknown',
        checkedAt: new Date(clock()).toISOString(),
        ...(confirmed ? {} : { error: 'readback-missing' }),
      });
    } catch (error) {
      logger?.warn?.(`[telegram-session-bridge] model command registration failed for ${target}: ${error?.message ?? error}`);
      chats.push({ chatId: target, error: String(error?.message ?? error) });
    }
  }
  return {
    registered: chats.length > 0 && chats.every((entry) => entry.confirmed === true),
    checkedAt: chats[0]?.checkedAt ?? new Date(clock()).toISOString(),
    chats,
  };
}
