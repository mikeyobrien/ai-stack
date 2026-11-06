/**
 * Protocol-contract regression for the marked Remote methods.
 *
 * The actual DSH Typert gateway rejects a marked method whose source signature
 * destructures, defaults or rests its parameters. These assertions inspect the
 * service's own marked methods, so a future `request = {}` cannot come back
 * while the in-process helper tests still pass.
 *
 * @module @local/dsh-artifact-library/test/remote-signatures
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { libraryService } from '../index.js';

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const REQUEST_METHODS = ['search', 'artifact', 'setPinned', 'register'];

/** A store stub sufficient for the no-argument behavior checks. */
function emptyStore() {
	return {
		registry: () => ({ schemaVersion: 1, approvedRoots: [], collections: [] }),
		roots: () => [],
		persist: () => {},
	};
}

/** The parameter list text from a class method's source. */
function parametersOf(method) {
	const source = Function.prototype.toString.call(method);
	const open = source.indexOf('(');
	const close = source.indexOf(')', open + 1);
	assert.ok(open >= 0 && close > open, 'the method has a parameter list');
	return source.slice(open + 1, close).trim();
}

test('every marked Remote method has a plain, gateway-safe signature', () => {
	const Service = libraryService({ store: emptyStore() });
	const descriptor = Service.prototype[REMOTE_METHOD_DESCRIPTOR];
	assert.ok(descriptor, 'the service marks its Remote methods');
	assert.equal(descriptor.version, 1);
	assert.deepEqual(descriptor.methods.map((entry) => entry.method), ['library', ...REQUEST_METHODS]);

	for (const { method } of descriptor.methods) {
		const fn = Service.prototype[method];
		assert.equal(typeof fn, 'function', `${method} is implemented`);
		const parameters = parametersOf(fn);
		assert.equal(parameters.includes('='), false, `${method} has no default parameter`);
		assert.equal(parameters.includes('{'), false, `${method} has no destructuring parameter`);
		assert.equal(parameters.includes('}'), false, `${method} has no destructuring parameter`);
		assert.equal(parameters.includes('...'), false, `${method} has no rest parameter`);
		if (method === 'library') {
			assert.equal(parameters, '', 'library takes no parameters');
			assert.equal(fn.length, 0);
		} else {
			assert.equal(parameters, 'request', `${method} takes one plain request object`);
			assert.equal(fn.length, 1, `${method} exposes one required parameter`);
		}
	}
});

test('the four request methods normalize a missing request instead of throwing', () => {
	const store = emptyStore();
	const Service = libraryService({ store });
	const instance = Object.create(Service.prototype);
	instance.store = store;

	assert.deepEqual(instance.search(), { matches: [] });
	assert.equal(instance.artifact().ok, false);
	assert.equal(instance.setPinned().ok, false);
	assert.equal(instance.register().ok, false);
});
