/**
 * MOV Skills — personal agent skills packaged as a DSH plugin.
 *
 * The provider registers on the skill registry (`ctx.skills`) and serves every
 * skill bundle under `skills/`: a flat `<name>/SKILL.md`, a flat `<name>.md`,
 * or one level down inside a group folder, `<group>/<name>/SKILL.md`. A skill
 * added, edited, or removed while the harness runs reaches the next session
 * catalog on its own: the provider polls the folder for catalog-relevant
 * changes and invalidates the registry, and skill bodies are re-read on every
 * load.
 *
 * @module @local/mov-skills
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/** Folder scanned for skills; it ships inside the package so it travels with it. */
export const SKILLS_DIR = fileURLToPath(new URL('./skills/', import.meta.url));

/** Provider label used by skill tooling and the registry. */
export const PROVIDER_NAME = 'mov-skills';

/** Packaged skills rank behind project, custom, and user skills (600 = bundled). */
const RANK = 600;

/** How often the folder is re-read for added, edited, or removed skills. */
const POLL_INTERVAL_MS = 1000;

/** Public kebab-case skill-name grammar, identical to the registry's. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TRUE_VALUES = new Set(['true', 'yes', 'on', '1']);
const FALSE_VALUES = new Set(['false', 'no', 'off', '0']);

/** Cordis plugin name. */
export const name = 'mov-skills';

/** The skill registry this provider registers itself on. */
export const inject = ['skills'];

/**
 * Register the provider and keep its catalog in step with the skills folder.
 * @param ctx - Cordis context carrying the `skills` service and logger.
 */
export function apply(ctx) {
	let invalidate = () => {};
	ctx.skills.registerProvider((control) => {
		invalidate = control.invalidate;
		return {
			name: PROVIDER_NAME,
			list: () => listSkills(ctx),
			get: (candidate) => loadSkill(candidate, ctx),
		};
	});
	ctx.effect(() => watchSkills(() => invalidate()), 'mov-skills catalog watcher');
}

/**
 * List every valid skill in the folder, including one level of group folders.
 * @param ctx - context used for diagnostics.
 * @returns candidates sorted by name; unreadable or invalid entries are skipped.
 */
export async function listSkills(ctx) {
	const candidates = [];
	const seen = new Set();
	for (const { file } of await discoverSkillFiles()) {
		const kind = basename(file) === 'SKILL.md' ? 'directory' : 'file';
		const skill = await readSkill(file, kind, ctx);
		if (skill === undefined || seen.has(skill.candidate.name)) continue;
		seen.add(skill.candidate.name);
		candidates.push(skill.candidate);
	}
	return candidates.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Find every skill instruction file under the skills folder.
 *
 * A top-level directory with `SKILL.md` is a skill; one without it is a group,
 * and its direct children are scanned for skill bundles. Flat `<name>.md` files
 * at the top level are skills; dot-prefixed entries are ignored everywhere.
 *
 * @returns instruction files with the bundle name and absolute path.
 */
export async function discoverSkillFiles() {
	const found = [];
	let entries;
	try {
		entries = await readdir(SKILLS_DIR, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const kind = await entryKind(SKILLS_DIR, entry);
		if (kind === undefined) continue;
		const entryPath = join(SKILLS_DIR, entry.name);
		if (kind === 'file') {
			found.push({ name: entry.name.slice(0, -3), file: entryPath });
			continue;
		}
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

/**
 * Load one skill body for a candidate this provider listed earlier.
 * @param candidate - candidate returned by {@link listSkills}.
 * @param ctx - context used for diagnostics.
 * @returns the full definition, or undefined when the skill is no longer loadable.
 */
async function loadSkill(candidate, ctx) {
	const { file, kind } = candidate.locator;
	const skill = await readSkill(file, kind, ctx);
	if (skill === undefined || skill.candidate.name !== candidate.name) return undefined;
	return {
		name: skill.candidate.name,
		description: skill.candidate.description,
		...(skill.candidate.whenToUse === undefined ? {} : { whenToUse: skill.candidate.whenToUse }),
		invocation: skill.candidate.invocation,
		provider: PROVIDER_NAME,
		source: 'bundled',
		resourceBase: skill.candidate.resourceBase,
		path: file,
		...(skill.candidate.metadata === undefined ? {} : { metadata: skill.candidate.metadata }),
		content: skill.body,
	};
}

/**
 * Read and validate one skill file.
 * @param file - absolute SKILL.md (or flat `<name>.md`) path.
 * @param kind - whether the file lives in its own folder bundle or flat in the root.
 * @param ctx - context used for diagnostics.
 * @returns candidate plus its body, or undefined when the file is missing or invalid.
 */
async function readSkill(file, kind, ctx) {
	let raw;
	try {
		raw = await readFile(file, 'utf8');
	} catch (error) {
		if (error?.code !== 'ENOENT') ctx.logger?.warn?.(`mov-skills: cannot read ${file}: ${errorMessage(error)}`);
		return undefined;
	}
	const frontmatter = splitFrontmatter(raw);
	if (frontmatter === undefined) {
		ctx.logger?.warn?.(`mov-skills: ${file} ignored: missing or invalid YAML frontmatter`);
		return undefined;
	}
	const { data, body } = frontmatter;
	const skillName = typeof data.name === 'string' ? data.name.trim() : '';
	if (!SKILL_NAME.test(skillName)) {
		ctx.logger?.warn?.(`mov-skills: ${file} ignored: "name" must be kebab-case (got ${JSON.stringify(data.name)})`);
		return undefined;
	}
	const description = typeof data.description === 'string' ? data.description.trim() : '';
	if (description === '') {
		ctx.logger?.warn?.(`mov-skills: ${file} ignored: "description" is required`);
		return undefined;
	}
	const invocation = readInvocation(data);
	if (invocation === undefined) {
		ctx.logger?.warn?.(
			`mov-skills: ${file} ignored: "disable-model-invocation" and "user-invocable" accept only true/false`,
		);
		return undefined;
	}
	const whenToUse = typeof data.whenToUse === 'string' && data.whenToUse.trim() !== '' ? data.whenToUse.trim() : undefined;
	const metadata =
		data.metadata !== null && typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? data.metadata : undefined;
	return {
		body,
		candidate: {
			name: skillName,
			description,
			...(whenToUse === undefined ? {} : { whenToUse }),
			invocation,
			provider: PROVIDER_NAME,
			source: 'bundled',
			resourceBase: { kind: 'directory', path: kind === 'directory' ? dirname(file) : SKILLS_DIR },
			rank: RANK,
			path: file,
			locator: { file, kind },
			...(metadata === undefined ? {} : { metadata }),
		},
	};
}

/**
 * Split YAML frontmatter from the Markdown body.
 * @param raw - complete file text.
 * @returns parsed frontmatter mapping and body, or undefined when absent or malformed.
 */
export function splitFrontmatter(raw) {
	const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
	if ((lines[0] ?? '').trim() !== '---') return undefined;
	let closing = -1;
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (line === '---' || line === '...') {
			closing = index;
			break;
		}
	}
	if (closing < 0) return undefined;
	let data;
	try {
		data = parseYaml(lines.slice(1, closing).join('\n'));
	} catch {
		return undefined;
	}
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
	return { data, body: lines.slice(closing + 1).join('\n').replace(/^\n+/, '') };
}

/**
 * Resolve invocation policy from optional frontmatter keys.
 * @param data - parsed frontmatter mapping.
 * @returns resolved policy, or undefined when a key carries a non-boolean value.
 */
function readInvocation(data) {
	const modelDisabled = readBoolean(data['disable-model-invocation']);
	if (modelDisabled === null) return undefined;
	const userInvocable = readBoolean(data['user-invocable']);
	if (userInvocable === null) return undefined;
	return {
		modelInvocable: modelDisabled === undefined ? true : !modelDisabled,
		userInvocable: userInvocable === undefined ? true : userInvocable,
	};
}

/**
 * Read a strict boolean from a frontmatter value.
 * @param value - raw YAML value.
 * @returns undefined when absent, null when malformed, otherwise the boolean.
 */
function readBoolean(value) {
	if (value === undefined) return undefined;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (TRUE_VALUES.has(normalized)) return true;
		if (FALSE_VALUES.has(normalized)) return false;
	}
	return null;
}

/**
 * Classify a direct entry of the skills folder.
 * @param root - folder the entry was read from.
 * @param entry - directory entry.
 * @returns 'directory' for a skill bundle, 'file' for a flat Markdown skill, else undefined.
 */
async function entryKind(root, entry) {
	if (entry.name.startsWith('.')) return undefined;
	if (entry.isDirectory()) return 'directory';
	if (entry.isFile()) return entry.name.endsWith('.md') ? 'file' : undefined;
	if (entry.isSymbolicLink()) {
		try {
			const target = await stat(join(root, entry.name));
			if (target.isDirectory()) return 'directory';
			if (target.isFile() && entry.name.endsWith('.md')) return 'file';
		} catch {
			return undefined;
		}
	}
	return undefined;
}

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
 * Watch the folder for catalog-relevant changes and invalidate the registry.
 * Polling keeps behavior identical on every platform and recovers when the
 * folder is created or deleted later.
 * @param onChanged - invalidates the provider registration's cached catalogs.
 * @returns disposer stopping the watch.
 */
export function watchSkills(onChanged) {
	let signature;
	let busy = false;
	const timer = setInterval(() => {
		if (busy) return;
		busy = true;
		void catalogSignature()
			.then((next) => {
				if (signature !== undefined && next !== signature) onChanged();
				signature = next;
			})
			.finally(() => {
				busy = false;
			});
	}, POLL_INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/**
 * Compose a cheap fingerprint of the catalog-relevant files.
 * @returns sorted `file:mtime:size` records; a missing folder yields an empty string.
 */
async function catalogSignature() {
	const parts = [];
	for (const { file } of await discoverSkillFiles()) {
		try {
			const info = await stat(file);
			parts.push(`${file}:${info.mtimeMs}:${info.size}`);
		} catch {
			// A bundle without a readable SKILL.md contributes no candidate.
		}
	}
	return parts.sort().join('|');
}

/**
 * Render an error's message safely.
 * @param error - thrown value of unknown shape.
 * @returns its message, or its string form.
 */
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
