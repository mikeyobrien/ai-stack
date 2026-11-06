/**
 * Safe readers for the artifact Library.
 *
 * The reader never runs a file's content. It renders it:
 * - Markdown is converted to HTML with a small, dependency-free converter that
 *   emits no executable markup. Any raw HTML embedded in the source is
 *   dropped, not interpreted.
 * - An HTML document is returned to the client verbatim, but the client wraps
 *   it in a sandboxed iframe (no script, no forms, no same-origin, no
 *   network) and applies a strict CSP. So a malicious document cannot run.
 *
 * @module @local/dsh-artifact-library/render
 */

import { isRenderableText } from './security.js';

/**
 * Escape a string for safe inclusion in an HTML element.
 * @param {string} text - the raw text.
 * @returns the escaped text.
 */
export function escapeHtml(text) {
	if (typeof text !== 'string') return '';
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Convert one Markdown document to safe HTML.
 *
 * The converter is intentionally small and dependency-free. It handles the
 * constructs the real reports use: headings, paragraphs, lists, code blocks,
 * inline code, bold, italic, links, blockquotes, tables and horizontal
 * rules. Raw HTML in the source is discarded, so no executable markup can
 * reach the reader.
 *
 * @param {string} source - the Markdown source.
 * @returns the safe HTML string.
 */
export function markdownToHtml(source) {
	if (typeof source !== 'string' || source === '') return '';
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const out = [];
	let inFence = false;
	let inList = null; // 'ul' or 'ol'
	let inTable = false;
	let inBlockquote = false;

	const closeList = () => {
		if (inList) {
			out.push(`</${inList}>`);
			inList = null;
		}
	};
	const closeTable = () => {
		if (inTable) {
			out.push('</table>');
			inTable = false;
		}
	};
	const closeBlockquote = () => {
		if (inBlockquote) {
			out.push('</blockquote>');
			inBlockquote = false;
		}
	};

	const inline = (text) => {
		let html = escapeHtml(text);
		// Links: [label](target). Target must be a safe URL or relative path;
		// javascript: and file: are refused.
		html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, target) => {
			const clean = target.trim();
			if (/^(javascript|file|data):/i.test(clean)) return escapeHtml(label);
			return `<a href="${clean}" rel="noopener noreferrer" target="_blank">${label}</a>`;
		});
		// Bold.
		html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
		// Italic.
		html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
		// Inline code.
		html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
		return html;
	};

	for (const rawLine of lines) {
		const line = rawLine;
		const trimmed = line.trim();

		// Fence toggles.
		if (/^```/.test(trimmed)) {
			if (!inFence) {
				closeList();
				closeTable();
				closeBlockquote();
				out.push('<pre><code>');
				inFence = true;
			} else {
				out.push('</code></pre>');
				inFence = false;
			}
			continue;
		}
		if (inFence) {
			out.push(escapeHtml(line));
			continue;
		}

		// Table row.
		if (trimmed.startsWith('|')) {
			if (!inTable) {
				closeList();
				closeBlockquote();
				out.push('<table>');
				inTable = true;
			}
			const isSeparator = /^[\s|:-]+$/.test(trimmed.replace(/\|/g, ''));
			if (isSeparator) continue;
			const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
			const tags = out[out.length - 1] === '<table>' ? 'th' : 'td';
			out.push('<tr>' + cells.map((cell) => `<${tags}>${inline(cell.trim())}</${tags}>`).join('') + '</tr>');
			continue;
		}
		closeTable();

		// Headings.
		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			closeList();
			closeBlockquote();
			const level = heading[1].length;
			out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
			continue;
		}

		// Blockquote.
		if (trimmed.startsWith('>')) {
			closeList();
			if (!inBlockquote) {
				out.push('<blockquote>');
				inBlockquote = true;
			}
			out.push(`<p>${inline(trimmed.replace(/^>\s?/, ''))}</p>`);
			continue;
		}
		closeBlockquote();

		// Lists.
		const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
		const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (unordered || ordered) {
			const kind = unordered ? 'ul' : 'ol';
			if (inList !== kind) {
				closeList();
				out.push(`<${kind}>`);
				inList = kind;
			}
			const content = (unordered ? unordered[1] : ordered[1]).trim();
			out.push(`<li>${inline(content)}</li>`);
			continue;
		}
		closeList();

		// Horizontal rule.
		if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
			closeBlockquote();
			out.push('<hr>');
			continue;
		}

		// Blank line: paragraph boundary.
		if (trimmed === '') {
			continue;
		}

		// Paragraph.
		out.push(`<p>${inline(line)}</p>`);
	}
	if (inFence) out.push('</code></pre>');
	closeList();
	closeTable();
	closeBlockquote();
	return out.join('\n');
}

/**
 * A safe document for one artifact.
 *
 * Markdown is converted; HTML is returned as the document body, to be wrapped
 * in the client's sandboxed iframe; anything else is shown as plain text.
 *
 * @param {object} artifact - the artifact record.
 * @param {string} text - the current content.
 * @returns `{ mode, html }` where mode is 'markdown', 'html' or 'text'.
 */
export function safeDocument(artifact, text) {
	if (typeof text !== 'string' || text === '') return { mode: 'text', html: '' };
	const format = artifact && typeof artifact.format === 'string' ? artifact.format : null;
	const name = artifact && typeof artifact.path === 'string' ? artifact.path : '';
	if (format === 'html' || name.endsWith('.html') || name.endsWith('.htm')) {
		return { mode: 'html', html: text };
	}
	if (isRenderableText(name) && name.endsWith('.txt')) {
		return { mode: 'text', html: `<pre class="lib-plain">${escapeHtml(text)}</pre>` };
	}
	return { mode: 'markdown', html: markdownToHtml(text) };
}

/**
 * Whether a document's text looks like it contains HTML elements. Used to
 * decide whether a `.html` file should be treated as an HTML artifact.
 * @param {string} text - the document body.
 * @returns true when it has a doctype or an html/body tag.
 */
export function looksLikeHtml(text) {
	if (typeof text !== 'string') return false;
	const head = text.slice(0, 512).toLowerCase();
	return head.includes('<!doctype html') || head.includes('<html') || head.includes('<body');
}
