/**
 * Notification composition for @local/dsh-notifier.
 *
 * The summary is generated from the session log alone: the request that opened
 * the turn, the last words the model wrote, the work the turn did, and how long
 * it took. Nothing here calls a model, so a notification costs no tokens and
 * arrives as soon as the turn closes.
 *
 * Pushover measures `message` and `title` in Unicode characters, so every bound
 * here counts code points rather than UTF-16 units and never splits a surrogate
 * pair or an emoji.
 *
 * @module @local/dsh-notifier/summary
 */

/** Pushover's message limit, in Unicode code points. */
export const MESSAGE_LIMIT = 1024;

/** Pushover's title limit, in Unicode code points. */
export const TITLE_LIMIT = 250;

/**
 * Status word per turn-end kind. A completed turn needs none: the URL and the
 * app name already say what finished. Unknown kinds print their raw kind.
 */
const STATUS = {
	completed: { emoji: '✅', word: '' },
	error: { emoji: '⚠️', word: 'failed' },
	blocked: { emoji: '⛔', word: 'blocked' },
	aborted: { emoji: '⏹️', word: 'stopped' },
	interrupted: { emoji: '🛑', word: 'interrupted' },
	'max-tokens': { emoji: '📉', word: 'out of tokens' },
	forked: { emoji: '↪️', word: 'forked' },
};

/**
 * Count Unicode code points, the unit Pushover's limits use.
 * @param text - any string.
 * @returns its length in code points.
 */
export function codePointLength(text) {
	return Array.from(text).length;
}

/**
 * Bound a string to a code-point limit, preferring a word boundary and marking
 * the cut with an ellipsis.
 * @param text - the string to bound.
 * @param limit - maximum code points, ellipsis included.
 * @returns the bounded string.
 */
export function truncate(text, limit) {
	const points = Array.from(text);
	if (points.length <= limit) return text;
	if (limit <= 1) return '…';
	let cut = points.slice(0, limit - 1).join('');
	const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
	if (boundary >= Math.floor((limit - 1) * 0.8)) cut = cut.slice(0, boundary);
	return `${cut.trimEnd()}…`;
}

/**
 * Collapse whitespace into one line and bound it.
 * @param text - the string to condense.
 * @param limit - maximum code points.
 * @returns a single bounded line.
 */
export function condense(text, limit) {
	return truncate(String(text).replace(/\s+/g, ' ').trim(), limit);
}

/**
 * Flatten model-authored Markdown into the plain text Pushover renders.
 *
 * The closing summary is written as Markdown for the chat view; a push has no
 * Markdown renderer, so `**bold**`, backticks, headings, and table pipes reach
 * the phone as noise. This removes the syntax and keeps the words: fenced code
 * keeps its code, links keep their label, tables become dot-separated rows, and
 * list markers become bullets. Underscores inside words survive, so
 * `snake_case` is not mistaken for emphasis.
 * @param text - the Markdown source.
 * @returns the plain-text rendering.
 */
export function plainText(text) {
	/** @type {string} */
	let value = String(text).replace(/\r\n?/g, '\n');
	// Fenced code: keep the code, drop the fence and its language tag.
	value = value.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.replace(/\n$/, ''));
	// Inline code.
	value = value.replace(/`([^`\n]+)`/g, '$1');
	// Images keep their alt text; links keep their label.
	value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	value = value.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1');
	// Headings and blockquotes lose their markers.
	value = value.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
	value = value.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
	value = value.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, '');
	// Task checkboxes and bullets.
	value = value.replace(/^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+/gm, (_, indent, mark) => `${indent}${mark.trim() === '' ? '☐' : '☑'} `);
	value = value.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
	// Tables: one row per line, cells separated by a dot.
	value = value.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, cells) => {
		const parts = cells.split('|').map((cell) => cell.trim());
		return parts.every((cell) => /^:?-{2,}:?$/.test(cell)) ? '' : parts.join(' · ');
	});
	// Emphasis and strikethrough.
	value = value.replace(/\*\*([^*\n]+)\*\*/g, '$1');
	value = value.replace(/__([^_\n]+)__/g, '$1');
	value = value.replace(/~~([^~\n]+)~~/g, '$1');
	value = value.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1$2');
	value = value.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1$2');
	// Escape markers revealed by the removals above.
	value = value.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
	// Tidy: trailing spaces, collapsed blank runs, trimmed edges.
	value = value.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
	return value.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render a duration for a notification title.
 * @param milliseconds - elapsed turn time.
 * @returns `42s`, `4m 32s`, or `2h 5m`.
 */
export function formatDuration(milliseconds) {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const rest = seconds % 60;
		return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Extract the visible text of one message, ignoring reasoning, images, files,
 * and tool blocks.
 * @param message - a session message.
 * @returns its text blocks joined, or an empty string.
 */
export function messageText(message) {
	if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return '';
	return message.content
		.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
		.trim();
}

/**
 * Render a token count compactly.
 * @param tokens - total tokens for the turn.
 * @returns `850`, `1.5k`, or `42k`.
 */
export function formatTokens(tokens) {
	if (tokens < 1000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}

/**
 * A failed turn's most useful line: the failure the model reported.
 * @param reason - the `turn/end` reason.
 * @returns the error line.
 */
function errorLine(reason) {
	const message = reason?.error?.message;
	if (typeof message !== 'string' || message.trim() === '') return 'Error: the turn failed.';
	return `Error: ${condense(message, 300)}`;
}

/**
 * Compose the Pushover title and message for a finished turn.
 * @param turn - `{ label, reason, durationMs, ask, closing, toolCalls, toolErrors, tokens }`,
 *   where `ask` is a human request or a real goal objective, or empty when
 *   the turn carries neither.
 * @returns `{ title, message }`, both within Pushover's limits.
 */
export function composeNotification(turn) {
	const kind = typeof turn.reason === 'string' ? turn.reason : turn.reason?.kind ?? 'completed';
	const status = STATUS[kind] ?? { emoji: '•', word: kind };
	const label = condense(turn.label ?? 'session', 48);
	const duration = formatDuration(turn.durationMs);
	const title = truncate(
		`${status.emoji} ${label}${status.word === '' ? '' : ` ${status.word}`} · ${duration}`,
		TITLE_LIMIT,
	);

	const error = kind === 'error' ? errorLine(turn.reason) : '';
	const goal = turn.ask ? `Goal: ${condense(turn.ask, 200)}` : '';
	const facts = [];
	if (turn.toolCalls > 0) facts.push(`${turn.toolCalls} tool ${turn.toolCalls === 1 ? 'call' : 'calls'}`);
	if (turn.toolErrors > 0) facts.push(`${turn.toolErrors} failed`);
	if (turn.tokens > 0) facts.push(`${formatTokens(turn.tokens)} tokens`);
	const factsLine = facts.join(' · ');

	const fixed = [error, goal, factsLine].filter(Boolean);
	const closing = typeof turn.closing === 'string' ? plainText(turn.closing) : '';
	const parts = fixed.length + (closing === '' ? 0 : 1);
	const budget = MESSAGE_LIMIT - codePointLength(fixed.join('\n\n')) - Math.max(0, parts - 1) * 2;
	const closingLine = closing !== '' && budget > 40 ? truncate(closing, budget) : '';

	return {
		title,
		message: truncate([error, goal, closingLine, factsLine].filter(Boolean).join('\n\n'), MESSAGE_LIMIT),
	};
}

/**
 * Compose the Pushover title and message for the tasks a `todo/write` just
 * completed.
 * @param completion - `{ label, done: string[], completed, total }`, where
 *   `completed` and `total` describe the whole list after the write.
 * @returns `{ title, message }`, both within Pushover's limits.
 */
export function composeTaskNotification(completion) {
	const label = condense(completion.label ?? 'session', 48);
	const done = completion.done.map((item) => condense(plainText(item), 160));
	const title = truncate(`☑️ ${label} · task ${completion.completed}/${completion.total}`, TITLE_LIMIT);

	const lines = [];
	if (done.length === 1) {
		lines.push(`Done: ${done[0]}`);
	} else {
		lines.push('Done:');
		for (const item of done.slice(0, 4)) lines.push(`• ${item}`);
		if (done.length > 4) lines.push(`• +${done.length - 4} more`);
	}
	lines.push('', `${completion.completed} of ${completion.total} complete.`);
	return { title, message: truncate(lines.join('\n'), MESSAGE_LIMIT) };
}

/**
 * Compose the Pushover title and message for a goal that reached a terminal
 * phase.
 * @param goal - `{ label, operation, objective, blockedReason, rounds, durationMs }`,
 *   where `operation` is `complete` or `block`.
 * @returns `{ title, message }`, both within Pushover's limits.
 */
export function composeGoalNotification(goal) {
	const label = condense(goal.label ?? 'session', 48);
	const blocked = goal.operation === 'block';
	const title = truncate(`🎯 ${label} · goal ${blocked ? 'blocked' : 'complete'}`, TITLE_LIMIT);

	const lines = [`Objective: ${condense(goal.objective, 300)}`];
	if (blocked && typeof goal.blockedReason === 'string' && goal.blockedReason.trim() !== '') {
		lines.push('', `Blocked: ${condense(plainText(goal.blockedReason), 300)}`);
	}
	const facts = [];
	if (Number.isFinite(goal.rounds) && goal.rounds > 0) facts.push(`${goal.rounds} ${goal.rounds === 1 ? 'round' : 'rounds'}`);
	if (Number.isFinite(goal.durationMs)) facts.push(formatDuration(goal.durationMs));
	if (facts.length > 0) lines.push('', facts.join(' · '));
	return { title, message: truncate(lines.join('\n'), MESSAGE_LIMIT) };
}
