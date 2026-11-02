import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createBacklogStore, BACKLOG_PATH } from '../store.js';

function fixture() {
  let content, version = 0, conflict, link = false;
  const fs = {
    lstat: async (path) => link ? { type: 'symlink' } : path === '.agents' ? { type: 'directory' } : content ? { type: 'file' } : undefined,
    resolve: async (path, options) => ({ targetKey: options ? `${options.cwd}/${path}` : path }),
    contains: (root, target) => target.targetKey.startsWith(`${root.targetKey}/`),
    stat: async () => content === undefined ? undefined : { type: 'file', size: Buffer.byteLength(content), version: String(version) },
    readText: async () => content,
    writeText: async (_target, value, intent) => {
      if (conflict) { const fn = conflict; conflict = null; fn(); throw Object.assign(new Error('race'), { code: 'FS_STALE_VERSION' }); }
      assert.ok(intent);
      if ((intent.kind === 'createIfAbsent' && content !== undefined) ||
          (intent.kind === 'replaceIfVersion' && intent.version !== String(version))) {
        throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
      }
      content = value; version++;
    },
  };
  const sessions = { get: (id) => ['s1', 's2'].includes(id) ? { header: { cwd: '/workspace' } } : undefined };
  const make = () => createBacklogStore({ fs, sessions, now: () => '2026-11-02T03:20:00.000Z' });
  return { make, fs, content: () => content, set: (value) => { content = value; version++; },
    link: () => { link = true; }, conflict: (fn) => { conflict = fn; } };
}
const req = (op, rest = {}) => ({ op, sessionId: 's1', ...rest });

test('list is side-effect free; save persists through fresh store; origin is retained', async () => {
  const f = fixture(), store = f.make();
  assert.deepEqual(await store.run(req('list')), { items: [] });
  assert.equal(f.content(), undefined);
  const saved = await store.run(req('add', { id: 'a', text: '  Follow up\nwith details  ' }));
  assert.equal(saved.items[0].text, 'Follow up\nwith details');
  assert.equal(saved.items[0].state, 'held');
  const fresh = await f.make().run(req('list', { sessionId: 's2' }));
  assert.deepEqual(fresh, saved);
  assert.equal(fresh.items[0].originSessionId, 's1');
  assert.equal(JSON.parse(f.content()).schema, 1);
});

test('concurrent adds do not lose items and duplicate delivery is idempotent', async () => {
  const f = fixture(), store = f.make();
  await Promise.all(Array.from({ length: 30 }, (_, n) => store.run(req('add', { id: `a${n}`, text: `idea ${n}` }))));
  assert.equal((await store.run(req('list'))).items.length, 30);
  await store.run(req('add', { id: 'a1', text: 'idea 1' }));
  assert.equal((await store.run(req('list'))).items.length, 30);
  await assert.rejects(store.run(req('add', { id: 'a1', text: 'different' })), /already exists/);
});

test('pulled and dismissed items remain recoverable; stale edits are refused', async () => {
  const f = fixture(), store = f.make();
  await store.run(req('add', { id: 'a', text: 'idea' }));
  const edit = await store.run(req('edit', { id: 'a', text: 'edited', revision: 1 }));
  assert.equal(edit.items[0].revision, 2);
  await assert.rejects(store.run(req('edit', { id: 'a', text: 'clobber', revision: 1 })), /changed elsewhere/);
  await store.run(req('state', { id: 'a', state: 'pulled', revision: 2 }));
  await store.run(req('state', { id: 'a', state: 'dismissed', revision: 3 }));
  const restored = await store.run(req('state', { id: 'a', state: 'held', revision: 4 }));
  assert.equal(restored.items[0].text, 'edited');
  assert.equal(restored.items[0].state, 'held');
});

test('unrelated external change is merged by guarded retry', async () => {
  const f = fixture(), store = f.make();
  await store.run(req('add', { id: 'a', text: 'first' }));
  f.conflict(() => { const data = JSON.parse(f.content()); data.items[0].text = 'external'; data.items[0].revision++; f.set(JSON.stringify(data)); });
  const result = await store.run(req('add', { id: 'b', text: 'second' }));
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].text, 'external');
});

test('corrupt or future schema is never overwritten', async () => {
  for (const bad of ['bad JSON', JSON.stringify({ schema: 99, items: [] }), JSON.stringify({ schema: 1, items: [{ id: 'a' }] })]) {
    const f = fixture(); f.set(bad);
    await assert.rejects(f.make().run(req('add', { text: 'x' })));
    assert.equal(f.content(), bad);
  }
});

test('unknown sessions, links, path injection, invalid states and empty captures are refused', async () => {
  const f = fixture(), store = f.make();
  await assert.rejects(store.run(req('list', { sessionId: 'unknown' })), /unknown session/);
  await assert.rejects(store.run(req('add', { text: '  ' })), /characters/);
  await assert.rejects(store.run(req('add', { id: '../escape', text: 'x' })), /ID/);
  await store.run(req('add', { id: 'a', text: 'x', path: '/outside' }));
  assert.ok(f.content()); // caller-supplied path is ignored; the fixed target is used
  await assert.rejects(store.run(req('state', { id: 'a', revision: 1, state: 'running' })), /state/);
  f.link();
  await assert.rejects(store.run(req('list')), /link/);
  assert.equal(BACKLOG_PATH, '.agents/backlog.json');
});

let plugin;
const browserStorage = new Map();
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({ createElement() {} })); } } },
  globalThis: { crypto: webcrypto, sessionStorage: {
    getItem: (key) => browserStorage.get(key), setItem: (key, value) => browserStorage.set(key, value),
  } }, console,
});
const { createModel, insertIdea, contribution, unwrap } = plugin.__internals;
const idea = { id: 'a', text: 'idea', originSessionId: 's1', createdAt: '2026-11-02T03:20:00.000Z', state: 'held', revision: 1 };

test('client capture calls only backlog add; no agent or draft action', async () => {
  const calls = [];
  const model = createModel(async (r) => { calls.push(r); return { items: [idea] }; });
  model.patch('s1', { capture: true, text: 'idea' });
  await model.save('s1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'add');
  assert.equal(calls[0].text, 'idea');
  assert.equal(model.get('s1').text, '');
  assert.equal(model.get('s1').capture, false);
  assert.equal(model.get('s2').items.length, 0);
});

test('failed capture retains text and id so retry is safe', async () => {
  let count = 0; const ids = [];
  const model = createModel(async (r) => { ids.push(r.id); if (!count++) throw new Error('offline'); return { items: [idea] }; });
  model.patch('s1', { text: 'keep me', capture: true });
  await model.save('s1');
  assert.equal(model.get('s1').text, 'keep me');
  assert.equal(model.get('s1').capture, true);
  assert.equal(model.get('s1').error, 'offline');
  await model.save('s1');
  assert.equal(ids[0], ids[1]);
});

test('pull is insertion and persistence only, preserves selected text and never submits', async () => {
  const calls = [];
  const actions = {
    captureInsertion: () => ({ start: 2, end: 5, draftRev: 9 }),
    insertText: (value, span) => { calls.push({ value, span }); return true; },
    persistDraft: () => calls.push('persist'),
    submit: () => { throw new Error('must never send'); },
    setDraft: () => { throw new Error('must never replace'); },
  };
  insertIdea(actions, idea);
  assert.equal(calls[0].span.start, 5);
  assert.equal(calls[0].span.end, 5);
  assert.match(calls[0].value, /idea/);
  assert.match(calls[0].value, /origin session s1/);
  assert.equal(calls[1], 'persist');
});

test('locked draft leaves idea held; successful pull marks history only after insertion', async () => {
  const calls = [];
  const model = createModel(async (r) => { calls.push(r); return { items: [{ ...idea, state: r.op === 'list' ? 'held' : 'pulled' }] }; });
  const actions = { captureInsertion: () => ({}), insertText: () => false, persistDraft() {} };
  await model.pull('s1', idea, actions);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'list');
  assert.match(model.get('s1').error, /locked/);
  actions.insertText = () => true;
  await model.pull('s1', idea, actions);
  assert.equal(calls[2].op, 'state');
  assert.equal(calls[2].state, 'pulled');
  assert.match(model.get('s1').notice, /draft only/);
});

test('refresh does not rebase the revision of an in-progress edit', async () => {
  const calls = [];
  const model = createModel(async (r) => { calls.push(r); return { items: [{ ...idea, revision: 2, text: 'remote edit' }] }; });
  model.patch('s1', { editing: idea.id, editText: 'local edit', editRevision: 1 });
  await model.refresh('s1');
  await model.edit('s1', model.get('s1').items[0]);
  assert.equal(calls[1].revision, 1);
});

test('stale or dismissed ideas never enter the draft', async () => {
  for (const current of [{ ...idea, revision: 2 }, { ...idea, state: 'dismissed' }]) {
    const model = createModel(async () => ({ items: [current] }));
    await model.pull('s1', idea, {
      captureInsertion: () => ({}), insertText: () => { throw new Error('must not insert'); }, persistDraft() {},
    });
    assert.match(model.get('s1').error, /changed elsewhere/);
  }
});

test('partial pull failure cannot duplicate insertion after refresh; marking can be retried', async () => {
  let inserts = 0, offline = true;
  const model = createModel(async (r) => {
    if (r.op === 'state' && offline) throw new Error('offline');
    return { items: [{ ...idea, state: r.op === 'state' ? 'pulled' : 'held' }] };
  });
  const actions = { captureInsertion: () => ({}), insertText: () => { inserts++; return true; }, persistDraft() {} };
  await model.pull('s1', idea, actions);
  assert.match(model.get('s1').error, /Added to draft/);
  await model.refresh('s1');
  await model.pull('s1', idea, actions);
  assert.equal(inserts, 1);
  assert.equal(model.get('s1').insertedIds[0], idea.id);
  offline = false;
  await model.state('s1', idea, 'pulled');
  assert.equal(model.get('s1').insertedIds.length, 0);
});

test('persistDraft throwing after insertion still creates an insertion receipt', async () => {
  let inserts = 0;
  const model = createModel(async () => ({ items: [idea] }));
  const actions = { captureInsertion: () => ({}), insertText: () => { inserts++; return true; },
    persistDraft: () => { throw new Error('disk full'); } };
  await model.pull('s1', idea, actions);
  await model.pull('s1', idea, actions);
  assert.equal(inserts, 1);
  assert.equal(model.get('s1').insertedIds[0], idea.id);
});

test('insertion receipt survives creating a fresh client model after page reload', async () => {
  let inserts = 0;
  const call = async (r) => {
    if (r.op === 'state') throw new Error('offline');
    return { items: [idea] };
  };
  const actions = { captureInsertion: () => ({}), insertText: () => { inserts++; return true; }, persistDraft() {} };
  await createModel(call).pull('reload-session', idea, actions);
  await createModel(call).pull('reload-session', idea, actions);
  assert.equal(inserts, 1);
});

test('mount codecs are strict and remote failures surface', () => {
  const descriptor = contribution().descriptors[0];
  assert.equal(descriptor.parameters[0].codec.mode, 'strict');
  assert.equal(descriptor.namespace, 'backlog');
  assert.deepEqual(unwrap({ ok: true, value: 'ok' }), 'ok');
  assert.throws(() => unwrap({ ok: false, message: 'failure' }), /failure/);
});
