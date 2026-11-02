/**
 * Smoke test for the client module without a browser: load `client.js` the way the page's module
 * loader does, run `apply` against a stub ctx, and assert the tab type and both slot registrations.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const ID = '@local/dsh-client-sidebar-editor';

test('preview Edit button opens the correct encoded file in the editor', () => {
  const { editAddress, PreviewEditButton } = mod.__internals;
  const path = '/workspace/my file #1.ts';
  const address = editAddress(path);
  assert.equal(mod.__internals.pathOf(address), path);
  assert.equal(editAddress(undefined), '');
  assert.equal(editAddress('relative.ts'), '');
  const calls = [];
  const button = PreviewEditButton({ absolutePath: path, sessionId: 's1', openEditor: (...args) => calls.push(args) });
  assert.equal(button.type, 'button');
  assert.equal(button.props['aria-label'], 'Edit file');
  button.props.onClick();
  assert.deepEqual(calls, [[address, 's1']]);
  assert.equal(PreviewEditButton({ absolutePath: '/workspace/image.png' }), null);
});

test('registered preview action selects editor kind and ignores stale-session clicks', () => {
  let component;
  let mounted = 's1';
  const opens = [];
  const ctx = {
    effect: fn => fn(),
    locale: { bind: () => key => key, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: {
      mounted: { getSnapshot: () => mounted },
      openResource: (...args) => opens.push(args),
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, Component) => {
        if (options.id === 'sidebar-editor-edit') component = Component;
        return () => {};
      },
    },
    remote: { $mount: async () => () => {} },
  };
  mod.apply(ctx);
  const fragment = component({ sessionId: 's1', absolutePath: '/workspace/test.ts' });
  assert.equal(fragment.type, ReactStub.Fragment, 'the toolbar cell renders the button beside the note host');
  const edit = fragment.props.children[0];
  const button = edit.type(edit.props);
  button.props.onClick();
  assert.deepEqual(opens, [['dsh-resource://file/absolute/workspace/test.ts', { kind: 'editor' }]]);
  mounted = 's2';
  button.props.onClick();
  assert.equal(opens.length, 1);
});

test('popover flips above a selection and stays within viewport edges', () => {
  const place = mod.__internals.popoverPosition;
  assert.deepEqual(place({ left: 30, top: 50, bottom: 70 }, 304, 188, 1000, 800), { left: 30, top: 78 });
  assert.deepEqual(place({ left: 950, top: 720, bottom: 740 }, 304, 188, 1000, 800), { left: 688, top: 524 });
  assert.deepEqual(place({ left: -30, top: 10, bottom: 30 }, 304, 188, 320, 220), { left: 8, top: 8 });
});

/** Minimal React stand-in: the factory only needs createElement and the hooks it calls at render. */
const ReactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), ...(children.length ? { children } : {}) },
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
};

/** Load the module the way `__ModuleLoader__` does and return its exported face. */
function loadModule() {
  let face;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, ID, 'the module id must equal the package name');
        face = factory((name) => {
          if (name === 'react') return ReactStub;
          throw new Error(`unexpected require: ${name}`);
        });
      },
    },
  };
  return { set: (f) => (face = f), get: () => face };
}

const loaded = loadModule();
await import('../client.js');
const mod = loaded.get();

test('module exports the apply face and its service inject list', () => {
  assert.equal(typeof mod.apply, 'function');
  for (const service of ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']) {
    assert.ok(mod.inject.includes(service), `missing inject: ${service}`);
  }
});

test('editor remains opt-in and does not replace the shipped preview', () => {
  const registered = [];
  const slotRegs = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    sidebarRightTabs: { register: (definition) => (registered.push(definition), () => {}) },
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, Component) => (slotRegs.push({ options, Component }), () => {}),
    },
    remote: {
      $mount: async () => () => {},
      sidebarEditor: { save: async () => ({ version: 'v2', before: '', after: '', operation: 'update' }) },
      workspaceFiles: { read: async () => ({ text: '', lines: 0, eof: true }) },
    },
  };

  mod.apply(ctx);

  assert.equal(registered.length, 1, 'exactly one tab type');
  const type = registered[0];
  assert.equal(type.id, ID);
  assert.equal(type.kind, 'editor');
  // The shipped file preview's full-URI fallback pattern wins by specificity.
  assert.equal(type.priority, 'fallback');
  assert.deepEqual(type.patterns, ['*']);
  assert.equal(type.title('dsh-resource://file/session/s1/home/me/notes.md'), 'notes.md');
  assert.equal(type.title('dsh-resource://file/absolute/tmp/x.ts'), 'x.ts');
  assert.equal(type.title('nonsense'), 'type.label', 'falls back to copy for a non-file address');

  assert.equal(slotRegs.length, 5, 'body, title, stager, chat-note composer and preview Edit action');
  assert.ok(slotRegs.some(entry => entry.options.name === 'sidebar.right.tab.document.actions' && entry.options.id === 'sidebar-editor-edit'));
  const byName = Object.fromEntries(slotRegs.map((entry) => [entry.options.name, entry]));
  assert.equal(byName['sidebar.right.pane.tab'].options.key, ID);
  assert.equal(byName['sidebar.right.pane.tab.title'].options.key, ID);
  assert.equal(byName['conversation.input.left'].options.id, 'sidebar-editor-notes');
  assert.equal(byName['conversation.input.dock'].options.id, 'sidebar-editor-note-composer');
  for (const entry of slotRegs) assert.equal(typeof entry.Component, 'function');
});

test('the body binds its Remote call to the tab session and renders without throwing', async () => {
  const calls = [];
  let options;
  let body;
  const ctx = {
    effect: (fn) => fn(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject: (_name, factory) => factory(),
      register: (registered, Component) => {
        if (registered.name === 'sidebar.right.pane.tab') {
          options = registered;
          body = Component;
        }
        return () => {};
      },
    },
    remote: {
      $mount: async () => () => {},
      sidebarEditor: { save: async () => ({ version: 'v2', before: '', after: '', operation: 'update' }) },
      workspaceFiles: {
        read: async (...args) => {
          calls.push(args);
          return { text: 'line one\nline two', lines: 2, eof: true };
        },
      },
    },
  };
  mod.apply(ctx);
  assert.equal(typeof body, 'function');
  assert.equal(typeof options.inject, 'function', 'the body needs an inject factory');

  const signal = new AbortController().signal;
  const face = options.inject('session-1');
  const page = await face.readFile('home/me/notes.md', signal);

  assert.equal(page.lines, 2);
  assert.equal(calls.length, 1);
  const [scope, path, range, passed] = calls[0];
  assert.equal(scope, 'session-1', 'reads are scoped to the tab session, never to whatever is on screen');
  assert.equal(path, 'home/me/notes.md');
  assert.deepEqual(range, { offset: 1, limit: 5000 });
  assert.equal(passed, signal, 'the caller keeps its abort signal');

  const element = body({
    tab: { contentId: 'dsh-resource://file/session/session-1/home/me/notes.md' },
    t: (key) => key,
    readFile: face.readFile,
    documents: face.documents,
  });
  assert.equal(element.type, 'div');
});

const { createDocuments, pathOf, basename, errorKey } = mod.__internals;

/** One tick, enough for the cache's promise chain to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('address parsing survives scopes, encoding and nonsense', () => {
  assert.equal(pathOf('dsh-resource://file/session/s1/home/me/a%20b.md'), 'home/me/a b.md');
  assert.equal(pathOf('dsh-resource://file/absolute/tmp/x.ts'), '/tmp/x.ts');
  assert.equal(pathOf('sidebar://guide'), '');
  assert.equal(pathOf('dsh-resource://file/session'), '');
  assert.equal(pathOf('dsh-resource://file/session/s1/'), '');
  assert.equal(basename('home/me/a.md'), 'a.md');
});

test('two views of one address share a single read, and the content outlives both', async () => {
  const documents = createDocuments();
  let reads = 0;
  const read = async () => {
    reads += 1;
    return { ok: true, value: { text: 'hello', lines: 1, eof: true } };
  };

  const seenA = [];
  const seenB = [];
  const stopA = documents.watch('dsh-resource://file/session/s1/a.md', 'a.md', read, (s) => seenA.push(s.status));
  const stopB = documents.watch('dsh-resource://file/session/s1/a.md', 'a.md', read, (s) => seenB.push(s.status));
  await settle();

  assert.equal(reads, 1, 'one fetch for two views (I1)');
  assert.equal(documents.peek('dsh-resource://file/session/s1/a.md').text, 'hello');
  assert.deepEqual(seenB, ['loading', 'ready'], 'a late subscriber sees the current state on arrival');

  // Both views leave; the entry stays, so a remount shows content without touching the Remote (I6).
  stopA();
  stopB();
  const seenC = [];
  const stopC = documents.watch('dsh-resource://file/session/s1/a.md', 'a.md', read, (s) => seenC.push(s.status));
  await settle();
  assert.equal(reads, 1, 'remount must not refetch');
  assert.deepEqual(seenC, ['ready']);
  stopC();
});

test('a failed read is cached as a typed failure, not retried on remount', async () => {
  const documents = createDocuments();
  let reads = 0;
  const read = async () => {
    reads += 1;
    throw Object.assign(new Error('nope'), { code: 'workspace-file/too-large' });
  };
  const stop = documents.watch('dsh-resource://file/session/s1/big.log', 'big.log', read, () => {});
  await settle();
  const state = documents.peek('dsh-resource://file/session/s1/big.log');
  assert.equal(state.status, 'error');
  assert.equal(state.key, 'error.tooLarge');
  stop();

  const seen = [];
  const stop2 = documents.watch('dsh-resource://file/session/s1/big.log', 'big.log', read, (s) => seen.push(s.status));
  await settle();
  assert.equal(reads, 1, 'a failure is not re-run by a remount');
  assert.deepEqual(seen, ['error']);
  stop2();
});

test('the cache evicts unsubscribed documents past its bound and keeps the watched ones', async () => {
  const documents = createDocuments();
  const read = async () => ({ ok: true, value: { text: 'x', lines: 1, eof: true } });
  const stop = documents.watch('dsh-resource://file/session/s1/pinned.md', 'pinned.md', read, () => {});
  for (let index = 0; index < 30; index += 1) {
    documents.watch(`dsh-resource://file/session/s1/f${index}.md`, `f${index}.md`, read, () => {})();
  }
  await settle();
  assert.ok(documents.size <= 24, `cache stayed bounded: ${documents.size}`);
  assert.equal(documents.peek('dsh-resource://file/session/s1/pinned.md').status, 'ready', 'a watched document is never evicted');
  stop();
});

test('error codes choose the copy a user reads', () => {
  assert.equal(errorKey({ code: 'workspace-file/too-large' }), 'error.tooLarge');
  assert.equal(errorKey({ code: 'workspace-file/not-text' }), 'error.binary');
  assert.equal(errorKey(new Error('boom')), 'error.title');
});

const { createNotes, makeNote, formatNote } = mod.__internals;

test('a note is a snapshot: range, quote and body travel together', () => {
  const note = makeNote({
    sessionId: 's1',
    address: 'dsh-resource://file/session/s1/a.md',
    path: 'a.md',
    startLine: 12,
    endLine: 14,
    quote: 'one\ntwo\nthree',
    body: 'rename this',
  });
  const text = formatNote(note);
  assert.match(text, /lines 12-14 of a\.md/);
  assert.match(text, /^> one$/m);
  assert.match(text, /note: rename this$/);
  assert.equal(note.id.startsWith('note-'), true);
});

test('a one-line note says "line", not "lines"', () => {
  const note = makeNote({ sessionId: 's1', address: 'a', path: 'a.ts', startLine: 7, endLine: 7, quote: 'x', body: 'b' });
  assert.match(formatNote(note), /^line 7 of a\.ts/);
});

test('the tray is per session, removable, and notifies subscribers', () => {
  const notes = createNotes();
  const seen = [];
  const stop = notes.subscribe((sessionId) => seen.push(sessionId));
  const first = notes.add(makeNote({ sessionId: 's1', address: 'a', path: 'a.md', startLine: 1, endLine: 1, quote: 'q', body: 'b' }));
  notes.add(makeNote({ sessionId: 's2', address: 'b', path: 'b.md', startLine: 2, endLine: 2, quote: 'q', body: 'b' }));

  assert.equal(notes.list('s1').length, 1, 'sessions do not see each other\'s notes');
  assert.equal(notes.list('s2').length, 1);
  assert.deepEqual(seen, ['s1', 's2']);
  assert.equal(notes.remove('s1', first.id), true);
  assert.equal(notes.list('s1').length, 0);
  assert.equal(notes.remove('s1', first.id), false, 'removing twice is a no-op');
  stop();
  notes.add(makeNote({ sessionId: 's1', address: 'a', path: 'a.md', startLine: 3, endLine: 3, quote: 'q', body: 'b' }));
  assert.equal(seen.length, 3, 'a disposer stops notifications');
});

const { saveContribution } = mod.__internals;

test('the client descriptor names the one endpoint the panel calls, with source-JSON codecs', () => {
  const contribution = saveContribution();
  assert.equal(contribution.package, ID);
  assert.equal(contribution.descriptors.length, 1);
  const [descriptor] = contribution.descriptors;
  assert.equal(descriptor.namespace, 'sidebarEditor');
  assert.equal(descriptor.method, 'save');
  assert.equal(descriptor.service, 'sidebarEditor');
  assert.deepEqual(descriptor.invocation, { kind: 'direct' });
  assert.equal(descriptor.parameters.length, 1);
  assert.equal(descriptor.parameters[0].wire, 'request');
  assert.equal(descriptor.parameters[0].source, 'json');
  // The Client refuses anything but strict input codecs when it mounts a contribution.
  assert.equal(descriptor.parameters[0].codec.mode, 'strict');
  assert.equal(typeof descriptor.parameters[0].codec.create().parse, 'function');
  assert.equal(descriptor.parameters[0].codec.create().parse({ a: 1 }).a, 1);
  assert.equal(descriptor.result.mode, 'strict');
});

test('a landed save replaces the cached text and tells every view', async () => {
  const documents = createDocuments();
  const seen = [];
  const stop = documents.watch('dsh-resource://file/session/s1/a.md', 'a.md', async () => ({ text: 'before', lines: 1, eof: true }), () => {});
  documents.watch('dsh-resource://file/session/s1/a.md', 'a.md', async () => ({ text: 'before', lines: 1, eof: true }), (state) => seen.push(state.text));
  await settle();
  documents.adopt('dsh-resource://file/session/s1/a.md', { status: 'ready', text: 'after', lines: 1, eof: true, version: 'v2' });
  assert.equal(documents.peek('dsh-resource://file/session/s1/a.md').text, 'after');
  assert.ok(seen.includes('after'), 'the second view saw the saved text');
  stop();
});

const { saveErrorKey } = mod.__internals;

test('a refused save picks the notice the user needs', () => {
  assert.equal(saveErrorKey(Object.assign(new Error('FS_STALE_VERSION'), { code: 'FS_STALE_VERSION' })), 'edit.conflict');
  assert.equal(saveErrorKey(new Error('sidebar-editor: outside-workspace')), 'edit.outside');
  assert.equal(saveErrorKey(new Error('disk full')), 'edit.failed');
  assert.equal(saveErrorKey(null), 'edit.failed');
});

const { unwrap } = mod.__internals;

test('a Remote envelope is unwrapped before the editor reads it', () => {
  assert.deepEqual(unwrap({ ok: true, value: { version: 'v2', after: 'x' } }), { version: 'v2', after: 'x' });
  const stale = { ok: false, code: 'FS_STALE_VERSION', details: { code: 'FS_STALE_VERSION' } };
  assert.throws(() => unwrap(stale), (error) => saveErrorKey(error) === 'edit.conflict');
  assert.throws(() => unwrap({ ok: false, message: 'sidebar-editor: outside-workspace' }), (e) => saveErrorKey(e) === 'edit.outside');
});

test('the reader declines what it cannot render, so the preview keeps those files', () => {
  const type = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    sidebarRightTabs: { register: (definition) => (type.push(definition), () => {}) },
    slots: { inject: (_n, f) => f(), register: () => () => {} },
    remote: {
      $mount: async () => () => {},
      sidebarEditor: { save: async () => ({ ok: true, value: {} }) },
      workspaceFiles: { read: async () => ({ text: '', lines: 0, eof: true }) },
    },
  };
  mod.apply(ctx);
  const canOpen = type[0].canOpen;
  assert.equal(canOpen('dsh-resource://file/session/s1/home/me/a.ts'), true);
  assert.equal(canOpen('dsh-resource://file/session/s1/home/me/notes.md'), true);
  assert.equal(canOpen('dsh-resource://file/session/s1/home/me/doc.pdf'), false);
  assert.equal(canOpen('dsh-resource://file/session/s1/home/me/pic.PNG'), false);
  assert.equal(canOpen('dsh-resource://file/session/s1/home/me/sheet.xlsx'), false);
  assert.equal(canOpen('dsh-resource://file/session/s1/home/me/clip.mp4'), false);
});

test('a chat note records the message it came from, and formats as a message quote', () => {
  const note = makeNote({
    sessionId: 's1',
    kind: 'message',
    anchor: '14:assistant-step20:8',
    quote: 'the sentence I picked',
    body: 'explain this',
  });
  const text = formatNote(note);
  assert.match(text, /^re: the assistant message in turn 14$/m);
  assert.match(text, /^> the sentence I picked$/m);
  assert.match(text, /note: explain this$/);
});

test('a preview note names its file, and admits when it cannot name lines', () => {
  const { noteWhere, formatNote } = mod.__internals;
  assert.equal(
    noteWhere({ kind: 'file', path: 'src/a.ts', startLine: 4, endLine: 4 }),
    'line 4 of src/a.ts',
  );
  assert.equal(
    noteWhere({ kind: 'file', path: 'src/a.ts', startLine: 4, endLine: 9 }),
    'lines 4-9 of src/a.ts',
  );
  // A rendered preview has no source lines, so the note must not invent one.
  assert.equal(
    noteWhere({ kind: 'file', path: 'README.md', startLine: null, endLine: null }),
    'selection in README.md',
  );
  const text = formatNote({ kind: 'file', path: 'README.md', startLine: null, endLine: null, quote: 'hello', body: 'expand' });
  assert.equal(text, 'selection in README.md\n> hello\n\nnote: expand');
});
