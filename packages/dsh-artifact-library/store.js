/**
 * The artifact Library's durable registry, snapshots and readers.
 *
 * The store owns one small JSON document per profile. It records collections
 * (topics), artifacts (readable files) and expected outputs, plus a bounded
 * local snapshot of each readable text artifact. A snapshot is a deliverable,
 * not a copy of a whole tree: when the original is deleted, the snapshot
 * keeps the text readable.
 *
 * Reads are safe. Every read re-resolves the original path through the
 * filesystem (following symlinks), re-checks the resolved path against the
 * resolved approved roots, and reads at most `MAX_READ_BYTES` bytes. The
 * snapshot is read from the registry document itself, never from a path a
 * caller names.
 *
 * @module @local/dsh-artifact-library/store
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
	isContainedIn,
	isWithinApprovedRoots,
	realPath,
} from './security.js';

/** Schema version of the registry document. */
export const SCHEMA_VERSION = 1;

/** The snapshot cap for Markdown / text artifacts. */
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

/**
 * The snapshot cap for HTML artifacts. The curated reports (e.g. the inbox
 * review, ~563 KB each) live below this; anything larger is reported as
 * unsupported rather than silently truncated.
 */
export const MAX_HTML_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** The hard ceiling: a file bigger than this is never read whole. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * The DSH home directory this store reads and writes under.
 * @returns the DSH home.
 */
export function dshHome() {
	return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
		? process.env.DSH_HOME
		: join(homedir(), '.dsh');
}

/**
 * The profile this Host serves, taken from the launch arguments. Scoping the
 * store by profile keeps one profile's Library from another's.
 * @param {string[]} [argv] - the Host's argument list.
 * @returns the profile name, or undefined when the Host was launched without one.
 */
export function activeProfile(argv = process.argv) {
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--profile' && typeof argv[index + 1] === 'string' && argv[index + 1] !== '') return argv[index + 1];
		if (typeof argument === 'string' && argument.startsWith('--profile=')) {
			const value = argument.slice('--profile='.length);
			if (value !== '') return value;
		}
	}
	return undefined;
}

/** A filesystem-safe file stem for one profile name. */
function profileStem(profile) {
	const stem = profile.replace(/[^A-Za-z0-9._-]/g, '_');
	return stem === '' || stem === '.' || stem === '..' ? 'profile' : stem;
}

/**
 * The store file's path, scoped by profile when the row did not point it
 * elsewhere.
 * @param {object} [config] - bundle row configuration.
 * @param {object} [options] - launch arguments to scope by.
 * @returns the absolute path.
 */
export function scopedStoreFilePath(config = {}, options = {}) {
	if (typeof config.storeFile === 'string' && config.storeFile !== '') return config.storeFile;
	const file = activeProfile(options.argv ?? process.argv);
	const name = file === undefined ? 'registry.json' : `registry-${profileStem(file)}.json`;
	return join(dshHome(), 'artifact-library', name);
}

/**
 * Read the registry document from disk.
 *
 * A missing file is the only case that starts fresh: the first write creates
 * it. Every other read or parse failure is visible, because treating a
 * malformed or unreadable file as empty would reseed over the user's pins and
 * registered deliverables.
 *
 * @param {string} file - the registry path.
 * @returns the document, or a fresh one only when the file does not exist.
 */
export function readRegistry(file) {
	let raw;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') return freshRegistry();
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`artifactLibrary: registry ${file} is not valid JSON`, { cause: error });
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.collections)) {
		throw new Error(`artifactLibrary: registry ${file} is malformed`);
	}
	if (parsed.approvedRoots !== undefined && !Array.isArray(parsed.approvedRoots)) {
		throw new Error(`artifactLibrary: registry ${file} has malformed approvedRoots`);
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		approvedRoots: Array.isArray(parsed.approvedRoots) ? parsed.approvedRoots : [],
		collections: parsed.collections,
	};
}

/**
 * Persist the registry atomically. The write must succeed before the caller
 * commits its in-memory state; a failed write throws and leaves the previous
 * file intact. The state directory is private (0700) and the document is
 * private (0600).
 * @param {string} file - the registry path.
 * @param {object} registry - the document to persist.
 * @returns true when the document reached disk.
 */
export function writeRegistry(file, registry) {
	if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
		throw new Error(`artifactLibrary: registry ${file} is not an object`);
	}
	const directory = dirname(file);
	const temporary = `${file}.tmp`;
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		if (directory !== '.' && directory !== '/') chmodSync(directory, 0o700);
		writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, file);
		return true;
	} catch (error) {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// A directory or other non-file blocker stays visible to the caller.
		}
		throw new Error(`artifactLibrary: registry ${file} could not be written`, { cause: error });
	}
}

/**
 * A content hash over a string, used to dedupe identical snapshots and to
 * detect a changed original.
 * @param {string} text - the content.
 * @returns a short hex digest.
 */
export function hashText(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/**
 * The resolved (real) form of an approved root. Roots are resolved once and
 * reused for every containment check, so a root that is itself a symlink is
 * handled at the root, not at every artifact.
 * @param {string} root - the root as registered.
 * @returns the real path, or the lexical form when it cannot be resolved.
 */
export function resolveRoot(root) {
	return realPath(root) ?? root;
}

/**
 * Read a text file up to `maxBytes` bytes. The bound is enforced before any
 * read: a file whose size exceeds the cap is refused, so the registry never
 * loads an unbounded original into memory.
 * @param {string} path - the file path (already real).
 * @param {number} [maxBytes] - the cap.
 * @returns the text, or null when missing, too large or unreadable.
 */
export function readTextFileBounded(path, maxBytes = MAX_READ_BYTES) {
	try {
		if (typeof path !== 'string' || path === '') return null;
		const stats = statSync(path);
		if (!stats.isFile()) return null;
		if (stats.size > maxBytes) return null;
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Whether a registered original is still present and readable.
 * @param {string} path - the original path (already real).
 * @returns true when it exists and is a regular file.
 */
export function originalAvailable(path) {
	try {
		if (typeof path !== 'string' || path === '') return false;
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * The availability of one artifact's current revision.
 * @param {string} originalPath - the registered original.
 * @param {boolean} hasSnapshot - whether a snapshot exists.
 * @returns 'original' when readable, 'snapshot' when only the snapshot
 * survives, 'missing' otherwise.
 */
export function availability(originalPath, hasSnapshot) {
	if (originalAvailable(originalPath)) return 'original';
	if (hasSnapshot) return 'snapshot';
	return 'missing';
}

/**
 * The snapshot cap that applies to one artifact, by kind/format.
 * @param {object} artifact - the artifact record.
 * @returns the byte cap for its snapshot.
 */
export function snapshotCap(artifact) {
	const name = typeof artifact?.path === 'string' ? artifact.path.toLowerCase() : '';
	const isHtml = artifact?.format === 'html' || name.endsWith('.html') || name.endsWith('.htm');
	return isHtml ? MAX_HTML_SNAPSHOT_BYTES : MAX_SNAPSHOT_BYTES;
}

/**
 * Read the current content of one artifact.
 *
 * Resolution order: the original, when still present, its real path inside
 * the approved roots and it within the read bound; otherwise the saved
 * snapshot, when one exists. The original is never read from a path a caller
 * names directly: it is the path registered for the artifact, resolved and
 * re-checked against the approved roots.
 *
 * @param {string} originalPath - the registered original path.
 * @param {string} [snapshot] - the saved snapshot text.
 * @param {string[]} roots - approved roots, already real.
 * @param {number} [maxBytes] - the read cap.
 * @returns `{ text, source }` where source is 'original', 'snapshot' or
 * 'missing'.
 */
export function readArtifact(originalPath, snapshot, roots, maxBytes = MAX_READ_BYTES) {
	const real = realPath(originalPath);
	if (real !== null && isWithinApprovedRoots(real, roots)) {
		const text = readTextFileBounded(real, maxBytes);
		if (text !== null) return { text, source: 'original' };
	}
	if (typeof snapshot === 'string') return { text: snapshot, source: 'snapshot' };
	return { text: null, source: 'missing' };
}

/**
 * A fresh empty registry.
 * @returns the document.
 */
export function freshRegistry() {
	return { schemaVersion: SCHEMA_VERSION, approvedRoots: [], collections: [] };
}

/**
 * Index one collection's artifacts by id for fast lookup.
 * @param {object} collection - a collection document.
 * @returns a map of artifact id to artifact record.
 */
export function artifactIndex(collection) {
	const byId = new Map();
	if (collection && Array.isArray(collection.artifacts)) {
		for (const artifact of collection.artifacts) {
			if (artifact && typeof artifact.id === 'string' && !byId.has(artifact.id)) byId.set(artifact.id, artifact);
		}
	}
	return byId;
}

/**
 * The list of artifact ids in a collection, in display order.
 * @param {object} collection - a collection document.
 * @returns an array of artifact ids.
 */
export function artifactIds(collection) {
	if (!collection || !Array.isArray(collection.artifacts)) return [];
	return collection.artifacts.map((artifact) => artifact && artifact.id).filter((id) => typeof id === 'string');
}

/**
 * The list of expected-output records in a collection.
 * @param {object} collection - a collection document.
 * @returns the expected outputs.
 */
export function expectedOutputs(collection) {
	if (!collection || !Array.isArray(collection.expectedOutputs)) return [];
	return collection.expectedOutputs;
}

/**
 * Find a collection by id, case-insensitively.
 * @param {object} registry - the document.
 * @param {string} id - the collection id.
 * @returns the collection or null.
 */
export function findCollection(registry, id) {
	if (!registry || !Array.isArray(registry.collections) || typeof id !== 'string') return null;
	const needle = id.toLowerCase();
	for (const collection of registry.collections) {
		if (collection && typeof collection.id === 'string' && collection.id.toLowerCase() === needle) return collection;
	}
	return null;
}

/**
 * Find an artifact by id across all collections.
 * @param {object} registry - the document.
 * @param {string} id - the artifact id.
 * @returns `{ collection, artifact }` or null.
 */
export function findArtifact(registry, id) {
	if (!registry || !Array.isArray(registry.collections) || typeof id !== 'string') return null;
	const needle = id.toLowerCase();
	for (const collection of registry.collections) {
		const byId = artifactIndex(collection);
		for (const candidate of byId.values()) {
			if (candidate.id.toLowerCase() === needle) return { collection, artifact: candidate };
		}
	}
	return null;
}

/**
 * The projects named by the registry's collections, in display order.
 * @param {object} registry - the document.
 * @returns an array of project strings.
 */
export function projectList(registry) {
	if (!registry || !Array.isArray(registry.collections)) return [];
	const seen = new Set();
	const list = [];
	for (const collection of registry.collections) {
		if (collection && typeof collection.project === 'string' && collection.project !== '' && !seen.has(collection.project)) {
			seen.add(collection.project);
			list.push(collection.project);
		}
	}
	return list;
}

/**
 * Whether a registered path is readable under the approved roots, enforcing
 * the real filesystem, not the name.
 * @param {string} path - the candidate path.
 * @param {string[]} roots - approved roots, already real.
 * @returns true when the resolved path is inside an approved root and exists
 * as a regular file.
 */
export function pathAllowed(path, roots) {
	const real = realPath(path);
	if (real === null) return false;
	if (!isWithinApprovedRoots(real, roots)) return false;
	return originalAvailable(real);
}
