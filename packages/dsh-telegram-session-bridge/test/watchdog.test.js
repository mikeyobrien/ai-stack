import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBindingStore } from '../src/state.js';
import { TelegramBotApi } from '../src/telegram.js';
import { Watchdog } from '../src/watchdog.js';
import { Delivery } from '../src/delivery.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import { flush, makeTempDir, removeDir, turnEndEvent, turnStartEvent, userEvent, waitFor } from './helpers/fixtures.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const CHAT = 111;
const THREAD = 42;
const TIMEOUT = 60_000;

function fakeScheduler() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      sequence += 1;
      timers.set(sequence, { fn, at: now + ms });
      return sequence;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending() {
      return timers.size;
    },
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, timer] of due) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.fn();
      }
      await flush();
    },
  };
}

async function setup(t) {
  const dir = await makeTempDir();
  const bot = await new FakeBotApi().start();
  t.after(async () => {
    await bot.stop();
    await removeDir(dir);
  });
  const store = await openBindingStore({ file: join(dir, 'telegram-session-bridge', 'state.json'), logger: silentLogger });
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });
  const api = new TelegramBotApi({ token: bot.token, baseUrl: bot.baseUrl });
  const cancels = [];
  const scheduler = fakeScheduler();
  const watchdog = new Watchdog({
    store,
    bot: api,
    cancel: async (sessionId) => {
      cancels.push(sessionId);
    },
    timeoutMs: TIMEOUT,
    scheduler,
    logger: silentLogger,
  });
  t.after(() => watchdog.stop());
  return { store, bot, watchdog, cancels, scheduler, api };
}

test('[M8] a stalled turn is notified and cancelled with the inbox kept', async (t) => {
  const { bot, watchdog, cancels, scheduler } = await setup(t);
  assert.equal(watchdog.arm('session-a'), true);
  await scheduler.advance(TIMEOUT - 1);
  assert.equal(bot.messages.length, 0);

  await scheduler.advance(1);
  await waitFor(() => cancels.length === 1);
  assert.equal(bot.messages.length, 1);
  assert.match(bot.messages[0].text, /No activity for 1m/);
  assert.match(bot.messages[0].text, /queued input is kept/);
  assert.equal(bot.messages[0].message_thread_id, THREAD);
  assert.deepEqual(cancels, ['session-a']);
  assert.equal(watchdog.isArmed('session-a'), false);
});

test('[M8] activity postpones the stall and a new prompt re-arms after recovery', async (t) => {
  const { watchdog, cancels, scheduler } = await setup(t);
  watchdog.arm('session-a');
  await scheduler.advance(TIMEOUT - 10_000);
  watchdog.touch('session-a');
  await scheduler.advance(TIMEOUT - 1);
  assert.deepEqual(cancels, [], 'touch reset the timer');

  await scheduler.advance(1);
  await waitFor(() => cancels.length === 1);
  assert.deepEqual(cancels, ['session-a']);
  assert.equal(watchdog.touch('session-a'), false, 'a fired watchdog stays idle until re-armed');

  watchdog.arm('session-a');
  await scheduler.advance(TIMEOUT);
  await waitFor(() => cancels.length === 2);
  assert.deepEqual(cancels, ['session-a', 'session-a'], 'a later prompt gets its own watchdog');
});

test('[M8] unbound sessions are never watched', async (t) => {
  const { watchdog, cancels, scheduler } = await setup(t);
  assert.equal(watchdog.arm('session-unbound'), false);
  await scheduler.advance(TIMEOUT);
  assert.deepEqual(cancels, []);
});

test('[M8] turn/start arms the watchdog for a turn with no human user message', async (t) => {
  const { store, bot, watchdog, cancels, scheduler, api } = await setup(t);
  const delivery = new Delivery({ store, bot: api, logger: silentLogger });
  delivery.watchdog = watchdog;

  await delivery.handleSessionEvent({ id: 'session-a' }, turnStartEvent({ turn: 7 }));
  assert.equal(watchdog.isArmed('session-a'), true, 'a goal/heartbeat turn is watched from turn/start');

  await scheduler.advance(TIMEOUT);
  await waitFor(() => cancels.length === 1);
  assert.match(bot.messages.at(-1).text, /No activity for 1m/);
  assert.deepEqual(cancels, ['session-a']);
});

test('[M8] turn/end disarms the watchdog through the delivery path', async (t) => {
  const { store, bot, watchdog, cancels, scheduler, api } = await setup(t);
  const delivery = new Delivery({ store, bot: api, logger: silentLogger });
  delivery.watchdog = watchdog;
  const session = { id: 'session-a' };

  await delivery.handleSessionEvent(session, userEvent('start a turn'));
  assert.equal(watchdog.isArmed('session-a'), true);
  await delivery.handleSessionEvent(session, turnEndEvent({ seq: 20, turn: 1 }));
  assert.equal(watchdog.isArmed('session-a'), false);

  await scheduler.advance(TIMEOUT);
  assert.deepEqual(cancels, []);
  assert.deepEqual(bot.messages.map((message) => message.text), ['▸ start a turn']);
});
