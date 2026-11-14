/**
 * Pure fusion, cursor, and shape helpers for the hybrid session-search engine.
 *
 * Kept free of SQLite and Cordis so the ranking rules, cursor binding, and hit
 * projection can be tested directly.
 *
 * @module @local/dsh-session-semantic-search/fusion
 */

import { createHash } from 'node:crypto';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';

/** Reciprocal-rank-fusion smoothing constant from the design. */
export const RRF_K = 60;

/**
 * Cosine similarity of two equal-length float vectors.
 * @param {Float32Array} left - first vector.
 * @param {Float32Array} right - second vector.
 * @returns {number} similarity in [-1, 1], or 0 for a zero vector or length mismatch.
 */
export function cosineSimilarity(left, right) {
	if (!left || !right || left.length !== right.length) return 0;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index];
		const b = right[index];
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	if (leftNorm === 0 || rightNorm === 0) return 0;
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * Stable digest of the parts that bind one opaque cursor to its request.
 * @param {...unknown} parts - values to hash.
 * @returns {string} base64url SHA-256 digest.
 */
export function digest(...parts) {
	return createHash('sha256').update(parts.map((part) => String(part)).join('\u0000')).digest('base64url');
}

/** Cursor format version. */
export const CURSOR_VERSION = 2;

/** Stream modes a cursor can continue: full text alone, or the fused stream. */
export const CURSOR_MODES = Object.freeze(['fts', 'hybrid']);

/**
 * Encode one continuation cursor.
 * @param {object} payload - cursor fields.
 * @returns {string} opaque base64url cursor.
 */
export function encodeCursor(payload) {
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode a cursor and assert it belongs to this engine instance and request.
 *
 * A cursor names the stream it continues (`m`: `fts` or `hybrid`), the next
 * offset (`o`), how many full-text hits its served prefix depends on (`n`),
 * and a digest of the ids that fixed that prefix (`g`).
 *
 * @param {unknown} cursor - caller-held opaque cursor.
 * @param {{ instance: string, fingerprint: string }} binding - expected owner and request identity.
 * @returns {{ m: 'fts' | 'hybrid', o: number, n: number, g: string }} decoded payload; `g` is compared by the caller.
 * @throws {SessionQueryError} `SESSION_QUERY_INVALID_CURSOR` for a foreign or malformed cursor.
 */
export function decodeCursor(cursor, binding) {
	if (typeof cursor !== 'string') throw invalidCursor(new Error('session-search cursor must be text'));
	let decoded;
	try {
		decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
	} catch (error) {
		throw invalidCursor(error);
	}
	if (decoded === null || typeof decoded !== 'object') throw invalidCursor(new Error('cursor is not an object'));
	if (decoded.v !== CURSOR_VERSION || decoded.i !== binding.instance || decoded.s !== 'sessions' || decoded.f !== binding.fingerprint) {
		throw invalidCursor(new Error('cursor does not belong to this normalized request'));
	}
	if (!CURSOR_MODES.includes(decoded.m)) throw invalidCursor(new Error('cursor stream is invalid'));
	if (!Number.isSafeInteger(decoded.o) || decoded.o < 0) throw invalidCursor(new Error('cursor offset is invalid'));
	if (!Number.isSafeInteger(decoded.n) || decoded.n < 0) throw invalidCursor(new Error('cursor coverage is invalid'));
	if (typeof decoded.g !== 'string') throw invalidCursor(new Error('cursor generation is invalid'));
	return decoded;
}

/**
 * Build the public invalid-cursor failure.
 * @param {unknown} cause - why decoding failed.
 * @returns {SessionQueryError} typed failure.
 */
export function invalidCursor(cause) {
	return new SessionQueryError('session-search cursor is invalid', 'SESSION_QUERY_INVALID_CURSOR', { cause });
}

/**
 * Fuse one FTS page and one vector candidate list by reciprocal rank.
 *
 * The FTS list is already grouped and ordered by the native backend, so its
 * index is the session's FTS rank. The vector list is ordered by descending
 * cosine similarity. Each side contributes `1 / (k + rank)` with rank starting
 * at 1; a session absent from one side contributes nothing for it.
 *
 * @param {object} input - candidates to fuse.
 * @param {readonly object[]} input.ftsItems - native session hits in native rank order.
 * @param {readonly object[]} input.vectorCandidates - sidecar rows with `session_id` and `score`, best per session, best first.
 * @param {number} [input.k] - RRF smoothing constant.
 * @returns {Array<object>} fused entries: `{ sessionId, ftsHit, vectorRow, ftsRank, vectorRank, vectorScore, score }`.
 */
export function rrfFuse({ ftsItems, vectorCandidates, k = RRF_K }) {
	const entries = new Map();
	ftsItems.forEach((hit, index) => {
		entries.set(hit.header.id, {
			sessionId: hit.header.id,
			ftsHit: hit,
			vectorRow: undefined,
			ftsRank: index + 1,
			vectorRank: undefined,
			vectorScore: 0,
			score: 1 / (k + index + 1),
		});
	});
	vectorCandidates.forEach((row, index) => {
		const sessionId = row.session_id;
		const existing = entries.get(sessionId);
		const contribution = 1 / (k + index + 1);
		if (existing === undefined) {
			entries.set(sessionId, {
				sessionId,
				ftsHit: undefined,
				vectorRow: row,
				ftsRank: undefined,
				vectorRank: index + 1,
				vectorScore: row.score,
				score: contribution,
			});
			return;
		}
		existing.vectorRow = row;
		existing.vectorRank = index + 1;
		existing.vectorScore = row.score;
		existing.score += contribution;
	});
	return [...entries.values()].sort(compareFused);
}

/**
 * Deterministic fused order: score, then the stronger single-side signal.
 * @param {object} left - first fused entry.
 * @param {object} right - second fused entry.
 * @returns {number} comparator result.
 */
function compareFused(left, right) {
	if (right.score !== left.score) return right.score - left.score;
	const leftRank = left.ftsRank ?? Number.POSITIVE_INFINITY;
	const rightRank = right.ftsRank ?? Number.POSITIVE_INFINITY;
	if (leftRank !== rightRank) return leftRank - rightRank;
	if (right.vectorScore !== left.vectorScore) return right.vectorScore - left.vectorScore;
	const leftTime = timeOf(left);
	const rightTime = timeOf(right);
	if (rightTime !== leftTime) return rightTime - leftTime;
	return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}

/**
 * Event time of a fused entry, preferring the native hit.
 * @param {object} entry - fused entry.
 * @returns {number} epoch milliseconds, or 0 when unknown.
 */
function timeOf(entry) {
	if (entry.ftsHit !== undefined) return entry.ftsHit.bestMatch?.time ?? 0;
	return entry.vectorRow?.time ?? 0;
}

/**
 * Truncate text to a bounded number of Unicode code points.
 * @param {string} text - source text.
 * @param {number} chars - maximum code points.
 * @returns {string} bounded excerpt.
 */
export function excerpt(text, chars) {
	const codePoints = Array.from(text);
	if (codePoints.length <= chars) return text;
	return codePoints.slice(0, chars).join('');
}
