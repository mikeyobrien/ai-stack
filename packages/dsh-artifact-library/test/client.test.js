/**
 * Behaviour test for the browser half, without a browser: load `client.js` the
 * way the page's module loader does, apply it to a stub context, and render the
 * reader's element tree. The assertions are about what a person can reach — the
 * Library entry, the list, the reader, the origin link, and the sandboxed HTML
 * frame — and about the rule that no React hook runs in `apply`.
 *
 * The real React run lives in `test/fixture/`; this file keeps the ordinary
 * `npm test` run honest without adding React as a package dependency.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const ID = '@local/dsh-artifact-library';
const NS = 'artifact-library';

let face;
let hooksEnabled = false;
const stateUpdates = [];
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState(initial) {
    if (!hooksEnabled) throw new Error('React hooks cannot run during Cordis plugin apply');
    return [initial, (next) => { stateUpdates.push(next); }];
  },
  useEffect() {
    if (!hooksEnabled) throw new Error('React hooks cannot run during Cordis plugin apply');
  },
  useReducer(_reducer, initial) {
    if (!hooksEnabled) throw new Error('React hooks cannot run during Cordis plugin apply');
    return [initial, () => {}];
  },
};

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, ID, 'the module id must equal the package name');
      face = factory((name) => {
        assert.equal(name, 'react');
        return ReactStub;
      });
    },
  },
};
await import('../client.js');

const mod = face;
const internals = mod.__internals;
const DICT = internals.locale;
const t = (key) => DICT[key] ?? key;

/** The text a reader would see, flattening the element tree. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') return textOf(node.type(node.props));
  return textOf(node.children);
}

/** The first element matching a predicate. */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  return findNode(node.children, predicate);
}

/** Render the reader with hooks enabled, then restore the strict apply stub. */
function renderReader(props) {
  hooksEnabled = true;
  try {
    return internals.ReaderPage(props);
  } finally {
    hooksEnabled = false;
  }
}

/** Apply the module to a stub Client context and collect its registrations. */
function boot() {
  const registrations = [];
  const mounts = [];
  const injections = [];
  const effects = [];
  const ctx = {
    locale: {
      register(ns, dicts) {
        assert.equal(ns, NS);
        assert.equal(dicts.en.panel, 'Artifact Library');
        return () => {};
      },
      getSnapshot: () => ({}),
      subscribe: () => () => {},
      bind: () => t,
    },
    remote: {
      $mount(contribution) {
        mounts.push(contribution);
        return Promise.resolve();
      },
    },
    slots: {
      inject(name, run) {
        run();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effects.push(cleanup);
    },
    inject(keys, run) {
      injections.push(Array.from(keys));
      run({ remote: { artifactLibrary: {} } });
      return { dispose() {} };
    },
  };
  const previous = hooksEnabled;
  hooksEnabled = false;
  try {
    mod.apply(ctx);
  } finally {
    hooksEnabled = previous;
  }
  return { registrations, mounts, injections, effects };
}

test('apply never runs a React hook; the page owns its own state', async () => {
  // The React stub throws on useState/useEffect/useReducer, so a direct hook
  // call in apply would fail this test rather than reach the browser.
  const { registrations, mounts, injections } = boot();
  await Promise.resolve();
  assert.equal(registrations.length, 2);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].package, ID);
  assert.deepEqual(mounts[0].descriptors.map(({ method, namespace }) => ({ method, namespace })), [
    { method: 'library', namespace: 'artifactLibrary' },
    { method: 'search', namespace: 'artifactLibrary' },
    { method: 'artifact', namespace: 'artifactLibrary' },
    { method: 'setPinned', namespace: 'artifactLibrary' },
    { method: 'register', namespace: 'artifactLibrary' },
  ]);
  assert.deepEqual(injections, [['remote.artifactLibrary']]);
});

test('the left sidebar gets the Artifact Library entry that opens the same main panel', () => {
  const { registrations } = boot();
  const entry = registrations.find(({ options }) => options.name === 'sidebar.panellist');
  const panel = registrations.find(({ options }) => options.name === 'main');
  assert.ok(entry, 'a sidebar-panellist entry is registered');
  assert.ok(panel, 'a main panel is registered');
  assert.equal(entry.options.id, 'library');
  assert.equal(panel.options.key, entry.options.id, 'the entry id is the main panel key');
  assert.equal(entry.options.label(), 'Artifact Library');
  assert.equal(typeof entry.component, 'function');
  assert.equal(panel.component, internals.LibraryPage);
});

test('the client injects the native session catalog and workspace navigation', () => {
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote', 'sessions', 'uiWorkspace']);
});

test('the reader renders artifact metadata and a real ?session link, never [object Object]', () => {
  const doc = {
    id: 'a-html',
    title: 'Report HTML',
    kind: 'research',
    project: 'ai-stack',
    mode: 'html',
    source: 'snapshot',
    sourceSessionId: 'session-x',
    html: '<html><head><title>Saved</title></head><body><script>bad()</script><img src="https://evil.test/x.png"></body></html>',
    relatedArtifactId: 'a-md',
  };
  const tree = renderReader({
    t,
    useArtifact: () => ({ doc, error: null }),
    artifactId: 'a-html',
    onBack: () => {},
    ctx: {},
  });
  const text = textOf(tree);
  assert.match(text, /Research/);
  assert.match(text, /ai-stack/);
  assert.match(text, /Origin/);
  assert.match(text, /Saved copy/);
  assert.match(text, /a-md/);
  assert.equal(text.includes('[object Object]'), false, 'metadata elements are rendered as nodes, not joined into text');

  const link = findNode(tree, (node) => node.type === 'a');
  assert.ok(link, 'the origin is a link');
  assert.equal(link.props.href, '?session=session-x', 'the link uses the app deep-link form, not a guessed #/s route');
  assert.equal(link.props.href.includes('#/s/'), false);

  const frame = findNode(tree, (node) => node.type === 'iframe');
  assert.ok(frame, 'an HTML artifact is rendered in an iframe');
  assert.equal(frame.props.sandbox, '', 'the iframe sandbox grants no capability');
  assert.equal(Object.hasOwn(frame.props, 'ref'), false, 'the reader never touches the frame DOM');
  assert.equal(frame.props.referrerPolicy, 'no-referrer');
  assert.equal(frame.props.srcDoc.includes('allow-modals'), false);
  assert.ok(frame.props.srcDoc.indexOf('Content-Security-Policy') < frame.props.srcDoc.indexOf('<title>'), 'the CSP is first in the head');
});

test('the reader shows markdown through the safe HTML path, not an iframe', () => {
  const doc = {
    id: 'a-md',
    title: 'Report',
    kind: 'research',
    project: 'ai-stack',
    mode: 'markdown',
    source: 'original',
    sourceSessionId: 'session-x',
    html: '<h1>Report</h1><p>Body</p>',
  };
  const tree = renderReader({
    t,
    useArtifact: () => ({ doc, error: null }),
    artifactId: 'a-md',
    onBack: () => {},
    ctx: {},
  });
  assert.equal(findNode(tree, (node) => node.type === 'iframe'), undefined);
  const body = findNode(tree, (node) => node.props?.className === 'lib-markdown');
  assert.ok(body, 'markdown uses the safe innerHTML reader');
  assert.equal(body.props.dangerouslySetInnerHTML.__html, doc.html);
});

test('the origin refreshes the native session catalog before opening the exact source', async () => {
  const order = [];
  const ctx = {
    sessions: {
      async refresh() { order.push('refresh'); },
      list: { getSnapshot: () => ({ phase: 'ready', ids: ['session-x', 'session-y'], byId: { 'session-x': {}, 'session-y': {} } }) },
    },
    uiWorkspace: { openSession: (id) => order.push(`open:${id}`) },
  };
  await internals.navigateToSession(ctx, 'session-x');
  assert.deepEqual(order, ['refresh', 'open:session-x']);
});

test('an unavailable origin target throws and never opens another chat', async () => {
  const opened = [];
  const ctx = {
    sessions: {
      async refresh() {},
      list: { getSnapshot: () => ({ phase: 'ready', ids: ['session-other'], byId: { 'session-other': {} } }) },
    },
    uiWorkspace: { openSession: (id) => opened.push(id) },
  };
  await assert.rejects(internals.navigateToSession(ctx, 'session-x'), /not available/);
  assert.deepEqual(opened, []);
});

test('an origin click intercepts the URL, refreshes, then opens the clicked source', async () => {
  const order = [];
  const ctx = {
    sessions: {
      async refresh() { order.push('refresh'); },
      list: { getSnapshot: () => ({ phase: 'ready', ids: ['session-x', 'session-y'], byId: { 'session-x': {}, 'session-y': {} } }) },
    },
    uiWorkspace: { openSession: (id) => order.push(`open:${id}`) },
  };
  const doc = { id: 'a-md', title: 'Report', kind: 'research', project: 'ai-stack', mode: 'markdown', source: 'original', sourceSessionId: 'session-x', html: '<p>x</p>' };
  const tree = renderReader({ t, useArtifact: () => ({ doc, error: null }), artifactId: 'a-md', onBack: () => {}, ctx });
  const link = findNode(tree, (node) => node.type === 'a');
  let prevented = 0;
  link.props.onClick({ preventDefault: () => { prevented += 1; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prevented, 1, 'the URL fallback is always intercepted');
  assert.deepEqual(order, ['refresh', 'open:session-x']);
});

test('an unavailable origin click surfaces the error instead of opening the previous chat', async () => {
  stateUpdates.length = 0;
  const opened = [];
  const ctx = {
    sessions: {
      async refresh() {},
      list: { getSnapshot: () => ({ phase: 'ready', ids: ['session-other'], byId: { 'session-other': {} } }) },
    },
    uiWorkspace: { openSession: (id) => opened.push(id) },
  };
  const doc = { id: 'a-md', title: 'Report', kind: 'research', project: 'ai-stack', mode: 'markdown', source: 'original', sourceSessionId: 'session-x', html: '<p>x</p>' };
  const tree = renderReader({ t, useArtifact: () => ({ doc, error: null }), artifactId: 'a-md', onBack: () => {}, ctx });
  const link = findNode(tree, (node) => node.type === 'a');
  link.props.onClick({ preventDefault: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(opened, [], 'no wrong chat is opened');
  assert.equal(stateUpdates.at(-1), 'That session is not available.');
});

test('a collection heading is its human title, not the repeated project label', () => {
  const collection = {
    id: 'coll-a',
    title: 'Library topic',
    project: 'ai-stack',
    artifacts: [{ id: 'a-md', title: 'Report MD', kind: 'research', availability: 'original' }],
    expectedOutputs: [],
  };
  const tree = internals.CollectionBlock({ t, collection, onOpen: () => {}, onTogglePin: () => {} });
  const section = findNode(tree, (node) => node.type === 'section');
  assert.equal(section.props['aria-label'], 'Library topic', 'the accessible name uses the topic title');
  const text = textOf(tree);
  assert.match(text, /Library topic/);
  assert.equal(text.includes('ai-stack'), true, 'the row metadata still carries the project');
  assert.ok(text.indexOf('Library topic') < text.indexOf('ai-stack'), 'the heading is the topic, the row carries the project');
});

test('sandboxDocument puts the CSP in the head before any artifact markup', () => {
  const withHead = internals.sandboxDocument('<html><head><title>x</title><link rel="stylesheet" href="https://evil.test/x.css"></head><body><script>bad()</script></body></html>');
  assert.ok(withHead.startsWith('<head><meta http-equiv="Content-Security-Policy"'), 'the reader opens its own head and the meta is its first child');
  assert.ok(withHead.indexOf('Content-Security-Policy') < withHead.indexOf('<title>'));
  assert.ok(withHead.indexOf('Content-Security-Policy') < withHead.indexOf('https://evil.test/x.css'));

  const withoutHead = internals.sandboxDocument('<script>bad()</script><img src="/exfil.png">');
  assert.ok(withoutHead.startsWith('<head><meta http-equiv="Content-Security-Policy"'), 'a head is opened before user markup');
  assert.ok(withoutHead.indexOf('Content-Security-Policy') < withoutHead.indexOf('<script>'));

  const withDoctype = internals.sandboxDocument('<!doctype html><html><body><img src="/exfil.png"></body></html>');
  assert.ok(withDoctype.startsWith('<!doctype html><head><meta http-equiv="Content-Security-Policy"'), 'the head is opened after the doctype, still before the body');
  assert.ok(withDoctype.indexOf('Content-Security-Policy') < withDoctype.indexOf('<img'));

  assert.match(internals.HTML_CSP, /default-src 'none'/);
  assert.match(internals.HTML_CSP, /img-src data:/);
  assert.match(internals.HTML_CSP, /style-src 'unsafe-inline'/);
  assert.match(internals.HTML_CSP, /script-src 'none'/);
  assert.equal(internals.HTML_CSP.includes("img-src 'self'"), false, 'remote images are not allowed');
  assert.equal(internals.HTML_CSP.includes('allow-modals'), false);
});

test('the session link encodes the id and never guesses a route', () => {
  assert.equal(internals.sessionHref('session-x'), '?session=session-x');
  assert.equal(internals.sessionHref('a b'), '?session=a%20b');
  assert.equal(internals.sessionHref('a/b'), '?session=a%2Fb');
});
