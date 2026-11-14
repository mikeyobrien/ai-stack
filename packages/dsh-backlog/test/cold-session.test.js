import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createBacklogStore, BACKLOG_PATH } from '../store.js';

function fixture({ live = new Map(), stored = new Map(), lookup, unsafePath, contained = true } = {}) {
  const observed = { lookups: [], paths: [], writes: [] };
  let content;
  const fs = {
    async lstat(path, { cwd }) {
      observed.paths.push({ path, cwd });
      return path === unsafePath ? { type: 'symlink' } : undefined;
    },
    async resolve(path, options) { return { targetKey: options ? `${options.cwd}/${path}` : path }; },
    contains: (root, target) => contained && target.targetKey.startsWith(`${root.targetKey}/`),
    async stat() { return content === undefined ? undefined : { type: 'file', size: Buffer.byteLength(content), version: '1' }; },
    async readText() { return content; },
    async writeText(target, value) { observed.writes.push(target.targetKey); content = value; },
  };
  const sessions = { get: id => live.get(id) };
  const sessionPersistence = {
    async stat(id) { observed.lookups.push(id); return lookup ? lookup(id) : stored.get(id); },
  };
  return { store: createBacklogStore({ fs, sessions, sessionPersistence }), observed };
}
const cold = { header: { id: 'cold-summary', cwd: '/original/worktree', agentPreset: 'ralph-summary', isSeeded: false } };

test('known cold session lists from its immutable persisted cwd without creating a backlog or accepting caller paths', async () => {
  const setup = fixture({ stored: new Map([['cold-summary', cold]]) });
  assert.deepEqual(await setup.store.run({ op: 'list', sessionId: 'cold-summary', cwd: '/wrong', path: '/outside/backlog.json' }), { items: [] });
  assert.deepEqual(setup.observed.lookups, ['cold-summary']);
  assert.deepEqual(setup.observed.paths, [{ path: '.agents', cwd: '/original/worktree' }, { path: BACKLOG_PATH, cwd: '/original/worktree' }]);
  assert.deepEqual(setup.observed.writes, []);
  assert.equal(cold.header.agentPreset, 'ralph-summary');
});

test('a known live header wins without consulting persisted metadata', async () => {
  const setup = fixture({ live: new Map([['live', { header: { cwd: '/live/original' } }]]), lookup() { throw new Error('live lookup must not read persistence'); } });
  assert.deepEqual(await setup.store.run({ op: 'list', sessionId: 'live' }), { items: [] });
  assert.deepEqual(setup.observed.lookups, []);
  assert.ok(setup.observed.paths.every(item => item.cwd === '/live/original'));
});

test('truly unknown or cwd-less persisted sessions remain refused before filesystem access', async () => {
  const setup = fixture({ stored: new Map([['cwd-less', { header: { id: 'cwd-less', isSeeded: false } }]]) });
  for (const sessionId of ['unknown', 'cwd-less']) await assert.rejects(setup.store.run({ op: 'list', sessionId }), /backlog: unknown session/);
  assert.deepEqual(setup.observed.paths, []); assert.deepEqual(setup.observed.writes, []);
});

test('persistence corruption, I/O and unsupported-format errors propagate rather than becoming unknown sessions', async t => {
  for (const code of ['SESSION_PERSISTENCE_CORRUPTION', 'EACCES', 'SESSION_FORMAT_UNSUPPORTED']) await t.test(code, async () => {
    const error = Object.assign(new Error('Persistent header cannot be read'), { code });
    const setup = fixture({ lookup() { throw error; } });
    await assert.rejects(setup.store.run({ op: 'list', sessionId: 'cold-summary' }), caught => caught === error);
    assert.deepEqual(setup.observed.paths, []); assert.deepEqual(setup.observed.writes, []);
  });
});

test('cold-session resolution preserves parent/file link refusal and workspace containment', async t => {
  for (const unsafePath of ['.agents', BACKLOG_PATH]) await t.test(unsafePath, async () => {
    const setup = fixture({ stored: new Map([['cold-summary', cold]]), unsafePath });
    await assert.rejects(setup.store.run({ op: 'list', sessionId: 'cold-summary' }), /must not be a link or special file/);
    assert.deepEqual(setup.observed.writes, []);
  });
  const setup = fixture({ stored: new Map([['cold-summary', cold]]), contained: false });
  await assert.rejects(setup.store.run({ op: 'list', sessionId: 'cold-summary' }), /outside the workspace/);
  assert.deepEqual(setup.observed.writes, []);
});

test('cold sessions retain ordinary save, edit and state behavior with fixed-path revalidation', async () => {
  const setup = fixture({ stored: new Map([['cold-summary', cold]]) });
  const saved = await setup.store.run({ op: 'add', sessionId: 'cold-summary', id: 'idea', text: 'Remember the evidence' });
  assert.equal(saved.items[0].originSessionId, 'cold-summary');
  await setup.store.run({ op: 'edit', sessionId: 'cold-summary', id: 'idea', text: 'Updated idea', revision: 1 });
  const changed = await setup.store.run({ op: 'state', sessionId: 'cold-summary', id: 'idea', state: 'pulled', revision: 2 });
  assert.equal(changed.items[0].text, 'Updated idea'); assert.equal(changed.items[0].state, 'pulled');
  assert.deepEqual(setup.observed.writes, Array(3).fill('/original/worktree/.agents/backlog.json'));
  assert.equal(setup.observed.lookups.length, 6, 'each mutation revalidates the persisted workspace before publishing');
});

// Opt into the installed Harness boundary without adding runtime dependencies to
// this profile plugin: DSH_TEST_RUNTIME=/path/to/dsh npm test.
test('real JSONL flush/close and backend restart leave a cold session listable without any Agent or backlog file', { skip: !process.env.DSH_TEST_RUNTIME }, async t => {
  const runtime = createRequire(join(process.env.DSH_TEST_RUNTIME, 'package.json'));
  const load = name => import(pathToFileURL(runtime.resolve(name)).href);
  const [{ Context }, Persistence, { SESSION_FORMAT_VERSION, SessionId }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-session-persistence-jsonl'), load('@deepseek-ai/dsh-session'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-backlog-cold-'));
  const workspace = join(directory, 'original-worktree'), storage = join(directory, 'sessions');
  await mkdir(workspace);
  const contexts = [];
  t.after(async () => {
    try { for (const context of contexts) await context.fiber.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const start = async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(Persistence, { root: storage, compression: 'none' }).await();
    return context;
  };
  const id = SessionId('cold-summary');
  const first = await start();
  const writer = await first.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: workspace, agentPreset: 'ralph-summary', isSeeded: false });
  await writer.flush(); await writer.close(); await first.fiber.dispose();
  const restarted = await start();
  assert.equal(restarted.get('agents'), undefined, 'this fixture has no AgentFactory or model driver to activate');
  const nativeStat = restarted.sessionPersistence.stat.bind(restarted.sessionPersistence);
  const setup = fixture({ lookup: nativeStat });
  const header = (await nativeStat(id)).header;
  assert.equal(header.cwd, workspace); assert.equal(header.agentPreset, 'ralph-summary'); assert.equal(header.isSeeded, false);
  assert.deepEqual(await setup.store.run({ op: 'list', sessionId: id }), { items: [] });
  assert.ok(setup.observed.paths.every(item => item.cwd === workspace));
  assert.deepEqual(setup.observed.writes, []);
  assert.deepEqual(await readdir(workspace), []);
  assert.deepEqual((await nativeStat(id)).header, header);
  await assert.rejects(setup.store.run({ op: 'list', sessionId: 'not-persisted' }), /backlog: unknown session/);
});
