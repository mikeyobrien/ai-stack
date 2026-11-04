import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chunkText, TELEGRAM_MAX_TEXT } from '../src/chunk.js';
import { openBindingStore } from '../src/state.js';
import { TelegramBotApi, topicParams } from '../src/telegram.js';
import { UpdatePoller, updateDedupeKey } from '../src/poller.js';
import { resolveConfig } from '../src/config.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import { makeTempDir, messageUpdate, removeDir } from './helpers/fixtures.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function setup(t, { replayAll = false } = {}) {
  const dir = await makeTempDir();
  const bot = await new FakeBotApi({ replayAll }).start();
  t.after(async () => {
    await bot.stop();
    await removeDir(dir);
  });
  const file = join(dir, 'telegram-session-bridge', 'state.json');
  const store = await openBindingStore({ file, logger: silentLogger });
  const api = new TelegramBotApi({ token: bot.token, baseUrl: bot.baseUrl });
  return { dir, file, bot, store, api };
}

test('[transport] long assistant text is chunked at the Telegram limit without loss', async (t) => {
  const { bot, api } = await setup(t);
  const paragraph = 'line of answer text\n';
  const text = paragraph.repeat(400) + 'x'.repeat(5000);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= TELEGRAM_MAX_TEXT);
    assert.ok(chunk.isWellFormed());
  }
  assert.equal(chunks.join(''), text);

  await api.sendMessage({ chatId: 111, threadId: 42, text });
  assert.equal(bot.messages.length, chunks.length);
  assert.equal(bot.messages.map((message) => message.text).join(''), text);
  for (const message of bot.messages) assert.ok(message.text.length <= TELEGRAM_MAX_TEXT);
});

test('[transport] chunking never splits a surrogate pair', () => {
  const text = '🙂'.repeat(3000);
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= TELEGRAM_MAX_TEXT);
    assert.ok(chunk.isWellFormed());
  }
  assert.equal(chunks.join(''), text);
});

test('[transport] duplicate updates are suppressed across a simulated restart', async (t) => {
  const { file, bot, store, api } = await setup(t, { replayAll: true });
  const update = messageUpdate({ updateId: 7, chatId: 111, threadId: 42, messageId: 70, text: 'hello' });
  bot.pushUpdate(update);
  let handled = 0;
  const onUpdate = async () => {
    handled += 1;
  };

  const first = new UpdatePoller({ api, store, onUpdate, logger: silentLogger, timeoutSec: 0 });
  await first.pollOnce();
  assert.equal(handled, 1);
  assert.equal(store.getOffset(), 8);

  // Simulate a crash after acknowledge: a fresh process replays the same batch.
  const reloaded = await openBindingStore({ file, logger: silentLogger });
  const second = new UpdatePoller({ api, store: reloaded, onUpdate, logger: silentLogger, timeoutSec: 0 });
  await second.pollOnce();
  assert.equal(handled, 1, 'the dedupe ledger survived the restart');
  assert.equal(reloaded.getOffset(), 8);
  assert.equal(bot.getUpdatesCalls.at(-1).offset, 8);
});

test('[transport] dedupe keys include both chat and thread', async (t) => {
  const { bot, store, api } = await setup(t);
  let handled = 0;
  const poller = new UpdatePoller({
    api,
    store,
    onUpdate: async () => {
      handled += 1;
    },
    logger: silentLogger,
    timeoutSec: 0,
  });
  const base = { chatId: 111, threadId: 42, messageId: 70 };
  bot.pushUpdate(messageUpdate({ ...base, updateId: 1 }));
  bot.pushUpdate(messageUpdate({ ...base, updateId: 2, threadId: 43 }));

  assert.equal(updateDedupeKey(messageUpdate({ ...base, updateId: 1 })), 'message:111:42:70');
  assert.notEqual(
    updateDedupeKey(messageUpdate({ ...base, updateId: 2, threadId: 43 })),
    updateDedupeKey(messageUpdate({ ...base, updateId: 1 })),
  );
  await poller.pollOnce();
  assert.equal(handled, 2);
  assert.equal(store.getOffset(), 3);
});

test('[transport] the General topic omits message_thread_id on send, numbered topics keep it', async () => {
  assert.deepEqual(topicParams(0), {});
  assert.deepEqual(topicParams(1), {});
  assert.deepEqual(topicParams(42), { message_thread_id: 42 });
});

test('[transport] sendMessage and getUpdates carry the real Bot API parameters', async (t) => {
  const { bot, store, api } = await setup(t);
  await store.bind({ chatId: 111, threadId: 1, sessionId: 'session-general', managedMode: 'auto' });

  await api.sendMessage({ chatId: 111, threadId: 1, text: 'general' });
  await api.sendMessage({ chatId: 111, threadId: 42, text: 'topic' });
  assert.equal(bot.messages[0].message_thread_id, undefined);
  assert.equal(bot.messages[1].message_thread_id, 42);

  const poller = new UpdatePoller({ api, store, onUpdate: async () => {}, logger: silentLogger, timeoutSec: 3 });
  await poller.pollOnce();
  assert.deepEqual(bot.getUpdatesCalls[0], {
    offset: 0,
    timeout: 3,
    allowed_updates: ['message', 'callback_query'],
  });
});

test('[transport] tokenRef is an env credential and never dsh-im\'s bot identity', () => {
  const ok = resolveConfig(
    { tokenRef: 'BRIDGE_TOKEN', dshHome: '/tmp/example-dsh-home' },
    { BRIDGE_TOKEN: '123:bridge-token' },
  );
  assert.equal(ok.token, '123:bridge-token');
  assert.equal(ok.stateFile, '/tmp/example-dsh-home/telegram-session-bridge/state.json');

  assert.throws(
    () => resolveConfig({ tokenRef: 'BRIDGE_TOKEN' }, {}),
    (error) => error.code === 'token-missing' && /BRIDGE_TOKEN/.test(error.message) && !/123:/.test(error.message),
  );
  assert.throws(
    () => resolveConfig({ tokenRef: '../integrations/dsh-telegram/config.json' }, { }),
    (error) => error.code === 'token-ref-invalid',
  );
  assert.throws(
    () => resolveConfig({ tokenRef: 'DSH_IM_BOT_TOKEN' }, { DSH_IM_BOT_TOKEN: 'dsh-im' }),
    (error) => error.code === 'token-ref-conflict',
  );
});
