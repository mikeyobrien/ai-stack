/**
 * Behaviour test for the browser half, without a browser: load `client.js` the
 * way the page's module loader does, then apply it to a stub context. The
 * assertions are about what a person can reach — a Token Metrics entry in the
 * left sidebar that opens one main panel, labelled with what it counts and when
 * it started — and about the read method the panel asks the Host for.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const ID = '@local/dsh-token-metrics';
const NS = 'token-metrics';

let face;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, ID, 'the module id must equal the package name');
      face = factory((name) => {
        assert.equal(name, 'react');
        return {
          createElement: (type, props, ...children) => {
            if (typeof type === 'function') return type({ ...props, children });
            return { type, props, children };
          },
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
        assert.equal(dicts.en.panel, 'Token Metrics');
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
      run({ remote: { tokenMetrics: {} } });
      return { dispose() {} };
    },
  };
  mod.apply(ctx);
  return { registrations, mounts, injections };
}

test('the left sidebar gets one Token Metrics entry that opens the same main panel', () => {
  const { registrations } = boot();
  const entry = registrations.find(({ options }) => options.name === 'sidebar.panellist');
  const panel = registrations.find(({ options }) => options.name === 'main');
  assert.ok(entry, 'a sidebar-panellist entry is registered');
  assert.ok(panel, 'a main panel is registered');
  assert.equal(entry.options.id, 'token-metrics');
  assert.equal(panel.options.key, entry.options.id, 'the entry id is the main panel key');
  assert.equal(entry.options.label(), 'Token Metrics');
  assert.equal(typeof entry.component, 'function');
  assert.equal(typeof panel.component, 'function');
});

test('the panel asks the Host for the current rows', async () => {
  const { mounts, injections } = boot();
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].package, ID);
  assert.deepEqual(mounts[0].descriptors.map(({ method, namespace }) => ({ method, namespace })), [
    { method: 'overview', namespace: 'tokenMetrics' },
  ]);
  await Promise.resolve();
  assert.deepEqual(injections, [['remote.tokenMetrics']]);
});

/** Recursively collect the text of a rendered node tree. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'number' || typeof node === 'boolean') return typeof node === 'string' ? node : String(node ?? '');
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.children !== undefined) return node.children.map(textOf).join('');
  return '';
}

const READY = { overview: { activatedAt: 1790000000000, totals: { calls: 3, inputTokens: 120, outputTokens: 60, totalTokens: 180, cacheReadTokens: 40 }, models: [{ model: 'reef', calls: 2, inputTokens: 80, outputTokens: 40, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 0 }, { model: 'sparks', calls: 1, inputTokens: 40, outputTokens: 20, totalTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }] }, error: null, errorDetail: '', busy: false };

/**
 * Render the main panel with a stubbed store, the way the page consumes it
 * through `useTokenMetrics`. No React is needed: the page is a plain function
 * component that reads its hook result, so calling it with a stub returns the
 * element tree for the reader to assert on.
 */
function render(state) {
  const panel = registeredPanel();
  const stub = {
    useTokenMetrics: (selector) => selector({ ...state }),
    refresh: () => {},
    ctx: { locale: { getSnapshot: () => ({}), subscribe: () => () => {}, bind: () => t } },
  };
  const tree = panel(stub);
  return { text: textOf(tree), tree };
}

/** The main panel component, registered by a fresh apply. */
function registeredPanel() {
  const registrations = [];
  const ctx = {
    locale: { register: () => () => {}, getSnapshot: () => ({}), subscribe: () => () => {}, bind: () => t },
    remote: { $mount: (c) => Promise.resolve(c) },
    slots: {
      inject(name, run) { run(); return () => {}; },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
    effect(fn) { fn(); },
    inject(keys, run) { run({ remote: { tokenMetrics: fakeRemote(READY) } }); return { dispose() {} }; },
  };
  mod.apply(ctx);
  return registrations.find(({ options }) => options.name === 'main').component;
}

function fakeRemote(state) {
  return {
    overview: async () => state.error === null ? { ok: true, value: state.overview } : { ok: false, error: { message: state.error } },
  };
}

test('a ready overview renders one row per model with its token columns', () => {
  const { text } = render(READY);
  assert.ok(text.includes('reef'));
  assert.ok(text.includes('sparks'));
  // Totals line.
  assert.ok(text.includes('Calls'));
  assert.ok(text.includes('Cache read'));
  assert.ok(text.includes('Total'));
  assert.ok(text.includes('None recorded.') === false);
});

test('an empty overview shows the empty state, not a table', () => {
  const { text } = render({ ...READY, overview: { ...READY.overview, models: [] } });
  assert.ok(text.includes('No calls recorded.'));
  assert.ok(text.includes('reef') === false);
});

test('a read error shows the alert and not the rows', () => {
  const { text } = render({ overview: null, error: 'Could not read token metrics.', errorDetail: 'boom', busy: false });
  assert.ok(text.includes('Could not read token metrics.'));
  assert.ok(text.includes('No calls recorded.') === false);
});

test('a failed refresh keeps the rows and adds the alert', () => {
  const { text } = render({ ...READY, error: 'Could not read token metrics.', errorDetail: 'boom' });
  assert.ok(text.includes('reef'));
  assert.ok(text.includes('Could not read token metrics.'));
});

test('the first read shows the loading placeholder', () => {
  const { text } = render({ overview: null, error: null, errorDetail: '', busy: true });
  assert.ok(text.includes('…'));
});
