import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBindingStore } from '../src/state.js';
import { TelegramBotApi } from '../src/telegram.js';
import { Delivery } from '../src/delivery.js';
import { Commands, gateReactionOf } from '../src/commands.js';
import { Presence } from '../src/presence.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import { makeTempDir, messageUpdate, removeDir, turnEndEvent, waitFor } from './helpers/fixtures.js';

const CHAT = 111;
const THREAD = 42;
const EYES = [{ type: 'emoji', emoji: '👀' }];
const DONE = [{ type: 'emoji', emoji: '✅' }];
const FAILED = [{ type: 'emoji', emoji: '⚠️' }];
const QUEUE = [{ type: 'emoji', emoji: '⏳' }];
const REDIRECT = [{ type: 'emoji', emoji: '🔀' }];

function captureLogger() {
  const warns = [];
  return {
    warns,
    logger: {
      info() {},
      debug() {},
      error() {},
      warn(message) {
        warns.push(String(message));
      },
    },
  };
}

function fakeHost() {
  const host = {
    created: 0,
    prompts: [],
    async createSession() {
      host.created += 1;
      return `dm-session-${host.created}`;
    },
    async listSessions() {
      return [];
    },
    async prompt(sessionId, text) {
      host.prompts.push({ sessionId, text });
      return { accepted: true };
    },
  };
  return host;
}

function privateUpdate({ updateId = 1, messageId = 601, text = 'hello' } = {}) {
  const update = messageUpdate({ updateId, chatId: CHAT, threadId: 0, messageId, text });
  update.message.from = { id: CHAT, is_bot: false, first_name: 'user' };
  return update;
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
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const api = new TelegramBotApi({ token: bot.token, baseUrl: bot.baseUrl });
  const { logger, warns } = captureLogger();
  const presence = new Presence({ store, bot: api, logger });
  const delivery = new Delivery({ store, bot: api, logger });
  delivery.presence = presence;
  const host = fakeHost();
  const commands = new Commands({
    store,
    bot: api,
    host,
    delivery,
    presence,
    allowedChatIds: [CHAT],
    logger,
  });
  t.after(() => presence.stop());
  return { dir, bot, store, api, presence, delivery, host, commands, warns };
}

async function topicPrompt(commands, { updateId = 1, messageId = 501, text = 'ship it' } = {}) {
  const update = messageUpdate({ updateId, chatId: CHAT, threadId: THREAD, messageId, text });
  return commands.handleMessage(update.message);
}

test('[reaction] a topic prompt gets 👀 on the user message and ✅ when the turn completes', async (t) => {
  const { bot, store, delivery, commands } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });

  const result = await topicPrompt(commands, { messageId: 501 });
  assert.equal(result.prompted, true);
  await waitFor(() => bot.reactions.length === 1);
  assert.deepEqual(bot.reactions[0], { chat_id: CHAT, message_id: 501, reaction: EYES });

  await delivery.handleSessionEvent({ id: 'session-a' }, turnEndEvent({ reason: { kind: 'completed' } }));
  await waitFor(() => bot.reactions.length === 2);
  assert.deepEqual(bot.reactions[1], { chat_id: CHAT, message_id: 501, reaction: DONE });
});

test('[reaction] an errored turn swaps the eye for ⚠️', async (t) => {
  const { bot, store, delivery, commands } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });

  await topicPrompt(commands, { messageId: 502 });
  await waitFor(() => bot.reactions.length === 1);

  await delivery.handleSessionEvent(
    { id: 'session-a' },
    turnEndEvent({ reason: { kind: 'error', error: { message: 'kaput' } } }),
  );
  await waitFor(() => bot.reactions.length === 2);
  assert.deepEqual(bot.reactions[1], { chat_id: CHAT, message_id: 502, reaction: FAILED });
  assert.match(bot.messages.at(-1).text, /kaput/);
});

test('[reaction] a DM prompt gets 👀 on the user message and ✅ when the turn completes', async (t) => {
  const { bot, delivery, commands } = await setup(t);

  const result = await commands.handleMessage(privateUpdate({ updateId: 1, messageId: 601, text: 'hi' }).message);
  assert.equal(result.prompted, true);
  await waitFor(() => bot.reactions.length === 1);
  assert.deepEqual(bot.reactions[0], { chat_id: CHAT, message_id: 601, reaction: EYES });

  await delivery.handleSessionEvent({ id: result.sessionId }, turnEndEvent({ reason: { kind: 'completed' } }));
  await waitFor(() => bot.reactions.length === 2);
  assert.deepEqual(bot.reactions[1], { chat_id: CHAT, message_id: 601, reaction: DONE });
});

test('[reaction] other endings leave 👀 in place and settle nothing later', async (t) => {
  const { bot, store, delivery, commands } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });

  await topicPrompt(commands, { messageId: 503 });
  await waitFor(() => bot.reactions.length === 1);

  await delivery.handleSessionEvent({ id: 'session-a' }, turnEndEvent({ reason: { kind: 'aborted' } }));
  await delivery.handleSessionEvent({ id: 'session-a' }, turnEndEvent({ reason: { kind: 'completed' } }));
  assert.equal(bot.reactions.length, 1, 'the eye stays and is not swapped twice');
  assert.deepEqual(bot.reactions[0].reaction, EYES);
});

test('[reaction] commands get none', async (t) => {
  const { bot, store, host, commands } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });

  await topicPrompt(commands, { updateId: 2, messageId: 504, text: '/help' });
  assert.equal(bot.reactions.length, 0);
  assert.equal(host.prompts.length, 0);
  assert.match(bot.messages.at(-1).text, /Telegram session bridge/);
});

test('[reaction] unbound topic text gets none', async (t) => {
  const { bot, host, commands } = await setup(t);

  const update = messageUpdate({ updateId: 1, chatId: CHAT, threadId: 43, messageId: 505, text: 'anyone?' });
  const result = await commands.handleMessage(update.message);
  assert.equal(result.reason, 'unbound');
  assert.equal(bot.reactions.length, 0);
  assert.equal(host.prompts.length, 0);
});

test('[reaction] a failing setMessageReaction is swallowed and the prompt still succeeds', async (t) => {
  const { bot, store, host, commands, warns } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });
  bot.failReactions = 1;

  const result = await topicPrompt(commands, { messageId: 506 });
  assert.equal(result.prompted, true);
  assert.equal(host.prompts.length, 1, 'the prompt landed despite the reaction failure');
  assert.equal(bot.failedReactions.length, 1);
  assert.equal(bot.reactions.length, 0);
  assert.equal(warns.filter((message) => /reaction update failed/.test(message)).length, 1);
});

test('[reaction] a failing turn/end reaction never blocks the turn error delivery', async (t) => {
  const { bot, store, delivery, commands } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });

  await topicPrompt(commands, { messageId: 507 });
  await waitFor(() => bot.reactions.length === 1);
  bot.failReactions = 1;

  await delivery.handleSessionEvent(
    { id: 'session-a' },
    turnEndEvent({ reason: { kind: 'error', error: { message: 'still delivered' } } }),
  );
  assert.equal(bot.failedReactions.length, 1);
  assert.match(bot.messages.at(-1).text, /still delivered/, 'delivery is independent of the reaction');
});


test('[gate reaction] maps mid-turn queue/steer/explicit/answer/idle exactly', () => {
  assert.equal(gateReactionOf({ gate: true, running: true, choice: 'queue', path: 'default-queue' }), '⏳');
  assert.equal(gateReactionOf({ gate: true, running: true, choice: 'steer', path: 'urgent' }), '🔀');
  assert.equal(gateReactionOf({ gate: true, running: true, choice: 'queue', path: 'explicit-queue' }), '🔀');
  assert.equal(gateReactionOf({ gate: true, running: true, choice: 'steer', path: 'explicit-steer' }), '🔀');
  assert.equal(gateReactionOf({ gate: true, running: true, choice: 'answer', path: 'pending-question' }), null);
  assert.equal(gateReactionOf({ gate: true, running: false, choice: 'queue', path: 'idle-followup' }), null);
  assert.equal(gateReactionOf({ accepted: true }), null);
});

test('[gate reaction] a queued topic prompt gets one ⏳, then ✅ at turn end', async (t) => {
  const { bot, store, delivery, commands, host } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });
  host.prompt = async () => ({ gate: true, running: true, choice: 'queue', path: 'default-queue' });

  await topicPrompt(commands, { messageId: 508 });
  await waitFor(() => bot.reactions.length === 1);
  assert.deepEqual(bot.reactions[0], { chat_id: CHAT, message_id: 508, reaction: QUEUE });
  await delivery.handleSessionEvent({ id: 'session-a' }, turnEndEvent({ reason: { kind: 'completed' } }));
  await waitFor(() => bot.reactions.length === 2);
  assert.deepEqual(bot.reactions[1], { chat_id: CHAT, message_id: 508, reaction: DONE });
});

test('[gate reaction] an explicit path gets 🔀 and idle keeps the existing eye', async (t) => {
  const { bot, store, commands, host } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });
  host.prompt = async () => ({ gate: true, running: true, choice: 'queue', path: 'explicit-queue' });
  await topicPrompt(commands, { messageId: 509, text: 'queued control' });
  await waitFor(() => bot.reactions.length === 1);
  assert.deepEqual(bot.reactions[0].reaction, REDIRECT);

  host.prompt = async () => ({ gate: true, running: false, choice: 'queue', path: 'idle-followup' });
  await topicPrompt(commands, { updateId: 2, messageId: 510, text: 'idle' });
  await waitFor(() => bot.reactions.length === 2);
  assert.deepEqual(bot.reactions[1].reaction, EYES);
});

test('[gate reaction] a failed gate reaction is swallowed and the prompt still lands', async (t) => {
  const { bot, store, commands, host, warns } = await setup(t);
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: 'session-a', managedMode: 'auto' });
  host.prompt = async (sessionId, text) => {
    host.prompts.push({ sessionId, text });
    return { gate: true, running: true, choice: 'steer', path: 'urgent' };
  };
  bot.failReactions = 1;
  const result = await topicPrompt(commands, { messageId: 511, text: 'stop now' });
  assert.equal(result.prompted, true);
  assert.equal(host.prompts.length, 1);
  assert.equal(bot.failedReactions.length, 1);
  assert.equal(warns.filter((message) => /reaction update failed/.test(message)).length, 1);
});
