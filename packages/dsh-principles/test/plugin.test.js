/**
 * Wiring tests for `@local/dsh-principles`: the plugin a DSH session loads must
 * register the prompt section and both tools, seed a fresh store, and emit the
 * size line once per index build through the section provider itself.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SECTION_NAME, SECTION_ORDER, apply } from '../index.js';

/** A temporary store folder removed when the test ends. */
function sandbox(t) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-principles-plugin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A fake Cordis context that records the plugin's contributions. */
function fakeContext() {
	const lines = [];
	const sections = [];
	const tools = [];
	const ctx = {
		logger: {
			info: (line) => lines.push(line),
			warn: (line) => lines.push(line),
		},
		systemPrompt: {
			section(section) {
				sections.push(section);
				return () => {};
			},
		},
		tools: {
			register(definition) {
				tools.push(definition);
				return () => {};
			},
		},
	};
	return { ctx, lines, sections, tools };
}

test('apply seeds the store, registers the section, and registers both tools', (t) => {
	const dir = sandbox(t);
	const { ctx, sections, tools } = fakeContext();
	apply(ctx, { dir });

	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		['principle_read', 'principle_write'],
	);
	const section = sections.find((each) => each.name === SECTION_NAME);
	assert.equal(section?.order, SECTION_ORDER);
	assert.ok(existsSync(join(dir, 'prove-it-works.md')));
	assert.ok(existsSync(join(dir, '.removed')) === false);
});

test('the section provider emits exactly one size line per build, through the plugin logger', (t) => {
	const dir = sandbox(t);
	const { ctx, lines, sections } = fakeContext();
	apply(ctx, { dir });
	const section = sections.find((each) => each.name === SECTION_NAME);
	lines.length = 0;

	const text = section.text({ scope: undefined });
	const sizeLines = lines.filter((line) => line.startsWith('principles index:'));
	assert.equal(sizeLines.length, 1);
	assert.equal(sizeLines[0], `principles index: 5 principles, ${Buffer.byteLength(text, 'utf8')} bytes`);
	assert.equal(lines.filter((line) => line.includes('skipped')).length, 0);

	section.text({ scope: undefined });
	assert.equal(lines.filter((line) => line.startsWith('principles index:')).length, 2);
});

test('the registered tools read and write through the plugin', async (t) => {
	const dir = sandbox(t);
	const { ctx, tools } = fakeContext();
	apply(ctx, { dir });
	const read = tools.find((tool) => tool.name === 'principle_read');
	const write = tools.find((tool) => tool.name === 'principle_write');

	const seeded = await read.execute({ name: 'prove it works' }, {});
	assert.equal(seeded.name, 'prove-it-works');
	assert.match(seeded.body, /Verify|verif/u);
	assert.match(seeded.version, /^[0-9a-f]{12}$/u);

	await assert.rejects(read.execute({ name: 'prove works' }, {}), /Close names: prove-it-works/u);

	const added = await write.execute(
		{
			action: 'add',
			name: 'Prefer boring tools',
			title: 'Prefer Boring Tools',
			description: 'Apply when choosing a dependency.',
			body: 'Use what the project already has.',
		},
		{},
	);
	assert.equal(added.name, 'prefer-boring-tools');
	assert.equal(added.version.length, 12);

	const changed = await write.execute(
		{ action: 'change', name: 'prefer-boring-tools', was: added.version, body: 'Use what the project already has, first.' },
		{},
	);
	assert.equal(changed.action, 'change');
	assert.notEqual(changed.version, added.version);

	await assert.rejects(
		write.execute({ action: 'change', name: 'prefer-boring-tools', was: added.version, body: 'Stale write.' }, {}),
		/changed since version/u,
	);

	const removed = await write.execute({ action: 'remove', name: 'prefer-boring-tools', was: changed.version }, {});
	assert.equal(removed.action, 'remove');
	assert.match(removed.removedTo, /\.removed\/prefer-boring-tools-\d+\.md$/u);
	await assert.rejects(read.execute({ name: 'prefer-boring-tools' }, {}), /removed/u);
});
