/**
 * Behaviour test for the mobile sidebar, without a browser: load `client.js` the way the page's module
 * loader does, run `apply` against a stub ctx and a stub document, and assert what a user would see —
 * the drawer marks, the scrim, and every way to dismiss it.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const ID = '@local/dsh-client-sidebar-mobile';

/** Effects registered during the last render, so a test can run them and read their cleanup. */
let effects = [];
/** Click handlers the scrim installed, so a test can dismiss the way a user would. */
let cleanups = [];

/** Minimal React stand-in: createElement plus the hooks the components call. */
const ReactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), ...(children.length ? { children } : {}) },
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => {
    effects.push(fn);
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  },
  useRef: (value) => ({ current: value }),
};

/** Append one listener to a type's list in a Map of lists. */
function pushListener(map, type, fn) {
  map.set(type, [...(map.get(type) ?? []), fn]);
}

/** Remove one listener from a type's list in a Map of lists. */
function dropListener(map, type, fn) {
  map.set(type, (map.get(type) ?? []).filter((entry) => entry !== fn));
}

/** A stub node: attributes, children with parents, and listeners. */
class StubElement {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.classList = new Set();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
  }
  getAttribute(name) {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }
  hasAttribute(name) {
    return Object.hasOwn(this.attrs, name);
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  appendChild(child) {
    child._parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    this.removed = true;
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type, fn) {
    if (this.listeners.get(type) === fn) this.listeners.delete(type);
  }
  closest() {
    return null;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get parentElement() {
    return this._parent ?? null;
  }
}

/**
 * Install a document holding one frame: overlay layer, and a sidebar column that is its first child.
 * @param options - whether the frame reports the sidebar collapsed.
 */
function installDocument({ collapsed }) {
  const head = new StubElement('head');
  const body = new StubElement('body');
  const root = new StubElement('html');
  const frame = new StubElement('div', collapsed ? { 'data-sidebar-collapsed': 'true' } : {});
  const column = new StubElement('div');
  const center = new StubElement('div');
  const overlay = new StubElement('div', { 'data-shell-overlay': '' });
  frame.appendChild(column);
  frame.appendChild(center);
  frame.appendChild(overlay);
  body.appendChild(frame);

  const dialogs = [];
  const document = {
    documentElement: root,
    head,
    body,
    querySelector(selector) {
      if (selector.includes('data-sidebar-mobile-css')) {
        return head.children.find((node) => node.tagName === 'STYLE') ?? null;
      }
      if (selector === '[data-shell-overlay]') return overlay;
      if (selector === '[aria-modal="true"]') return dialogs[0] ?? null;
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => new StubElement(tag),
    addEventListener: (type, fn) => pushListener(document._listeners, type, fn),
    removeEventListener: (type, fn) => dropListener(document._listeners, type, fn),
    _listeners: new Map(),
    /** Run every listener of one type, the way the browser would. */
    fire(type, event) {
      for (const fn of document._listeners.get(type) ?? []) fn(event);
    },
  };

  const observers = [];
  const windowListeners = new Map();
  const window = {
    innerWidth: 390,
    addEventListener: (type, fn) => pushListener(windowListeners, type, fn),
    removeEventListener: (type, fn) => dropListener(windowListeners, type, fn),
    /** Run every listener of one type, the way the browser would. */
    fire(type) {
      for (const fn of windowListeners.get(type) ?? []) fn();
    },
  };
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    fire() {
      this.callback();
    }
  }
  globalThis.document = document;
  globalThis.window = window;
  globalThis.MutationObserver = MutationObserver;
  globalThis.Element = StubElement;
  return { document, window, frame, column, root, head, observers, dialogs, windowListeners };
}

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
  return () => face;
}

const faceOf = loadModule();
await import('../client.js');
const mod = faceOf();

/** A ctx whose effects run immediately and whose slot registrations are collected. */
function stubCtx() {
  const toggles = [];
  const slots = [];
  const ctx = {
    effect: (fn) => fn(),
    layout: { toggleSidebar: () => toggles.push('toggle') },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, Component) => (slots.push({ options, Component }), () => {}),
    },
  };
  return { ctx, slots, toggles };
}

/** Render the overlay cell with the props the slot would supply. */
function renderScrim(cell, { panel = null } = {}) {
  effects = [];
  cleanups = [];
  const props = { ...cell.options.inject(), usePanelInfo: (select) => select({ activePanelId: panel }) };
  return cell.Component(props);
}

test('module exports the apply face and its service inject list', () => {
  assert.equal(typeof mod.apply, 'function');
  for (const service of ['slots', 'layout']) {
    assert.ok(mod.inject.includes(service), `missing inject: ${service}`);
  }
});

test('only a phone-width viewport gets the drawer', () => {
  const { isPhone, PHONE_MAX } = mod.__internals;
  assert.equal(isPhone(390), true);
  assert.equal(isPhone(PHONE_MAX), true);
  assert.equal(isPhone(PHONE_MAX + 1), false);
  assert.equal(isPhone(0), false);
  assert.equal(isPhone(undefined), false);
});

test('an expanded phone-width frame turns the column into the drawer', () => {
  effects = [];
  const dom = installDocument({ collapsed: false });
  const { ctx } = stubCtx();
  mod.apply(ctx);

  assert.ok(dom.root.hasAttribute('data-sidebar-mobile'), 'the root carries the phone marker');
  assert.ok(dom.column.hasAttribute('data-sidebar-mobile-drawer'), 'the column is the drawer');
  assert.ok(dom.frame.hasAttribute('data-sidebar-mobile-frame'), 'the frame is marked for the track override');
  assert.equal(dom.frame.hasAttribute('data-sidebar-mobile-drawer'), false, 'the frame itself is not the drawer');

  const styles = dom.head.children.filter((node) => node.tagName === 'STYLE');
  assert.equal(styles.length, 1, 'one stylesheet');
  const css = styles[0].textContent;
  assert.match(css, /data-sidebar-mobile-drawer/, 'it styles the drawer');
  assert.match(css, /grid-template-columns: 0 minmax\(0, 1fr\)/, 'the track collapses so the conversation keeps its width');
  assert.match(css, /--dsw-alias-bg-mask-1/, 'the scrim reuses the shell mask token');
  assert.match(css, /min-height: 44px/, 'navigation rows meet the touch minimum');
});

test('a phone-width collapsed frame keeps the shipped rail', () => {
  effects = [];
  const dom = installDocument({ collapsed: true });
  const { ctx, slots } = stubCtx();
  mod.apply(ctx);

  assert.equal(dom.root.hasAttribute('data-sidebar-mobile'), false, 'the rail is not a drawer');
  assert.equal(dom.column.hasAttribute('data-sidebar-mobile-drawer'), false);
  const cell = slots.find((entry) => entry.options.name === 'shell.overlay');
  assert.equal(renderScrim(cell), null);
});

test('a desktop-width expanded frame is left alone', () => {
  effects = [];
  const dom = installDocument({ collapsed: false });
  dom.window.innerWidth = 1280;
  const { ctx, slots } = stubCtx();
  mod.apply(ctx);

  assert.equal(dom.root.hasAttribute('data-sidebar-mobile'), false, 'the desktop column is not a drawer');
  assert.equal(dom.column.hasAttribute('data-sidebar-mobile-drawer'), false);
  assert.equal(dom.frame.hasAttribute('data-sidebar-mobile-frame'), false);
  const cell = slots.find((entry) => entry.options.name === 'shell.overlay');
  assert.equal(renderScrim(cell), null);
});

test('an open drawer shows a scrim that closes the sidebar when tapped', () => {
  effects = [];
  const dom = installDocument({ collapsed: false });
  const { ctx, slots, toggles } = stubCtx();
  mod.apply(ctx);

  const cell = slots.find((entry) => entry.options.name === 'shell.overlay');
  const scrim = renderScrim(cell);
  assert.equal(scrim.type, 'div');
  assert.equal(scrim.props.className, 'dsh-sm-scrim');
  assert.equal(scrim.props['aria-hidden'], 'true', 'the drawer’s own control is the labelled exit');
  scrim.props.onClick();
  assert.deepEqual(toggles, ['toggle'], 'a tap on the scrim toggles the sidebar closed');

  assert.equal((dom.document._listeners.get('keydown') ?? []).length, 1, 'Escape closes the drawer too');
  dom.document.fire('keydown', { key: 'Escape', defaultPrevented: false });
  assert.deepEqual(toggles, ['toggle', 'toggle']);
  dom.document.fire('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(toggles.length, 2, 'a dialog that already consumed Escape keeps it');
  dom.document.fire('keydown', { key: 'a', defaultPrevented: false });
  assert.equal(toggles.length, 2, 'other keys leave the drawer alone');
});

test('Escape does not reach the drawer while a modal dialog is open', () => {
  effects = [];
  const dom = installDocument({ collapsed: false });
  const { ctx, slots, toggles } = stubCtx();
  mod.apply(ctx);

  const cell = slots.find((entry) => entry.options.name === 'shell.overlay');
  renderScrim(cell);
  dom.dialogs.push(new StubElement('div'));
  dom.document.fire('keydown', { key: 'Escape', defaultPrevented: false });
  assert.deepEqual(toggles, [], 'the dialog owns the Escape key');
});

test('picking a conversation closes the drawer, and other taps do not', () => {
  effects = [];
  const dom = installDocument({ collapsed: false });
  const { ctx, slots, toggles } = stubCtx();
  mod.apply(ctx);

  const cell = slots.find((entry) => entry.options.name === 'shell.overlay');
  renderScrim(cell);
  const click = (event) => dom.document.fire('click', event);
  assert.equal((dom.document._listeners.get('click') ?? []).length, 1);

  const tap = (inside, sessionRow) => {
    const target = new StubElement('button');
    target.closest = (selector) => {
      if (selector === '[data-sidebar-mobile-drawer]') return inside ? {} : null;
      if (selector === '[data-row-key^="session:"]') return sessionRow ? {} : null;
      return null;
    };
    click({ target });
  };

  tap(true, true);
  assert.deepEqual(toggles, ['toggle'], 'a session row dismisses the drawer');
  tap(true, false);
  assert.equal(toggles.length, 1, 'a workspace header leaves the drawer open');
  tap(false, false);
  assert.equal(toggles.length, 1, 'a tap outside the drawer is the scrim’s job');
});

test('the drawer follows the frame as the sidebar expands and collapses', () => {
  effects = [];
  const dom = installDocument({ collapsed: true });
  const { ctx, slots } = stubCtx();
  mod.apply(ctx);

  const cell = slots.find((entry) => entry.options.name === 'shell.overlay');
  assert.equal(renderScrim(cell), null, 'rail: no scrim');

  // Opening the sidebar is the frame dropping its collapsed flag; the plugin re-marks on the mutation.
  dom.frame.removeAttribute('data-sidebar-collapsed');
  const watcher = dom.observers.find((observer) => !observer.disconnected);
  watcher.fire();
  assert.ok(dom.column.hasAttribute('data-sidebar-mobile-drawer'));
  assert.notEqual(renderScrim(cell), null, 'expanded: scrim shows');

  // Collapsing again returns to the rail, with no scrim.
  dom.frame.setAttribute('data-sidebar-collapsed', 'true');
  watcher.fire();
  assert.equal(dom.root.hasAttribute('data-sidebar-mobile'), false);
  assert.equal(renderScrim(cell), null, 'rail again: no scrim');

  // A desktop viewport is never a drawer, even with the sidebar expanded.
  dom.frame.removeAttribute('data-sidebar-collapsed');
  dom.window.innerWidth = 1280;
  dom.window.fire('resize');
  assert.equal(dom.root.hasAttribute('data-sidebar-mobile'), false);
  assert.equal(renderScrim(cell), null, 'desktop: no scrim');
});

test('disposal removes the markers, the stylesheet and the watcher', () => {
  effects = [];
  const dom = installDocument({ collapsed: false });
  const disposers = [];
  const ctx = {
    effect: (fn) => (disposers.push(fn()), () => {}),
    layout: { toggleSidebar: () => {} },
    slots: { inject: (_name, fn) => fn(), register: () => () => {} },
  };
  mod.apply(ctx);
  assert.ok(dom.root.hasAttribute('data-sidebar-mobile'));

  const watcher = dom.observers.find((observer) => !observer.disconnected);
  const style = dom.head.children[0];
  for (const dispose of disposers) dispose();

  assert.equal(dom.root.hasAttribute('data-sidebar-mobile'), false);
  assert.equal(dom.column.hasAttribute('data-sidebar-mobile-drawer'), false);
  assert.equal(dom.frame.hasAttribute('data-sidebar-mobile-frame'), false);
  assert.equal(watcher.disconnected, true, 'the observer stops watching');
  assert.equal(style.removed, true, 'the stylesheet is removed with the plugin');
});
