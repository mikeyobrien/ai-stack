/**
 * Store-level tests for `@local/dsh-principles`: the round-trip, the version
 * guard, the skipped-file rule, and the index the prompt receives.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	BUNDLE_DIR,
	PRINCIPLE_LIMITS,
	createPrincipleStore,
	parsePrinciple,
	renderIndex,
	seedPrinciples,
} from '../store.js';

/** The five bundled principles, in id order. */
const SEED_IDS = [
	'fix-root-causes',
	'guard-the-context-window',
	'prove-it-works',
	'subtract-before-you-add',
	'test-behavior-not-implementation',
];

/** A temporary store folder removed when the test ends. */
function sandbox(t) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-principles-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A logger whose emitted lines the test can read. */
function capture() {
	const lines = [];
	return { lines, log: (line) => lines.push(line) };
}

/** A store over a fresh folder with silent diagnostics. */
function storeIn(dir, log) {
	return createPrincipleStore({ dir, log: log ?? (() => {}) });
}

/** Write one file into a store folder. */
function put(dir, name, text) {
	writeFileSync(join(dir, name), text, 'utf8');
}

test('add, read, change, and remove round-trip', (t) => {
	const dir = sandbox(t);
	const store = storeIn(dir);
	const added = store.add({
		name: 'Prove It Works',
		title: 'Prove It Works',
		description: 'Apply after completing a task, before declaring done.',
		body: '# Prove It Works\n\nRun the real thing.',
	});
	assert.equal(added.id, 'prove-it-works');
	assert.equal(added.title, 'Prove It Works');
	assert.ok(existsSync(join(dir, 'prove-it-works.md')));

	const read = store.find('prove it works');
	assert.equal(read.id, 'prove-it-works');
	assert.match(read.body, /Run the real thing/u);

	const changed = store.change({
		name: 'prove-it-works',
		was: read.version,
		description: 'Apply before declaring done.',
		body: 'Verify against the real artifact.',
	});
	assert.equal(changed.description, 'Apply before declaring done.');
	assert.equal(changed.body, 'Verify against the real artifact.');
	assert.notEqual(changed.version, read.version);
	assert.equal(store.find('Prove It Works').version, changed.version);

	const removed = store.remove({ name: 'prove-it-works', was: changed.version });
	assert.equal(store.find('prove-it-works'), undefined);
	assert.equal(existsSync(join(dir, 'prove-it-works.md')), false);
	const trash = readdirSync(join(dir, '.removed'));
	assert.equal(trash.length, 1);
	assert.match(trash[0], /^prove-it-works-\d+\.md$/u);
	assert.equal(removed.removedTo, join(dir, '.removed', trash[0]));
	assert.match(readFileSync(removed.removedTo, 'utf8'), /Verify against the real artifact/u);
});

test('a stale "was" refuses a change or a removal', (t) => {
	const dir = sandbox(t);
	const store = storeIn(dir);
	store.add({ name: 'small-rule', description: 'Apply when testing the guard.', body: 'First text.' });
	const first = store.find('small-rule');
	const second = store.change({ name: 'small-rule', was: first.version, body: 'Second text.' });
	assert.equal(second.body, 'Second text.');

	assert.throws(
		() => store.change({ name: 'small-rule', was: first.version, body: 'Third text.' }),
		/changed since version/u,
	);
	assert.throws(() => store.remove({ name: 'small-rule', was: first.version }), /changed since version/u);
	assert.equal(store.find('small-rule').body, 'Second text.');
	assert.equal(store.find('small-rule').version, second.version);
});

test('a malformed file is skipped once and the index still renders', (t) => {
	const dir = sandbox(t);
	const store = storeIn(dir);
	store.add({ name: 'valid-rule', description: 'Apply when the store is scanned.', body: 'Stay valid.' });
	put(dir, 'broken.md', '---\nname: broken\n---\n\nNo description, so no principle.\n');
	put(dir, 'other-name.md', '---\nname: different-name\ndescription: A mismatched name.\n---\n\nBody.\n');
	put(dir, 'no-frontmatter.md', 'Just text, no frontmatter.\n');

	const logger = capture();
	const logging = storeIn(dir, logger.log);
	assert.equal(logging.list().length, 1);
	assert.equal(logging.list().length, 1);
	const skipped = logger.lines.filter((line) => line.includes('skipped'));
	assert.equal(skipped.length, 3);
	assert.equal(new Set(skipped).size, 3);

	const text = renderIndex(logging.list(), () => {});
	assert.match(text, /<principle name="valid-rule"/u);
	assert.doesNotMatch(text, /broken/u);
	assert.doesNotMatch(text, /different-name/u);
});

test('the index carries one line per principle, sorted by id, with the precedence rule', (t) => {
	const dir = sandbox(t);
	seedPrinciples({ dir, bundleDir: BUNDLE_DIR });
	const store = storeIn(dir);
	const principles = store.list();
	assert.equal(principles.length, 5);
	const logger = capture();
	const text = renderIndex(principles, logger.log);

	assert.equal(logger.lines.length, 1);
	assert.equal(
		logger.lines[0],
		`principles index: ${principles.length} principles, ${Buffer.byteLength(text, 'utf8')} bytes`,
	);

	const lines = text.split('\n').filter((line) => line.startsWith('<principle '));
	assert.equal(lines.length, principles.length);
	const names = [...text.matchAll(/<principle name="([^"]+)"/gu)].map((match) => match[1]);
	assert.deepEqual(names, SEED_IDS);
	assert.deepEqual(names, [...names].sort());

	assert.match(text, /At the start of a multi-step task, check this list/u);
	assert.match(text, /read it with principle_read before applying it/u);
	assert.match(text, /Apply it even when the person does not name it/u);
	assert.match(text, /name each principle that changed a decision/u);
	assert.match(text, /win over AGENTS\.md where they conflict/u);
	assert.match(text, /never overrides an explicit instruction in the current turn/u);
});

test('every index build logs exactly one size line, with its count and byte figure', (t) => {
	const dir = sandbox(t);
	seedPrinciples({ dir, bundleDir: BUNDLE_DIR });
	const store = storeIn(dir);
	const principles = store.list();
	const logger = capture();

	const first = renderIndex(principles, logger.log);
	assert.equal(logger.lines.length, 1);
	assert.equal(
		logger.lines[0],
		`principles index: 5 principles, ${Buffer.byteLength(first, 'utf8')} bytes`,
	);

	const second = renderIndex(principles, logger.log);
	assert.equal(logger.lines.length, 2);
	assert.equal(logger.lines[1], logger.lines[0]);
	assert.equal(second, first);

	const empty = capture();
	assert.equal(renderIndex([], empty.log), '');
	assert.equal(empty.lines.length, 1);
	assert.equal(empty.lines[0], 'principles index: 0 principles, 0 bytes');
});

test('an unknown name lists close names and says when a principle was removed', (t) => {
	const dir = sandbox(t);
	const store = storeIn(dir);
	store.add({ name: 'prove-it-works', description: 'Apply after a task.', body: 'Verify it.' });
	const message = store.unknown('prove works');
	assert.match(message, /No principle matches "prove works"/u);
	assert.match(message, /Close names: prove-it-works/u);

	const found = store.find('prove-it-works');
	store.remove({ name: 'prove-it-works', was: found.version });
	assert.match(store.unknown('prove-it-works'), /removed; its copy is in \.removed\//u);
	assert.match(store.unknown('unrelated words'), /store is empty/u);
});

test('unicode survives the store and reaches the index', (t) => {
	const dir = sandbox(t);
	const store = storeIn(dir);
	const description = 'Apply when the text is café — naïve ✓';
	store.add({ name: 'unicode-rule', description, body: 'Привет, 世界 🌍\n\nKeep the ünïcode.' });
	const found = store.find('unicode rule');
	assert.equal(found.description, description);
	assert.equal(found.body, 'Привет, 世界 🌍\n\nKeep the ünïcode.');
	assert.match(readFileSync(join(dir, 'unicode-rule.md'), 'utf8'), /Привет, 世界 🌍/u);

	const text = renderIndex(store.list(), () => {});
	assert.match(text, /café — naïve ✓/u);
	// The index carries the trigger; the body is read on demand.
	assert.doesNotMatch(text, /Привет/u);
});

test('a 16 KB body is accepted and one byte over is refused', (t) => {
	const dir = sandbox(t);
	const store = storeIn(dir);
	const body = 'a'.repeat(PRINCIPLE_LIMITS.body);
	store.add({ name: 'big-rule', description: 'Apply when testing the size limit.', body });
	const found = store.find('big-rule');
	assert.equal(Buffer.byteLength(found.body, 'utf8'), 16 * 1024);
	assert.match(renderIndex(store.list(), () => {}), /<principle name="big-rule"/u);
	assert.throws(
		() => store.add({ name: 'too-big', description: 'Apply when over the limit.', body: 'a'.repeat(PRINCIPLE_LIMITS.body + 1) }),
		/limit is 16384/u,
	);

	// The limit is bytes, not characters: 8192 two-byte characters fit, 8193 do not.
	store.add({ name: 'unicode-big', description: 'Apply when testing byte counting.', body: 'é'.repeat(8192) });
	assert.equal(Buffer.byteLength(store.find('unicode-big').body, 'utf8'), 16 * 1024);
	assert.throws(
		() => store.add({ name: 'unicode-over', description: 'Apply when testing byte counting.', body: 'é'.repeat(8193) }),
		/limit is 16384/u,
	);
});

test('names, triggers, and file names are validated', (t) => {
	const dir = sandbox(t);
	const store = storeIn(dir);
	assert.throws(() => store.add({ name: '!!!', description: 'Apply when nameless.', body: 'Body.' }), /lowercase/u);
	assert.throws(
		() => store.add({ name: 'x'.repeat(PRINCIPLE_LIMITS.name + 1), description: 'Apply when too long.', body: 'Body.' }),
		/longer than 60/u,
	);
	assert.throws(() => store.add({ name: 'no-trigger', description: '   ', body: 'Body.' }), /trigger/u);
	assert.throws(
		() => store.add({ name: 'long-trigger', description: 'x'.repeat(PRINCIPLE_LIMITS.description + 1), body: 'Body.' }),
		/limit is 600/u,
	);

	put(dir, 'Bad_Name.md', '---\nname: Bad_Name\ndescription: Bad file name.\n---\n\nBody.\n');
	const parsed = parsePrinciple('bad-name', '---\nname: other-name\ndescription: A trigger.\n---\n\nBody.\n');
	assert.match(parsed.error, /does not match the file name/u);
	assert.equal(store.list().length, 0);

	// A `principle-` prefix names the same principle, which is what the seed strips.
	const prefixed = store.add({ name: 'principle-demo-rule', description: 'Apply when demonstrating the prefix.', body: 'Body.' });
	assert.equal(prefixed.id, 'demo-rule');
});

test('seeding copies the bundle, never overwrites an edit, and never resurrects a removal', (t) => {
	const dir = sandbox(t);
	const logger = capture();
	const added = seedPrinciples({ dir, bundleDir: BUNDLE_DIR, log: logger.log });
	assert.deepEqual(
		added.filter((name) => name !== 'LICENSE-pstack.txt'),
		SEED_IDS,
	);
	assert.ok(existsSync(join(dir, 'LICENSE-pstack.txt')));
	assert.equal(logger.lines.filter((line) => line.startsWith('principles: seeded')).length, 1);

	for (const id of SEED_IDS) {
		const parsed = parsePrinciple(id, readFileSync(join(dir, `${id}.md`), 'utf8'));
		assert.equal(parsed.error, undefined, `${id} should parse`);
		assert.equal(parsed.principle.id, id);
		assert.match(parsed.principle.source, /^https:\/\//u);
		assert.match(parsed.principle.license, /MIT/u);
	}

	put(dir, 'prove-it-works.md', '---\nname: prove-it-works\ndescription: The person edited this.\n---\n\nMine now.\n');
	assert.deepEqual(seedPrinciples({ dir, bundleDir: BUNDLE_DIR }), []);
	assert.match(readFileSync(join(dir, 'prove-it-works.md'), 'utf8'), /Mine now/u);

	const store = storeIn(dir);
	const removed = store.find('fix-root-causes');
	store.remove({ name: 'fix-root-causes', was: removed.version });
	assert.deepEqual(seedPrinciples({ dir, bundleDir: BUNDLE_DIR }), []);
	assert.equal(existsSync(join(dir, 'fix-root-causes.md')), false);

	assert.deepEqual(seedPrinciples({ dir: sandbox(t), bundleDir: join(dir, 'missing') }), []);
});
