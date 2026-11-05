/**
 * Pure feed formatting for the KWGT payload — no DSH imports, trivially
 * testable. The widget consumes `text` verbatim. Content policy: only live
 * agents and sessions finished since the last acknowledgement — the widget
 * is a what-needs-attention surface, not a log.
 *
 * Lines stay short on purpose: the preset's elements are TOPRIGHT-anchored
 * with auto width, so long lines grow left past the widget edge and clip.
 */

/** How long a session-list snapshot feeds consecutive widget polls. */
export const SUMMARY_TTL_MS = 30_000;

/** Finished sessions count as "recent" for this long after their last update… */
export const FINISHED_WINDOW_MS = 30 * 60_000;

/** …and until this epoch ms: the last acknowledgement. */
export const DEFAULT_SEEN = 0;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Human age: `now`, `4m`, `3h`, `2d`. */
export function age(until, now) {
	const delta = Math.max(0, now - until);
	if (delta < MINUTE) return 'now';
	if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
	if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
	return `${Math.floor(delta / DAY)}d`;
}

function clip(title, max) {
	const one = title.replace(/\s+/g, ' ').trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * @param {Array<{title: string, running: boolean, blank: boolean, updatedAt: number}>} rows
 * @param {number} now epoch ms
 * @param {number} seen epoch ms of last acknowledgement
 */
export function formatFeed(rows, now, seen = DEFAULT_SEEN) {
	const live = rows
		.filter((row) => row.running && !row.blank)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const done = rows
		.filter((row) => !row.running && !row.blank && row.updatedAt > seen && now - row.updatedAt < FINISHED_WINDOW_MS)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, 3);

	// No decoration glyphs: Sixtyfour lacks them and they render in the
	// fallback font. The `done Nm` suffix is the live/finished distinguisher.
	const liveLines = live.map((row) => clip(row.title, 24));
	const doneLines = done.map((row) => `${clip(row.title, 16)} · done ${age(row.updatedAt, now)}`);

	return {
		stamp: Math.floor(now / 1000),
		live: live.length,
		done: done.length,
		// Split blocks for two-tone rendering: the widget paints liveText in
		// the accent color and doneText dimmed. `text` remains for consumers
		// that render one block.
		liveText: liveLines.join('\n'),
		doneText: doneLines.join('\n'),
		text: liveLines.length + doneLines.length > 0 ? [...liveLines, ...doneLines].join('\n') : 'all quiet',
	};
}
