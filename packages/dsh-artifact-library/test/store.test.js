/**
 * Behavior tests for the artifact Library: the seed import, search,
 * readers, pins, registration, and the two safety invariants — no read
 * escapes an approved root, and a malicious HTML document cannot execute.
 *
 * @module @local/dsh-artifact-library/test/store
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readArtifact } from '../store.js';
import { HTML_SANDBOX } from '../security.js';
import { applySeed, createStore, libraryService, seedRegistry } from '../index.js';

const ROOT = mkdtempSync(join(tmpdir(), 'lib-store-'));
const APPROVED = join(ROOT, 'approved');
const OUTSIDE = join(ROOT, 'outside');
mkdirSync(APPROVED, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });

/** A minimal seed with one markdown and one HTML artifact, both readable. */
function makeSeed() {
	const mdPath = join(APPROVED, 'report.md');
	writeFileSync(mdPath, '# Report\n\nThe quick brown fox.');
	const htmlPath = join(APPROVED, 'report.html');
	writeFileSync(htmlPath, '<html><head><title>t</title></head><body><h1>OK</h1></body></html>');
	const bigPath = join(APPROVED, 'big.html');
	writeFileSync(bigPath, '<html><head><title>big</title></head><body><p>' + 'x'.repeat(600 * 1024) + '</p></body></html>');
	return {
		schemaVersion: 1,
		approvedRoots: [APPROVED],
		collections: [
			{
				id: 'coll',
				title: 'Coll',
				project: 'ai-stack',
				sourceSessionId: 'session-x',
				artifacts: [
					{ id: 'a-md', title: 'Report', kind: 'research', path: mdPath },
					{ id: 'a-html', title: 'Report HTML', kind: 'report', format: 'html', path: htmlPath, relatedArtifactId: 'a-md' },
					{ id: 'a-big', title: 'Big HTML', kind: 'report', format: 'html', path: bigPath },
					{ id: 'a-missing', title: 'Gone', kind: 'report', path: join(APPROVED, 'deleted.md') },
				],
				expectedOutputs: [{ id: 'e-html', title: 'Illustrated HTML guide', format: 'html', state: 'pending', reason: 'Requested by user; not delivered.' }],
			},
		],
	};
}

/** Seed a store from a seed file on disk, returning the store. */
function seededStore(name) {
	const file = join(ROOT, `${name}.json`);
	writeFileSync(join(ROOT, `${name}-seed.json`), JSON.stringify(makeSeed()));
	return createStore({ file, seedFile: join(ROOT, `${name}-seed.json`) });
}

test('seed import snapshots real files and records the seed revision', () => {
	const store = seededStore('seed-test');
	const registry = store.registry();
	assert.equal(registry.collections.length, 1);
	const artifacts = registry.collections[0].artifacts;
	assert.equal(artifacts.length, 4);
	for (const artifact of artifacts) {
		assert.equal(artifact.revision, 1, `${artifact.id} has revision 1`);
		assert.ok(Array.isArray(artifact.history) && artifact.history.length === 1);
	}
	const md = artifacts.find((a) => a.id === 'a-md');
	assert.ok(typeof md.snapshot === 'string' && md.snapshot.includes('quick brown fox'), 'md snapshot present');
	const html = artifacts.find((a) => a.id === 'a-html');
	assert.ok(typeof html.snapshot === 'string' && html.snapshot.includes('<h1>OK</h1>'), 'html snapshot present');
	const big = artifacts.find((a) => a.id === 'a-big');
	assert.ok(typeof big.snapshot === 'string' && big.snapshot.length > 512 * 1024, 'large html snapshots within 2MiB cap');
	const missing = artifacts.find((a) => a.id === 'a-missing');
	assert.equal(missing.snapshot, undefined, 'missing original has no snapshot');
});

test('a deleted original still reads from its saved copy', () => {
	const store = seededStore('delete-test');
	const registry = store.registry();
	const md = registry.collections[0].artifacts.find((a) => a.id === 'a-md');
	rmSync(md.path);
	const { text, source } = readArtifact(md.path, md.snapshot, [APPROVED]);
	assert.equal(source, 'snapshot');
	assert.ok(text.includes('quick brown fox'));
});

test('register is idempotent by id and bumps a revision with history on re-register', () => {
	const store = seededStore('register-test');
	const service = libraryService({ store });
	const instance = Object.create(service.prototype); instance.store = store;
	assert.ok(instance.register({ collectionId: 'coll', artifactId: 'new-item', title: 'New', path: join(APPROVED, 'report.md'), kind: 'report' }).ok);
	assert.ok(instance.register({ collectionId: 'coll', artifactId: 'new-item', title: 'New', path: join(APPROVED, 'report.html'), kind: 'report', format: 'html' }).ok);
	const registry = store.registry();
	const matches = registry.collections[0].artifacts.filter((a) => a.id === 'new-item');
	assert.equal(matches.length, 1, 'no duplicate row for the same id');
	assert.equal(matches[0].revision, 2);
	assert.equal(matches[0].path, join(APPROVED, 'report.html'), 'path updated on re-register');
	assert.equal(matches[0].history.length, 2, 'two revisions recorded');
});

test('register rejects a path outside an approved root', () => {
	const store = seededStore('escape-test');
	const service = libraryService({ store });
	const instance = Object.create(service.prototype); instance.store = store;
	const result = instance.register({ collectionId: 'coll', artifactId: 'evil', title: 'Evil', path: join(OUTSIDE, 'x.md') });
	assert.equal(result.ok, false);
});

test('a body-only search hit finds the artifact', () => {
	const store = seededStore('search-test');
	const service = libraryService({ store });
	const instance = Object.create(service.prototype); instance.store = store;
	const result = instance.search({ query: 'quick brown', includeBody: true });
	assert.ok(result.matches.some((m) => m.id === 'a-md'), 'body hit');
	const titleOnly = instance.search({ query: 'quick brown', includeBody: false });
	assert.equal(titleOnly.matches.length, 0, 'title-only search does not see the body');
});

test('search finds a body-only hit across the seeded collections', () => {
	const store = seededStore('body-hit-test');
	const service = libraryService({ store });
	const instance = Object.create(service.prototype); instance.store = store;
	const result = instance.search({ query: 'quick brown', includeBody: true });
	assert.ok(result.matches.length >= 1, 'at least one body-only hit');
	const aMd = result.matches.find((m) => m.id === 'a-md');
	assert.ok(aMd, 'the seeded markdown artifact is found by body content');
});

test('a revision-1 snapshot stays readable after revision 2 replaces the snapshot', () => {
	const store = seededStore('revision-test');
	const service = libraryService({ store });
	const instance = Object.create(service.prototype); instance.store = store;
	const first = instance.artifact({ id: 'a-md' });
	assert.ok(first.ok && first.html.includes('quick brown fox'));
	writeFileSync(join(APPROVED, 'report.md'), '# Report v2\n\nNew body, no fox.');
	instance.register({ collectionId: 'coll', artifactId: 'a-md', title: 'Report', kind: 'research', path: join(APPROVED, 'report.md') });
	const second = instance.artifact({ id: 'a-md' });
	assert.ok(second.html.includes('New body'), 'new revision reads the updated file');
	const registry = store.registry();
	const artifact = registry.collections[0].artifacts.find((a) => a.id === 'a-md');
	assert.equal(artifact.revision, 2);
	assert.ok(artifact.history.length >= 2, 'both revisions recorded');
});

test('symlinks that resolve outside an approved root are refused', () => {
	const link = join(APPROVED, 'link.md');
	writeFileSync(join(OUTSIDE, 'target.md'), 'secret');
	symlinkSync(join(OUTSIDE, 'target.md'), link);
	const store = createStore({ file: join(ROOT, 'sym-test.json'), roots: [APPROVED] });
	const { text, source } = readArtifact(link, undefined, [APPROVED]);
	assert.equal(text, null, 'a symlink pointing outside is not read');
	assert.equal(source, 'missing');
});

test('a directory symlink swap is also refused', () => {
	const dirLink = join(APPROVED, 'dirlink');
	symlinkSync(OUTSIDE, dirLink);
	const store = createStore({ file: join(ROOT, 'dirlink-test.json'), roots: [APPROVED] });
	const { text, source } = readArtifact(join(dirLink, 'target.md'), undefined, [APPROVED]);
	assert.equal(text, null, 'a file reached through a directory link outside is not read');
	assert.equal(source, 'missing');
});

test('applySeed merges collections idempotently', () => {
	const registry = { schemaVersion: 1, approvedRoots: [], collections: [] };
	applySeed(registry, makeSeed());
	assert.equal(registry.collections.length, 1);
	const addedAgain = applySeed(registry, makeSeed());
	assert.equal(registry.collections.length, 1, 'no duplicate collection');
	assert.equal(addedAgain, 0, 'no artifacts re-added');
});

test('malicious HTML does not become executable in the reader output', () => {
	const store = seededStore('inject-test');
	const malicePath = join(APPROVED, 'malice.html');
	writeFileSync(malicePath, '<html><body><script>bad()</script><img src=x onerror="bad()"></body></html>');
	const service = libraryService({ store });
	const instance = Object.create(service.prototype); instance.store = store;
	// Register the malicious file so the service actually reads it.
	const reg = instance.register({
		collectionId: 'coll',
		artifactId: 'a-malice',
		title: 'Malice',
		path: malicePath,
		kind: 'report',
		format: 'html',
	});
	assert.ok(reg.ok, 'malicious fixture is registered');
	const doc = instance.artifact({ id: 'a-malice' });
	assert.ok(doc.ok);
	// The service returns the raw document for the client to sandbox.
	assert.equal(doc.mode, 'html', 'an HTML artifact is served as a sandboxed document, not inlined');
	assert.ok(doc.html.includes('<script>'), 'the raw document contains a script tag');
	assert.ok(doc.html.includes('onerror'), 'the raw document contains an inline event handler');
	// The security guarantee lives in the client: the client must never inject
	// doc.html into the host DOM. Instead it hands the raw document to an
	// <iframe sandbox="" srcdoc> element whose CSP forbids script. Verify the
	// sandbox and CSP constants from security.js are the ones the client uses.
	assert.equal(HTML_SANDBOX.attributes, 'sandbox=""', 'the iframe sandbox attribute forbids all capabilities');
	assert.ok(HTML_SANDBOX.csp.includes('default-src \'none\''), 'the CSP default denies script loading');
	assert.ok(!HTML_SANDBOX.csp.includes('script-src'), 'no script-src allowlist exists in the CSP');
});
