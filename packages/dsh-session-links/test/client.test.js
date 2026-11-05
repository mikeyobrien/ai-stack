/**
 * Behaviour test for the deep link, without a browser: load `client.js` the way
 * the page's module loader does, point `window.location` at each link form, and
 * assert which session the UI is asked to open. The assertions are about what a
 * person gets when they tap a link — the named thread opens and the marker is
 * removed — not about how the handler is wired.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const ID = '@local/dsh-session-links';

let face;
globalThis.window = {
	location: { href: 'https://example.test/' },
	history: { replaceState: () => {} },
	__ModuleLoader__: {
		load({ id, factory }) {
			assert.equal(id, ID, 'the module id must equal the package name');
			face = factory(() => {
				throw new Error('unexpected require');
			});
		},
	},
};
await import('../client.js');

const mod = face;

/** Point the fake page at one URL and record history rewrites. */
function page(href) {
	const replaced = [];
	globalThis.window.location = { href };
	globalThis.window.history = {
		replaceState: (_state, _title, url) => {
			replaced.push(url);
		},
	};
	return replaced;
}

/** A ctx whose session list starts in the given phase. */
function stubCtx(phase = 'ready') {
	const listeners = new Set();
	let current = phase;
	const opened = [];
	const ctx = {
		sessions: {
			list: {
				getSnapshot: () => ({ phase: current }),
				subscribe: (fn) => {
					listeners.add(fn);
					return () => listeners.delete(fn);
				},
			},
		},
		uiWorkspace: {
			openSession: (target) => opened.push(target),
		},
	};
	return {
		ctx,
		opened,
		ready() {
			current = 'ready';
			for (const fn of listeners) fn();
		},
		listeners,
	};
}

test('a session query opens that thread and clears the marker', () => {
	const replaced = page('https://example.test/?session=session-abc');
	const { ctx, opened } = stubCtx('ready');
	mod.apply(ctx);
	assert.deepEqual(opened, ['session-abc']);
	assert.deepEqual(replaced, ['/']);
});

test('a dsh-session fragment opens that thread', () => {
	page('https://example.test/#dsh-session:session-def');
	const { ctx, opened } = stubCtx('ready');
	mod.apply(ctx);
	assert.deepEqual(opened, ['session-def']);
});

test('a page without a deep link leaves the selection alone', () => {
	const replaced = page('https://example.test/');
	const { ctx, opened } = stubCtx('ready');
	mod.apply(ctx);
	assert.deepEqual(opened, []);
	assert.deepEqual(replaced, []);
});

test('a pending session list defers the open until it is ready', () => {
	page('https://example.test/?session=session-abc');
	const { ctx, opened, ready } = stubCtx('pending');
	mod.apply(ctx);
	assert.deepEqual(opened, []);
	ready();
	assert.deepEqual(opened, ['session-abc']);
});

test('unrelated query parameters survive the cleanup', () => {
	const replaced = page('https://example.test/?tab=files&session=session-abc');
	const { ctx } = stubCtx('ready');
	mod.apply(ctx);
	assert.deepEqual(replaced, ['/?tab=files']);
});

test('the target reader accepts every supported form and decodes values', () => {
	const read = mod.__internals.readTarget;
	assert.equal(read({ href: 'https://example.test/?session=a%20b' }), 'a b');
	assert.equal(read({ href: 'https://example.test/#dsh-session:session-a' }), 'session-a');
	assert.equal(read({ href: 'https://example.test/#session=session-a' }), 'session-a');
	assert.equal(read({ href: 'https://example.test/?session=' }), null);
	assert.equal(read({ href: 'https://example.test/' }), null);
});
