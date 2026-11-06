import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBindingStore } from '../src/state.js';
import { TelegramBotApi } from '../src/telegram.js';
import { Delivery } from '../src/delivery.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import { assistantEvent, makeTempDir, removeDir, syntheticUserEvent, userEvent } from './helpers/fixtures.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function setup(t) {
  const dir = await makeTempDir();
  const bot = await new FakeBotApi().start();
  t.after(async () => {
    await bot.stop();
    await removeDir(dir);
  });
  const store = await openBindingStore({ file: join(dir, 'telegram-session-bridge', 'state.json'), logger: silentLogger });
  const api = new TelegramBotApi({ token: bot.token, baseUrl: bot.baseUrl });
  const delivery = new Delivery({ store, bot: api, logger: silentLogger });
  return { bot, store, delivery };
}

test('[M2] an assistant final is delivered to the bound topic', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });

  const addressed = await delivery.handleSessionEvent({ id: 'session-a' }, assistantEvent('hello from the session'));
  assert.equal(addressed, true);
  assert.equal(bot.messages.length, 1);
  assert.equal(bot.messages[0].chat_id, 111);
  assert.equal(bot.messages[0].message_thread_id, 42);
  assert.equal(bot.messages[0].text, 'hello from the session');
});

test('[M2] delivery follows the binding, not the last chat used', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  await store.bind({ chatId: 111, threadId: 43, sessionId: 'session-b', managedMode: 'auto' });

  await delivery.handleSessionEvent({ id: 'session-a' }, assistantEvent('answer a'));
  await delivery.handleSessionEvent({ id: 'session-b' }, assistantEvent('answer b'));

  assert.deepEqual(
    bot.messages.map((message) => [message.message_thread_id, message.text]),
    [[42, 'answer a'], [43, 'answer b']],
  );
});

test('[M2] an unbound session produces no output at all', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });

  const addressed = await delivery.handleSessionEvent({ id: 'session-unbound' }, assistantEvent('must not leak'));
  assert.equal(addressed, false);
  assert.deepEqual(bot.messages, []);
});

test('[M6] web-originated user turns and assistant finals keep transcript parity', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  const session = { id: 'session-a' };

  await delivery.handleSessionEvent(session, userEvent('asked from the web GUI'));
  await delivery.handleSessionEvent(session, assistantEvent('answered to both surfaces'));

  assert.deepEqual(
    bot.messages.map((message) => message.text),
    ['▸ asked from the web GUI', 'answered to both surfaces'],
  );
});

test('[M6] synthetic loop context is never echoed to the topic', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  const session = { id: 'session-a' };

  for (const kind of ['runtime-context', 'time-context', 'openclaw-heartbeat', 'skill-catalog']) {
    const addressed = await delivery.handleSessionEvent(session, syntheticUserEvent(kind, `loop context from ${kind}`));
    assert.equal(addressed, true, `${kind} is still routed through the binding`);
  }
  assert.deepEqual(bot.messages, [], 'synthetic user/message sources must not flood the topic');

  await delivery.handleSessionEvent(session, userEvent('asked by the operator'));
  assert.deepEqual(bot.messages.map((message) => message.text), ['▸ asked by the operator']);
});

test('[M6] a prompt sent from Telegram is not echoed back as a duplicate', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  const session = { id: 'session-a' };

  delivery.noteOwnPrompt('session-a', 'typed on the phone');
  await delivery.handleSessionEvent(session, userEvent('typed on the phone'));
  await delivery.handleSessionEvent(session, assistantEvent('reply'));

  assert.deepEqual(bot.messages.map((message) => message.text), ['reply']);
});

test('[M6] a different web turn is still echoed after one own prompt is consumed', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  const session = { id: 'session-a' };

  delivery.noteOwnPrompt('session-a', 'typed on the phone');
  await delivery.handleSessionEvent(session, userEvent('typed on the phone'));
  await delivery.handleSessionEvent(session, userEvent('typed on the web'));

  assert.deepEqual(bot.messages.map((message) => message.text), ['▸ typed on the web']);
});

test('[M6] voice transcript uses the microphone marker, not the user arrow', async (t) => {
  const { bot, store, delivery } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  await delivery.handleSessionEvent({ id: 'session-a' }, userEvent('🎤 hello voice'));
  assert.deepEqual(bot.messages.map((message) => message.text), ['🎤 hello voice']);
});
