import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BindingStore, STATE_VERSION, openBindingStore } from '../src/state.js';
import { makeTempDir, removeDir, readState, stateStat } from './helpers/fixtures.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function newStore(t, { clock } = {}) {
  const dir = await makeTempDir();
  t.after(() => removeDir(dir));
  const store = await openBindingStore({
    file: join(dir, 'telegram-session-bridge', 'state.json'),
    logger: silentLogger,
    ...(clock ? { clock } : {}),
  });
  return { dir, store };
}

test('[M1] bindings persist as versioned JSON through an atomic tmp+rename', async (t) => {
  const { dir, store } = await newStore(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });

  const state = await readState(dir);
  assert.equal(state.version, STATE_VERSION);
  assert.deepEqual(state.bindings['111:42'], {
    chatId: 111,
    threadId: 42,
    sessionId: 'session-a',
    managedMode: 'auto',
    boundAt: state.bindings['111:42'].boundAt,
  });
  assert.match(state.bindings['111:42'].boundAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await stateStat(dir)).mode & 0o777, 0o600);
  const leftovers = (await readdir(join(dir, 'telegram-session-bridge'))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('[M1] the same topic and session rebind idempotently', async (t) => {
  const { dir, store } = await newStore(t);
  const first = await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  const second = await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.binding.boundAt, first.binding.boundAt);
  assert.equal(store.listBindings().length, 1);
  assert.equal((await readState(dir)).bindings['111:42'].sessionId, 'session-a');
});

test('[M1] one session cannot be linked to two topics (UNIQUE(session))', async (t) => {
  const { store } = await newStore(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });

  await assert.rejects(
    store.bind({ chatId: 111, threadId: 43, sessionId: 'session-a', managedMode: 'auto' }),
    (error) => error.code === 'session-already-linked' && /already linked/.test(error.message),
  );
  assert.equal(store.listBindings().length, 1);
  assert.equal(store.getBinding(111, 43), null);
  assert.equal(store.getBindingForSession('session-a').threadId, 42);
});

test('[M1] managed_mode provenance is recorded for auto, restored and new_replaced', async (t) => {
  const { store } = await newStore(t);
  const auto = await store.bind({ chatId: 1, threadId: 10, sessionId: 'session-auto', managedMode: 'auto' });
  assert.equal(auto.binding.managedMode, 'auto');

  await store.bind({ chatId: 1, threadId: 11, sessionId: 'session-restore', managedMode: 'auto' });
  const restored = await store.restore({
    chatId: 1,
    threadId: 11,
    sessionId: 'session-restore',
    replay: async () => 'earlier answer',
  });
  assert.equal(restored.binding.managedMode, 'restored');
  assert.equal(restored.replayed, true);
  assert.equal(restored.replay, 'earlier answer');

  await store.bind({ chatId: 1, threadId: 12, sessionId: 'session-old', managedMode: 'auto' });
  const replaced = await store.bind({ chatId: 1, threadId: 12, sessionId: 'session-new', managedMode: 'new_replaced' });
  assert.equal(replaced.replacedSessionId, 'session-old');
  assert.equal(replaced.binding.managedMode, 'new_replaced');
});

test('[M1] restore replays the last assistant message from the host', async (t) => {
  const { store } = await newStore(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  const seen = [];
  const result = await store.restore({
    chatId: 111,
    threadId: 42,
    sessionId: 'session-a',
    replay: async (sessionId) => {
      seen.push(sessionId);
      return 'the last answer';
    },
  });

  assert.deepEqual(seen, ['session-a']);
  assert.equal(result.replayed, true);
  assert.equal(result.replay, 'the last answer');
  assert.equal(result.created, false);
  assert.equal(store.getBinding(111, 42).managedMode, 'restored');
});

test('[M1] state and verbosity survive a reload', async (t) => {
  const { dir, store } = await newStore(t);
  await store.bind({ chatId: 111, threadId: 42, sessionId: 'session-a', managedMode: 'auto' });
  await store.setVerbosity({ chatId: 111, threadId: 42, level: 'verbose' });

  const reloaded = await new BindingStore({ file: join(dir, 'telegram-session-bridge', 'state.json'), logger: silentLogger }).load();
  assert.equal(reloaded.getBinding(111, 42).sessionId, 'session-a');
  assert.equal(reloaded.getVerbosity(111, 42), 'verbose');
});

test('[M1] topic id 0 (the DM lobby) cannot be bound', async (t) => {
  const { store } = await newStore(t);
  await assert.rejects(
    store.bind({ chatId: 111, threadId: 0, sessionId: 'session-a' }),
    (error) => error.code === 'bad-topic-id',
  );
});

test('[M4] loading creates no state and writes nothing until the operator binds', async (t) => {
  const dir = await makeTempDir();
  t.after(() => removeDir(dir));
  const file = join(dir, 'telegram-session-bridge', 'state.json');
  const store = await openBindingStore({ file, logger: silentLogger });
  await assert.rejects(readFile(file, 'utf8'), (error) => error.code === 'ENOENT');
  assert.equal(store.getBinding(111, 42), null);
});

test('[M4] a corrupt state file is quarantined instead of silently overwritten', async (t) => {
  const dir = await makeTempDir();
  t.after(() => removeDir(dir));
  const stateDir = join(dir, 'telegram-session-bridge');
  await mkdir(stateDir, { recursive: true });
  const file = join(stateDir, 'state.json');
  await writeFile(file, '{ not json', 'utf8');
  const errors = [];
  const store = await openBindingStore({
    file,
    logger: { ...silentLogger, error: (message) => errors.push(String(message)) },
  });

  assert.deepEqual(store.listBindings(), []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unreadable/);
  const backups = (await readdir(stateDir)).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(stateDir, backups[0]), 'utf8'), '{ not json');
});

test('[M4] a future state version is rejected instead of rewritten', async (t) => {
  const dir = await makeTempDir();
  t.after(() => removeDir(dir));
  const stateDir = join(dir, 'telegram-session-bridge');
  await mkdir(stateDir, { recursive: true });
  const file = join(stateDir, 'state.json');
  await writeFile(file, JSON.stringify({ version: STATE_VERSION + 1 }), 'utf8');

  await assert.rejects(openBindingStore({ file, logger: silentLogger }), (error) => error.code === 'state-version');
});

test('[transport] concurrent bindings serialise without losing writes', async (t) => {
  const { dir, store } = await newStore(t);
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      store.bind({ chatId: 111, threadId: 100 + index, sessionId: `session-${index}`, managedMode: 'auto' }),
    ),
  );
  assert.equal(store.listBindings().length, 12);
  const state = await readState(dir);
  assert.equal(Object.keys(state.bindings).length, 12);
  assert.equal((await readdir(join(dir, 'telegram-session-bridge'))).filter((name) => name.endsWith('.tmp')).length, 0);
});
