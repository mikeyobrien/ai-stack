import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBindingStore } from '../src/state.js';
import { TelegramBotApi } from '../src/telegram.js';
import { Delivery } from '../src/delivery.js';
import { Commands } from '../src/commands.js';
import { Presence } from '../src/presence.js';
import { createBridge } from '../src/bridge.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import {
  flush,
  makeTempDir,
  messageUpdate,
  removeDir,
  turnEndEvent,
  turnStartEvent,
  waitFor,
} from './helpers/fixtures.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const CHAT = 111;
const THREAD = 42;

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
  const store = await openBindingStore({
    file: join(dir, 'telegram-session-bridge', 'state.json'),
    logger: silentLogger,
  });
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });
  const api = new TelegramBotApi({ token: bot.token, baseUrl: bot.baseUrl });
  const scheduler = fakeScheduler();
  const presence = new Presence({ store, bot: api, timers: scheduler, logger: silentLogger });
  const delivery = new Delivery({ store, bot: api, logger: silentLogger });
  delivery.presence = presence;
  t.after(() => presence.stop());
  return { dir, bot, store, api, scheduler, presence, delivery };
}

test('[typing] turn/start sends one action in the bound topic and refreshes every 4 s', async (t) => {
  const { bot, scheduler, delivery, presence } = await setup(t);
  const session = { id: 'session-a' };

  await delivery.handleSessionEvent(session, turnStartEvent());
  await waitFor(() => bot.chatActions.length === 1);
  assert.deepEqual(bot.chatActions[0], { chat_id: CHAT, message_thread_id: THREAD, action: 'typing' });
  assert.equal(presence.isActive(CHAT, THREAD), true);
  assert.equal(scheduler.pending(), 1, 'exactly one timer per chat/topic');

  await scheduler.advance(3999);
  assert.equal(bot.chatActions.length, 1, 'nothing before the 4 s refresh');
  await scheduler.advance(1);
  await waitFor(() => bot.chatActions.length === 2);
  assert.equal(scheduler.pending(), 1, 'the refresh re-arms, it does not stack');

  await delivery.handleSessionEvent(session, turnEndEvent({ reason: { kind: 'completed' } }));
  assert.equal(presence.isActive(CHAT, THREAD), false);
  assert.equal(scheduler.pending(), 0, 'turn/end clears the live timer');
  await scheduler.advance(4000);
  await flush();
  assert.equal(bot.chatActions.length, 2, 'no action after turn/end');
});

test('[typing] a later turn re-arms the loop', async (t) => {
  const { bot, scheduler, delivery } = await setup(t);
  const session = { id: 'session-a' };

  await delivery.handleSessionEvent(session, turnStartEvent({ turn: 1 }));
  await waitFor(() => bot.chatActions.length === 1);
  await delivery.handleSessionEvent(session, turnEndEvent({ turn: 1 }));
  assert.equal(scheduler.pending(), 0);

  await delivery.handleSessionEvent(session, turnStartEvent({ turn: 2, seq: 30 }));
  await waitFor(() => bot.chatActions.length === 2);
  assert.equal(scheduler.pending(), 1);
  await scheduler.advance(4000);
  await waitFor(() => bot.chatActions.length === 3);
});

test('[typing] repeated turn/start is idempotent: one loop, no duplicate immediate action', async (t) => {
  const { bot, scheduler, presence } = await setup(t);

  assert.equal(presence.start('session-a'), true);
  assert.equal(presence.start('session-a'), true);
  await waitFor(() => bot.chatActions.length === 1);
  await flush();
  assert.equal(bot.chatActions.length, 1, 'the second start did not double the loop');
  assert.equal(scheduler.pending(), 1);
});

test('[typing] an unbound session never types', async (t) => {
  const { bot, scheduler, presence } = await setup(t);

  assert.equal(presence.start('session-unbound'), false);
  await flush();
  assert.equal(bot.chatActions.length, 0);
  assert.equal(scheduler.pending(), 0);
});

test('[typing] unbind stops the loop for that session', async (t) => {
  const { store, bot, api, scheduler, presence } = await setup(t);
  const commands = new Commands({
    store,
    bot: api,
    delivery: { noteOwnPrompt() {} },
    host: {},
    presence,
    allowedChatIds: [CHAT],
    logger: silentLogger,
  });

  presence.start('session-a');
  await waitFor(() => bot.chatActions.length === 1);
  assert.equal(scheduler.pending(), 1);

  const result = await commands.handleMessage(
    messageUpdate({ updateId: 1, chatId: CHAT, threadId: THREAD, messageId: 9, text: '/unbind' }).message,
  );
  assert.equal(result.removed, true);
  assert.equal(presence.isActive(CHAT, THREAD), false);
  assert.equal(scheduler.pending(), 0, 'unbind clears the typing timer');
});

test('[typing] bridge stop clears a live loop and its timer', async (t) => {
  const dir = await makeTempDir();
  const bot = await new FakeBotApi().start();
  t.after(async () => {
    await bot.stop();
    await removeDir(dir);
  });
  const scheduler = fakeScheduler();
  const services = {
    sessionController: {
      async prompt(_request, signal) {
        signal?.throwIfAborted();
        return { accepted: true };
      },
      cancel() {
        return { accepted: true };
      },
      async list() {
        return { items: [] };
      },
    },
  };
  const bridge = await createBridge({
    config: {
      tokenRef: 'PRESENCE_TEST_TOKEN',
      dshHome: dir,
      baseUrl: bot.baseUrl,
      poll: false,
      allowedChatIds: [CHAT],
      stallTimeoutMs: 60_000,
    },
    env: { PRESENCE_TEST_TOKEN: bot.token },
    services,
    scheduler,
    logger: silentLogger,
  });
  await bridge.store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });

  await bridge.handleSessionEvent({ id: 'session-a' }, turnStartEvent());
  await waitFor(() => bot.chatActions.length === 1);
  assert.equal(scheduler.pending(), 1 + 1, 'typing timer plus the watchdog timer');

  await bridge.stop();
  assert.equal(bridge.presence.stopped, true);
  assert.equal(scheduler.pending(), 0, 'bridge stop clears every timer it owns');
  await scheduler.advance(4000);
  await flush();
  assert.equal(bot.chatActions.length, 1, 'no typing refresh survives bridge stop');
});
