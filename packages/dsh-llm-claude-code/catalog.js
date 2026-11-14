/**
 * Fallback model catalog. Used only when the adapter cannot discover models
 * from the CLI; every entry is explicitly labeled as a labeled fallback with
 * UNKNOWN context capacity — no capacity is invented here. Ids are CLI
 * aliases/short names the `--model` flag documents as accepted.
 *
 * @module catalog
 */

/** Labeled fallback rows; `context` deliberately omitted (unknown, not guessed). */
export const FALLBACK_MODELS = [
	{ id: 'opus', name: 'Claude Opus (fallback alias)', description: 'Alias resolved by the Claude Code CLI; fallback entry, capacity unknown.' },
	{ id: 'sonnet', name: 'Claude Sonnet (fallback alias)', description: 'Alias resolved by the Claude Code CLI; fallback entry, capacity unknown.' },
	{ id: 'haiku', name: 'Claude Haiku (fallback alias)', description: 'Alias resolved by the Claude Code CLI; fallback entry, capacity unknown.' },
];
