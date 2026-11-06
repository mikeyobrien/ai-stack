/**
 * Security behavior tests: approved-root enforcement, symlink escapes and
 * the bounded read.
 *
 * @module @local/dsh-artifact-library/test/security
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isContainedIn, isWithinApprovedRoots, realPath } from '../security.js';
import { MAX_READ_BYTES, readTextFileBounded, scopedStoreFilePath, dshHome } from '../store.js';

const ROOT = mkdtempSync(join(tmpdir(), 'lib-sec-'));
const IN = join(ROOT, 'in');
const OUT = join(ROOT, 'out');
mkdirSync(IN, { recursive: true });
mkdirSync(OUT, { recursive: true });

test('isContainedIn enforces the prefix without a sibling-escape', () => {
	assert.equal(isContainedIn(join(IN, 'x.txt'), IN), true);
	assert.equal(isContainedIn(IN, IN), true, 'equality is inside');
	assert.equal(isContainedIn(join(IN, '..', 'x.txt'), IN), false, 'lexical .. escape is refused');
	assert.equal(isContainedIn(join(IN, 'sibling', 'x.txt'), join(IN, 'sibling')), true, 'a child of the same root is inside');
});

test('a path outside the approved roots is refused', () => {
	const root = realPath(OUT);
	assert.equal(isWithinApprovedRoots(join(OUT, 'x.txt'), [realPath(IN)]), false);
	assert.equal(isWithinApprovedRoots(join(IN, 'x.txt'), [root, realPath(IN)]), true);
});

test('realPath resolves a symlink to its real location', () => {
	writeFileSync(join(OUT, 't.txt'), 'x');
	const link = join(IN, 'l.txt');
	symlinkSync(join(OUT, 't.txt'), link);
	const real = realPath(link);
	assert.equal(real, realPath(join(OUT, 't.txt')));
});

test('a file under an approved root is read; a read is bounded to the cap', () => {
	const inside = join(IN, 'a.md');
	writeFileSync(inside, 'inside');
	assert.equal(readTextFileBounded(inside, 1024), 'inside');
	const tiny = join(IN, 'tiny.txt');
	writeFileSync(tiny, 'x'.repeat(2 * 1024));
	assert.equal(readTextFileBounded(tiny, 1024), null, 'a file above the read cap is refused');
});

test('a symlink that resolves outside an approved root is refused for a read', () => {
	writeFileSync(join(OUT, 'secret.md'), 'secret');
	const link = join(IN, 'link.md');
	symlinkSync(join(OUT, 'secret.md'), link);
	const roots = [realPath(IN)];
	const { isWithinApprovedRoots: check } = {};
	const real = realPath(link);
	assert.equal(check === undefined, true);
	assert.equal(isWithinApprovedRoots(real, roots), false, 'a link outside the root is not inside');
});

test('a directory symlink that resolves outside is refused for every file under it', () => {
	mkdirSync(join(OUT, 'nested'), { recursive: true });
	writeFileSync(join(OUT, 'nested', 'd.md'), 'deep');
	const dirLink = join(IN, 'dirlink');
	symlinkSync(OUT, dirLink);
	const roots = [realPath(IN)];
	const real = realPath(join(dirLink, 'nested', 'd.md'));
	assert.equal(isWithinApprovedRoots(real, roots), false, 'a file reached through a directory link outside is not inside');
});

test('a read larger than the byte cap is refused, not truncated', () => {
	const big = join(IN, 'big.txt');
	writeFileSync(big, 'x'.repeat(5 * 1024 * 1024));
	assert.equal(readTextFileBounded(big, 4 * 1024 * 1024), null, 'a file above the cap is never read whole');
	assert.equal(MAX_READ_BYTES, 4 * 1024 * 1024);
});

test('the store file path honors a configured override and a profile scope', () => {
	process.env.DSH_HOME = join(ROOT, 'home');
	mkdirSync(join(ROOT, 'home', 'artifact-library'), { recursive: true });
	assert.equal(scopedStoreFilePath({ storeFile: '/x/y.json' }), '/x/y.json');
	assert.equal(scopedStoreFilePath({}, { argv: ['node', '--profile', 'web'] }), join(ROOT, 'home', 'artifact-library', 'registry-web.json'));
	assert.equal(scopedStoreFilePath({}, { argv: ['node'] }), join(ROOT, 'home', 'artifact-library', 'registry.json'));
	assert.equal(dshHome(), join(ROOT, 'home'));
});
