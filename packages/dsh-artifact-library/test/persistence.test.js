/**
 * Persistence failure behavior. The registry is the only durable record of
 * pins, registered deliverables and saved snapshots, so these tests use
 * synthetic temp files to prove that a failed write, a corrupt file or an
 * unreadable path is visible and never replaces the last good state.
 *
 * @module @local/dsh-artifact-library/test/persistence
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createStore, libraryService } from '../index.js';
import { readRegistry, writeRegistry } from '../store.js';

/** A synthetic registry, an approved report, and a private state file. */
function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), 'lib-persist-'));
	const approved = join(root, 'approved');
	mkdirSync(approved, { recursive: true, mode: 0o700 });
	const report = join(approved, 'report.md');
	writeFileSync(report, '# Report\n\nBody.\n');
	const file = join(root, 'state', 'registry.json');
	const registry = {
		schemaVersion: 1,
		approvedRoots: [approved],
		collections: [{
			id: 'coll',
			title: 'Topic',
			project: 'ai-stack',
			artifacts: [{ id: 'a-md', title: 'Report', kind: 'research', path: report, revision: 1, history: [], pinned: false }],
			expectedOutputs: [],
		}],
	};
	writeRegistry(file, registry);
	return { root, approved, report, file, registry };
}

/** A service instance over a store, without starting a Cordis context. */
function serviceFor(store) {
	const Service = libraryService({ store });
	const instance = Object.create(Service.prototype);
	instance.store = store;
	return instance;
}

/** Remove one synthetic fixture tree after its test. */
function cleanup(t, root) {
	t.after(() => rmSync(root, { recursive: true, force: true }));
}

test('only ENOENT reads fresh; malformed or unreadable registries throw', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'lib-read-'));
	cleanup(t, root);

	const missing = join(root, 'missing.json');
	assert.deepEqual(readRegistry(missing), { schemaVersion: 1, approvedRoots: [], collections: [] });
	assert.equal(existsSync(missing), false, 'a fresh read does not create a file');

	const corrupt = join(root, 'corrupt.json');
	writeFileSync(corrupt, '{ this is not json');
	assert.throws(() => readRegistry(corrupt), /not valid JSON/);

	const malformed = join(root, 'malformed.json');
	writeFileSync(malformed, JSON.stringify({ collections: 'not-an-array' }));
	assert.throws(() => readRegistry(malformed), /malformed/);

	const unreadable = join(root, 'directory.json');
	mkdirSync(unreadable);
	assert.throws(() => readRegistry(unreadable));
});

test('a corrupt existing registry is visible and is never reseeded or overwritten', (t) => {
	const { root, file } = makeFixture();
	cleanup(t, root);

	const seedFile = join(root, 'seed.json');
	writeFileSync(seedFile, JSON.stringify({
		approvedRoots: [join(root, 'approved')],
		collections: [{ id: 'seed', project: 'seed-project', artifacts: [] }],
	}));

	const corrupt = '{ this is not json';
	writeFileSync(file, corrupt);
	const first = createStore({ file, seedFile });
	assert.throws(() => first.registry(), /not valid JSON/);
	assert.equal(readFileSync(file, 'utf8'), corrupt, 'the corrupt file was not replaced by a seed');

	const malformed = JSON.stringify({ collections: 'not-an-array' });
	writeFileSync(file, malformed);
	const second = createStore({ file, seedFile });
	assert.throws(() => second.registry(), /malformed/);
	assert.equal(readFileSync(file, 'utf8'), malformed, 'the malformed file is untouched');

	rmSync(file);
	mkdirSync(file);
	const third = createStore({ file, seedFile });
	assert.throws(() => third.registry());
	assert.equal(statSync(file).isDirectory(), true, 'the directory blocker is untouched');
});

test('persist writes before committing and propagates a failed write', (t) => {
	const { root, file } = makeFixture();
	cleanup(t, root);

	const store = createStore({ file });
	const before = store.registry();
	assert.equal(before.collections[0].artifacts[0].pinned, false);

	mkdirSync(`${file}.tmp`);
	assert.throws(
		() => store.persist({ ...structuredClone(before), collections: [] }),
		/could not be written/,
	);
	assert.strictEqual(store.registry(), before, 'the cache still holds the last good registry');
	assert.equal(JSON.parse(readFileSync(file, 'utf8')).collections.length, 1, 'the last good file is unchanged');
});

test('a failed pin returns an error and preserves last-good memory and disk', (t) => {
	const { root, file } = makeFixture();
	cleanup(t, root);

	const store = createStore({ file });
	const instance = serviceFor(store);
	const diskBefore = readFileSync(file, 'utf8');

	mkdirSync(`${file}.tmp`);
	const result = instance.setPinned({ collectionId: 'coll', artifactId: 'a-md', pinned: true });
	assert.equal(result.ok, false);
	assert.match(result.error, /pin was not saved/);
	assert.equal(store.registry().collections[0].artifacts[0].pinned, false, 'memory keeps the last good pin');
	assert.equal(readFileSync(file, 'utf8'), diskBefore, 'disk keeps the last good registry');
});

test('a pin fails visibly when the registry path itself became a directory', (t) => {
	const { root, file } = makeFixture();
	cleanup(t, root);

	const store = createStore({ file });
	const instance = serviceFor(store);
	assert.equal(store.registry().collections[0].artifacts[0].pinned, false);

	rmSync(file);
	mkdirSync(file);
	const result = instance.setPinned({ collectionId: 'coll', artifactId: 'a-md', pinned: true });
	assert.equal(result.ok, false);
	assert.match(result.error, /pin was not saved/);
	assert.equal(store.registry().collections[0].artifacts[0].pinned, false, 'the cache keeps the last good pin');
	assert.equal(statSync(file).isDirectory(), true, 'the directory blocker was not overwritten');
});

test('a failed register returns an error and preserves last-good memory and disk', (t) => {
	const { root, file, report } = makeFixture();
	cleanup(t, root);

	const store = createStore({ file });
	const instance = serviceFor(store);
	const diskBefore = readFileSync(file, 'utf8');

	mkdirSync(`${file}.tmp`);
	const result = instance.register({
		collectionId: 'coll',
		artifactId: 'a-new',
		title: 'New report',
		kind: 'report',
		path: report,
	});
	assert.equal(result.ok, false);
	assert.match(result.error, /artifact was not registered/);
	assert.equal(
		store.registry().collections[0].artifacts.some((artifact) => artifact.id === 'a-new'),
		false,
		'memory keeps the last good artifact list',
	);
	assert.equal(readFileSync(file, 'utf8'), diskBefore, 'disk keeps the last good registry');
});

test('a seed write failure throws before any seeded registry is cached', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'lib-seed-'));
	cleanup(t, root);
	const approved = join(root, 'approved');
	mkdirSync(approved, { recursive: true, mode: 0o700 });
	const seedFile = join(root, 'seed.json');
	writeFileSync(seedFile, JSON.stringify({
		approvedRoots: [approved],
		collections: [{ id: 'seed', project: 'seed-project', artifacts: [] }],
	}));
	const file = join(root, 'state', 'registry.json');
	mkdirSync(dirname(file), { recursive: true });
	mkdirSync(`${file}.tmp`);

	const store = createStore({ file, seedFile });
	assert.throws(() => store.registry(), /could not be written/);
	assert.equal(existsSync(file), false, 'no seeded registry reached disk');
});

test('a successful pin reaches disk and the state directory/file stay private', (t) => {
	const { root, file } = makeFixture();
	cleanup(t, root);

	const store = createStore({ file });
	const instance = serviceFor(store);
	const result = instance.setPinned({ collectionId: 'coll', artifactId: 'a-md', pinned: true });
	assert.equal(result.ok, true);
	assert.equal(store.registry().collections[0].artifacts[0].pinned, true);

	const saved = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(saved.collections[0].artifacts[0].pinned, true, 'the pin is on disk');
	assert.equal(statSync(file).mode & 0o777, 0o600, 'the registry file is private');
	assert.equal(statSync(dirname(file)).mode & 0o777, 0o700, 'the state directory is private');
});
