#!/usr/bin/env node
/**
 * Validate every skill's YAML frontmatter before it reaches a commit.
 *
 * Catches the failure mode that dropped first-principles from the catalog: an
 * unquoted colon in `description` makes the frontmatter invalid YAML, and the
 * provider silently skips the skill.
 *
 * Scans both layouts the provider serves: a flat `<name>/SKILL.md` and one
 * level of grouping, `<group>/<name>/SKILL.md`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let parse;
try {
	({ parse } = await import('yaml'));
} catch {
	console.error('validate-skills: the `yaml` package is missing; run `pnpm install` first.');
	process.exit(1);
}

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skillsDir = join(repoDir, 'skills');
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

const problems = [];
let checked = 0;

/**
 * Whether a path exists.
 * @param path - absolute path.
 * @returns true when it exists.
 */
async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Find every skill bundle under the skills folder.
 * @returns bundle name plus its SKILL.md path.
 */
async function discover() {
	const found = [];
	let entries;
	try {
		entries = await readdir(skillsDir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const entryPath = join(skillsDir, entry.name);
		if (await exists(join(entryPath, 'SKILL.md'))) {
			found.push({ name: entry.name, file: join(entryPath, 'SKILL.md') });
			continue;
		}
		let children;
		try {
			children = await readdir(entryPath, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const child of children) {
			if (!child.isDirectory() || child.name.startsWith('.')) continue;
			const childPath = join(entryPath, child.name);
			if (await exists(join(childPath, 'SKILL.md'))) {
				found.push({ name: child.name, file: join(childPath, 'SKILL.md') });
			}
		}
	}
	return found;
}

for (const { name, file } of await discover()) {
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
	} else if (data.name !== name) {
		problems.push(`${file}: name "${data.name}" does not match folder "${name}"`);
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
