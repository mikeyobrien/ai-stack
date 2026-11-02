/**
 * The principle store: the person's named rules of work, one Markdown file each
 * under `$DSH_HOME/principles/`, plus the index rendered into the session
 * prompt.
 *
 * The shape follows pi-dobo's principles layer, which proved the two-layer
 * pattern: the model always sees a name, a title, and the trigger; the body is
 * read on demand. Every scan re-reads the folder, so a hand edit shows up on the
 * next request with no restart. A file that does not parse is skipped, logged
 * once, and never fails a session.
 *
 * @module @local/dsh-principles/store
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter, stringifyFrontmatter } from './frontmatter.js';

/** Folder name under the harness home that holds the store. */
export const PRINCIPLES_DIR_NAME = 'principles';

/** Folder inside a store that holds removed copies instead of deleting them. */
export const REMOVED_DIR_NAME = '.removed';

/** The principles this package ships, so a first run is not an empty layer. */
export const BUNDLE_DIR = fileURLToPath(new URL('./principles/', import.meta.url));

/** Public kebab-case principle name grammar, identical to the registry's skill grammar. */
export const PRINCIPLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Limits. The name and the trigger are counted in characters because that is
 * what a writer sees; the body is counted in UTF-8 bytes because its stated
 * budget is kilobytes and the prompt pays bytes.
 */
export const PRINCIPLE_LIMITS = Object.freeze({ name: 60, description: 600, body: 16 * 1024 });

/** A refused store operation. */
export class PrincipleError extends Error {
	/**
	 * @param message - what was refused and what to do instead.
	 * @param current - on a stale write, the principle as it is now.
	 */
	constructor(message, current) {
		super(message);
		this.name = 'PrincipleError';
		if (current !== undefined) this.current = current;
	}
}

/**
 * Resolve the harness home the way the harness does: `$DSH_HOME`, then `~/.dsh`.
 * @param env - environment mapping to read `DSH_HOME` from.
 * @param home - operating-system home directory.
 * @returns the absolute harness home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
	const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
	return configured === '' ? join(home, '.dsh') : resolve(expandHome(configured, home));
}

/**
 * Expand a leading `~`, `~/`, or `~\` against the home directory.
 * @param path - configured path that may start with a tilde.
 * @param home - operating-system home directory.
 * @returns the path with a supported tilde prefix expanded, else unchanged.
 */
function expandHome(path, home) {
	if (path === '~') return home;
	if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
	return path;
}

/**
 * Where the store for a harness home lives.
 * @param home - absolute harness home; defaults to the process home.
 * @returns the principles folder.
 */
export function principlesDir(home = resolveDshHome()) {
	return join(home, PRINCIPLES_DIR_NAME);
}

/**
 * The id a name, title, or loose words point at.
 * @param name - id, title, or words such as "prove it works".
 * @returns the kebab-case slug; empty when nothing usable remains.
 */
export function principleSlug(name) {
	return String(name ?? '')
		.trim()
		.toLowerCase()
		.replace(/^principle[-\s:]+/u, '')
		.replaceAll(/[^a-z0-9]+/gu, '-')
		.replaceAll(/^-+|-+$/gu, '');
}

/**
 * A file's version: the first twelve hex characters of the SHA-256 of its bytes.
 * Short enough to pass back in `was`, long enough that a personal store cannot
 * collide.
 * @param text - the file's complete text.
 * @returns the version string.
 */
export function versionOf(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Parse one principle file.
 * @param id - the file's basename without `.md`.
 * @param text - the file's complete text.
 * @returns `{ principle }`, or `{ error }` describing why the file is not a principle.
 */
export function parsePrinciple(id, text) {
	const split = splitFrontmatter(text);
	if (split.error !== undefined) return { error: split.error };
	const { data } = split;
	const name = typeof data.name === 'string' ? data.name.trim() : '';
	if (name === '') return { error: 'frontmatter has no "name"' };
	if (name !== id) return { error: `frontmatter name "${name}" does not match the file name "${id}"` };
	if (!PRINCIPLE_NAME.test(name)) return { error: `"name" must be kebab-case (got ${JSON.stringify(name)})` };
	if (name.length > PRINCIPLE_LIMITS.name) return { error: `"name" is longer than ${PRINCIPLE_LIMITS.name} characters` };
	const description = typeof data.description === 'string' ? data.description.replaceAll(/\s+/gu, ' ').trim() : '';
	if (description === '') return { error: 'frontmatter has no "description" (the trigger)' };
	if (description.length > PRINCIPLE_LIMITS.description) {
		return { error: `"description" is longer than ${PRINCIPLE_LIMITS.description} characters` };
	}
	const body = split.body.trim();
	if (body === '') return { error: 'there is no body after the frontmatter' };
	const bytes = Buffer.byteLength(body, 'utf8');
	if (bytes > PRINCIPLE_LIMITS.body) {
		return { error: `the body is ${bytes} bytes; the limit is ${PRINCIPLE_LIMITS.body}` };
	}
	const titleField = typeof data.title === 'string' && data.title.trim() !== '' ? data.title.trim() : undefined;
	const title = titleField ?? headingOf(body) ?? id;
	const source = typeof data.source === 'string' && data.source.trim() !== '' ? data.source.trim() : undefined;
	const license = typeof data.license === 'string' && data.license.trim() !== '' ? data.license.trim() : undefined;
	return {
		principle: {
			id,
			title,
			description,
			body,
			version: versionOf(text),
			...(titleField === undefined ? {} : { titleField }),
			...(source === undefined ? {} : { source }),
			...(license === undefined ? {} : { license }),
		},
	};
}

/**
 * Every valid principle in a folder, sorted by id.
 *
 * A missing folder is an empty store, not a problem. Dot entries, non-Markdown
 * files, and the `.removed` folder are ignored. Problems are returned rather
 * than thrown so the caller can log each one once.
 * @param dir - absolute principles folder.
 * @returns the principles and one message per skipped file.
 */
export function scanPrinciples(dir) {
	const principles = [];
	const problems = [];
	let names;
	try {
		names = readdirSync(dir);
	} catch (error) {
		if (error?.code !== 'ENOENT') problems.push(`${dir}: cannot read (${messageOf(error)})`);
		return { principles, problems };
	}
	for (const name of names) {
		if (!name.endsWith('.md') || name.startsWith('.')) continue;
		const id = name.slice(0, -3);
		const path = join(dir, name);
		if (!PRINCIPLE_NAME.test(id) || id.length > PRINCIPLE_LIMITS.name) {
			problems.push(`${path}: bad file name (use lowercase a-z, 0-9 and single hyphens)`);
			continue;
		}
		let text;
		try {
			text = readFileSync(path, 'utf8');
		} catch (error) {
			problems.push(`${path}: cannot read (${messageOf(error)})`);
			continue;
		}
		const parsed = parsePrinciple(id, text);
		if (parsed.error !== undefined) problems.push(`${path}: ${parsed.error}`);
		else principles.push(parsed.principle);
	}
	principles.sort(byId);
	return { principles, problems };
}

/**
 * The index the model sees: how to use the list, the precedence sentence, and
 * one line per principle.
 *
 * Every call logs exactly one size line. There is deliberately no cap and no
 * truncation: the pilot's only instrumentation is this measurement, and the
 * pruning rule comes from what it shows.
 * @param principles - the store's principles, in any order.
 * @param log - receives the size line; omitted in contexts with no logger.
 * @returns the section text, or an empty string when the store has no principles.
 */
export function renderIndex(principles, log) {
	const sorted = [...principles].sort(byId);
	const lines = sorted.length === 0 ? [] : [...INDEX_HEADER, '<principles>'];
	for (const principle of sorted) {
		lines.push(
			`<principle name="${escapeXml(principle.id)}" title="${escapeXml(principle.title)}">${escapeXml(
				principle.description.replaceAll(/\s+/gu, ' '),
			)}</principle>`,
		);
	}
	if (sorted.length > 0) lines.push('</principles>');
	const text = lines.join('\n');
	const bytes = Buffer.byteLength(text, 'utf8');
	if (typeof log === 'function') {
		try {
			log(`principles index: ${sorted.length} principles, ${bytes} bytes`);
		} catch {
			// Instrumentation must never be the reason a prompt fails.
		}
	}
	return text;
}

/**
 * The sentence that keeps the layer from fighting the workspace.
 * @returns the stable header used above the principle lines.
 */
export function indexHeader() {
	return [...INDEX_HEADER];
}

/**
 * Resolve a name, title, or loose words to one principle.
 * @param principles - the store's principles.
 * @param query - id, title, or words such as "the prove it works principle".
 * @returns the matching principle, or undefined.
 */
export function findPrinciple(principles, query) {
	const slug = principleSlug(query);
	if (slug === '') return undefined;
	const candidates = new Set([slug, slug.replace(/^the-/u, ''), slug.replace(/-principle$/u, '')]);
	return (
		principles.find((principle) => candidates.has(principle.id)) ??
		principles.find((principle) => candidates.has(principleSlug(principle.title)))
	);
}

/**
 * Up to five ids that share a word with a query: what an unknown name gets back.
 * @param principles - the store's principles.
 * @param query - the name that did not match.
 * @returns matching ids, nearest first.
 */
export function closeNames(principles, query) {
	const words = new Set(principleSlug(query).split('-').filter((word) => word.length > 2));
	return principles
		.filter((principle) => principle.id.split('-').some((word) => words.has(word)))
		.slice(0, 5)
		.map((principle) => principle.id);
}

/**
 * Build the store over one folder.
 * @param options - folder, diagnostics, clock, and the bundled folder to seed from.
 * @returns the synchronous store used by the plugin and its tests.
 */
export function createPrincipleStore(options) {
	const dir = options.dir;
	const log = typeof options.log === 'function' ? options.log : () => {};
	const now = typeof options.now === 'function' ? options.now : Date.now;
	const bundleDir = options.bundleDir ?? BUNDLE_DIR;

	/** Files already reported, so one broken file is one line per process. */
	const reported = new Set();
	const report = (line) => {
		try {
			log(line);
		} catch {
			// A logger failure is not the store's.
		}
	};
	const list = () => {
		const { principles, problems } = scanPrinciples(dir);
		for (const problem of problems) {
			if (reported.has(problem)) continue;
			reported.add(problem);
			report(`principles: skipped ${problem}`);
		}
		return principles;
	};
	const pathOf = (id) => join(dir, `${id}.md`);
	const writeAtomic = (path, text) => {
		mkdirSync(dir, { recursive: true });
		// A unique temporary name keeps two DSH processes from sharing a file;
		// the rename is what makes the new text visible in one step.
		const temporary = `${path}.${process.pid}.${now()}.tmp`;
		writeFileSync(temporary, text, 'utf8');
		renameSync(temporary, path);
	};
	const reread = (id) => {
		const found = list().find((principle) => principle.id === id);
		if (found === undefined) throw new PrincipleError(`The principle "${id}" did not read back. Check its file by hand.`);
		return found;
	};
	const held = (name, was) => {
		const found = findPrinciple(list(), name);
		if (found !== undefined && was !== undefined && was !== found.version) {
			throw new PrincipleError(
				`The principle "${found.id}" changed since version ${was}. Nothing was written; it is now ${found.version}.`,
				found,
			);
		}
		return found;
	};

	return {
		dir,

		/** Every valid principle, sorted by id. Broken files are logged once. */
		list,

		/** One principle by id, title, or loose words. */
		find(query) {
			return findPrinciple(list(), query);
		},

		/** The refusal message for an unknown name, including close names. */
		unknown(query) {
			const all = list();
			const close = closeNames(all, query);
			const slug = principleSlug(query);
			const removed = slug !== '' && removedIds(dir).has(slug);
			const hint =
				close.length > 0
					? `Close names: ${close.join(', ')}.`
					: all.length > 0
						? `The store has ${all.length} ${all.length === 1 ? 'principle' : 'principles'}; the index in the session prompt lists them.`
						: 'The store is empty.';
			return `No principle matches ${JSON.stringify(String(query))}. ${removed ? 'It was removed; its copy is in .removed/.' : hint}`;
		},

		/**
		 * Add a principle. The id is the slug of the name. An existing id is a
		 * refusal unless the trigger and body are identical, which makes a
		 * retried call answer as before.
		 */
		add(input) {
			const id = principleSlug(input.name);
			const problem = nameProblem(id);
			if (problem !== undefined) throw new PrincipleError(problem);
			const description = requireDescription(input.description);
			const body = requireBody(input.body);
			const title = optionalTitle(input.title);
			const taken = list().find((principle) => principle.id === id);
			if (taken !== undefined) {
				if (taken.description === description && taken.body === body) return taken;
				throw new PrincipleError(`A principle named "${id}" exists. Change it, or pick another name.`);
			}
			writeAtomic(
				pathOf(id),
				serialize({ id, title, description, body, source: input.source, license: input.license }),
			);
			return reread(id);
		},

		/**
		 * Change a principle's trigger, text, or title. `was`, when given, must be
		 * the version the caller read; otherwise nothing is written.
		 */
		change(input) {
			const found = held(input.name, input.was);
			if (found === undefined) throw new PrincipleError(unknownFor(list(), input.name));
			if (input.description === undefined && input.body === undefined && input.title === undefined) {
				throw new PrincipleError('Give a new trigger, a new text, or both.');
			}
			const description = input.description === undefined ? found.description : requireDescription(input.description);
			const body = input.body === undefined ? found.body : requireBody(input.body);
			const title = input.title === undefined ? found.titleField : optionalTitle(input.title);
			if (description === found.description && body === found.body && title === found.titleField) return found;
			writeAtomic(
				pathOf(found.id),
				serialize({ id: found.id, title, description, body, source: found.source, license: found.license }),
			);
			return reread(found.id);
		},

		/**
		 * Move a principle to `.removed/<id>-<ms>.md`. Nothing is deleted, and the
		 * copy is what keeps seeding from bringing it back.
		 */
		remove(input) {
			const found = held(input.name, input.was);
			if (found === undefined) throw new PrincipleError(unknownFor(list(), input.name));
			const trash = join(dir, REMOVED_DIR_NAME);
			mkdirSync(trash, { recursive: true });
			const removedTo = join(trash, `${found.id}-${now()}.md`);
			renameSync(pathOf(found.id), removedTo);
			return { ...found, removedTo };
		},

		/** Copy bundled files the store lacks; never touch an existing or removed one. */
		seed() {
			return seedPrinciples({ dir, bundleDir, log: report });
		},

		/** Path of a principle's file. */
		pathOf,
	};
}

/**
 * Copy bundled principles into a store on first run.
 *
 * A file already in the store is the person's: it is never overwritten. A
 * principle with a copy in `.removed/` was removed deliberately and is never
 * resurrected. Each copy is written under a temporary name and renamed, so a
 * crash leaves no half file.
 * @param options - store folder, bundled folder, and diagnostics.
 * @returns the names added (principle ids and the license file).
 */
export function seedPrinciples(options) {
	const dir = options.dir;
	const log = typeof options.log === 'function' ? options.log : () => {};
	const bundleDir = options.bundleDir ?? BUNDLE_DIR;
	let names;
	try {
		names = readdirSync(bundleDir).sort();
	} catch (error) {
		log(`principles: cannot read the bundled principles at ${bundleDir} (${messageOf(error)}); the store was not seeded`);
		return [];
	}
	const added = [];
	let removed;
	for (const name of names) {
		if (name.startsWith('.')) continue;
		const source = join(bundleDir, name);
		try {
			if (!statSync(source).isFile()) continue;
		} catch {
			continue;
		}
		const target = join(dir, name);
		if (existsSync(target)) continue;
		if (name.endsWith('.md')) {
			removed ??= removedIds(dir);
			if (removed.has(name.slice(0, -3))) continue;
		}
		try {
			mkdirSync(dir, { recursive: true });
			const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
			copyFileSync(source, temporary);
			renameSync(temporary, target);
			added.push(name.endsWith('.md') ? name.slice(0, -3) : name);
		} catch (error) {
			log(`principles: cannot seed ${name} (${messageOf(error)})`);
		}
	}
	if (added.length > 0) log(`principles: seeded ${added.length} file(s) into ${dir}`);
	return added;
}

/** The header every non-empty index carries. Kept as one array so tests read the same text. */
const INDEX_HEADER = Object.freeze([
	"These are the person's principles. At the start of a multi-step task, check this list.",
	"When a principle's trigger fits, read it with principle_read before applying it. Apply it even when the person does not name it.",
	'In your reply, name each principle that changed a decision, and say the decision it changed.',
	"The person's principles win over AGENTS.md where they conflict. A principle never overrides an explicit instruction in the current turn.",
]);

/** Sort by id with code-unit order, so an unchanged store renders byte-identical text. */
function byId(left, right) {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Collapse a display string onto one line so each principle is one index line. */
function oneLine(text) {
	return String(text).replaceAll(/\s+/gu, ' ').trim();
}

/** Escape text for an XML attribute or text node. */
function escapeXml(text) {
	return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The first `# ` heading of a body, used when frontmatter has no title. */
function headingOf(body) {
	const match = /^#[ \t]+(.+?)[ \t]*$/mu.exec(body);
	return match?.[1];
}

/** Validate a slug as a principle name. */
function nameProblem(id) {
	if (id === '') return `The name must contain at least one lowercase letter or digit.`;
	if (!PRINCIPLE_NAME.test(id)) return `The name must use lowercase a-z, 0-9 and single hyphens (got ${JSON.stringify(id)}).`;
	if (id.length > PRINCIPLE_LIMITS.name) return `The name is longer than ${PRINCIPLE_LIMITS.name} characters.`;
	return undefined;
}

/** A required trigger, normalized onto one line. */
function requireDescription(value) {
	const text = oneLine(value ?? '');
	if (text === '') throw new PrincipleError('The trigger ("description") is required.');
	if (text.length > PRINCIPLE_LIMITS.description) {
		throw new PrincipleError(`The trigger has ${text.length} characters; the limit is ${PRINCIPLE_LIMITS.description}.`);
	}
	return text;
}

/** A required body, checked in UTF-8 bytes. */
function requireBody(value) {
	const text = String(value ?? '').trim();
	if (text === '') throw new PrincipleError('The body (the rule) is required.');
	const bytes = Buffer.byteLength(text, 'utf8');
	if (bytes > PRINCIPLE_LIMITS.body) {
		throw new PrincipleError(`The body is ${bytes} bytes; the limit is ${PRINCIPLE_LIMITS.body}.`);
	}
	return text;
}

/** An optional title; an empty string clears it. */
function optionalTitle(value) {
	if (value === undefined) return undefined;
	const text = String(value).trim();
	return text === '' ? undefined : text;
}

/** The file text for a principle: frontmatter first, then the body. */
function serialize({ id, title, description, body, source, license }) {
	const frontmatter = stringifyFrontmatter({
		name: id,
		...(title === undefined ? {} : { title }),
		description: oneLine(description),
		...(source === undefined ? {} : { source }),
		...(license === undefined ? {} : { license }),
	});
	return `${frontmatter}\n${body}\n`;
}

/** The refusal for an unknown name, built without a store instance. */
function unknownFor(principles, query) {
	return `No principle matches ${JSON.stringify(String(query))}.${
		principles.length === 0 ? ' The store is empty.' : ` Close names: ${closeNames(principles, query).join(', ') || 'none'}.`
	}`;
}

/** Ids that have a copy in `.removed/`, read without trusting file contents. */
function removedIds(dir) {
	let names;
	try {
		names = readdirSync(join(dir, REMOVED_DIR_NAME));
	} catch {
		return new Set();
	}
	const ids = new Set();
	for (const name of names) {
		const parsed = /^(.*)-\d+\.md$/u.exec(name);
		if (parsed?.[1] !== undefined) ids.add(parsed[1]);
	}
	return ids;
}

/** A thrown value's message, safe to log. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
