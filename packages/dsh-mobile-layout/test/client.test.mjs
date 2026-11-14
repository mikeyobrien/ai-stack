/**
 * Load `client.js` the way the page's module loader does and check what keeps
 * the layout safe: the breakpoint, the fail-safe that hides the menu button
 * unless the frame was found, and the scrim component's output.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), ...(children.length ? { children } : {}) } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
};

/** Evaluate client.js with a stub module loader and return its module. */
async function load({ drawerOpen = false } = {}) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let module;
  const frame = { hasAttribute: (name) => drawerOpen && name === 'data-dsh-mobile-open' };
  const context = {
    window: { __ModuleLoader__: { load: ({ factory }) => { module = factory((name) => (name === 'react' ? ReactStub : undefined)); } } },
    document: { querySelector: (selector) => (selector.includes('overlay') ? { parentElement: frame } : null) },
  };
  vm.runInNewContext(source, context);
  return module;
}

test('the layout applies at phone width only', async () => {
  const { __internals } = await load();
  assert.equal(__internals.PHONE_MAX, 767);
  assert.match(__internals.STYLE, /@media \(max-width: 767px\)/);
});

test('the menu button is hidden unless the shell frame was found and marked', async () => {
  const { __internals } = await load();
  const { STYLE, MENU, FRAME } = __internals;
  assert.ok(STYLE.includes(`[${MENU}] { display: none; }`), 'hidden by default');
  assert.ok(STYLE.includes(`html:has([${FRAME}]) [${MENU}] {`), 'shown only with the frame marker');
});

test('layout rules key on plugin markers, not hashed shell classes', async () => {
  const { __internals } = await load();
  for (const hashed of ['pI_x6G_frame', 'pI_x6G_sidebarCol', 'pI_x6G_centerCol', 'hHd-Xa_panelRow', 'hHd-Xa_panelList']) {
    assert.ok(!__internals.STYLE.includes(hashed), `${hashed} is not a layout selector`);
  }
});

test('the scrim component renders one element when open and nothing when closed', async () => {
  const closed = await load({ drawerOpen: false });
  assert.equal(closed.__internals.Chrome({ toggle: () => {} }), null);
  const open = await load({ drawerOpen: true });
  const scrim = open.__internals.Chrome({ toggle: () => {} });
  assert.ok(!Array.isArray(scrim), 'a single element, not an unkeyed array');
  assert.equal(scrim.props.className, 'dsh-ml-scrim');
});
