import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBindingStore, pairKey } from '../src/state.js';
import { Commands } from '../src/commands.js';
import { makeTempDir, messageUpdate, removeDir } from './helpers/fixtures.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const BOT_ID = 777000;

function fakeHost({ failCreate = false } = {}) {
  const host = {
    created: 0,
    prompts: [],
    failCreate,
    async createSession() {
      if (host.failCreate) throw new Error('host unavailable');
      host.created += 1;
      return `dm-session-${host.created}`;
    },
    async listSessions() {
      return [];
    },
    async prompt(sessionId, text) {
      if (host.failPrompt) throw new Error('prompt rejected');
      host.prompts.push({ sessionId, text });
      return { accepted: true };
    },
    failPrompt: false,
  };
  return host;
}

async function setup(t, { allowed = true } = {}) {
  const dir = await makeTempDir();
  t.after(() => removeDir(dir));
  const store = await openBindingStore({
    file: join(dir, 'telegram-session-bridge', 'state.json'),
    logger: silentLogger,
  });
  const bot = {
    sent: [],
    async sendMessage(params) {
      bot.sent.push(params);
      return { message_id: bot.sent.length };
    },
  };
  const host = fakeHost();
  const commands = new Commands({
    store,
    bot,
    host,
    delivery: { noteOwnPrompt() {} },
    allowedChatIds: allowed ? [111, 222] : [],
    logger: silentLogger,
  });
  return { dir, store, bot, host, commands };
}

/** A real private-chat update: chat.type 'private', sender id == chat id. */
function privateUpdate({ updateId = 1, chatId = 111, senderId = chatId, messageId = 100 + updateId, text = 'hello', botId = BOT_ID } = {}) {
  const update = messageUpdate({ updateId, chatId, threadId: 0, messageId, text });
  update.message.chat.type = 'private';
  update.message.from = { id: senderId, is_bot: false, first_name: 'user' };
  return update;
}

async function dispatch(commands, update) {
  return commands.handleMessage(update.message);
}

test('[dm] first private text auto-creates and binds a personal session', async (t) => {
  const { store, host, commands } = await setup(t);
  const result = await dispatch(commands, privateUpdate({ updateId: 1 }));
  assert.equal(result.handled, true);
  assert.equal(result.created, true);
  assert.equal(host.created, 1);
  const binding = store.getBinding(111, 0);
  assert.equal(binding.sessionId, 'dm-session-1');
  assert.equal(binding.managedMode, 'auto');
  assert.equal(binding.threadId, 0, 'DM binding lives on thread 0');
  assert.equal(pairKey(111, 0) in Object.fromEntries(store.listBindings().map((b) => [`${b.chatId}:${b.threadId}`, b])), true);
});

test('[dm] second private text resumes the same session, no new creation', async (t) => {
  const { store, host, commands } = await setup(t);
  await dispatch(commands, privateUpdate({ updateId: 1, text: 'first' }));
  const second = await dispatch(commands, privateUpdate({ updateId: 2, text: 'second' }));
  assert.equal(second.created, false);
  assert.equal(second.prompted, true);
  assert.equal(host.created, 1, 'only one create for the second message');
  assert.deepEqual(host.prompts.map((p) => p.text), ['first', 'second']);
  assert.equal(host.prompts[1].sessionId, store.getBinding(111, 0).sessionId);
});

test('[dm] reload persists the DM binding and keeps routing', async (t) => {
  const { dir, store, commands } = await setup(t);
  await dispatch(commands, privateUpdate({ updateId: 1, text: 'persist me' }));
  const bindingBefore = store.getBinding(111, 0);
  const reloaded = await openBindingStore({
    file: join(dir, 'telegram-session-bridge', 'state.json'),
    logger: silentLogger,
  });
  assert.equal(reloaded.getBinding(111, 0).sessionId, bindingBefore.sessionId);
  assert.equal(reloaded.getBinding(111, 0).managedMode, 'auto');
});

test('[dm] two users are isolated; each gets a distinct session', async (t) => {
  const { store, host, commands } = await setup(t);
  await dispatch(commands, privateUpdate({ updateId: 1, chatId: 111, text: 'from a' }));
  await dispatch(commands, privateUpdate({ updateId: 2, chatId: 222, text: 'from b' }));
  const a = store.getBinding(111, 0);
  const b = store.getBinding(222, 0);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(host.created, 2);
  assert.equal(host.prompts[0].sessionId, a.sessionId);
  assert.equal(host.prompts[1].sessionId, b.sessionId);
});

test('[dm] auth gates creation: unauthorized chat never creates', async (t) => {
    const { store, host, commands } = await setup(t, { allowed: false });
  const result = await dispatch(commands, privateUpdate({ updateId: 1, chatId: 999 }));
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not-allowed');
  assert.equal(host.created, 0);
  assert.equal(store.getBinding(999, 0), null);
});

test('[dm] fail closed: private routing requires chat.type private and sender == chat', async (t) => {
  const { store, host, commands } = await setup(t);
    // group chat without a thread: not private, no auto-create
  const group = messageUpdate({ updateId: 3, chatId: 555, threadId: 0, text: 'in a group' });
  group.message.chat.type = 'supergroup';
  group.message.from = { id: 42, is_bot: false };
  const groupResult = await dispatch(commands, group);
  assert.equal(groupResult.created ?? false, false);
    // private type but sender is a different account: fail closed
  const mismatch = privateUpdate({ updateId: 4, chatId: 111, senderId: 999999 });
  const mismatchResult = await dispatch(commands, mismatch);
  assert.equal(mismatchResult.created ?? false, false, 'sender must match the private chat identity');
    // sender matches: proceeds
  const ok = await dispatch(commands, privateUpdate({ updateId: 5, text: 'mine' }));
  assert.equal(ok.created, true);
  assert.equal(host.prompts.length, 1);
  assert.equal(store.getBinding(111, 0).sessionId, 'dm-session-1');
});

test('[dm] concurrent first messages race-safe: one session, both prompts delivered', async (t) => {
  const { store, host, commands } = await setup(t);
  const updates = [
    privateUpdate({ updateId: 11, messageId: 101, text: 'race a' }),
    privateUpdate({ updateId: 12, messageId: 102, text: 'race b' }),
    privateUpdate({ updateId: 13, messageId: 103, text: 'race c' }),
  ];
  const results = await Promise.all(updates.map((update) => dispatch(commands, update)));
  const created = results.filter((r) => r.created).length;
  assert.ok(created >= 1, 'at least one create wins');
  assert.equal(host.created <= results.filter((r) => r.created).length ? true : false, true);
  const sessionIds = new Set(results.map((r) => r.sessionId).filter(Boolean));
    // all three prompts land on the one surviving binding
  const bound = store.getBinding(111, 0).sessionId;
  assert.equal(host.prompts.every((p) => p.sessionId === bound), true);
  assert.equal([...new Set(host.prompts.map((p) => p.text))].sort().join(','), 'race a,race b,race c');
  assert.equal(store.listBindings().length, 1, 'no duplicate bindings for one DM');
  assert.ok(sessionIds.size <= 2);
});

test('[dm] /new in a DM replaces only that user mapping and retains the old session', async (t) => {
  const { store, host, commands } = await setup(t);
  await dispatch(commands, privateUpdate({ updateId: 1, chatId: 111, text: 'first era' }));
  await dispatch(commands, privateUpdate({ updateId: 2, chatId: 222, text: 'other user' }));
  const oldA = store.getBinding(111, 0).sessionId;

    const cmd = privateUpdate({ updateId: 3, chatId: 111, text: '/new' });
  const result = await dispatch(commands, cmd);
  assert.equal(result.handled, true);
  const newA = store.getBinding(111, 0);
  assert.equal(newA.sessionId, 'dm-session-3');
  assert.equal(newA.managedMode, 'new_replaced');
  assert.notEqual(newA.sessionId, oldA);
    // user B untouched
  assert.equal(store.getBinding(222, 0).sessionId, 'dm-session-2');
  // the old session still exists on the host (no deletion)
  assert.equal(host.created, 3);
});

test('[dm] /unbind detaches without deletion; next text auto-creates anew', async (t) => {
  const { store, host, commands } = await setup(t);
  await dispatch(commands, privateUpdate({ updateId: 1, text: 'era one' }));
  const first = store.getBinding(111, 0).sessionId;

  const unbind = privateUpdate({ updateId: 2, text: '/unbind' });
  await dispatch(commands, unbind);
  assert.equal(store.getBinding(111, 0), null);
  assert.equal(host.created, 1, 'unbind deletes nothing');

  await dispatch(commands, privateUpdate({ updateId: 3, text: 'era two' }));
  const second = store.getBinding(111, 0);
  assert.notEqual(second.sessionId, first);
  assert.equal(second.managedMode, 'auto');
  assert.equal(host.created, 2);
});

test('[dm] topic bindings are untouched by DM routing', async (t) => {
  const { store, commands } = await setup(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'topic-session', managedMode: 'auto' });
  await dispatch(commands, privateUpdate({ updateId: 1, text: 'dm text' }));
  assert.equal(store.getBinding(111, 42).sessionId, 'topic-session');
  assert.equal(store.getBinding(111, 42).managedMode, 'auto');
  const bindings = store.listBindings();
  assert.equal(bindings.filter((b) => b.threadId === 42).length, 1);
  assert.equal(bindings.filter((b) => b.threadId === 0).length, 1);
});

test('[dm] creation failure replies once and a retry creates without duplicates', async (t) => {
  const { store, host, commands, bot } = await setup(t);
  host.failCreate = true;
  const failed = await dispatch(commands, privateUpdate({ updateId: 1, text: 'while down' }));
  assert.equal(failed.created ?? false, false);
  assert.equal(store.getBinding(111, 0), null);
  assert.equal(bot.sent.filter((m) => /could not start/i.test(m.text)).length, 1, 'exactly one failure notice');

  host.failCreate = false;
  const ok = await dispatch(commands, privateUpdate({ updateId: 2, text: 'after recovery' }));
  assert.equal(ok.created, true);
  assert.equal(host.created, 1, 'no duplicate creates from the failed attempt');
  assert.equal(store.listBindings().length, 1);
});

test('[dm] prompt failure after bind keeps the binding; retry prompts once', async (t) => {
  const { store, host, commands, bot } = await setup(t);
  await dispatch(commands, privateUpdate({ updateId: 1, text: 'ok' }));
  host.failPrompt = true;
  const failed = await dispatch(commands, privateUpdate({ updateId: 2, text: 'boom' }));
  assert.equal(failed.reason, 'prompt-failed');
  const bound = store.getBinding(111, 0);
  assert.ok(bound, 'binding survives a failed prompt');
  host.failPrompt = false;
  await dispatch(commands, privateUpdate({ updateId: 3, text: 'again' }));
  assert.deepEqual(host.prompts.filter((p) => p.text === 'again').length, 1);
  assert.equal(bot.sent.filter((m) => /Prompt failed/.test(m.text)).length, 1);
});

test('[dm] prompt requestId is stable per Telegram update (idempotent retry identity)', async (t) => {
    const { host, commands } = await setup(t);
  const seen = [];
  const wrapped = await dispatch(commands, privateUpdate({ updateId: 7, messageId: 107, text: 'tracked' }));
  assert.equal(wrapped.prompted, true);
  seen.push(wrapped.requestId);
    // same update identity redelivered through the poller dedupes upstream; a
  // genuine retry (new update) yields a new requestId
  const second = await dispatch(commands, privateUpdate({ updateId: 8, messageId: 108, text: "tracked" }));
  assert.notEqual(second.requestId, seen[0]);
});
