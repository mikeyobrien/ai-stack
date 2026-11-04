import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBindingStore } from '../src/state.js';
import { TelegramBotApi } from '../src/telegram.js';
import { Delivery } from '../src/delivery.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import { assistantEvent, makeTempDir, removeDir, toolCallEvent } from './helpers/fixtures.js';

const CHAT = 111;
const THREAD = 42;
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function setup(t) {
  const dir = await makeTempDir();
  const bot = await new FakeBotApi().start();
  t.after(async () => {
    await bot.stop();
    await removeDir(dir);
  });
  const file = join(dir, 'telegram-session-bridge', 'state.json');
  const store = await openBindingStore({ file, logger: silentLogger });
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });
  const api = new TelegramBotApi({ token: bot.token, baseUrl: bot.baseUrl });
  const delivery = new Delivery({ store, bot: api, logger: silentLogger });
  return { dir, bot, store, api, delivery, file };
}

test('[M7] verbosity defaults to quiet per topic and persists across a reload', async (t) => {
  const { store, file } = await setup(t);
  assert.equal(store.getVerbosity(CHAT, THREAD), 'quiet');
  assert.equal(store.getVerbosity(CHAT, 99), 'quiet');

  await store.setVerbosity({ chatId: CHAT, threadId: THREAD, level: 'normal' });
  assert.equal(store.getVerbosity(CHAT, THREAD), 'normal');
  assert.equal(store.getVerbosity(CHAT, 99), 'quiet');

  const reloaded = await openBindingStore({ file, logger: silentLogger });
  assert.equal(reloaded.getVerbosity(CHAT, THREAD), 'normal');
});

test('[M7] quiet delivers finals only; normal adds tool digests; verbose adds thinking digests', async (t) => {
  const { bot, store, delivery } = await setup(t);
  const session = { id: 'session-a' };

  await delivery.handleSessionEvent(session, toolCallEvent('bash', { command: 'ls' }));
  assert.equal(bot.messages.length, 0, 'quiet hides tool activity');

  await delivery.handleSessionEvent(session, assistantEvent('the answer'));
  assert.equal(bot.messages.length, 1);
  assert.equal(bot.messages[0].text, 'the answer');

  await store.setVerbosity({ chatId: CHAT, threadId: THREAD, level: 'normal' });
  await delivery.handleSessionEvent(session, toolCallEvent('bash', { command: 'ls' }));
  assert.equal(bot.messages.length, 2);
  assert.match(bot.messages[1].text, /^⚙ bash /);

  await store.setVerbosity({ chatId: CHAT, threadId: THREAD, level: 'verbose' });
  await delivery.handleSessionEvent(session, {
    type: 'assistant/thinking',
    seq: 12,
    data: { text: 'checking the filesystem first' },
  });
  assert.equal(bot.messages.length, 3);
  assert.match(bot.messages[2].text, /^✎ checking the filesystem first/);
});

test('[M7] a higher level still delivers the final answer', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.setVerbosity({ chatId: CHAT, threadId: THREAD, level: 'verbose' });
  await delivery.handleSessionEvent({ id: 'session-a' }, assistantEvent('verbose but final'));
  assert.equal(bot.messages.at(-1).text, 'verbose but final');
});
