#!/usr/bin/env node
/**
 * Validate every skill's YAML frontmatter before it reaches a commit.
 *
 * Catches the failure mode that dropped first-principles from the catalog: an
 * unquoted colon in `description` makes the frontmatter invalid YAML, and the
 * provider silently skips the skill.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let parse;
try {
	({ parse } = await import('yaml'));
} catch {
	console.error('validate-skills: the `yaml` package is missing; run `pnpm install` first.');
	process.exit(1);
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(packageDir, 'skills');
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

const problems = [];
let checked = 0;

for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
	if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
	const file = join(skillsDir, entry.name, 'SKILL.md');
	checked += 1;

	let raw;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		problems.push(`${file}: missing SKILL.md`);
		continue;
	}

	const match = raw.match(FRONTMATTER);
	if (!match) {
		problems.push(`${file}: missing --- frontmatter block`);
		continue;
	}

	let data;
	try {
		data = parse(match[1]);
	} catch (error) {
		problems.push(`${file}: invalid YAML frontmatter: ${error.message}`);
		continue;
	}

	if (typeof data?.name !== 'string' || !NAME.test(data.name)) {
		problems.push(`${file}: name must be a kebab-case string`);
	} else if (data.name !== entry.name) {
		problems.push(`${file}: name "${data.name}" does not match folder "${entry.name}"`);
	}

	if (typeof data?.description !== 'string' || data.description.trim() === '') {
		problems.push(`${file}: description must be a non-empty string (quote it if it contains a colon)`);
	}
}

if (problems.length > 0) {
	console.error('validate-skills: refusing to commit\n');
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error(`\n${problems.length} problem(s) in ${checked} skill(s).`);
	process.exit(1);
}

console.log(`validate-skills: ${checked} skill(s) ok`);
