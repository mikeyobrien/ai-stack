#!/usr/bin/env node
/**
 * Scaffold a mov-skills skill.
 *
 * Two modes, chosen by the terminal:
 * - With a terminal, run it bare (or with only a name) and it interviews you for
 *   the missing pieces, shows a summary, and writes nothing until you confirm.
 * - Without a terminal (pipes, CI), flags are required and nothing prompts.
 *
 * Dependency-free: Node built-ins only, no install step. Runnable from any
 * directory; paths resolve relative to this script, not the caller.
 *
 *   node mov-skills/scripts/new-skill.mjs
 *   node mov-skills/scripts/new-skill.mjs my-skill --when "Use when ..."
 *
 * @module @local/mov-skills/scripts/new-skill
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

/** Folder that holds the skills served by the provider. */
const SKILLS_DIR = fileURLToPath(new URL('../../../skills/', import.meta.url));

/** Starter file copied for each new skill; hidden from discovery by its dot prefix. */
const TEMPLATE_FILE = join(SKILLS_DIR, '.template', 'SKILL.md');

/** Public kebab-case skill-name grammar, identical to the registry's. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Optional folders a skill may carry. */
const RESOURCE_KINDS = new Set(['references', 'scripts', 'assets']);

/** Description used when the interview or flags leave one out. */
const PLACEHOLDER_DESCRIPTION = 'Use when … (one sentence on what this skill does and when to trigger it).';

const USAGE = `Create a skill folder under ${SKILLS_DIR}

Usage, from the repo root:
  ./mov-skills/new-skill [<name>] [options]

Usage, from this package's root (mov-skills/):
  ./new-skill [<name>] [options]

Node also accepts the long form from the repo root:
  node mov-skills/scripts/new-skill.mjs [<name>] [options]

Interactive:
  Run bare, or with only a name, in a terminal and it asks for the missing
  details, shows a summary, and writes nothing until you confirm.
  Without a terminal it never prompts; flags are required.

Arguments:
  <name>                    Kebab-case skill name, e.g. release-notes

Options:
  --when <text>             Routing description shown in the skill catalog
  --resources <list>        Comma-separated folders to create:
                            references, scripts, assets
  -h, --help                Show this help

Examples:
  ./mov-skills/new-skill
  ./mov-skills/new-skill release-notes
  ./mov-skills/new-skill release-notes --when "Use when writing release notes from a diff." --resources references
`;

/**
 * Print an error and exit.
 * @param message - failure text.
 * @returns never.
 */
function fail(message) {
	console.error(`new-skill: ${message}`);
	console.error('\nRun with --help for usage.');
	process.exit(1);
}

/**
 * Convert a kebab-case name to a display title.
 * @param value - kebab-case skill name.
 * @returns title-cased words.
 */
function toTitle(value) {
	return value
		.split('-')
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/**
 * Quote a description as a YAML double-quoted scalar.
 * @param value - raw description text.
 * @returns a scalar safe for frontmatter.
 */
function yamlString(value) {
	return JSON.stringify(value);
}

/**
 * Parse command-line arguments.
 * @param argv - arguments after the node executable and script path.
 * @returns normalized options; an empty argument list yields an empty interview input.
 */
function parseArgs(argv) {
	const options = { name: undefined, description: undefined, resources: [], resourcesProvided: false };
	if (argv.length === 0) return options;
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(USAGE);
		process.exit(0);
	}
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--when' || arg === '--description') {
			const value = argv[index + 1];
			index += 1;
			if (value === undefined) fail(`${arg} needs a value`);
			options.description = value;
			continue;
		}
		if (arg === '--resources') {
			const value = argv[index + 1];
			index += 1;
			if (value === undefined) fail('--resources needs a comma-separated list');
			options.resourcesProvided = true;
			options.resources = [];
			for (const kind of value.split(',')) {
				const normalized = kind.trim();
				if (normalized === '') continue;
				if (!RESOURCE_KINDS.has(normalized)) {
					fail(`unknown resource folder "${normalized}" (expected: ${[...RESOURCE_KINDS].join(', ')})`);
				}
				options.resources.push(normalized);
			}
			continue;
		}
		if (arg.startsWith('-')) fail(`unknown option ${arg}`);
		if (options.name !== undefined) fail(`unexpected extra argument ${arg}`);
		options.name = arg;
	}
	if (options.name !== undefined && !SKILL_NAME.test(options.name)) {
		fail(`"${options.name}" is not kebab-case (lowercase letters, digits, single hyphens)`);
	}
	return options;
}

/**
 * Whether a path exists.
 * @param path - absolute path.
 * @returns true when it exists.
 */
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Human-readable list of the folders a skill will carry.
 * @param resources - requested resource folder names.
 * @returns summary text.
 */
function describeResources(resources) {
	return resources.length === 0 ? 'no resource folders' : `folders: ${resources.join(', ')}`;
}

/**
 * Interview for missing skill details.
 * @param base - options already supplied by flags.
 * @returns completed options, after an explicit confirmation.
 */
async function gather(base) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const options = { ...base, resources: [...base.resources] };
	rl.on('SIGINT', () => {
		console.log('\nAborted — nothing written.');
		process.exit(0);
	});
	console.log('Scaffolding a mov-skills skill (Ctrl+C cancels).');
	try {
		while (options.name === undefined) {
			const answer = (await rl.question('Skill name (kebab-case): ')).trim();
			if (answer === '') {
				console.log('  a name is required');
				continue;
			}
			if (!SKILL_NAME.test(answer)) {
				console.log('  use lowercase letters, digits, and single hyphens');
				continue;
			}
			if (await exists(join(SKILLS_DIR, answer))) {
				console.log(`  ${answer} already exists`);
				continue;
			}
			options.name = answer;
		}
		if (options.description === undefined) {
			const answer = (await rl.question('Description (use when…): ')).trim();
			if (answer === '') console.log(`  keeping placeholder: ${PLACEHOLDER_DESCRIPTION}`);
			else options.description = answer;
		}
		if (!options.resourcesProvided) {
			for (;;) {
				const answer = (await rl.question(`Resource folders [none] (${[...RESOURCE_KINDS].join(', ')}): `)).trim();
				if (answer === '') {
					options.resources = [];
					break;
				}
				const kinds = answer.split(',').map((kind) => kind.trim()).filter(Boolean);
				const unknown = kinds.filter((kind) => !RESOURCE_KINDS.has(kind));
				if (unknown.length > 0) {
					console.log(`  unknown: ${unknown.join(', ')} (choose from ${[...RESOURCE_KINDS].join(', ')})`);
					continue;
				}
				options.resources = kinds;
				break;
			}
		}
		const confirm = (await rl.question(`Create "${options.name}" with ${describeResources(options.resources)}? [Y/n] `))
			.trim()
			.toLowerCase();
		if (confirm === 'n' || confirm === 'no') {
			console.log('Aborted — nothing written.');
			process.exit(0);
		}
	} catch (error) {
		if (error?.code === 'ABORT_ERR') {
			console.log('\nAborted — nothing written.');
			process.exit(0);
		}
		throw error;
	} finally {
		rl.close();
	}
	return options;
}

/**
 * Create the skill folder and its starter files.
 * @param options - completed options.
 */
async function createSkill(options) {
	const skillDir = join(SKILLS_DIR, options.name);
	if (await exists(skillDir)) fail(`${relative(process.cwd(), skillDir)} already exists`);

	let template;
	try {
		template = await readFile(TEMPLATE_FILE, 'utf8');
	} catch {
		fail(`template missing at ${TEMPLATE_FILE}`);
	}

	const description = options.description?.trim() || PLACEHOLDER_DESCRIPTION;
	const body = template
		.replaceAll('{name}', options.name)
		.replaceAll('{title}', toTitle(options.name))
		.replaceAll('{description}', JSON.stringify(description));

	await mkdir(skillDir, { recursive: true });
	await writeFile(join(skillDir, 'SKILL.md'), body, 'utf8');
	const created = [relative(process.cwd(), join(skillDir, 'SKILL.md'))];

	for (const kind of [...new Set(options.resources)]) {
		const resourceDir = join(skillDir, kind);
		await mkdir(resourceDir, { recursive: true });
		await writeFile(join(resourceDir, '.gitkeep'), '', 'utf8');
		created.push(`${relative(process.cwd(), resourceDir)}/`);
	}

	console.log(`Created ${options.name}:`);
	for (const path of created) console.log(`  ${path}`);
	console.log(`\nEdit the file, then load it with the skill tool or /${options.name}.`);
	console.log('The catalog refreshes within about a second — no restart.');
}

/**
 * Choose flags or the interview, then scaffold.
 */
async function main() {
	const options = parseArgs(process.argv.slice(2));
	const interactive = process.stdin.isTTY === true;
	const missingDetails = options.name === undefined || options.description === undefined;
	if (!interactive) {
		if (options.name === undefined) {
			console.log(USAGE);
			process.exit(1);
		}
		await createSkill(options);
		return;
	}
	await createSkill(missingDetails ? await gather(options) : options);
}

await main();
