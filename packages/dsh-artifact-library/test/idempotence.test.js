/**
 * Registration idempotence and revision-byte preservation.
 *
 * A repeat with the same resolved path, content and supplied metadata is a
 * no-op that returns the existing revision. Changed content creates a revision
 * and keeps the prior revision's snapshot bytes in history, not only its hash.
 *
 * @module @local/dsh-artifact-library/test/idempotence
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createStore, libraryService } from '../index.js';
import { hashText, writeRegistry } from '../store.js';

/** A synthetic store with one empty collection and a readable report. */
function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), 'lib-idem-'));
	const approved = join(root, 'approved');
	mkdirSync(approved, { recursive: true, mode: 0o700 });
	const report = join(approved, 'report.md');
	writeFileSync(report, 'abc');
	const file = join(root, 'state', 'registry.json');
	writeRegistry(file, {
		schemaVersion: 1,
		approvedRoots: [approved],
		collections: [{ id: 'coll', title: 'Topic', project: 'ai-stack', artifacts: [], expectedOutputs: [] }],
	});
	const store = createStore({ file });
	const Service = libraryService({ store });
	const instance = Object.create(Service.prototype);
	instance.store = store;
	return { root, approved, report, file, store, instance };
}

/** Remove the synthetic fixture tree after its test. */
function cleanup(t, root) {
	t.after(() => rmSync(root, { recursive: true, force: true }));
}

function registration(report) {
	return { collectionId: 'coll', artifactId: 'a-md', title: 'Report', kind: 'report', path: report };
}

test('an identical registration retry keeps one row and one revision and writes nothing', (t) => {
	const { root, report, file, store, instance } = makeFixture();
	cleanup(t, root);

	const request = registration(report);
	const first = instance.register(request);
	assert.equal(first.ok, true);
	assert.equal(first.revision, 1);
	assert.equal(first.unchanged, undefined);
	assert.equal(first.snapshot, true);

	const disk = readFileSync(file, 'utf8');
	const second = instance.register(request);
	assert.equal(second.ok, true);
	assert.equal(second.unchanged, true);
	assert.equal(second.revision, 1);
	assert.equal(second.snapshot, true);

	const artifacts = store.registry().collections[0].artifacts;
	assert.equal(artifacts.length, 1, 'one row');
	assert.equal(artifacts[0].revision, 1, 'one revision');
	assert.equal(artifacts[0].history.length, 1, 'no history append');
	assert.equal(artifacts[0].history[0].snapshot, 'abc');
	assert.equal(readFileSync(file, 'utf8'), disk, 'the unchanged retry did not write');
});

test('the same file reached through a symlink is an unchanged registration', (t) => {
	const { root, approved, report, store, instance } = makeFixture();
	cleanup(t, root);

	assert.equal(instance.register(registration(report)).ok, true);
	const link = join(approved, 'report-link.md');
	symlinkSync(report, link);

	const retry = instance.register(registration(link));
	assert.equal(retry.ok, true);
	assert.equal(retry.unchanged, true);
	assert.equal(retry.revision, 1);

	const artifacts = store.registry().collections[0].artifacts;
	assert.equal(artifacts.length, 1);
	assert.equal(artifacts[0].revision, 1);
	assert.equal(artifacts[0].history.length, 1);
});

test('changed content appends a revision and keeps the prior snapshot bytes', (t) => {
	const { root, report, store, instance } = makeFixture();
	cleanup(t, root);

	const request = registration(report);
	assert.equal(instance.register(request).ok, true);
	writeFileSync(report, 'def');

	const second = instance.register(request);
	assert.equal(second.ok, true);
	assert.equal(second.revision, 2);
	assert.equal(second.unchanged, undefined);
	assert.equal(second.snapshot, true);

	const artifact = store.registry().collections[0].artifacts[0];
	assert.equal(artifact.snapshot, 'def');
	assert.equal(artifact.history.length, 2);
	const first = artifact.history.find((entry) => entry.revision === 1);
	const latest = artifact.history.find((entry) => entry.revision === 2);
	assert.equal(first.snapshot, 'abc', 'the prior revision bytes are kept');
	assert.equal(latest.snapshot, 'def', 'the new revision bytes are kept');
	assert.equal(first.hash, hashText('abc'));
	assert.equal(latest.hash, hashText('def'));
});

test('a changed supplied title still creates a revision', (t) => {
	const { root, report, store, instance } = makeFixture();
	cleanup(t, root);

	const request = registration(report);
	assert.equal(instance.register(request).ok, true);
	const renamed = instance.register({ ...request, title: 'Renamed' });
	assert.equal(renamed.ok, true);
	assert.equal(renamed.revision, 2);
	assert.equal(renamed.unchanged, undefined);

	const artifact = store.registry().collections[0].artifacts[0];
	assert.equal(artifact.title, 'Renamed');
	assert.equal(artifact.history.length, 2);
	assert.equal(artifact.history.find((entry) => entry.revision === 1).snapshot, 'abc');
	assert.equal(artifact.history.find((entry) => entry.revision === 2).snapshot, 'abc');
});

test('a legacy hash-only history entry gains the prior snapshot on change', (t) => {
	const { root, report, file, instance } = makeFixture();
	cleanup(t, root);

	const request = registration(report);
	assert.equal(instance.register(request).ok, true);

	// Simulate a revision record written before snapshots were kept in history.
	const parsed = JSON.parse(readFileSync(file, 'utf8'));
	const legacy = parsed.collections[0].artifacts.find((artifact) => artifact.id === 'a-md');
	delete legacy.history[0].snapshot;
	writeFileSync(file, JSON.stringify(parsed));

	const store = createStore({ file });
	const Service = libraryService({ store });
	const next = Object.create(Service.prototype);
	next.store = store;
	writeFileSync(report, 'def');
	const result = next.register(request);

	assert.equal(result.ok, true);
	assert.equal(result.revision, 2);
	const artifact = store.registry().collections[0].artifacts.find((candidate) => candidate.id === 'a-md');
	const prior = artifact.history.find((entry) => entry.revision === 1);
	const latest = artifact.history.find((entry) => entry.revision === 2);
	assert.equal(prior.snapshot, 'abc', 'the prior snapshot is backfilled');
	assert.equal(prior.hash, hashText('abc'));
	assert.equal(latest.snapshot, 'def');
});
