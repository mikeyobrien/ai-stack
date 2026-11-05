import test from 'node:test';
import assert from 'node:assert/strict';
import { mountBridge as apply } from '../src/index.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import { FakeHostContext } from './helpers/fake-host.js';
import {
  approvalRequest,
  assistantEvent,
  callbackUpdate,
  flush,
  waitFor,
  makeTempDir,
  messageUpdate,
  removeDir,
  userEvent,
} from './helpers/fixtures.js';

const ENV_NAME = 'BRIDGE_TEST_TOKEN';
const CHAT = 111;
const THREAD = 42;

async function setup(t, { sessions = [{ sessionId: 'session-1' }] } = {}) {
  const dir = await makeTempDir();
  const bot = await new FakeBotApi().start();
  const host = new FakeHostContext({ sessions });
  const previous = process.env[ENV_NAME];
  process.env[ENV_NAME] = bot.token;
  t.after(async () => {
    if (previous === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = previous;
    await host.dispose();
    await bot.stop();
    await removeDir(dir);
  });
  const config = {
    tokenRef: ENV_NAME,
    dshHome: dir,
    baseUrl: bot.baseUrl,
    poll: false,
    allowedChatIds: [CHAT],
    stallTimeoutMs: 60_000,
  };
  return { dir, bot, host, config };
}

async function command(bridge, bot, { updateId, text, chatId = CHAT, threadId = THREAD }) {
  bot.pushUpdate(messageUpdate({ updateId, text, chatId, threadId, messageId: 100 + updateId }));
  await bridge.pollOnce();
}

test('[M3] apply subscribes to the host push envelopes and drives the real Bot API end to end', async (t) => {
  const { bot, host, config } = await setup(t, {
    sessions: [{ sessionId: 'session-1', events: [assistantEvent('the restored answer', { seq: 3 })] }],
  });
  const bridge = await apply(host, config);

  await command(bridge, bot, { updateId: 1, text: '/bind session-1' });
  assert.match(bot.messages.at(-1).text, /Restored/);
  assert.match(bot.messages.at(-1).text, /the restored answer/);
  assert.equal(bridge.store.getBinding(CHAT, THREAD).sessionId, 'session-1');

  await host.emit('session/event', { id: 'session-1' }, assistantEvent('a live answer', { seq: 4 }));
  assert.equal(bot.messages.at(-1).text, 'a live answer');
  assert.equal(bot.messages.at(-1).message_thread_id, THREAD);

  await command(bridge, bot, { updateId: 2, text: 'please continue' });
  assert.equal(host.sessionController.prompts.length, 1);
  assert.equal(host.sessionController.prompts[0].sessionId, 'session-1');
  assert.deepEqual(host.sessionController.prompts[0].content, [{ type: 'text', text: 'please continue' }]);

  const beforeEcho = bot.messages.length;
  await host.emit('session/event', { id: 'session-1' }, userEvent('please continue', { seq: 5 }));
  assert.equal(bot.messages.length, beforeEcho, 'Telegram-originated prompt is not echoed twice');

  await host.emit('session/event', { id: 'session-1' }, userEvent('sent from the web GUI', { seq: 6 }));
  assert.equal(bot.messages.at(-1).text, '▸ sent from the web GUI');
});

test('[M3] an unbound approval falls through next() to the native GUI answerer', async (t) => {
  const { bot, host, config } = await setup(t);
  await apply(host, config);
  host.natives.set('approval/request', () => 'native-rejected');

  const outcome = await host.emitWaterfall('approval/request', approvalRequest({ sessionId: 'unbound-session' }));
  assert.equal(outcome, 'native-rejected');
  assert.deepEqual(bot.messages, []);
});

test('[M5] a bound approval is answered from a Telegram callback through the poller', async (t) => {
  const { bot, host, config } = await setup(t);
  const bridge = await apply(host, config);
  await bridge.store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-1', managedMode: 'auto' });

  const outcome = host.emitWaterfall('approval/request', approvalRequest({ sessionId: 'session-1' }));
  await waitFor(() => bot.messages.length === 1);
  const card = bot.messages.at(-1);
  assert.match(card.text, /Approval required/);
  const data = card.reply_markup.inline_keyboard[0][0].callback_data;

  bot.pushUpdate(callbackUpdate({ updateId: 9, data }));
  await bridge.pollOnce();
  assert.equal(await outcome, 'allowed-once');
  assert.equal(bot.callbackAnswers.at(-1).text, 'Allowed once');
});

test('[M3] disposing the host effect stops the watchdog and its timers', async (t) => {
  const { host, config } = await setup(t);
  const bridge = await apply(host, config);
  await bridge.store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-1', managedMode: 'auto' });
  bridge.watchdog.arm('session-1');
  assert.equal(bridge.watchdog.isArmed('session-1'), true);

  await host.dispose();

  assert.equal(bridge.watchdog.stopped, true, 'plugin disposal must stop the watchdog');
  assert.equal(bridge.watchdog.isArmed('session-1'), false, 'no stall timer may outlive the plugin');
});

test('[M3] the bridge cancels through the host session Remote without extra fields', async (t) => {
  const { host, config } = await setup(t);
  const bridge = await apply(host, config);

  await bridge.host.cancel('session-1');

  // 0.2.1-rc.5's session/cancel Remote takes only { sessionId }; the
  // keepInbox:true semantics live inside the host implementation (verified in
  // dsh-api-session-controller), not in the request the bridge sends.
  assert.deepEqual(host.sessionController.cancels.map((entry) => entry.request), [{ sessionId: 'session-1' }]);
});

test('[transport] the host adapter supplies the AbortSignal the session Remotes require', async (t) => {
  const { bot, host, config } = await setup(t, {
    sessions: [{ sessionId: 'session-1', events: [assistantEvent('the restored answer', { seq: 3 })] }],
  });

  // 0.2.1-rc.5 SessionController.prompt calls signal.throwIfAborted()
  // unconditionally; the gateway injects that signal for RPC callers, so a
  // one-argument in-host call is exactly the production TypeError.
  await assert.rejects(
    host.sessionController.prompt({ requestId: 'r1', sessionId: 'session-1', mode: 'queue', content: [] }),
    TypeError,
  );

  const bridge = await apply(host, config);
  await bridge.store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-1', managedMode: 'auto' });

  await command(bridge, bot, { updateId: 1, text: 'please continue' });
  const promptSignal = host.sessionController.promptSignals.at(-1);
  assert.ok(promptSignal instanceof AbortSignal, 'prompt needs the bridge lifetime signal');
  assert.equal(promptSignal.aborted, false);

  // Restore-with-replay reads the cold-safe inspect Remote, not page: page's
  // throughSeq must be the Session's current cursor, which only inspect provides.
  assert.equal(await bridge.host.readLastAssistant('session-1'), 'the restored answer');
  const inspectSignal = host.sessionController.inspectSignals.at(-1);
  assert.equal(inspectSignal, promptSignal, 'one lifetime signal covers every Remote call');

  await host.dispose();
  assert.equal(promptSignal.aborted, true, 'plugin disposal aborts in-flight Remote calls');
  await assert.rejects(() => bridge.host.prompt('session-1', 'after stop'), { name: 'AbortError' });
});

test('[M4] a missing token disables the plugin without blocking host boot', async (t) => {
  const { bot, host, config } = await setup(t);
  delete process.env[ENV_NAME];
  const bridge = await apply(host, config);
  assert.equal(bridge, undefined);
  assert.equal(host.effects.length, 0);
  assert.ok(
    host.logs.some(([level, message]) => level === 'error' && /disabled/.test(message) && /BRIDGE_TEST_TOKEN/.test(message)),
  );
  assert.deepEqual(bot.calls, []);
});

test('[M1] /new creates and binds a session, replacing the old binding', async (t) => {
  const { bot, host, config } = await setup(t);
  const bridge = await apply(host, config);
  await bridge.store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-1', managedMode: 'auto' });

  await command(bridge, bot, { updateId: 1, text: '/new' });
  const binding = bridge.store.getBinding(CHAT, THREAD);
  assert.equal(binding.sessionId, 'session-new-1');
  assert.equal(binding.managedMode, 'new_replaced');
  assert.match(bot.messages.at(-1).text, /New session/);
});

test('[M7] /verbosity persists per topic across a bridge restart', async (t) => {
  const { bot, host, config } = await setup(t);
  const bridge = await apply(host, config);
  await bridge.store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-1', managedMode: 'auto' });

  await command(bridge, bot, { updateId: 1, text: '/verbosity normal' });
  assert.equal(bot.messages.at(-1).text, 'Verbosity: normal');
  await host.dispose();

  const bot2 = await new FakeBotApi().start();
  const host2 = new FakeHostContext({ sessions: [{ sessionId: 'session-1' }] });
  process.env[ENV_NAME] = bot2.token;
  t.after(async () => {
    await host2.dispose();
    await bot2.stop();
  });
  const bridge2 = await apply(host2, { ...config, baseUrl: bot2.baseUrl });
  await command(bridge2, bot2, { updateId: 2, text: '/verbosity' });
  assert.equal(bot2.messages.at(-1).text, 'Verbosity: normal (quiet, normal, verbose)');
});

test('[M8] a failed prompt leaves no watchdog armed and reports the error', async (t) => {
  const { bot, host, config } = await setup(t);
  // The adapter binds the controller method at apply time, so install the
  // failure before the bridge composes.
  host.sessionController.prompt = async () => {
    throw new Error('queue is full');
  };
  const bridge = await apply(host, config);
  await bridge.store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-1', managedMode: 'auto' });

  await command(bridge, bot, { updateId: 1, text: 'please continue' });

  assert.equal(bridge.watchdog.isArmed('session-1'), false, 'no turn started, so nothing may later be cancelled');
  assert.match(bot.messages.at(-1).text, /Prompt failed: queue is full/);
});

test('[M4] unbound lobby text is answered with instructions instead of entering a session', async (t) => {
  const { bot, host, config } = await setup(t);
  const bridge = await apply(host, config);

  await command(bridge, bot, { updateId: 1, text: 'hello?', threadId: 0 });
  assert.equal(host.sessionController.prompts.length, 0);
  assert.match(bot.messages.at(-1).text, /DM lobby/);
});
