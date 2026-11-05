/**
 * Behaviour test for the browser half, without a browser: load `client.js` the
 * way the page's module loader does, then apply it to a stub context. The
 * assertions are about what a person can reach — a Metrics entry in the left
 * sidebar that opens one main panel, labelled with what it counts and when it
 * started — and about the read method the panel asks the Host for.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const ID = '@local/dsh-usage-metrics';
const NS = 'usage-metrics';

let face;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, ID, 'the module id must equal the package name');
      face = factory((name) => {
        assert.equal(name, 'react');
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState: () => [{}, () => {}],
          useEffect: () => {},
          useReducer: () => [{}, () => {}],
        };
      });
    },
  },
};
await import('../client.js');

const mod = face;
const { locale } = mod.__internals;

/** The panel's translator, over the module's own English strings. */
const t = (key, values) => {
  const template = locale[key] ?? key;
  if (values === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
};

/**
 * Apply the module to a stub Client context, recording what it registers and
 * asks for.
 */
function boot() {
  const registrations = [];
  const mounts = [];
  const injections = [];
  const ctx = {
    locale: {
      register(ns, dicts) {
        assert.equal(ns, NS);
        assert.equal(dicts.en.panel, 'Metrics');
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
      fn();
    },
    inject(keys, run) {
      injections.push(keys);
      run({ remote: { usageMetrics: {} } });
      return { dispose() {} };
    },
  };
  mod.apply(ctx);
  return { registrations, mounts, injections };
}

test('the left sidebar gets one Metrics entry that opens the same main panel', () => {
  const { registrations } = boot();
  const entry = registrations.find(({ options }) => options.name === 'sidebar.panellist');
  const panel = registrations.find(({ options }) => options.name === 'main');
  assert.ok(entry, 'a sidebar-panellist entry is registered');
  assert.ok(panel, 'a main panel is registered');
  assert.equal(entry.options.id, 'metrics');
  assert.equal(panel.options.key, entry.options.id, 'the entry id is the main panel key');
  assert.equal(entry.options.label(), 'Metrics');
  assert.equal(typeof entry.component, 'function');
  assert.equal(typeof panel.component, 'function');
});

test('the panel asks the Host for the current rows', async () => {
  const { mounts, injections } = boot();
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].package, ID);
  assert.deepEqual(mounts[0].descriptors.map(({ method, namespace }) => ({ method, namespace })), [
    { method: 'overview', namespace: 'usageMetrics' },
  ]);
  await Promise.resolve();
  assert.deepEqual(injections, [['remote.usageMetrics']]);
});

test('the plugin does not inject the remote face it mounts itself', () => {
  assert.equal(mod.inject.includes('remote.usageMetrics'), false);
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote']);
});

test('the scope line says what is counted and when counting began', () => {
  const { scopeLine, formatCount, formatDate } = mod.__internals;
  const started = Date.UTC(2026, 10, 3, 12, 0, 0);
  assert.equal(scopeLine(t, { activatedAt: started, skills: [], principles: [] }), 'Successful skill and principle_read calls since Nov 3, 2026');
  assert.equal(scopeLine(t, null), null);
  assert.equal(formatCount(3639), '3,639');
  assert.equal(formatCount(undefined), '0');
  assert.equal(formatDate(started), 'Nov 3, 2026');
  assert.equal(formatDate(undefined), '');
});

test('the empty state stays minimal because the scope line already labels the metric', () => {
  assert.equal(locale.empty, 'None recorded.');
});

/** The text a reader would see, flattening the element tree and its components. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') return textOf(node.type(node.props));
  return textOf(node.children);
}

/** The first element matching a predicate, through function components. */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node.type === 'function') return findNode(node.type(node.props), predicate);
  if (predicate(node)) return node;
  return findNode(node.children, predicate);
}

const STARTED = Date.UTC(2026, 10, 3, 12, 0, 0);
const READY = {
  overview: {
    activatedAt: STARTED,
    skills: [{ name: 'verified-delivery', count: 2 }, { name: 'ui-ux-pass', count: 1 }],
    principles: [{ name: 'prove-it-works', count: 3 }],
  },
  error: null,
  errorDetail: '',
  busy: false,
};

/** Render the registered main panel against one metric store. */
function render(state) {
  const { registrations } = boot();
  const page = registrations.find(({ options }) => options.name === 'main').component;
  const ctx = { locale: { bind: () => t, getSnapshot: () => ({}), subscribe: () => () => {} } };
  const tree = page({ useMetrics: (selector) => selector(state), refresh: () => {}, ctx });
  return { tree, text: textOf(tree) };
}

test('the panel renders each row with its count and the day counting began', () => {
  const { text, tree } = render(READY);
  assert.match(text, /verified-delivery2/);
  assert.match(text, /ui-ux-pass1/);
  assert.match(text, /prove-it-works3/);
  assert.ok(text.includes('Successful skill and principle_read calls since Nov 3, 2026'));
  assert.ok(text.includes('Skills') && text.includes('Principles'));
  assert.ok(text.indexOf('verified-delivery2') < text.indexOf('ui-ux-pass1'), 'host order is preserved');
  const button = findNode(tree, (node) => node.type === 'button');
  assert.equal(textOf(button.children), 'Refresh');
  assert.equal(button.props.disabled, false);
});

test('an empty overview renders one empty message, not two empty sections', () => {
  const { text } = render({ overview: { activatedAt: STARTED, skills: [], principles: [] }, error: null, errorDetail: '', busy: false });
  assert.ok(text.includes('None recorded.'));
  assert.equal(text.includes('Skills'), false, 'no heading without rows');
  assert.equal(text.includes('Principles'), false, 'no heading without rows');
});

test('a failed read with no data shows the alert and no rows', () => {
  const { text } = render({ overview: null, error: 'Could not read session metrics.', errorDetail: 'boom', busy: false });
  assert.ok(text.includes('Could not read session metrics.'));
  assert.equal(text.includes('None recorded.'), false);
});

test('a failed refresh keeps the rows and adds the alert', () => {
  const { text } = render({ ...READY, error: 'Could not read session metrics.', errorDetail: 'boom' });
  assert.ok(text.includes('verified-delivery2'));
  assert.ok(text.includes('Could not read session metrics.'));
});

test('the first read shows the loading placeholder and disables Refresh', () => {
  const { text, tree } = render({ overview: null, error: null, errorDetail: '', busy: true });
  assert.ok(text.includes('…'));
  const button = findNode(tree, (node) => node.type === 'button');
  assert.equal(textOf(button.children), 'Refreshing…');
  assert.equal(button.props.disabled, true);
});
