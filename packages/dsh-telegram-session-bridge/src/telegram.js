import { chunkText, TELEGRAM_MAX_TEXT } from './chunk.js';
import { chunkRenderedHtml, htmlToPlain, renderMarkdown } from './render.js';
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

/** Telegram's 400 when the HTML parser rejects the entity markup. */
function isParseEntitiesError(error) {
  return error?.status === 400 && /can'?t parse entities/i.test(String(error?.message ?? ''));
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

  /** Resolve one Telegram file id to its file_path/size. */
  getFile(fileId, options) {
    if (typeof fileId !== 'string' || fileId === '') throw new TypeError('getFile requires a file_id');
    return this.call('getFile', { file_id: fileId }, options);
  }

  /** Download one resolved Telegram file without exposing the bot token to callers. */
  async downloadFile(filePath, { signal } = {}) {
    if (typeof filePath !== 'string' || filePath === '') throw new TypeError('downloadFile requires a file_path');
    const response = await this.fetchImpl(`${this.baseUrl}/file/bot${this.token}/${filePath.replace(/^\/+/, '')}`, { signal });
    if (!response.ok) {
      throw new BotApiError(`Telegram file download failed (${response.status})`, {
        method: 'downloadFile',
        status: response.status,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
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

  /**
   * Send one assistant answer as Telegram HTML. Markdown is rendered first and
   * chunked with balanced tags; only this path sets `parse_mode`, so short
   * operational lines stay plain text and are never parsed as HTML.
   *
   * If Telegram rejects the markup (400 "can't parse entities"), that chunk is
   * retried once without `parse_mode` using its plain-text form: content is
   * never lost to a renderer bug the API rejects.
   */
  async sendMarkdown({
    chatId,
    threadId = 0,
    text,
    replyMarkup,
    disableNotification = false,
    signal,
  } = {}) {
    if (!Number.isSafeInteger(chatId)) throw new TypeError('sendMarkdown requires an integer chatId');
    const chunks = chunkRenderedHtml(renderMarkdown(text), this.maxTextChars);
    const sent = [];
    for (const chunk of chunks) {
      const params = { chat_id: chatId, ...topicParams(threadId) };
      if (replyMarkup) params.reply_markup = replyMarkup;
      if (disableNotification) params.disable_notification = true;
      try {
        sent.push(await this.call('sendMessage', { ...params, text: chunk, parse_mode: 'HTML' }, { signal }));
      } catch (error) {
        if (!isParseEntitiesError(error)) throw error;
        this.logger?.warn?.(
          `[telegram-session-bridge] Telegram rejected HTML markup; falling back to plain text: ${error?.message ?? error}`,
        );
        sent.push(await this.call('sendMessage', { ...params, text: htmlToPlain(chunk) }, { signal }));
      }
    }
    return sent;
  }

  /**
   * Typing presence only: Telegram expires a chat action after a few seconds,
   * so callers refresh it while the turn runs.
   */
  sendChatAction({ chatId, threadId = 0, action = 'typing', signal } = {}) {
    if (!Number.isSafeInteger(chatId)) throw new TypeError('sendChatAction requires an integer chatId');
    return this.call('sendChatAction', { chat_id: chatId, ...topicParams(threadId), action }, { signal });
  }

  setMessageReaction({ chatId, messageId, reaction, signal } = {}) {
    if (!Number.isSafeInteger(chatId)) throw new TypeError('setMessageReaction requires an integer chatId');
    return this.call(
      'setMessageReaction',
      { chat_id: chatId, message_id: messageId, reaction },
      { signal },
    );
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
