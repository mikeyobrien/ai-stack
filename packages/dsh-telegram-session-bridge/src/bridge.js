import { resolveConfig } from './config.js';
import { openBindingStore } from './state.js';
import { TelegramBotApi } from './telegram.js';
import { UpdatePoller } from './poller.js';
import { createHostAdapter } from './host.js';
import { Delivery } from './delivery.js';
import { Interactions } from './interactions.js';
import { Watchdog } from './watchdog.js';
import { Commands } from './commands.js';

/**
 * Compose the bridge outside cordis. This is the seam the tests drive with a
 * fake host and a fake Bot API on 127.0.0.1; `apply` in index.js is the thin
 * cordis adapter over the same object.
 */
export async function createBridge({
  config = {},
  env = process.env,
  services = {},
  fetchImpl,
  logger = console,
  clock = () => Date.now(),
  scheduler,
} = {}) {
  const options = resolveConfig(config, env);
  const store = await openBindingStore({
    file: options.stateFile,
    clock,
    logger,
    dedupeRetentionMs: options.dedupeRetentionMs,
    dedupeMaxEntries: options.dedupeMaxEntries,
  });
  const api = new TelegramBotApi({
    token: options.token,
    baseUrl: options.baseUrl,
    fetchImpl,
    logger,
    maxTextChars: options.maxChunkChars,
  });
  const host = createHostAdapter(services, { logger });
  const delivery = new Delivery({ store, bot: api, logger, clock });
  const watchdog = new Watchdog({
    store,
    bot: api,
    cancel: (sessionId) => host.cancel(sessionId),
    timeoutMs: options.stallTimeoutMs,
    ...(scheduler ? { scheduler } : {}),
    logger,
  });
  delivery.watchdog = watchdog;
  const interactions = new Interactions({ store, bot: api, logger, clock });
  const commands = new Commands({
    store,
    bot: api,
    host,
    delivery,
    watchdog,
    allowedChatIds: options.allowedChatIds,
    logger,
  });
  const abort = new AbortController();
  const poller = new UpdatePoller({
    api,
    store,
    logger,
    timeoutSec: options.pollTimeoutSec,
    signal: abort.signal,
    // Closes over the composed bridge below; called only after it exists.
    onUpdate: (update) => bridge.handleUpdate(update),
  });

  const bridge = {
    options,
    store,
    api,
    host,
    delivery,
    interactions,
    watchdog,
    commands,
    poller,
    started: false,
    capabilities: null,

    async handleUpdate(update) {
      if (update?.message) return commands.handleMessage(update.message);
      if (update?.callback_query) return interactions.handleCallback(update.callback_query);
      return { handled: false, reason: 'unsupported-update' };
    },

    async handleSessionEvent(session, event) {
      return delivery.handleSessionEvent(session, event);
    },

    handleApproval(request, next) {
      return interactions.handleApproval(request, next);
    },

    handleQuestion(request, next) {
      return interactions.handleQuestion(request, next);
    },

    pollOnce() {
      return poller.pollOnce();
    },

    async start() {
      if (this.started) return;
      this.started = true;
      try {
        this.capabilities = await api.getMe();
        if (this.capabilities?.has_topics_enabled === false) {
          logger?.warn?.(
            '[telegram-session-bridge] bot reports has_topics_enabled=false; enable topics for this bot before binding',
          );
        }
      } catch (error) {
        logger?.warn?.(`[telegram-session-bridge] getMe failed; continuing: ${error?.message ?? error}`);
      }
      if (this.options.poll) void poller.run();
    },

    async stop() {
      abort.abort();
      watchdog.stop();
      await poller.stop();
    },
  };
  return bridge;
}
