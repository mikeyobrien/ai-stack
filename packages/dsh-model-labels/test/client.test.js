/**
 * Behaviour test for the model tags, without a browser: load `client.js` the way
 * the page's module loader does, run `apply` against a stub ctx, and render the
 * label the composer's model selector would render for a given provider and
 * model. The assertions are about what a person sees in the selector — which
 * models carry Local, which carry Remote, and which stay untouched.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const ID = '@local/dsh-model-labels';

/** A React stand-in good enough for the label component. */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
};

/** Load the module the way `__ModuleLoader__` does and return its exported face. */
function plugin() {
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
  return () => face;
}

const faceOf = plugin();
await import('../client.js');
const mod = faceOf();

/** A ctx whose effects run immediately and whose registrations are collected. */
function stubCtx() {
  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => {
        assert.equal(ns, 'model-labels');
        assert.equal(dicts.en['label.local'], 'Local');
        assert.equal(dicts.en['label.remote'], 'Remote');
        return () => {};
      },
    },
    slots: {
      inject: (name, fn) => {
        assert.equal(name, 'conversation.input.model.label');
        return fn();
      },
      register: (options, Component) => {
        assert.equal(options.name, 'conversation.input.model.label');
        assert.equal(options.locale, 'model-labels');
        registrations.push(Component);
        return () => {};
      },
    },
  };
  return { ctx, registrations };
}

/** Register the plugin and return its label component. */
function label() {
  const { ctx, registrations } = stubCtx();
  mod.apply(ctx);
  assert.equal(registrations.length, 1, 'the plugin contributes one label component');
  return registrations[0];
}

/** The words a rendered label shows, tag included. */
function words(node) {
  if (node === undefined || node === null) return [];
  if (typeof node === 'string') return [node];
  return (node.props?.children ?? []).flatMap(words);
}

/** The tag text a rendered label carries, or null when it carries none. */
function tagText(node) {
  if (node === undefined || node === null || typeof node === 'string') return null;
  for (const child of node.props?.children ?? []) {
    const text = tagText(child);
    if (text !== null) return text;
  }
  return node.props?.style?.borderRadius === 999 ? node.props.children.join('') : null;
}

/** Render the label for one provider and model, with an identity translate. */
function render(provider, model) {
  const t = (key) => ({ 'label.local': 'Local', 'label.remote': 'Remote' }[key] ?? key);
  return label()({ provider, model, t });
}

test('a model served by reef vLLM is tagged Local', () => {
  const node = render({ id: 'sparks', name: 'Sparks' }, { id: 'qwen3.8-27b', name: 'Qwen3.8 27B' });
  assert.equal(tagText(node), 'Local');
  assert.equal(words(node).join(''), 'Qwen3.8 27B' + 'Local', 'the catalog name stays, with the tag after it');
});

test('a model served by the Sparks cluster is tagged Remote', () => {
  const node = render({ id: 'sparks', name: 'Sparks' }, { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' });
  assert.equal(tagText(node), 'Remote');
});

test('the tag follows the model, not the provider, when one provider serves both', () => {
  const provider = { id: 'sparks', name: 'Sparks' };
  assert.equal(tagText(render(provider, { id: 'qwen3.8-27b', name: 'Qwen3.8 27B' })), 'Local');
  assert.equal(tagText(render(provider, { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' })), 'Remote');
});

test('a serving provider is placed by the host its endpoint names', () => {
  assert.equal(tagText(render({ id: 'reef', name: 'Reef', baseURL: 'http://reef:8010/v1' }, { id: 'some-model', name: 'Some Model' })), 'Local');
  assert.equal(tagText(render({ id: 'sparks', name: 'Sparks', baseURL: 'http://127.0.0.1:8888/v1' }, { id: 'other-model', name: 'Other Model' })), 'Local');
  assert.equal(tagText(render({ id: 'sparks', name: 'Sparks', host: 'spark-1' }, { id: 'other-model', name: 'Other Model' })), 'Remote');
  assert.equal(tagText(render({ id: 'sparks', name: 'Sparks', host: 'reef' }, { id: 'other-model', name: 'Other Model' })), 'Local');
});

test('an API provider keeps its catalog name untouched', () => {
  for (const id of ['deepseek-official', 'deepseek-account']) {
    const node = render({ id, name: 'DeepSeek' }, { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' });
    assert.equal(node, 'DeepSeek-V4.1-Flash');
    assert.equal(tagText(node), null);
  }
});

test('a serving provider whose host is unknown keeps the catalog name', () => {
  assert.equal(render({ id: 'sparks', name: 'Sparks' }, { id: 'unlisted-model', name: 'Unlisted Model' }), 'Unlisted Model');
});
