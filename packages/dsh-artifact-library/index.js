/**
 * Artifact Library — the Host half.
 *
 * Owns the curated registry (collections, artifacts, expected outputs), the
 * bounded text snapshots, and the safe readers the Client panel calls. The
 * `artifactLibrary` Remote namespace is the only Client entry point; it never
 * exposes a raw filesystem path and never serves a file the registry did not
 * register.
 *
 * Reads are resolved through the filesystem: a candidate path and every
 * approved root are symlink-resolved before a prefix comparison, so a link
 * that points outside a root is refused. Reads are byte-bounded before any
 * file is opened.
 *
 * State persists to one JSON document per profile under the DSH home, so the
 * Library survives a restart. A pinned flag and a registered snapshot are both
 * durable and are restored on the next boot.
 *
 * @module @local/dsh-artifact-library
 */

import { existsSync, readFileSync } from 'node:fs';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import {
	artifactIndex,
	expectedOutputs,
	findArtifact,
	findCollection,
	hashText,
	pathAllowed,
	projectList,
	readArtifact,
	readRegistry,
	resolveRoot,
	scopedStoreFilePath,
	snapshotCap,
	writeRegistry,
} from './store.js';
import { realPath } from './security.js';
import { markdownToHtml } from './render.js';

/** Cordis plugin name. */
export const name = 'artifact-library';

/** Remote namespace the Client panel calls. */
export const NAMESPACE = 'artifactLibrary';

/** Prototype key the Typert Gateway reads to discover Remote methods. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * Merge one curated seed document into the registry.
 *
 * Idempotent: a collection whose id is already present is not duplicated; an
 * artifact whose id is already present in any collection is not re-added. The
 * approved roots are unioned.
 *
 * @param {object} registry - the registry to merge into (mutated).
 * @param {object} seed - the parsed seed document.
 * @returns the number of artifacts newly added.
 */
export function applySeed(registry, seed) {
	if (!registry || !seed || !Array.isArray(seed.collections)) return 0;
	if (Array.isArray(seed.approvedRoots)) {
		for (const root of seed.approvedRoots) {
			if (typeof root === 'string' && root !== '' && !registry.approvedRoots.includes(root)) {
				registry.approvedRoots.push(root);
			}
		}
	}
	let added = 0;
	const knownArtifactIds = new Set();
	for (const collection of registry.collections) {
		for (const artifact of artifactIndex(collection).values()) {
			if (typeof artifact.id === 'string') knownArtifactIds.add(artifact.id);
		}
	}
	for (const collection of seed.collections) {
		if (!collection || typeof collection.id !== 'string') continue;
		const existing = findCollection(registry, collection.id);
		if (existing) continue;
		const cleanArtifacts = Array.isArray(collection.artifacts) ? collection.artifacts : [];
		const kept = cleanArtifacts.filter((artifact) => {
			if (!artifact || typeof artifact.id !== 'string') return false;
			if (knownArtifactIds.has(artifact.id)) return false;
			knownArtifactIds.add(artifact.id);
			return true;
		});
		registry.collections.push({
			...collection,
			artifacts: kept.map((artifact) => ({
				...artifact,
				revision: 1,
				history: [{ revision: 1, at: new Date().toISOString(), hash: null, source: 'registered' }],
			})),
			expectedOutputs: Array.isArray(collection.expectedOutputs) ? collection.expectedOutputs : [],
		});
		added += kept.length;
	}
	return added;
}

/**
 * The `artifactLibrary` Remote namespace the panel reads.
 *
 * Methods:
 * - `library()` → the registry: collections with their artifacts, expected
 *   outputs, per-artifact availability and pinned flags, plus the project
 *   list for the filter.
 * - `search({ query, project })` → artifact matches across titles.
 * - `artifact({ id })` → one artifact's document: safe HTML for its current
 *   revision, availability, origin and expected outputs.
 * - `setPinned({ collectionId | artifactId, pinned })` → pin/unpin, durable.
 * - `register({ collectionId, artifactId, title, path, kind, format,
 *   sourceSessionId })` → idempotent registration of a new deliverable
 *   (validates against the roots, takes a bounded snapshot).
 *
 * @param {object} [deps] - host dependencies.
 * @param {object} [deps.store] - the durable store.
 * @returns {typeof import('@deepseek-ai/dsh-typert-protocol').TypertRemoteService} the service class.
 */
export function libraryService(deps = {}) {
	const store = deps.store;
	const service = class ArtifactLibraryService extends TypertRemoteService {
		/**
		 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
		 */
		constructor(ctx) {
			super(ctx, NAMESPACE);
			this.ctx = ctx;
			this.store = store;
		}

		/** The current registry snapshot with per-artifact availability. */
		library() {
			const registry = this.store.registry();
			const roots = this.store.roots().map(resolveRoot);
			const collections = registry.collections.map((collection) => ({
				...collection,
				artifacts: (Array.isArray(collection.artifacts) ? collection.artifacts : []).map((artifact) => ({
					...artifact,
					availability: this.availabilityFor(artifact, roots),
				})),
			}));
			return {
				schemaVersion: registry.schemaVersion,
				collections,
				projects: projectList(registry),
			};
		}

		/** Search across artifact titles, notes and, when enabled, the saved body. */
		search(request) {
			request ??= {};
			const registry = this.store.registry();
			const query = typeof request.query === 'string' ? request.query.trim().toLowerCase() : '';
			const project = typeof request.project === 'string' ? request.project : null;
			const includeBody = request.includeBody === true;
			const roots = this.store.roots().map(resolveRoot);
			const results = [];
			for (const collection of registry.collections) {
				if (project !== null && collection.project !== project) continue;
				for (const artifact of artifactIndex(collection).values()) {
					const title = (artifact.title ?? '').toLowerCase();
					const note = (artifact.note ?? '').toLowerCase();
					let body = '';
					if (includeBody) {
						const { text, source } = readArtifact(artifact.path ?? '', artifact.snapshot, roots);
						if (typeof text === 'string') body = text.toLowerCase();
						if (body === '' && source === 'missing' && typeof artifact.snapshot !== 'string') body = '';
					}
					if (query !== '' && !title.includes(query) && !note.includes(query) && !body.includes(query)) continue;
					results.push({
						collectionId: collection.id,
						id: artifact.id,
						title: artifact.title,
						kind: artifact.kind,
						format: artifact.format ?? null,
						project: collection.project,
					});
				}
			}
			results.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
			return { matches: results };
		}

		/** The safe document for one artifact's current revision. */
		artifact(request) {
			request ??= {};
			const registry = this.store.registry();
			const id = typeof request.id === 'string' ? request.id : null;
			if (id === null) return { ok: false, error: 'artifactLibrary: no artifact id' };
			const found = findArtifact(registry, id);
			if (!found) return { ok: false, error: `artifactLibrary: unknown artifact ${id}` };
			const { collection, artifact } = found;
			const roots = this.store.roots().map(resolveRoot);
			const { text, source } = readArtifact(artifact.path, artifact.snapshot, roots);
			const lower = (artifact.path ?? '').toLowerCase();
			const mode = artifact.format === 'html' || lower.endsWith('.html') || lower.endsWith('.htm')
				? 'html'
				: (lower.endsWith('.txt') ? 'text' : 'markdown');
			const html = mode === 'markdown'
				? markdownToHtml(text ?? '')
				: mode === 'text'
					? `<pre>${(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
					: (text ?? '');
			return {
				ok: true,
				id: artifact.id,
				collectionId: collection.id,
				title: artifact.title,
				kind: artifact.kind,
				format: artifact.format ?? (mode === 'html' ? 'html' : mode === 'text' ? 'text' : 'markdown'),
				project: collection.project,
				sourceSessionId: artifact.sourceSessionId ?? collection.sourceSessionId ?? null,
				source,
				availability: source,
				mode,
				html,
				evidenceDirectory: artifact.evidenceDirectory ?? null,
				relatedArtifactId: artifact.relatedArtifactId ?? null,
				note: artifact.note ?? null,
				expectedOutputs: expectedOutputs(collection),
			};
		}

		/**
		 * The availability of one artifact against the real roots: 'original'
		 * when its registered original still exists and is readable inside an
		 * approved root, 'snapshot' when only the saved copy remains, 'missing'
		 * otherwise.
		 * @param {object} artifact - the artifact record.
		 * @param {string[]} roots - approved roots, already real.
		 * @returns the availability string.
		 */
		availabilityFor(artifact, roots) {
			if (!pathAllowed(artifact.path ?? '', roots)) {
				return typeof artifact.snapshot === 'string' ? 'snapshot' : 'missing';
			}
			return 'original';
		}

		/** Pin or unpin a collection or a specific artifact. */
		setPinned(request) {
			request ??= {};
			const pinned = request.pinned === true;
			const registry = structuredClone(this.store.registry());
			let target = null;
			if (typeof request.artifactId === 'string' && request.artifactId !== '') {
				const found = findArtifact(registry, request.artifactId);
				if (!found) return { ok: false, error: `artifactLibrary: unknown artifact ${request.artifactId}` };
				found.artifact.pinned = pinned;
				target = found.artifact;
			} else if (typeof request.collectionId === 'string' && request.collectionId !== '') {
				const collection = findCollection(registry, request.collectionId);
				if (!collection) return { ok: false, error: `artifactLibrary: unknown collection ${request.collectionId}` };
				collection.pinned = pinned;
				target = collection;
			} else {
				return { ok: false, error: 'artifactLibrary: setPinned needs a collectionId or artifactId' };
			}
			try {
				this.store.persist(registry);
			} catch (error) {
				return { ok: false, error: `artifactLibrary: pin was not saved: ${error?.message ?? 'registry write failed'}` };
			}
			return { ok: true, id: target.id, pinned };
		}

		/**
		 * Register a new deliverable into an existing collection.
		 *
		 * An unchanged retry (same resolved path, content and supplied
		 * metadata) returns the existing revision with `unchanged: true` and
		 * writes nothing. A changed registration appends a revision and keeps
		 * the prior revision's snapshot bytes in history, not only its hash.
		 * The path is validated against the approved roots before any read; a
		 * bounded text snapshot is saved when the original is readable.
		 */
		register(request) {
			request ??= {};
			const registry = structuredClone(this.store.registry());
			const collectionId = typeof request.collectionId === 'string' ? request.collectionId : '';
			const artifactId = typeof request.artifactId === 'string' ? request.artifactId : '';
			if (collectionId === '' || artifactId === '') return { ok: false, error: 'artifactLibrary: register needs collectionId and artifactId' };
			const collection = findCollection(registry, collectionId);
			if (!collection) return { ok: false, error: `artifactLibrary: unknown collection ${collectionId}` };
			const path = typeof request.path === 'string' ? request.path : '';
			if (path === '') return { ok: false, error: 'artifactLibrary: register needs a path' };
			const roots = this.store.roots().map(resolveRoot);
			if (!pathAllowed(path, roots)) return { ok: false, error: `artifactLibrary: path not in approved roots: ${path}` };
			const title = typeof request.title === 'string' && request.title !== '' ? request.title : artifactId;
			const kind = request.kind === 'design' || request.kind === 'report' || request.kind === 'research' ? request.kind : 'research';
			const format = request.format === 'html' ? 'html' : null;
			const requestedSession = typeof request.sourceSessionId === 'string' && request.sourceSessionId !== '' ? request.sourceSessionId : null;
			const index = artifactIndex(collection);
			const existing = index.get(artifactId);
			let snapshot;
			const current = readArtifact(path, undefined, roots);
			if (current.source === 'original' && typeof current.text === 'string') {
				const cap = snapshotCap({ path, format });
				if (Buffer.byteLength(current.text, 'utf8') <= cap) snapshot = current.text;
			}

			const currentText = typeof current.text === 'string' ? current.text : null;
			const existingSnapshot = existing !== undefined && typeof existing.snapshot === 'string' ? existing.snapshot : null;
			const lastHistory = existing !== undefined && Array.isArray(existing.history) && existing.history.length > 0 ? existing.history[existing.history.length - 1] : null;
			const existingHash = existingSnapshot !== null
				? hashText(existingSnapshot)
				: (lastHistory !== null && typeof lastHistory.hash === 'string' ? lastHistory.hash : null);
			const currentHash = currentText !== null ? hashText(currentText) : null;
			const requestedReal = realPath(path);
			const existingReal = existing !== undefined ? realPath(existing.path ?? '') : null;
			const samePath = existing !== undefined && requestedReal !== null && existingReal !== null && requestedReal === existingReal;
			const sameContent = currentText !== null && (
				(existingSnapshot !== null && existingSnapshot === currentText)
				|| (existingHash !== null && existingHash === currentHash)
			);
			const existingSession = existing !== undefined && typeof existing.sourceSessionId === 'string' ? existing.sourceSessionId : null;
			const sameMetadata = existing !== undefined
				&& existing.title === title
				&& existing.kind === kind
				&& (format === null || existing.format === format)
				&& (requestedSession === null || requestedSession === existingSession);
			if (existing !== undefined && samePath && sameContent && sameMetadata) {
				return {
					ok: true,
					id: artifactId,
					collectionId,
					revision: typeof existing.revision === 'number' ? existing.revision : 1,
					snapshot: existingSnapshot !== null,
					unchanged: true,
				};
			}

			if (existing !== undefined) {
				const previousRevision = typeof existing.revision === 'number' ? existing.revision : 1;
				const previousSnapshot = typeof existing.snapshot === 'string' ? existing.snapshot : undefined;
				const history = Array.isArray(existing.history) ? [...existing.history] : [];
				if (previousSnapshot !== undefined) {
					const prior = history.find((entry) => entry !== null && typeof entry === 'object' && entry.revision === previousRevision);
					if (prior === undefined) {
						history.push({
							revision: previousRevision,
							at: new Date().toISOString(),
							hash: hashText(previousSnapshot),
							source: 'saved-copy',
							snapshot: previousSnapshot,
						});
					} else if (typeof prior.snapshot !== 'string') {
						prior.snapshot = previousSnapshot;
					}
				}
				const revision = previousRevision + 1;
				const at = new Date().toISOString();
				history.push({
					revision,
					at,
					hash: snapshot !== undefined ? hashText(snapshot) : null,
					source: snapshot !== undefined ? 'saved-copy' : 'original',
					...(snapshot !== undefined ? { snapshot } : {}),
				});
				existing.title = title;
				existing.kind = kind;
				existing.path = path;
				if (format) existing.format = format;
				if (requestedSession !== null) existing.sourceSessionId = requestedSession;
				if (snapshot !== undefined) existing.snapshot = snapshot;
				existing.revision = revision;
				existing.history = history;
			} else {
				const at = new Date().toISOString();
				collection.artifacts.push({
					id: artifactId,
					title,
					kind,
					...(format ? { format } : {}),
					path,
					...(snapshot !== undefined ? { snapshot } : {}),
					revision: 1,
					history: [{
						revision: 1,
						at,
						hash: snapshot !== undefined ? hashText(snapshot) : null,
						source: snapshot !== undefined ? 'saved-copy' : 'registered',
						...(snapshot !== undefined ? { snapshot } : {}),
					}],
					...(requestedSession !== null ? { sourceSessionId: requestedSession } : {}),
				});
			}
			try {
				this.store.persist(registry);
			} catch (error) {
				return { ok: false, error: `artifactLibrary: artifact was not registered: ${error?.message ?? 'registry write failed'}` };
			}
			const updated = existing ? existing : collection.artifacts[collection.artifacts.length - 1];
			return { ok: true, id: artifactId, collectionId, revision: updated.revision, snapshot: snapshot !== undefined };
		}
	};

	Object.defineProperty(service.prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([
				Object.freeze({ method: 'library', invocation: Object.freeze({ kind: 'direct' }) }),
				Object.freeze({ method: 'search', invocation: Object.freeze({ kind: 'direct' }) }),
				Object.freeze({ method: 'artifact', invocation: Object.freeze({ kind: 'direct' }) }),
				Object.freeze({ method: 'setPinned', invocation: Object.freeze({ kind: 'direct' }) }),
				Object.freeze({ method: 'register', invocation: Object.freeze({ kind: 'direct' }) }),
			]),
		}),
	});
	return service;
}

/**
 * A durable, per-profile store for the Library.
 *
 * Reads the registry on first use (or restores it from the curated seed when
 * the registry is still empty), serves `registry()`, `roots()` and
 * `persist()`, and keeps the document on disk so a restart continues.
 *
 * @param {object} [options] - test and configuration hooks.
 * @param {string} [options.file] - the registry path to use (defaults to the
 *   profile-scoped path).
 * @param {string[]} [options.roots] - approved roots, when the registry has
 *   none of its own.
 * @param {string} [options.seedFile] - the curated seed to merge when the
 *   registry is empty.
 * @returns the store object.
 */
export function createStore(options = {}) {
	const file = options.file ?? scopedStoreFilePath({});
	let cached = null;
	const load = () => {
		if (cached) return cached;
		const loaded = readRegistry(file);
		if (loaded.collections.length === 0 && typeof options.seedFile === 'string' && options.seedFile !== '') {
			let seed = null;
			try {
				if (existsSync(options.seedFile)) {
					const parsed = JSON.parse(readFileSync(options.seedFile, 'utf8'));
					if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) seed = parsed;
				}
			} catch {
				// A corrupt seed is ignored; the tested registry file is not touched.
				seed = null;
			}
			if (seed !== null) {
				if (Array.isArray(seed.approvedRoots)) {
					for (const root of seed.approvedRoots) {
						if (typeof root === 'string' && root !== '' && !loaded.approvedRoots.includes(root)) loaded.approvedRoots.push(root);
					}
				}
				seedRegistry(loaded, seed);
				// The first activation seed is not cached until it reaches disk.
				writeRegistry(file, loaded);
			}
		}
		cached = loaded;
		return cached;
	};
	return {
		registry: () => load(),
		roots: () => (Array.isArray(options.roots) && options.roots.length > 0
			? options.roots
			: (cached?.approvedRoots ?? [])),
		persist: (registry) => {
			// A failed write must not replace the last good in-memory registry.
			writeRegistry(file, registry);
			cached = registry;
			return true;
		},
		reset: () => {
			cached = null;
		},
	};
}

/**
 * Seed the registry from the curated seed document.
 *
 * Each artifact's original is read and validated against the approved roots.
 * A readable file within the artifact's snapshot cap becomes a saved
 * snapshot (revision 1) in the registry document, so the Library keeps the
 * text when the original is later deleted. Unreadable or out-of-root files
 * stay registered without a snapshot.
 *
 * @param {object} registry - the registry to seed (mutated).
 * @param {object} seed - the parsed seed document.
 * @returns the number of artifacts newly added.
 */
export function seedRegistry(registry, seed) {
	let added = 0;
	const known = new Set();
	for (const collection of registry.collections) {
		for (const artifact of artifactIndex(collection).values()) {
			if (typeof artifact.id === 'string') known.add(artifact.id);
		}
	}
	const roots = (registry.approvedRoots ?? []).map(resolveRoot);
	for (const collection of Array.isArray(seed.collections) ? seed.collections : []) {
		if (!collection || typeof collection.id !== 'string') continue;
		const existing = findCollection(registry, collection.id);
		if (existing) continue;
		const kept = [];
		for (const artifact of Array.isArray(collection.artifacts) ? collection.artifacts : []) {
			if (!artifact || typeof artifact.id !== 'string') continue;
			if (known.has(artifact.id)) continue;
			const clean = { ...artifact, revision: 1, history: [{ revision: 1, at: new Date().toISOString(), hash: null, source: 'registered' }] };
			const real = pathAllowed(artifact.path ?? '', roots) ? artifact.path : null;
			if (real !== null) {
				const { text, source } = readArtifact(real, undefined, roots);
				if (source === 'original' && typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= snapshotCap({ path: real, format: artifact.format })) {
					clean.snapshot = text;
					clean.history[0].hash = hashText(text);
				}
			}
			kept.push(clean);
			known.add(artifact.id);
		}
		registry.collections.push({
			...collection,
			artifacts: kept,
			expectedOutputs: Array.isArray(collection.expectedOutputs) ? collection.expectedOutputs : [],
		});
		added += kept.length;
	}
	return added;
}

/**
 * Mount the Library: build the store and the Remote service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the bundle's Host context.
 * @param {{ storeFile?: string, seedFile?: string, roots?: string[] }} [config] - bundle row configuration.
 */
export function apply(ctx, config = {}) {
	const file = config.storeFile ?? scopedStoreFilePath(config);
	const store = createStore({
		file,
		roots: Array.isArray(config.roots) ? config.roots : undefined,
		seedFile: typeof config.seedFile === 'string' ? config.seedFile : undefined,
	});
	ctx.plugin(libraryService({ store }));
}
