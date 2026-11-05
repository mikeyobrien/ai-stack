import test from 'node:test';
import assert from 'node:assert/strict';
import { guiBase, sessionReference, sessionUrl } from '../links.js';

test('a session URL normalizes the base and carries the id', () => {
	assert.equal(sessionUrl('https://example.test/', 'session-abc'), 'https://example.test/?session=session-abc');
	assert.equal(sessionUrl('https://example.test', 'session-abc'), 'https://example.test/?session=session-abc');
	assert.equal(sessionUrl(' https://example.test/base/ ', 'session-abc'), 'https://example.test/base/?session=session-abc');
	assert.equal(guiBase(' https://example.test/ '), 'https://example.test');
});

test('ids are URL-encoded', () => {
	assert.equal(sessionUrl('https://example.test', 'a b'), 'https://example.test/?session=a%20b');
});

test('the short reference keeps the scheme', () => {
	assert.equal(sessionReference('session-abc'), 'dsh-session:session-abc');
});
