import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBindingStore } from '../src/state.js';
import { TelegramBotApi } from '../src/telegram.js';
import { Interactions } from '../src/interactions.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import {
  approvalRequest,
  flush,
  waitFor,
  makeTempDir,
  questionRequest,
  removeDir,
} from './helpers/fixtures.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const CHAT = 111;
const THREAD = 42;

async function setup(t, { bind = true } = {}) {
  const dir = await makeTempDir();
  const bot = await new FakeBotApi().start();
  t.after(async () => {
    await bot.stop();
    await removeDir(dir);
  });
  const store = await openBindingStore({ file: join(dir, 'telegram-session-bridge', 'state.json'), logger: silentLogger });
  if (bind) await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-1', managedMode: 'auto' });
  const api = new TelegramBotApi({ token: bot.token, baseUrl: bot.baseUrl });
  const interactions = new Interactions({ store, bot: api, logger: silentLogger });
  return { bot, store, interactions };
}

function callbackQuery({ callbackId = 'cb-1', data, messageId = 101 } = {}) {
  return {
    id: callbackId,
    from: { id: 5, is_bot: false, first_name: 'operator' },
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'supergroup' },
      message_thread_id: THREAD,
    },
    data,
  };
}

function buttonData(bot, row = 0, column = 0) {
  return bot.messages.at(-1).reply_markup.inline_keyboard[row][column].callback_data;
}

test('[M5] a bound approval is claimed from the push envelope and answered once', async (t) => {
  const { bot, interactions } = await setup(t);
  let nextCalls = 0;
  const promise = interactions.handleApproval(approvalRequest(), () => {
    nextCalls += 1;
    return 'native';
  });
  await waitFor(() => bot.messages.length === 1);

  assert.equal(nextCalls, 0, 'the bridge owns approvals for bound sessions');
  assert.equal(bot.messages.length, 1);
  assert.match(bot.messages[0].text, /Approval required: bash/);
  assert.equal(bot.messages[0].message_thread_id, THREAD);

  const allow = buttonData(bot, 0, 0);
  const first = await interactions.handleCallback(callbackQuery({ data: allow }));
  assert.equal(first.accepted, true);
  assert.equal(first.outcome, 'allowed-once');
  assert.equal(await promise, 'allowed-once');
  assert.equal(bot.callbackAnswers.at(-1).text, 'Allowed once');
  assert.deepEqual(bot.edits.at(-1).reply_markup, { inline_keyboard: [] });

  const stale = await interactions.handleCallback(callbackQuery({ callbackId: 'cb-2', data: allow }));
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'not-pending');
  assert.equal(bot.callbackAnswers.at(-1).show_alert, true);
});

test('[M5] rejecting is a one-shot rejection outcome', async (t) => {
  const { bot, interactions } = await setup(t);
  const promise = interactions.handleApproval(approvalRequest(), () => 'native');
  await waitFor(() => bot.messages.length === 1);
  const reject = buttonData(bot, 0, 1);
  await interactions.handleCallback(callbackQuery({ data: reject }));
  assert.equal(await promise, 'rejected');
  assert.match(bot.edits.at(-1).text, /Rejected/);
});

test('[M5] an unbound approval falls through next() to the GUI', async (t) => {
  const { bot, interactions } = await setup(t, { bind: false });
  let nextCalls = 0;
  const outcome = interactions.handleApproval(approvalRequest(), () => {
    nextCalls += 1;
    return 'native-rejected';
  });
  assert.equal(outcome, 'native-rejected');
  assert.equal(nextCalls, 1);
  assert.deepEqual(bot.messages, []);
});

test('[M3] an approval request with no matching approval/asked event falls through', async (t) => {
  const { interactions } = await setup(t);
  let nextCalls = 0;
  const request = approvalRequest();
  request.callId = 'a-different-call';
  const outcome = interactions.handleApproval(request, () => {
    nextCalls += 1;
    return 'native';
  });
  assert.equal(outcome, 'native');
  assert.equal(nextCalls, 1);
});

test('[M5] an aborted approval resolves cancelled and stops accepting presses', async (t) => {
  const { bot, interactions } = await setup(t);
  const controller = new AbortController();
  const promise = interactions.handleApproval(approvalRequest({ signal: controller.signal }), () => 'native');
  await waitFor(() => bot.messages.length === 1);
  const allow = buttonData(bot, 0, 0);
  controller.abort();
  assert.equal(await promise, 'cancelled');

  const stale = await interactions.handleCallback(callbackQuery({ data: allow }));
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'not-pending');
});

test('[M5] a bound question returns the selected labels to the host', async (t) => {
  const { bot, interactions } = await setup(t);
  const questions = [
    { id: 'q1', question: 'Which path?', options: [{ label: 'A' }, { label: 'B' }] },
  ];
  const promise = interactions.handleQuestion(questionRequest({ questions }), () => 'native');
  await waitFor(() => bot.messages.length === 1);
  assert.match(bot.messages[0].text, /Which path\?/);

  const selectB = buttonData(bot, 0, 1);
  const result = await interactions.handleCallback(callbackQuery({ data: selectB }));
  assert.equal(result.accepted, true);
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['B'] }] });
  assert.equal(bot.callbackAnswers.at(-1).text, 'Answered');
});

test('[M5] a question with more than three options keeps every option answerable', async (t) => {
  const { bot, interactions } = await setup(t);
  const questions = [
    {
      id: 'q1',
      question: 'Which environment?',
      options: [{ label: 'dev' }, { label: 'staging' }, { label: 'prod' }, { label: 'sandbox' }],
    },
  ];
  const promise = interactions.handleQuestion(questionRequest({ questions }), () => 'native');
  await waitFor(() => bot.messages.length === 1);

  // The fourth option wraps onto the next keyboard row instead of being cut.
  const fourth = buttonData(bot, 1, 0);
  const result = await interactions.handleCallback(callbackQuery({ data: fourth }));
  assert.equal(result.accepted, true);
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['sandbox'] }] });
});

test('[M5] a multi-select question toggles options and finishes on Done', async (t) => {
  const { bot, interactions } = await setup(t);
  const questions = [
    { id: 'q1', question: 'Pick files', multiSelect: true, options: [{ label: 'a.js' }, { label: 'b.js' }] },
  ];
  const promise = interactions.handleQuestion(questionRequest({ questions }), () => 'native');
  await waitFor(() => bot.messages.length === 1);

  const first = buttonData(bot, 0, 0);
  const second = buttonData(bot, 0, 1);
  const done = buttonData(bot, 1, 0);
  await interactions.handleCallback(callbackQuery({ data: first }));
  await interactions.handleCallback(callbackQuery({ callbackId: 'cb-2', data: second }));
  const result = await interactions.handleCallback(callbackQuery({ callbackId: 'cb-3', data: done }));

  assert.equal(result.accepted, true);
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['a.js', 'b.js'] }] });
});

test('[M5] an unbound question falls through next()', async (t) => {
  const { interactions } = await setup(t, { bind: false });
  let nextCalls = 0;
  const outcome = interactions.handleQuestion(
    questionRequest({ questions: [{ id: 'q1', question: '?' }] }),
    () => {
      nextCalls += 1;
      return 'native';
    },
  );
  assert.equal(outcome, 'native');
  assert.equal(nextCalls, 1);
});

test('[M5] an aborted question rejects with the host ASK_ABORTED code', async (t) => {
  const { interactions } = await setup(t);
  const controller = new AbortController();
  const promise = interactions.handleQuestion(
    questionRequest({ questions: [{ id: 'q1', question: '?' }], signal: controller.signal }),
    () => 'native',
  );
  const assertion = assert.rejects(promise, (error) => error.code === 'ASK_ABORTED');
  controller.abort();
  await assertion;
});
