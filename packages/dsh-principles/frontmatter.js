/**
 * Frontmatter parsing and emission for principle files.
 *
 * The workspace takes no new dependency, and `yaml` is one only of
 * `mov-skills`, not of the workspace. A principle's frontmatter is a flat
 * mapping of short strings, so this file implements exactly that subset:
 * double-quoted scalars (JSON escapes), single-quoted scalars, plain scalars,
 * and `|` / `>` block scalars. Anything else is reported as malformed, which the
 * store skips and logs rather than letting a hand edit break the session.
 *
 * @module @local/dsh-principles/frontmatter
 */

/** One `key: value` line of the flat mapping this subset accepts. */
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/u;

/** A block-scalar header: `|`, `>`, and their chomping variants. */
const BLOCK_SCALAR = /^[|>][+-]?$/u;

/**
 * Split YAML frontmatter from a Markdown body.
 * @param raw - complete file text.
 * @returns `{ data, body }` on success, `{ error }` when the file is not a
 *   frontmatter document this subset understands.
 */
export function splitFrontmatter(raw) {
	const lines = String(raw).replace(/^\uFEFF/u, '').split(/\r?\n/u);
	if ((lines[0] ?? '').trim() !== '---') {
		return { error: 'missing frontmatter (the file must start with ---)' };
	}
	let closing = -1;
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (line === '---' || line === '...') {
			closing = index;
			break;
		}
	}
	if (closing < 0) return { error: 'unterminated frontmatter (no closing ---)' };
	const head = lines.slice(1, closing);
	const data = {};
	for (let index = 0; index < head.length; index += 1) {
		const line = head[index];
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const match = KEY_LINE.exec(line);
		if (match === null) {
			return { error: `unsupported frontmatter line ${JSON.stringify(line)}` };
		}
		const key = match[1];
		if (Object.hasOwn(data, key)) return { error: `duplicate frontmatter key "${key}"` };
		const rawValue = match[2] ?? '';
		if (BLOCK_SCALAR.test(rawValue)) {
			const folded = rawValue[0] === '>';
			const collected = [];
			let indent;
			while (index + 1 < head.length) {
				const next = head[index + 1];
				if (next.trim() === '') {
					collected.push('');
					index += 1;
					continue;
				}
				const lead = /^[ \t]*/u.exec(next)[0].length;
				if (lead === 0) break;
				indent ??= lead;
				collected.push(next.slice(Math.min(indent, lead)));
				index += 1;
			}
			data[key] = folded ? foldBlock(collected) : collected.join('\n');
			continue;
		}
		const scalar = parseScalar(rawValue);
		if (scalar === undefined) return { error: `unsupported value for "${key}"` };
		data[key] = scalar;
	}
	const body = lines.slice(closing + 1).join('\n').replace(/^(?:[ \t]*\r?\n)+/u, '');
	return { data, body };
}

/**
 * Serialize a flat mapping as frontmatter and its separating blank line.
 *
 * Every value is emitted as a JSON double-quoted string: the one form this
 * parser reads back byte-for-byte, including colons, quotes, and unicode.
 * @param data - mapping of frontmatter keys to strings; `undefined` values are omitted.
 * @returns text ending with the closing `---` and one blank line.
 */
export function stringifyFrontmatter(data) {
	const lines = ['---'];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		lines.push(`${key}: ${JSON.stringify(String(value))}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}

/**
 * Parse one scalar in the accepted subset.
 * @param raw - text after the `key:`.
 * @returns the string value, or undefined when the form is outside the subset.
 */
function parseScalar(raw) {
	const value = raw.trim();
	if (value === '') return '';
	if (value.startsWith('"')) {
		if (value.length < 2 || !value.endsWith('"')) return undefined;
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === 'string' ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	if (value.startsWith("'")) {
		if (value.length < 2 || !value.endsWith("'")) return undefined;
		return value.slice(1, -1).replaceAll("''", "'");
	}
	// Collections, anchors, aliases, and tags are outside the subset; a stray
	// plain value that starts with them is a hand edit the store should report.
	if (/^[[{&*!]/u.test(value)) return undefined;
	return value;
}

/**
 * Fold a `>` block scalar into the single line YAML would produce.
 * @param lines - block lines with the common indentation removed.
 * @returns folded text, preserving blank lines as paragraph breaks.
 */
function foldBlock(lines) {
	let out = '';
	for (const line of lines) {
		if (line === '') {
			out += '\n';
			continue;
		}
		out = out === '' || out.endsWith('\n') ? `${out}${line}` : `${out} ${line}`;
	}
	return out.replace(/\n$/u, '');
}
