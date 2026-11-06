/**
 * Security helpers for the artifact Library: approved-root containment,
 * path safety and the HTML sandbox policy.
 *
 * The rules here are enforced at the filesystem, not lexically. A path is
 * "contained" only when both it and every approved root have been resolved
 * through the filesystem (symlinks followed), and only then is the prefix
 * comparison made. A symbolic link that points outside an approved root
 * therefore fails the containment check even when its name looks like it is
 * inside one.
 *
 * @module @local/dsh-artifact-library/security
 */

import { isAbsolute, resolve as resolvePath, posix } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Normalize a path lexically: make it absolute (relative to `base` when
 * relative) and collapse `..` segments. This does NOT follow symlinks; use
 * `realPath` for that.
 * @param {string} path - the path to normalize.
 * @param {string} [base] - the directory a relative path resolves against.
 * @returns the normalized absolute path, or null when the input is not a path.
 */
export function normalizePath(path, base) {
	if (typeof path !== 'string' || path === '') return null;
	try {
		const absolute = isAbsolute(path) ? path : resolvePath(base ?? '', path);
		return posix.normalize(absolute);
	} catch {
		return null;
	}
}

/**
 * The real, symlink-resolved form of a path. This is the only value the
 * Library trusts for containment: the OS has told us where the file really
 * lives, so a link out of the tree is seen at the link, not at the name.
 * @param {string} path - the path to resolve.
 * @returns the resolved path, or null when it cannot be resolved.
 */
export function realPath(path) {
	if (typeof path !== 'string' || path === '') return null;
	try {
		return posix.normalize(realpathSync(path));
	} catch {
		return null;
	}
}

/**
 * Whether `candidate` is the root itself or lives inside it. Both values are
 * expected to be already real (symlink-resolved) paths.
 * @param {string} candidate - the path to test.
 * @param {string} root - the approved root, already resolved.
 * @returns true when the candidate is inside the root.
 */
export function isContainedIn(candidate, root) {
	if (typeof candidate !== 'string' || typeof root !== 'string') return false;
	if (candidate === root) return true;
	const base = root.endsWith('/') ? root : `${root}/`;
	return candidate.startsWith(base);
}

/**
 * Whether a real path stays inside any of the approved (real) roots.
 * @param {string} candidate - the resolved path to test.
 * @param {string[]} roots - approved roots, already real.
 * @returns true when the candidate is contained in at least one root.
 */
export function isWithinApprovedRoots(candidate, roots) {
	if (Array.isArray(roots)) {
		for (const root of roots) {
			if (isContainedIn(candidate, root)) return true;
		}
	}
	return false;
}

/**
 * The HTML preview sandbox.
 *
 * The preview document is served from the Library's own origin, but the
 * sandboxed iframe it runs in grants no privileges at all: no script, no
 * forms, no storage access, no same-origin, no navigation. The CSP repeats
 * the same refusal so a document that does reach the reader cannot fetch
 * anything or run anything.
 */
export const HTML_SANDBOX = {
	/** The iframe `sandbox` attribute: the empty set, i.e. no privileges. */
	attributes: 'sandbox=""',
	/** The `contentSecurityPolicy` for the preview document. */
	csp: "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
};

/**
 * The CSP for an authenticated local asset (a registered image or style
 * file). Images and inline styles only; no script, no network, no storage.
 */
export const ASSET_CSP = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

/**
 * Whether a file name is a text artifact the reader can render directly.
 * @param {string} filename - the candidate name.
 * @returns true for Markdown, HTML and plain text.
 */
export function isRenderableText(filename) {
	if (typeof filename !== 'string') return false;
	const name = filename.toLowerCase();
	return name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.txt');
}

/**
 * Whether a file name is a registered local asset (image or style) the
 * authenticated asset route may serve.
 * @param {string} filename - the candidate name.
 * @returns true for the bounded asset set.
 */
export function isRegisteredAsset(filename) {
	if (typeof filename !== 'string') return false;
	const name = filename.toLowerCase();
	return name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')
		|| name.endsWith('.gif') || name.endsWith('.webp') || name.endsWith('.svg')
		|| name.endsWith('.css');
}
