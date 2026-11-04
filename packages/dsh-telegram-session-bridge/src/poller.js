import { sleep } from './util.js';

/**
 * Dedupe identity for one inbound update. Telegram may redeliver an update
 * after a crash, so the ledger is keyed by (chat, thread) plus the message (or
 * callback) identity, not by update order alone.
 */
export function updateDedupeKey(update) {
  if (!update || typeof update !== 'object') return null;
  const callback = update.callback_query;
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const threadId = callback.message?.message_thread_id ?? 0;
    if (typeof chatId === 'number' && typeof callback.id === 'string') {
      return `callback:${chatId}:${threadId}:${callback.id}`;
    }
    return Number.isSafeInteger(update.update_id) ? `update:${update.update_id}` : null;
  }
  const message = update.message ?? update.edited_message;
  if (message) {
    const chatId = message.chat?.id;
    const threadId = message.message_thread_id ?? 0;
    if (typeof chatId === 'number' && Number.isSafeInteger(message.message_id)) {
      return `message:${chatId}:${threadId}:${message.message_id}`;
    }
  }
  return Number.isSafeInteger(update.update_id) ? `update:${update.update_id}` : null;
}

/**
 * Long-poll driver: getUpdates -> durable ack (dedupe + offset) -> handler.
 * The ack happens before dispatch, so an interrupted handler is retried by
 * Telegram while a restart cannot replay an already-acknowledged update twice.
 */
export class UpdatePoller {
  constructor({
    api,
    store,
    onUpdate,
    logger = console,
    timeoutSec = 25,
    idleDelayMs = 250,
    signal,
  } = {}) {
    if (typeof onUpdate !== 'function') throw new TypeError('UpdatePoller requires onUpdate');
    this.api = api;
    this.store = store;
    this.onUpdate = onUpdate;
    this.logger = logger;
    this.timeoutSec = timeoutSec;
    this.idleDelayMs = idleDelayMs;
    this.signal = signal;
    this.running = null;
  }

  async pollOnce() {
    const updates = await this.api.getUpdates(
      {
        offset: this.store.getOffset(),
        timeoutSec: this.timeoutSec,
        allowedUpdates: ['message', 'callback_query'],
      },
      { signal: this.signal },
    );
    const batch = Array.isArray(updates) ? updates : [];
    for (const update of batch) {
      await this.#dispatch(update);
    }
    return batch.length;
  }

  async #dispatch(update) {
    const key = updateDedupeKey(update);
    const receipt = await this.store.ackInbound({ key, updateId: update?.update_id });
    if (receipt.duplicate) {
      this.logger?.debug?.(`[telegram-session-bridge] duplicate update suppressed (${key})`);
      return;
    }
    try {
      await this.onUpdate(update);
    } catch (error) {
      this.logger?.error?.(`[telegram-session-bridge] update handler failed: ${error?.message ?? error}`);
    }
  }

  run() {
    if (this.running) return this.running;
    this.running = (async () => {
      while (!this.signal?.aborted) {
        try {
          const count = await this.pollOnce();
          if (count === 0) await sleep(this.idleDelayMs, this.signal);
        } catch (error) {
          if (this.signal?.aborted) return;
          this.logger?.error?.(`[telegram-session-bridge] poll failed: ${error?.message ?? error}`);
          await sleep(1000, this.signal);
        }
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async stop() {
    const running = this.running;
    this.running = null;
    await running?.catch(() => undefined);
  }
}
