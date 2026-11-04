import { chunkText, TELEGRAM_MAX_TEXT } from './chunk.js';
import { sleep } from './util.js';

export class BotApiError extends Error {
  constructor(message, { method, status, code, retryAfter, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BotApiError';
    this.method = method;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Telegram message_thread_id rules: topic 0 is invalid, the General topic (1)
 * is addressed by sending to the chat itself, and every other topic id must be
 * carried on the message.
 */
export function topicParams(threadId) {
  if (!Number.isSafeInteger(threadId) || threadId <= 0) return {};
  if (threadId === 1) return {};
  return { message_thread_id: threadId };
}

/** Minimal Bot API client over global fetch; zero runtime dependencies. */
export class TelegramBotApi {
  constructor({
    token,
    baseUrl = 'https://api.telegram.org',
    fetchImpl = globalThis.fetch,
    logger = console,
    maxRetries = 2,
    maxTextChars = TELEGRAM_MAX_TEXT,
  } = {}) {
    if (typeof token !== 'string' || !token) throw new TypeError('TelegramBotApi requires a bot token');
    if (typeof fetchImpl !== 'function') throw new TypeError('TelegramBotApi requires fetch');
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.maxTextChars = maxTextChars;
  }

  #url(method) {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  async call(method, params = {}, { signal } = {}) {
    let attempt = 0;
    for (;;) {
      let response;
      try {
        response = await this.fetchImpl(this.#url(method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt < this.maxRetries) {
          attempt += 1;
          await sleep(100 * attempt);
          continue;
        }
        throw new BotApiError(`Telegram ${method} request failed: ${error?.message ?? error}`, {
          method,
          code: 'network',
          cause: error,
        });
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.ok && body?.ok === true) return body.result;
      const retryAfter = body?.parameters?.retry_after;
      if ((response.status === 429 || retryAfter) && attempt < this.maxRetries) {
        attempt += 1;
        await sleep(Math.min(1000 * (retryAfter ?? 1), 5000));
        continue;
      }
      throw new BotApiError(
        `Telegram ${method} failed (${response.status}): ${body?.description ?? 'no description'}`,
        { method, status: response.status, retryAfter, code: body?.error_code },
      );
    }
  }

  getMe(options) {
    return this.call('getMe', {}, options);
  }

  getUpdates({ offset = 0, timeoutSec = 0, allowedUpdates = ['message', 'callback_query'] } = {}, { signal } = {}) {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: allowedUpdates },
      { signal },
    );
  }

  async sendMessage({
    chatId,
    threadId = 0,
    text,
    replyMarkup,
    disableNotification = false,
    signal,
  } = {}) {
    if (!Number.isSafeInteger(chatId)) throw new TypeError('sendMessage requires an integer chatId');
    const chunks = chunkText(String(text ?? ''), this.maxTextChars);
    const sent = [];
    for (const chunk of chunks) {
      const params = { chat_id: chatId, text: chunk, ...topicParams(threadId) };
      if (replyMarkup) params.reply_markup = replyMarkup;
      if (disableNotification) params.disable_notification = true;
      sent.push(await this.call('sendMessage', params, { signal }));
    }
    return sent;
  }

  async editMessageText({
    chatId,
    threadId = 0,
    messageId,
    text,
    replyMarkup,
    signal,
  } = {}) {
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...topicParams(threadId),
    };
    if (replyMarkup) params.reply_markup = replyMarkup;
    return this.call('editMessageText', params, { signal });
  }

  answerCallbackQuery({ callbackQueryId, text, showAlert = false, signal } = {}) {
    const params = { callback_query_id: callbackQueryId };
    if (text) params.text = text;
    if (showAlert) params.show_alert = true;
    return this.call('answerCallbackQuery', params, { signal });
  }
}
