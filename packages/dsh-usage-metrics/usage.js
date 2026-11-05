/**
 * The metric itself: successful recorded `skill` and `principle_read` calls,
 * counted from the moment the plugin is activated.
 *
 * Nothing is backfilled. The Host listens to the live `session/event` append
 * feed, pairs each target `tool/call` with the `tool/result` that follows it,
 * and keeps one count per name. Because a fork or resume seed never publishes
 * on that feed, inherited copies cannot arrive at all. One invocation is one
 * session's call id: a repeated identical event pair in that session is ignored,
 * while the same call id in another session is a distinct invocation.
 *
 * The row name is the canonical name the tool itself recorded: the
 * `skill_content` name for a skill, the `name: … · version: …` line for a
 * principle (so an alias resolves through it), with the call's `name` argument
 * as the fallback.
 *
 * @module @local/dsh-usage-metrics/usage
 */

/** Tool name whose calls are counted as skill usage. */
export const SKILL_TOOL = 'skill';

/** Tool name whose calls are counted as principle usage. */
export const PRINCIPLE_TOOL = 'principle_read';

/** Canonical skill name recorded by the skill tool in its result. */
const SKILL_NAME = /<skill_content name="([^"]+)"/;

/**
 * Canonical principle identity recorded by principle_read in its result:
 * a rendered `name: <id> · version: <hash>` line. An alias resolves through it.
 */
const PRINCIPLE_NAME = /^name:\s*(\S+?)\s*·\s*version:/m;

/** The text blocks of one `tool/result` event. */
export function resultText(event) {
	const content = event?.data?.message?.content;
	if (!Array.isArray(content)) return '';
	let text = '';
	for (const block of content) {
		if (typeof block?.text === 'string') text += block.text;
	}
	return text;
}

/**
 * Whether a `tool/result` records a successful invocation.
 * A failed, cancelled, interrupted or unknown-outcome call is not successful.
 * @param event - the paired result event, if one was recorded.
 * @returns true only for a recorded non-error result.
 */
export function isSuccessful(event) {
	if (event === undefined || event === null) return false;
	const message = event.data?.message;
	if (message === undefined || message.isError === true) return false;
	if (event.data?.error !== undefined) return false;
	return true;
}

/** The `name` argument of one call, when it is a non-empty string. */
export function callName(event) {
	const raw = event?.data?.arguments;
	if (typeof raw !== 'string') return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.name === 'string' && parsed.name.trim() !== '') return parsed.name.trim();
	} catch {
		// An unparseable call has no name to attribute; the result decides.
	}
	return null;
}

/** The canonical name recorded in a skill result, if it carries one. */
export function skillResultName(event) {
	const match = SKILL_NAME.exec(resultText(event));
	return match === null ? null : match[1];
}

/** The canonical name recorded in a principle result, if it carries one. */
export function principleResultName(event) {
	const match = PRINCIPLE_NAME.exec(resultText(event));
	return match === null ? null : match[1];
}

/** Rows highest count first, then by name. */
export function sortRows(counts) {
	return [...counts]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Create the live recorder.
 *
 * `observe` takes appended events in order; `snapshot` returns what the panel
 * reads. Only `observe` can change a count, so reopening or refreshing the
 * panel cannot inflate one.
 * @param [options] - the activation time and any counts restored from state.
 * @param [options.activatedAt] - when counting began, in epoch milliseconds.
 * @param [options.skills] - restored skill counts, name → count.
 * @param [options.principles] - restored principle counts, name → count.
 * @returns the recorder with `observe`, `forget`, `snapshot`, `toState` and `activatedAt`.
 */
export function createRecorder({ activatedAt = Date.now(), skills = {}, principles = {} } = {}) {
	/** Pending calls, keyed by session + call id, waiting for their result. */
	const pending = new Map();
	/** Counted invocations, keyed by session + call id, so a repeated event adds nothing. */
	const counted = new Set();
	const counts = {
		[SKILL_TOOL]: new Map(cleanCounts(skills)),
		[PRINCIPLE_TOOL]: new Map(cleanCounts(principles)),
	};

	/**
	 * Consume one appended session event.
	 * @param sessionId - the session the event belongs to.
	 * @param event - the appended event.
	 * @returns true when the event added a count, so the caller can persist.
	 */
	function observe(sessionId, event) {
		if (event?.type === 'tool/call') {
			const tool = event.data?.name;
			if (tool !== SKILL_TOOL && tool !== PRINCIPLE_TOOL) return;
			const callId = event.data?.callId;
			if (typeof callId !== 'string') return;
			pending.set(`${sessionId}\u0000${callId}`, { tool, callId, key: `${sessionId}\u0000${callId}`, fallbackName: callName(event) });
			return;
		}
		if (event?.type !== 'tool/result') return;
		const callId = event.data?.message?.toolCallId;
		if (typeof callId !== 'string') return;
		const key = `${sessionId}\u0000${callId}`;
		const call = pending.get(key);
		if (call === undefined) return; // A result with no observed call is not a use we may count.
		pending.delete(key);
		if (!isSuccessful(event)) return;
		// One invocation is one session's call: the same call id in another session is
		// a distinct invocation, and a repeated event pair in this session is not.
		if (counted.has(key)) return;
		const name = call.tool === SKILL_TOOL ? skillResultName(event) ?? call.fallbackName : principleResultName(event) ?? call.fallbackName;
		if (name === null) return;
		const table = counts[call.tool];
		table.set(name, (table.get(name) ?? 0) + 1);
		counted.add(key);
		return true;
	}

	/** Drop pending calls of a session that left the store; no result can arrive now. */
	function forget(sessionId) {
		const prefix = `${sessionId}\u0000`;
		for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
	}

	/** The current rows and the moment counting began. */
	function snapshot() {
		return {
			activatedAt,
			skills: sortRows(counts[SKILL_TOOL]),
			principles: sortRows(counts[PRINCIPLE_TOOL]),
		};
	}

	/** The durable form of this recorder, for the Host's state file. */
	function toState() {
		return {
			version: 1,
			activatedAt,
			skills: Object.fromEntries(counts[SKILL_TOOL]),
			principles: Object.fromEntries(counts[PRINCIPLE_TOOL]),
		};
	}

	return { activatedAt, observe, forget, snapshot, toState };
}

/**
 * Restore counts from a state document, ignoring anything malformed.
 * @param value - a parsed state document, if any.
 * @returns the counts and activation time to seed a recorder with.
 */
export function fromState(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	if (!Number.isSafeInteger(value.activatedAt) || value.activatedAt < 0) return {};
	return {
		activatedAt: value.activatedAt,
		skills: Object.fromEntries(cleanCounts(value.skills)),
		principles: Object.fromEntries(cleanCounts(value.principles)),
	};
}

/**
 * Name → count entries with positive safe integer counts only; always an array
 * so callers can build a Map or a plain object from it.
 */
function cleanCounts(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
	const entries = [];
	for (const [name, count] of Object.entries(value)) {
		if (typeof name === 'string' && name !== '' && Number.isSafeInteger(count) && count > 0) entries.push([name, count]);
	}
	return entries;
}
