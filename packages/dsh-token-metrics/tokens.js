/**
 * The metric itself: the token usage of every model call, rolled up by model,
 * counted from the moment the plugin is activated.
 *
 * Nothing is backfilled. The Host listens to the live `session/event` append
 * feed and reads the `usage` field of each settled `assistant/message` — the
 * exact `TokenUsage` the adapter reported for that call. Because a fork or
 * resume seed never publishes on that feed, inherited copies cannot arrive at
 * all. Only token counts and the model names travel to the browser; no
 * transcripts, no prompts, no arguments cross the boundary.
 *
 * A `TokenUsage` records disjoint fields: `inputTokens` is uncached input
 * only, and cached input is reported separately as `cacheReadTokens` /
 * `cacheWriteTokens` (billed input is the sum of the three). The rollup keeps
 * those fields separate so a reader can see how much of the prompt was a cache
 * hit, and it also surfaces `reasoningTokens` and `outputTokens` where the
 * adapter reported them.
 *
 * @module @local/dsh-token-metrics/tokens
 */

/** The five token fields a call may report. */
const FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];

/**
 * Whether a number is a count this rollup may add: a safe integer that is not
 * negative. Absent or malformed fields are treated as "not reported" and
 * ignored, never coerced.
 * @param value - the candidate count.
 * @returns true when the value may be added to a total.
 */
export function isCount(value) {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The token counts one settled assistant call reports, as a plain object of the
 * fields that are present and well-formed. Absent or malformed fields are
 * omitted rather than zeroed, so a reader can tell "not reported" from "zero".
 * @param usage - the `TokenUsage` a settled `assistant/message` carried, if any.
 * @returns the well-formed counts, or an empty object when none are present.
 */
export function countsOf(usage) {
	if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return {};
	const counts = {};
	for (const field of FIELDS) {
		const value = usage[field];
		if (isCount(value)) counts[field] = value;
	}
	return counts;
}

/**
 * The model name a settled call was attributed to, from the message's source.
 * The rollup keys its rows by this, so two models never share a row.
 * @param event - the settled `assistant/message` event.
 * @returns the model name, or the empty string when the call reports none.
 */
export function modelOf(event) {
	const source = event?.data?.message?.source;
	if (source === null || typeof source !== 'object' || Array.isArray(source)) return '';
	const model = source.model;
	if (typeof model !== 'string' || model.trim() === '') return '';
	return model;
}

/** A zeroed row for one model. */
function emptyRow() {
	return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

/** Rows by model, highest total tokens first, then by name. */
export function sortRows(byModel) {
	return [...byModel.entries()]
		.map(([model, row]) => ({ model, ...row }))
		.sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
}

/**
 * Create the live rollup.
 *
 * `observe` takes settled `assistant/message` events in order and adds their
 * reported counts to the model's row; `snapshot` returns what the panel reads.
 * Only `observe` can change a row, so reopening or refreshing the panel cannot
 * inflate one.
 * @param [options] - the activation time and any rows restored from state.
 * @param [options.activatedAt] - when counting began, in epoch milliseconds.
 * @param [options.models] - restored per-model rows, model name → counts.
 * @returns the rollup with `observe`, `forget`, `snapshot`, `toState` and `activatedAt`.
 */
export function createRollup({ activatedAt = Date.now(), models = {} } = {}) {
	/** Rows keyed by model name. */
	const byModel = new Map();

	/** Restore a model's row from its persisted counts, skipping malformed values. */
	function restoreRow(counts) {
		const row = emptyRow();
		row.calls = isCount(counts?.calls) ? counts.calls : 0;
		for (const field of FIELDS) if (isCount(counts?.[field])) row[field] = counts[field];
		return row;
	}
	for (const [model, counts] of cleanModels(models)) byModel.set(model, restoreRow(counts));

	/**
	 * Consume one appended session event.
	 * @param sessionId - the session the event belongs to (unused; a count is
	 *   global to the profile, not per session).
	 * @param event - the appended event.
	 * @returns true when the event changed a row, so the caller can persist.
	 */
	function observe(sessionId, event) {
		void sessionId;
		if (event?.type !== 'assistant/message') return false;
		const counts = countsOf(event.data?.usage);
		if (Object.keys(counts).length === 0) return false;
		const model = modelOf(event);
		const key = model === '' ? 'unknown' : model;
		const row = byModel.get(key) ?? emptyRow();
		row.calls += 1;
		for (const field of FIELDS) if (isCount(counts[field])) row[field] += counts[field];
		if (row.totalTokens === 0) row.totalTokens = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens;
		byModel.set(key, row);
		return true;
	}

	/** Drop a session's row on disposal; the rollup is global, so nothing to free, but keep the hook for symmetry. */
	function forget(_sessionId) {}

	/** The current rows and the moment counting began. */
	function snapshot() {
		return {
			activatedAt,
			totals: totalOf(byModel),
			models: sortRows(byModel),
		};
	}

	/** The durable form of this rollup, for the Host's state file. */
	function toState() {
		const models = {};
		for (const [model, row] of byModel) models[model] = { ...row };
		return { version: 1, activatedAt, models };
	}

	return { activatedAt, observe, forget, snapshot, toState };
}

/**
 * The profile-wide totals across every model row: one number per token field
 * plus the summed call count.
 * @param byModel - the rows keyed by model.
 * @returns the summed totals.
 */
function totalOf(byModel) {
	const totals = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	for (const row of byModel.values()) {
		totals.calls += row.calls;
		for (const field of FIELDS) totals[field] += row[field];
	}
	return totals;
}

/**
 * Restore rows from a state document, ignoring anything malformed.
 * @param value - a parsed state document, if any.
 * @returns the rows and activation time to seed a rollup with.
 */
export function fromState(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	if (!Number.isSafeInteger(value.activatedAt) || value.activatedAt < 0) return {};
	return {
		activatedAt: value.activatedAt,
		models: Object.fromEntries(cleanModels(value.models)),
	};
}

/** Model → counts entries with a well-formed counts object for each. */
function cleanModels(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
	const entries = [];
	for (const [model, counts] of Object.entries(value)) {
		if (typeof model !== 'string' || model === '' || counts === null || typeof counts !== 'object' || Array.isArray(counts)) continue;
		const row = { calls: 0 };
		for (const field of FIELDS) row[field] = 0;
		if (isCount(counts.calls)) row.calls = counts.calls;
		for (const field of FIELDS) if (isCount(counts[field])) row[field] = counts[field];
		entries.push([model, row]);
	}
	return entries;
}
