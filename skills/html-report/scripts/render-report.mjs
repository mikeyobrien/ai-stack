#!/usr/bin/env node
/**
 * Render a Markdown report plus its evidence into one self-contained HTML page.
 *
 * Deterministic by construction: the same Markdown, the same assets, and the
 * same options produce the same bytes. No timestamps, no run ids, no random
 * ordering, and asset names are content hashes.
 *
 * The page carries no remote request and needs no reader-side JavaScript to
 * show content: diagrams are pre-rendered to SVG at build time, images are
 * copied next to the page (or inlined with --single), and every style is in
 * the document.
 *
 * Usage:
 *   node render-report.mjs <report.md> [options]
 *
 * Exit codes: 0 ok, 1 unresolved input, 2 bad usage.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const USAGE = `render-report.mjs — Markdown + evidence -> one HTML report

  node render-report.mjs <report.md> [--folder] [--out <path>] [--title <text>]
                         [--no-mermaid] [--quiet]

  --detailed      Editorial layout: a hero that states the decision, metric
                  cards, pull quotes, side-by-side evidence, numbered sections,
                  and a visual register chosen for the intended audience.
  --folder        Write index.html plus an assets/ directory instead of one
                  inline file. Use it for large evidence sets, opened from disk.
  --out <path>    Output .html file, or a directory for --folder.
                  Default: <report>.html, or <report>-report/ with --folder.
  --no-mermaid    Keep mermaid fences as code blocks instead of diagrams.
  --quiet         Print only problems.

  Exit codes: 0 ok, 1 unresolved input (missing image, failed diagram), 2 bad usage.
`;

/** Larger assets are copied, never base64-inlined, even under --single. */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;
const MERMAID_TIMEOUT_MS = 60_000;
const MERMAID_ATTEMPTS = 3;

/* ------------------------------------------------------------------ text */

/**
 * Escape text for HTML element content and quoted attributes.
 * @param value - raw text.
 * @returns escaped text.
 */
function esc(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Turn heading text into a stable, unique anchor id.
 * @param text - heading text.
 * @param used - ids already taken; mutated with the new id.
 * @returns anchor id.
 */
function slug(text, used) {
	const base =
		text
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'section';
	let id = base;
	let n = 2;
	while (used.has(id)) id = `${base}-${n++}`;
	used.add(id);
	return id;
}

/**
 * MIME type for an inlined asset.
 * @param file - source path.
 * @returns media type.
 */
function mimeOf(file) {
	const ext = extname(file).toLowerCase();
	return (
		{
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.gif': 'image/gif',
			'.webp': 'image/webp',
			'.avif': 'image/avif',
			'.svg': 'image/svg+xml',
		}[ext] || 'application/octet-stream'
	);
}

/* ------------------------------------------------------------ frontmatter */

/**
 * Split a leading YAML frontmatter block from the document body.
 *
 * Only flat scalar fields and one-level lists are read. That is the whole
 * contract: the format is documented in references/format.md, and anything
 * outside it is ignored rather than guessed at.
 * @param raw - whole file.
 * @returns frontmatter record, body, and body line offset.
 */
function frontmatter(raw) {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
	if (!match) return { data: {}, body: raw, offset: 0 };

	const data = {};
	for (const line of match[1].split(/\r?\n/)) {
		if (line.trim() === '' || line.trim().startsWith('#')) continue;
		const field = line.match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
		if (!field) continue;
		let value = field[2].trim();
		if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
		else if (value.startsWith('[') && value.endsWith(']')) {
			value = value
				.slice(1, -1)
				.split(',')
				.map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
				.filter(Boolean);
		}
		data[field[1]] = value;
	}
	return { data, body: raw.slice(match[0].length), offset: match[1].split(/\r?\n/).length + 2 };
}

/* ---------------------------------------------------------------- blocks */

/**
 * Split one table row into cells, honouring escaped pipes.
 * @param line - raw row.
 * @returns cell strings.
 */
function splitRow(line) {
	const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells = [];
	let cell = '';
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === '\\' && trimmed[i + 1] === '|') {
			cell += '|';
			i++;
		} else if (ch === '|') {
			cells.push(cell.trim());
			cell = '';
		} else {
			cell += ch;
		}
	}
	cells.push(cell.trim());
	return cells;
}

/** Lines that end a paragraph. */
const BLOCK_START = [/^#{1,6}\s/, /^\s*(```|~~~)/, /^\s*:::/, /^\s*>/, /^\s*(?:[-*+]|\d+[.)])\s+/];

/**
 * Whether a line starts a block rather than continuing a paragraph.
 * @param line - raw line.
 * @returns true when it opens a new block.
 */
function startsBlock(line) {
	return BLOCK_START.some((pattern) => pattern.test(line));
}

/**
 * Parse Markdown into a flat block list.
 *
 * The subset is deliberate: headings, paragraphs, fenced code, tables, lists,
 * quotes, rules, figures, and `::: kind Title` callouts. Anything else is
 * reported rather than rendered approximately.
 * @param body - Markdown without frontmatter.
 * @param lineOffset - source line number of `body`'s first line.
 * @returns blocks, problems, and figure references in document order.
 */
function parseBlocks(body, lineOffset = 0) {
	const lines = body.split(/\r?\n/);
	const blocks = [];
	const problems = [];

	/** @param index - zero-based line index. @returns source line number. */
	const lineNo = (index) => index + 1 + lineOffset;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		if (line.trim() === '') {
			i++;
			continue;
		}

		const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
		if (fence) {
			const marker = fence[1][0];
			const length = fence[1].length;
			const lang = fence[2] || '';
			const openAt = i;
			i++;
			const chunk = [];
			while (i < lines.length && !new RegExp(`^\\s*${marker}{${length},}\\s*$`).test(lines[i])) {
				chunk.push(lines[i]);
				i++;
			}
			if (i >= lines.length) problems.push(`${lineNo(openAt)}: unclosed code fence`);
			i++;
			blocks.push({ kind: 'code', lang, text: chunk.join('\n'), line: lineNo(openAt) });
			continue;
		}

		const callout = line.match(/^\s*:::[ \t]*(\w+)?[ \t]*(.*)$/);
		if (callout) {
			const openAt = i;
			i++;
			const chunk = [];
			while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
				chunk.push(lines[i]);
				i++;
			}
			if (i >= lines.length) problems.push(`${lineNo(openAt)}: unclosed callout`);
			i++;
			blocks.push({
				kind: 'callout',
				flavour: (callout[1] || 'note').toLowerCase(),
				title: callout[2].trim(),
				text: chunk.join('\n'),
				line: lineNo(openAt),
			});
			continue;
		}

		if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
			blocks.push({ kind: 'rule' });
			i++;
			continue;
		}

		const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (heading) {
			blocks.push({ kind: 'heading', depth: heading[1].length, text: heading[2], line: lineNo(i) });
			i++;
			continue;
		}

		if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
			const openAt = i;
			const head = splitRow(line);
			const align = splitRow(lines[i + 1]).map((cell) => {
				const left = cell.startsWith(':');
				const right = cell.endsWith(':');
				return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
			});
			i += 2;
			const rows = [];
			while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
				rows.push(splitRow(lines[i]));
				i++;
			}
			blocks.push({ kind: 'table', head, align, rows, line: lineNo(openAt) });
			continue;
		}

		if (/^\s*>\s?/.test(line)) {
			const openAt = i;
			const chunk = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
				chunk.push(lines[i].replace(/^\s*>\s?/, ''));
				i++;
			}
			blocks.push({ kind: 'quote', text: chunk.join('\n'), line: lineNo(openAt) });
			continue;
		}

		const bullet = line.match(/^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/);
		if (bullet) {
			const openAt = i;
			const ordered = Boolean(bullet[3]);
			const items = [];
			while (i < lines.length) {
				const item = lines[i].match(/^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/);
				if (!item) break;
				const depth = Math.min(2, Math.floor(item[1].replace(/\t/g, '  ').length / 2));
				items.push({ depth, text: item[4] });
				i++;
				while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
					items[items.length - 1].text += ` ${lines[i].trim()}`;
					i++;
				}
			}
			blocks.push({ kind: 'list', ordered, items, line: lineNo(openAt) });
			continue;
		}

		const openAt = i;
		const chunk = [];
		while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
			chunk.push(lines[i]);
			i++;
		}
		if (chunk.length === 0) {
			problems.push(`${lineNo(i)}: unrecognised line — ${line.trim().slice(0, 60)}`);
			i++;
			continue;
		}
		blocks.push({ kind: 'paragraph', text: chunk.join('\n'), line: lineNo(openAt) });
	}

	return { blocks, problems };
}

/* ---------------------------------------------------------------- inline */

/**
 * Render inline Markdown to HTML.
 *
 * Text is escaped first, then markers are matched on the escaped string; the
 * characters this subset uses survive escaping, so code spans cannot be
 * re-parsed and attribute values stay quoted.
 * @param text - inline Markdown.
 * @param ctx - render context, for image lookup.
 * @returns HTML.
 */
function inline(text, ctx) {
	let out = esc(text);

	out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
	out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (whole, alt, src, caption) => {
		const asset = ctx.assets.get(src);
		if (!asset) {
			ctx.unresolved.add(src);
			return `<code>${whole}</code>`;
		}
		return `<img class="inline-shot" src="${esc(asset.href)}" alt="${esc(alt)}"${
			caption ? ` title="${esc(caption)}"` : ''
		} loading="lazy">`;
	});
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
		if (/^https?:/i.test(href)) return `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`;
		if (/^#/.test(href)) return `<a href="${href}">${label}</a>`;
		return `<a href="${href.replace(/\.md$/i, '.html')}">${label}</a>`;
	});
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
	out = out.replace(/\*\*/g, '');
	return out;
}

/* ---------------------------------------------------------------- assets */

/**
 * Read an image's intrinsic pixel size without a decoder dependency.
 * @param file - absolute path.
 * @param bytes - its contents.
 * @returns `{width, height}` or undefined when unknown.
 */
function imageSize(file, bytes) {
	const ext = extname(file).toLowerCase();
	if (ext === '.png' && bytes.length > 24 && bytes.toString('ascii', 12, 16) === 'IHDR') {
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}
	if (ext === '.gif' && bytes.length > 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
	if (ext === '.svg') {
		const head = bytes.toString('utf8', 0, Math.min(bytes.length, 4096));
		const w = head.match(/\bwidth=["']([\d.]+)(?:px)?["']/);
		const h = head.match(/\bheight=["']([\d.]+)(?:px)?["']/);
		if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
		const box = head.match(/viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/);
		if (box) return { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) };
	}
	return undefined;
}

/**
 * Resolve every image reference in the document to a page-relative URL or a
 * data URI, copying or inlining the bytes as required.
 * @param ctx - render context.
 * @param references - `{src, line}` in document order.
 */
async function resolveImages(ctx, references) {
	for (const { src, line } of references) {
		if (ctx.assets.has(src)) continue;

		if (/^(https?:|data:)/i.test(src)) {
			ctx.assets.set(src, { href: src, remote: true, group: 'remote' });
			ctx.problems.push(`${line}: remote image cannot be inlined for offline reading: ${src}`);
			continue;
		}

		const file = resolve(dirname(ctx.inputPath), decodeURI(src));
		let bytes;
		try {
			if (!(await stat(file)).isFile()) throw new Error('not a file');
			bytes = await readFile(file);
		} catch {
			ctx.problems.push(`${line}: image not found: ${src}`);
			ctx.assets.set(src, undefined);
			continue;
		}

		const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
		const stem = basename(file, extname(file)).replace(/[^a-zA-Z0-9._-]+/g, '-');
		const name = `${stem}-${digest}${extname(file).toLowerCase()}`;
		const size = imageSize(file, bytes);
		const group = relative(dirname(ctx.inputPath), dirname(file)).split(sep)[0] || 'evidence';

		let href;
		if (ctx.single && bytes.length <= MAX_INLINE_BYTES) {
			href = `data:${mimeOf(file)};base64,${bytes.toString('base64')}`;
		} else {
			if (ctx.single) ctx.problems.push(`${line}: ${src} is too large to inline (${bytes.length} bytes); copied to assets/`);
			href = `assets/${name}`;
			ctx.copies.set(name, bytes);
		}

		ctx.assets.set(src, { href, width: size?.width, height: size?.height, group, name });
	}
}

/**
 * Find every image reference in the source, with its line number.
 * @param body - Markdown body.
 * @param lineOffset - source line offset.
 * @returns `{src, line}` list.
 */
function imageReferences(body, lineOffset) {
	const found = [];
	body.split(/\r?\n/).forEach((line, index) => {
		const pattern = /!\[[^\]]*\]\(([^)\s]+)/g;
		let match;
		while ((match = pattern.exec(line))) found.push({ src: match[1], line: index + 1 + lineOffset });
	});
	return found;
}

/* --------------------------------------------------------------- mermaid */

/**
 * Locate a Mermaid UMD build: explicit env var, vendored copy, then any
 * install reachable from the working directory.
 * @returns absolute path or undefined.
 */
function findMermaid() {
	return [
		process.env.HTML_REPORT_MERMAID,
		join(here, '..', 'vendor', 'mermaid.min.js'),
		join(process.cwd(), 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
	].find((candidate) => candidate && existsSync(candidate));
}

/**
 * Find a headless browser usable for pre-rendering diagrams.
 * @returns executable path or undefined.
 */
function findBrowser() {
	const candidates = [process.env.HTML_REPORT_CHROMIUM, 'chromium', 'chromium-browser', 'google-chrome'].filter(Boolean);
	for (const candidate of candidates) {
		if (candidate.includes(sep)) {
			if (existsSync(candidate)) return candidate;
			continue;
		}
		try {
			const found = execFileSync('which', [candidate], { encoding: 'utf8' }).trim();
			if (found) return found;
		} catch {
			/* not installed */
		}
	}
	return undefined;
}

/**
 * Normalise Mermaid's SVG so it renders the same in a browser and in an
 * image pipeline: preserve the leading spaces it splits across sibling
 * tspans, and pin a concrete font stack (a CSS variable would not resolve
 * inside an <img>).
 * @param svg - raw SVG markup.
 * @returns tidied SVG markup.
 */
function tidySvg(svg) {
	return svg
		.replace(/<tspan([^>]*)> /g, '<tspan$1 xml:space="preserve"> ')
		.replace(/<svg([^>]*?)>/, (whole, attrs) => {
			// Give the root an intrinsic size so the image lays out before it
			// is decoded and so a thumbnail can scale it predictably.
			const box = attrs.match(/viewBox=["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/);
			const width = Math.ceil(Number(box?.[1] || 800));
			const height = Math.ceil(Number(box?.[2] || 600));
			const stripped = attrs.replace(/\s(?:width|height|style)=["'][^"']*["']/g, '');
			return `<svg${stripped} width="${width}" height="${height}">`;
		})
		.replace(
			/font-family:\s*"trebuchet ms",\s*verdana,\s*arial,\s*sans-serif/gi,
			'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Liberation Sans",Arial,sans-serif',
		)
		.replace(/>\s+</g, '><')
		.trim();
}

/**
 * Pre-render one Mermaid diagram to standalone SVG in a headless browser.
 *
 * Build-time rendering keeps the report free of reader-side JavaScript and
 * turns each diagram into a real file the sidebar can preview.
 * @param source - mermaid source.
 * @param index - diagram number, also the stable render id.
 * @param browser - browser executable.
 * @param mermaidPath - Mermaid UMD build.
 * @returns SVG markup.
 */
async function renderMermaid(source, index, browser, mermaidPath) {
	const id = `d${index}`;
	const harness = `<!doctype html><meta charset="utf-8"><body>
<pre id="src">${esc(source)}</pre>
<div id="slot"></div>
<script src="file://${mermaidPath}"></script>
<script>
(async () => {
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } });
    const { svg } = await mermaid.render(${JSON.stringify(id)}, document.getElementById('src').textContent);
    document.getElementById('slot').innerHTML = svg;
    document.title = 'ok';
  } catch (error) {
    document.title = 'ERR|' + (error && error.message || error);
  }
})();
</script>`;

	const work = join(tmpdir(), `dsh-report-${process.pid}`);
	await mkdir(work, { recursive: true });
	const harnessPath = join(work, `${id}.html`);
	await writeFile(harnessPath, harness, 'utf8');

	let lastError = 'no output';
	try {
		for (let attempt = 0; attempt < MERMAID_ATTEMPTS; attempt++) {
			let dom = '';
			try {
				const result = await runAsync(
					browser,
					['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=15000', '--dump-dom', `file://${harnessPath}`],
					{ encoding: 'utf8', timeout: MERMAID_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
				);
				dom = result.stdout;
			} catch (error) {
				lastError = error.message;
				continue;
			}
			const title = dom.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
			if (title.startsWith('ERR|')) throw new Error(`mermaid rejected the diagram: ${title.slice(4).trim()}`);
			const svg = dom.match(/<svg[\s\S]*?<\/svg>/);
			if (svg) return tidySvg(svg[0]);
			lastError = 'browser produced no <svg>';
		}
	} finally {
		await rm(work, { recursive: true, force: true });
	}
	throw new Error(`diagram did not render after ${MERMAID_ATTEMPTS} attempts (${lastError})`);
}

/* ---------------------------------------------------------------- render */


/**
 * Render a `::: metrics` block.
 *
 * Each item is `value | label | note`. A signed percentage in the note draws
 * a bar whose length is the magnitude, so a row of numbers reads as a shape.
 * @param block - the parsed callout.
 * @param md - inline renderer.
 * @returns HTML.
 */
function renderMetrics(block, md) {
	const items = block.text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*+]\s+/, '').trim())
		.filter(Boolean)
		.map((line) => {
			const [value = '', label = '', note = ''] = line.split('|').map((part) => part.trim());
			return { value, label, note };
		});

	const cards = items.map((item) => {
		const delta = item.note.match(/([+-]\d+(?:\.\d+)?)\s*%/);
		const bar = delta
			? `<span class="bar"><span class="${Number(delta[1]) >= 0 ? 'up' : 'down'}" style="width:${Math.min(
					100,
					Math.abs(Number(delta[1])),
				)}%"></span></span>`
			: '';
		return `<li><p class="metric-value">${md(item.value)}</p><p class="metric-label">${md(item.label)}</p>${
			item.note ? `<p class="metric-note">${md(item.note)}</p>` : ''
		}${bar}</li>`;
	});

	return `<ul class="metrics">${cards.join('')}</ul>`;
}

/**
 * Render the block list to HTML and collect the outline.
 * @param blocks - parsed blocks.
 * @param ctx - render context.
 * @returns body HTML, outline entries, and figure records.
 */
function renderBlocks(blocks, ctx) {
	const used = new Set();
	const out = [];
	const toc = [];
	const figures = [];

	/** @param text - inline markdown. @returns HTML. */
	const md = (text) => inline(text, ctx);

	/**
	 * Render a list tree, nesting by depth.
	 * @param nodes - tree nodes.
	 * @param ordered - whether this level is ordered.
	 * @returns HTML.
	 */
	const renderList = (nodes, ordered) => {
		if (nodes.length === 0) return '';
		const tag = ordered ? 'ol' : 'ul';
		return `<${tag}>${nodes
			.map((node) => `<li>${md(node.text)}${renderList(node.children, ordered)}</li>`)
			.join('')}</${tag}>`;
	};

	for (const block of blocks) {
		switch (block.kind) {
			case 'heading': {
				// The page header already carries the title; a body h1 is dropped
				// so the document never shows two top-level headings.
				if (block.depth === 1) break;
				const id = slug(block.text, used);
				toc.push({ id, depth: block.depth, text: block.text });
				const tag = `h${Math.min(block.depth, 4)}`;
				out.push(`<${tag} id="${id}">${md(block.text)}</${tag}>`);
				break;
			}
			case 'paragraph':
				out.push(`<p>${md(block.text.replace(/\s*\n\s*/g, ' '))}</p>`);
				break;
			case 'rule':
				out.push('<hr>');
				break;
			case 'quote':
				out.push(`<blockquote>${md(block.text.replace(/\s*\n\s*/g, ' '))}</blockquote>`);
				break;
			case 'code':
				out.push(`<pre class="code"><code${block.lang ? ` data-lang="${esc(block.lang)}"` : ''}>${esc(block.text)}</code></pre>`);
				break;
			case 'callout': {
				if (block.flavour === 'metrics') {
					out.push(renderMetrics(block, md));
					break;
				}
				if (block.flavour === 'quote') {
					out.push(
						`<figure class="pullquote"><blockquote>${md(block.text.replace(/\s*\n\s*/g, ' '))}</blockquote>${
							block.title ? `<figcaption>${md(block.title)}</figcaption>` : ''
						}</figure>`,
					);
					break;
				}
				if (block.flavour === 'compare') {
					const shots = [...block.text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g)].slice(0, 4);
					if (shots.length < 2) {
						ctx.problems.push(`${block.line}: compare needs two images`);
						break;
					}
					const cells = shots.map((shot) => {
						const asset = ctx.assets.get(shot[2]);
						if (!asset) return '';
						const n = figures.length + 1;
						figures.push({ src: shot[2], alt: shot[1], caption: shot[3] || shot[1], ...asset, n });
						return `<figure id="fig-${n}"><a href="${esc(asset.href)}" data-zoom><img src="${esc(asset.href)}" alt="${esc(
							shot[1],
						)}" loading="lazy"></a>${shot[1] ? `<figcaption>${md(shot[1])}</figcaption>` : ''}</figure>`;
					});
					out.push(`<div class="compare cols-${cells.length}">${cells.join('')}</div>`);
					break;
				}
				const flavour = ['note', 'warn', 'good'].includes(block.flavour) ? block.flavour : 'note';
				out.push(
					`<aside class="callout ${flavour}">${
						block.title ? `<p class="callout-title">${md(block.title)}</p>` : ''
					}${md(block.text.replace(/\s*\n\s*/g, ' '))}</aside>`,
				);
				break;
			}
			case 'table': {
				const CHIPS = {
					pass: 'ok', ok: 'ok', yes: 'ok', done: 'ok',
					fail: 'bad', error: 'bad', no: 'bad', blocked: 'bad',
					warn: 'warn', pending: 'warn',
					skipped: 'muted',
				};
				const cell = (tag, value, index) => {
					const align = block.align[index] ? ` style="text-align:${block.align[index]}"` : '';
					const text = (value ?? '').trim();
					const chip = ctx.detailed ? CHIPS[text.toLowerCase()] : undefined;
					if (chip) return `<${tag}${align}><span class="chip ${chip}">${esc(text)}</span></${tag}>`;
					return `<${tag}${align}>${md(text)}</${tag}>`;
				};
				const head = block.head.map((value, index) => cell('th', value, index)).join('');
				const rows = block.rows.map((row) => `<tr>${block.head.map((_, index) => cell('td', row[index], index)).join('')}</tr>`).join('');
				out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`);
				break;
			}
			case 'list': {
				const root = [];
				const stack = [{ depth: -1, children: root }];
				for (const item of block.items) {
					while (stack.length > 1 && item.depth <= stack[stack.length - 1].depth) stack.pop();
					const node = { text: item.text, children: [] };
					stack[stack.length - 1].children.push(node);
					stack.push({ depth: item.depth, children: node.children });
				}
				out.push(renderList(root, block.ordered));
				break;
			}
			case 'figure': {
				const figure = block.figure;
				const asset = ctx.assets.get(figure.src);
				if (!asset) break;
				// A diagram is self-describing; only an authored alt or a
				// "title" on the link is worth printing under it.
				const caption = figure.diagram ? figure.caption : figure.caption || figure.alt;
				const dims = asset.width && asset.height ? ` width="${asset.width}" height="${asset.height}"` : '';
				const n = figures.length + 1;
				figures.push({ ...figure, ...asset, n });
				out.push(
					`<figure id="fig-${n}"${figure.diagram ? ' class="diagram"' : ''}><a href="${esc(asset.href)}" data-zoom><img src="${esc(
						asset.href,
					)}" alt="${esc(figure.alt || caption || '')}"${dims} loading="lazy"></a>${
						caption ? `<figcaption>${md(caption)}</figcaption>` : ''
					}</figure>`,
				);
				break;
			}
			default:
				break;
		}
	}

	return { html: out.join('\n'), toc, figures };
}

/**
 * The page template. One fixed shell; the writing agent never authors HTML.
 * @param model - document model.
 * @returns full HTML document.
 */
function template(model) {
	const { title, subtitle, status, date, source, audience, decision, lede, detailed, register, body, toc, groups } =
		model;

	const tocItems = toc
		.map((item) => `<li class="d${Math.min(item.depth, 3)}"><a href="#${item.id}">${esc(item.text.replace(/[*`]/g, ''))}</a></li>`)
		.join('');

	const thumb = (item) =>
		`<li><a href="#fig-${item.n}"><img src="${esc(item.href)}" alt="" loading="lazy"><span>${esc(
			(item.caption || item.alt || item.src).slice(0, 70),
		)}</span></a></li>`;

	// The section header already says "Evidence", so the default group needs
	// no heading of its own; other folders and diagrams keep one.
	const shelf = groups
		.map(([group, items]) => {
			const list = `<ul class="thumbs">${items.map(thumb).join('')}</ul>`;
			if (group === 'evidence') return list;
			const label = group === 'diagrams' ? 'Diagrams' : group;
			return `<section class="shelf-group"><h3>${esc(label)}<span class="count">${items.length}</span></h3>${list}</section>`;
		})
		.join('');

	return `<!doctype html>
<html lang="en"${detailed ? ` data-detailed="true" data-register="${esc(register)}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  /* Warm off-white and off-black: never pure #fff on #000. */
  --bg: #fbfaf7;
  --panel: #f4f2ec;
  --ink: #1b1b19;
  --muted: #6b6a64;
  --line: #e4e1d9;
  --accent: oklch(52% 0.13 255);
  --warn: oklch(55% 0.12 62);
  --good: oklch(50% 0.11 150);

  /* One ratio, 1.25, on a 17px base. */
  --fs-xs: 12px;
  --fs-sm: 14px;
  --fs-body: 17px;
  --fs-h3: 21px;
  --fs-h2: 26px;
  --fs-h1: 33px;

  --measure: 66ch;
  --bleed: 900px;
  --radius: 10px;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --serif: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12120f;
    --panel: #1a1a16;
    --ink: #e9e7df;
    --muted: #9c9a90;
    --line: #2b2b25;
    --accent: oklch(76% 0.11 250);
    --warn: oklch(78% 0.12 70);
    --good: oklch(76% 0.12 150);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: var(--fs-body)/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration-thickness: .06em; text-underline-offset: .16em; }
::selection { background: color-mix(in oklab, var(--accent) 22%, transparent); }
.layout { display: grid; grid-template-columns: 272px minmax(0, 1fr); min-height: 100vh; }
.layout > * { min-width: 0; }

.side { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
  padding: 28px 18px 40px 24px; border-right: 1px solid var(--line); background: var(--panel); }
.side-brand { font-size: 13px; font-weight: 650; line-height: 1.35; margin: 0 0 22px; text-wrap: balance; }
.side h2 { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); margin: 26px 0 8px; }
.toc { list-style: none; margin: 0; padding: 0; max-height: 42vh; overflow-y: auto; scrollbar-width: thin; }
.toc a { display: block; padding: 3px 8px 3px 10px; margin-left: -10px; border-left: 2px solid transparent;
  color: var(--ink); text-decoration: none; font-size: 13px; line-height: 1.45; text-wrap: pretty; }
.toc a:hover { background: color-mix(in oklab, var(--accent) 8%, transparent); }
.toc a.active { border-left-color: var(--accent); color: var(--accent); font-weight: 550; }
.toc .d3 a, .toc .d4 a { padding-left: 22px; font-size: 12.5px; color: var(--muted); }
.toc .d3 a.active, .toc .d4 a.active { color: var(--ink); }

.shelf-group { margin: 0 0 16px; }
.shelf-group h3 { font-size: 11px; font-weight: 600; color: var(--muted); margin: 0 0 6px;
  display: flex; justify-content: space-between; gap: 8px; }
.count { font-variant-numeric: tabular-nums; opacity: .7; }
.thumbs { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.thumbs a { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 9px; align-items: center;
  text-decoration: none; color: var(--ink); padding: 3px; border-radius: 7px; }
.thumbs a:hover, .thumbs a:focus-visible { background: color-mix(in oklab, var(--accent) 9%, transparent); }
.thumbs img { width: 64px; height: 42px; object-fit: cover; object-position: top left;
  border: 1px solid var(--line); border-radius: 5px; background: #fff; }
.thumbs img[src$=".svg"], .thumbs img[src^="data:image/svg"] { object-position: center; }
.thumbs span { font-size: 11.5px; line-height: 1.35; color: var(--muted);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* Prose holds a readable measure; evidence is allowed to be wider than the
   text, which is the whole reason the page is not one column of 66ch. */
/* The text column is centred at a reading measure; evidence bleeds to both
   sides by the same amount, so the page has symmetry instead of a gutter. */
main { width: 100%; max-width: var(--measure); margin-inline: auto; padding: 56px 0 128px; }
main > figure, main > .table-wrap, main > pre.code, main > .metrics,
main > .compare {
  width: min(var(--bleed), 100vw - 336px);
  margin-inline: calc((min(var(--bleed), 100vw - 336px) - 100%) / -2);
}

.head { margin-block: 0 32px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.meta { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px;
  font-size: var(--fs-xs); color: var(--muted); }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
  border: 1px solid var(--line); background: color-mix(in oklab, var(--accent) 10%, transparent); color: var(--accent); }
h1 { font-size: var(--fs-h1); line-height: 1.2; margin: 0 0 8px; letter-spacing: -.02em; font-weight: 680;
  text-wrap: balance; }
.sub { font-size: var(--fs-sm); color: var(--muted); margin: 0; }
h2 { scroll-margin-top: 24px; font-size: var(--fs-h2); line-height: 1.25; margin: 48px 0 16px;
  letter-spacing: -.015em; font-weight: 650; padding-top: 16px; border-top: 1px solid var(--line);
  text-wrap: balance; }
h3 { scroll-margin-top: 24px; font-size: var(--fs-h3); line-height: 1.3; margin: 32px 0 8px;
  font-weight: 640; text-wrap: balance; }
h4 { font-size: var(--fs-body); margin: 24px 0 8px; font-weight: 650; }
p { margin: 0 0 16px; text-wrap: pretty; }
ul, ol { margin: 0 0 16px; padding-left: 24px; text-wrap: pretty; }
li { margin: 4px 0; }
li > ul, li > ol { margin: 4px 0; }
code { font-family: var(--mono); font-size: .84em; background: color-mix(in oklab, var(--ink) 7%, transparent);
  padding: .12em .38em; border-radius: 4px; white-space: nowrap; }
pre.code { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 16px 18px; overflow-x: auto; margin-block: 0 24px; }
pre.code code { background: none; padding: 0; font-size: 13.5px; line-height: 1.6; white-space: pre; }
blockquote { margin: 0 0 16px; padding: 2px 0 2px 20px; border-left: 3px solid var(--line); color: var(--muted);
  text-wrap: pretty; }
.callout { margin: 0 0 24px; padding: 14px 16px; border-radius: var(--radius); border: 1px solid var(--line);
  border-left: 3px solid var(--accent); background: color-mix(in oklab, var(--accent) 5%, transparent); }
.callout.warn { border-left-color: var(--warn); background: color-mix(in oklab, var(--warn) 7%, transparent); }
.callout.good { border-left-color: var(--good); background: color-mix(in oklab, var(--good) 7%, transparent); }
.callout-title { font-weight: 640; margin: 0 0 4px; font-size: var(--fs-sm); }
.callout p:last-child { margin-bottom: 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0; }

.table-wrap { overflow-x: auto; margin-block: 0 24px; }
table { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 640; font-size: 12px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--muted); white-space: nowrap; }
td { font-variant-numeric: tabular-nums; }
tbody tr:hover { background: color-mix(in oklab, var(--ink) 3%, transparent); }

/* Figures take the full content width; the caption sits under the image at a
   narrower measure so it reads as a caption, not a paragraph. */
figure { scroll-margin-top: 24px; margin-block: 0 32px; }
figure > a { display: block; border: 1px solid var(--line); border-radius: var(--radius);
  overflow: hidden; background: #fff; cursor: zoom-in; }
figure img { display: block; width: auto; max-width: 100%; height: auto; background: #fff; }
figure figcaption { padding: 10px 2px 0; max-width: 58ch; font-size: 13px; line-height: 1.5;
  color: var(--muted); text-wrap: pretty; }
figure.diagram > a { padding: 24px; }
figure.diagram img { margin: 0 auto; }
.origin { margin: 48px 0 0; padding-top: 16px; border-top: 1px solid var(--line);
  font-size: var(--fs-xs); color: var(--muted); }
.inline-shot { max-height: 22px; vertical-align: middle; border-radius: 3px; }

#zoom { position: fixed; inset: 0; z-index: 50; display: none; background: #000000d1; padding: 3vh 4vw; cursor: zoom-out; }
#zoom.open { display: grid; place-items: center; }
#zoom img { max-width: 100%; max-height: 94vh; border-radius: 6px; background: #fff; box-shadow: 0 12px 48px #0009; }

@media (max-width: 1180px) {
  :root { --bleed: 780px; }
}
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .side { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 20px; }
  .thumbs { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  main { max-width: none; margin-inline: 0; padding: 28px 20px 80px; }
  main > figure, main > .table-wrap, main > pre.code, main > .metrics,
  main > .compare { width: auto; margin-inline: 0; }
  h1 { font-size: 26px; }
}

/* --- detailed mode: hero, metrics, quotes, compares, registers ---------- */
[data-detailed] main { padding-top: 0; }
.hero { margin-block: 0 40px; padding: 48px 0 32px; border-bottom: 2px solid var(--ink); }
.eyebrow { font-size: var(--fs-xs); letter-spacing: .14em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 20px; font-weight: 600; }
.eyebrow .dot { opacity: .45; margin: 0 .35em; }
.eyebrow .eb:not(:first-child) { white-space: nowrap; }
.hero h1 { font-size: clamp(34px, 4.4vw, 46px); line-height: 1.05; letter-spacing: -.03em; margin: 0 0 14px; }
.hero .sub { font-size: var(--fs-sm); }
.lede { font-size: 21px; line-height: 1.45; margin: 18px 0 0; max-width: 44ch;
  text-wrap: pretty; color: var(--ink); }
.decision { margin: 26px 0 0; max-width: 64ch; padding: 16px 20px; border-left: 3px solid var(--accent);
  background: color-mix(in oklab, var(--accent) 7%, transparent);
  font-size: 17px; line-height: 1.5; }
.decision span { display: block; font-size: 11px; font-weight: 700; letter-spacing: .14em;
  text-transform: uppercase; color: var(--accent); margin-bottom: 4px; }

.metrics { list-style: none; margin-block: 0 32px; padding: 0; display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); direction: ltr; }
.metrics li { padding: 16px 18px 18px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--panel); }
.metric-value { font-size: 30px; line-height: 1.1; font-weight: 680; letter-spacing: -.02em;
  margin: 0 0 6px; font-variant-numeric: tabular-nums; }
.metric-label { font-size: 12px; line-height: 1.35; color: var(--muted); margin: 0; }
.metric-note { font-size: 12px; line-height: 1.35; color: var(--muted); margin: 6px 0 0;
  font-variant-numeric: tabular-nums; }
.metrics .bar { display: block; height: 3px; margin-top: 12px; background: color-mix(in oklab, var(--ink) 10%, transparent);
  border-radius: 2px; overflow: hidden; }
.metrics .bar span { display: block; height: 100%; background: var(--accent); }
.metrics .bar span.down { background: var(--warn); }

figure.pullquote { margin-block: 40px; padding: 0 0 0 24px; border-left: 3px solid var(--accent); }
figure.pullquote blockquote { margin: 0; border: 0; padding: 0; color: var(--ink);
  font-family: var(--serif); font-size: 24px; line-height: 1.35; font-style: italic; }
figure.pullquote figcaption { padding: 10px 0 0; font-size: 12px; letter-spacing: .08em;
  text-transform: uppercase; }

.compare { display: grid; gap: 20px; margin-block: 0 32px; align-items: start; }
.compare.cols-2 { grid-template-columns: 1fr 1fr; }
.compare.cols-3 { grid-template-columns: repeat(3, 1fr); }
.compare.cols-4 { grid-template-columns: 1fr 1fr; }
.compare figure { margin: 0; }
.compare figcaption { padding: 10px 2px 0; font-size: 12.5px; }

.chip { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px;
  font-weight: 600; line-height: 1.7; white-space: nowrap;
  border: 1px solid color-mix(in oklab, currentColor 30%, transparent); }
.chip.ok { color: var(--good); background: color-mix(in oklab, var(--good) 12%, transparent); }
.chip.bad { color: var(--warn); background: color-mix(in oklab, var(--warn) 12%, transparent); }
.chip.warn { color: var(--warn); background: color-mix(in oklab, var(--warn) 8%, transparent); }
.chip.muted { color: var(--muted); background: color-mix(in oklab, var(--muted) 10%, transparent); }

[data-detailed] main { counter-reset: section; }
[data-detailed] main > h2 { counter-increment: section; }
[data-detailed] main > h2::before { content: counter(section, decimal-leading-zero); display: block;
  font-size: 12px; letter-spacing: .16em; color: var(--muted); margin-bottom: 6px; font-weight: 600; }

/* Registers: the same structure spoken in four voices. */
[data-register="paper"] { --radius: 6px; }
[data-register="paper"] main h1, [data-register="paper"] main h2, [data-register="paper"] main h3,
[data-register="paper"] figure.pullquote blockquote, [data-register="paper"] .metric-value {
  font-family: var(--serif); font-weight: 600; letter-spacing: -.01em; }
[data-register="paper"] .hero h1 { letter-spacing: -.02em; }

[data-register="instrument"] { --bg: #f7f8f9; --panel: #eef0f2; --ink: #14171a; --muted: #5d646c;
  --line: #dde1e6; --accent: oklch(50% 0.14 250); --radius: 3px; }
@media (prefers-color-scheme: dark) {
  [data-register="instrument"] { --bg: #0d1013; --panel: #151a1f; --ink: #e6e9ec; --muted: #949ca6;
    --line: #232a31; --accent: oklch(74% 0.12 250); }
}
[data-register="instrument"] body { font-size: 16px; }
[data-register="instrument"] .eyebrow, [data-register="instrument"] th,
[data-register="instrument"] .metric-label { font-family: var(--mono); letter-spacing: .08em; }
[data-register="instrument"] .metric-value { font-family: var(--mono); font-size: 26px; font-weight: 600; }
[data-register="instrument"] .hero { border-bottom-width: 1px; }
[data-register="instrument"] main h1 { font-weight: 620; letter-spacing: -.015em; }

[data-register="blueprint"] { --bg: #f6f8fb; --panel: #eaf0f7; --ink: #12202e; --muted: #5a6b7d;
  --line: #d3dfeb; --accent: oklch(46% 0.13 240); --radius: 2px; }
@media (prefers-color-scheme: dark) {
  [data-register="blueprint"] { --bg: #0b1218; --panel: #111c26; --ink: #dce8f2; --muted: #8ba1b5;
    --line: #1d2c3a; --accent: oklch(78% 0.1 235); }
}
[data-register="blueprint"] .eyebrow { font-family: var(--mono); color: var(--accent); }
[data-register="blueprint"] main h2 { border-top: 1px solid var(--accent); }
[data-register="blueprint"] .metrics li { background: transparent; border-style: dashed; }
[data-register="blueprint"] figure > a, [data-register="blueprint"] figure.diagram > a { border-color: var(--accent); }

[data-register="editorial"] { --radius: 2px; }
[data-register="editorial"] .hero { border-bottom: 1px solid var(--line); margin-bottom: 48px; }
[data-register="editorial"] .hero h1 { font-family: var(--serif); font-size: clamp(38px, 5vw, 54px);
  font-weight: 600; letter-spacing: -.025em; line-height: 1.02; }
[data-register="editorial"] main h2 { font-family: var(--serif); font-size: 30px; font-weight: 600;
  letter-spacing: -.015em; border-top: 1px solid var(--line); }
[data-register="editorial"] main h3 { font-family: var(--serif); font-size: 23px; font-weight: 600; }
[data-register="editorial"] main > p:first-of-type::first-letter { float: left; font-family: var(--serif);
  font-size: 58px; line-height: .82; padding: 6px 10px 0 0; font-weight: 600; }
[data-register="editorial"] .lede { font-family: var(--serif); font-size: 23px; font-style: italic; }
[data-register="editorial"] .metrics li { background: transparent; border-width: 1px 0 0; border-radius: 0; }
[data-register="editorial"] .metric-value { font-family: var(--serif); font-size: 34px; }

@media (max-width: 900px) {
  .hero { padding: 32px 0 24px; }
  .lede { font-size: 19px; }
  .compare.cols-2, .compare.cols-3, .compare.cols-4 { grid-template-columns: 1fr; }
  .metrics { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
}

@media print {
  .layout { display: block; }
  .side, #zoom { display: none; }
  main { padding: 0; max-width: none; }
  figure, table, .callout { break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
}
</style>
</head>
<body>
<div class="layout">
  <nav class="side" aria-label="Report sections">
    <p class="side-brand">${esc(title)}</p>
    ${tocItems ? `<h2>Contents</h2><ul class="toc">${tocItems}</ul>` : ''}
    ${shelf ? `<h2>Evidence</h2>${shelf}` : ''}
  </nav>
  <main>
${detailed
			? `<header class="hero">
      <p class="eyebrow">${[audience, status, date]
					.filter(Boolean)
					.map((part) => `<span class="eb">${esc(part)}</span>`)
					.join('<span class="dot">·</span>')}</p>
      <h1>${esc(title)}</h1>
      ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
      ${lede ? `<p class="lede">${esc(lede)}</p>` : ''}
      ${decision ? `<p class="decision"><span>The ask</span>${esc(decision)}</p>` : ''}
    </header>`
			: `<header class="head">
      <div class="meta">
        ${status ? `<span class="badge">${esc(status)}</span>` : ''}
        ${date ? `<span>${esc(date)}</span>` : ''}
      </div>
      <h1>${esc(title)}</h1>
      ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
    </header>`}
${body}
${source ? `    <footer class="origin">${esc(source)}</footer>` : ''}
  </main>
</div>
<div id="zoom" aria-hidden="true"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt=""></div>
<script>
(function () {
  var zoom = document.getElementById('zoom');
  var big = zoom.querySelector('img');
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var shot = target.closest('figure a[data-zoom]');
    if (shot) {
      event.preventDefault();
      big.src = shot.getAttribute('href');
      var thumb = shot.querySelector('img');
      big.alt = thumb ? thumb.alt : '';
      zoom.classList.add('open');
      return;
    }
    if (target === zoom) {
      zoom.classList.remove('open');
      return;
    }

    // Fragment links are scrolled here rather than left to the browser: a
    // host that injects <base> resolves "#id" against its own URL, so the
    // native jump either navigates away or does nothing.
    var link = target.closest('a[href^="#"]');
    if (!link) return;
    var section = document.getElementById(link.getAttribute('href').slice(1));
    if (!section) return;
    event.preventDefault();
    section.scrollIntoView({ block: 'start' });
    try { history.replaceState(null, '', link.getAttribute('href')); } catch (error) { /* cross-origin base */ }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') zoom.classList.remove('open');
  });
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  var targets = links.map(function (link) { return document.getElementById(link.getAttribute('href').slice(1)); });
  if ('IntersectionObserver' in window && targets.length && targets.every(Boolean)) {
    var seen = new Set();
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { entry.isIntersecting ? seen.add(entry.target) : seen.delete(entry.target); });
      var first = targets.filter(function (target) { return seen.has(target); })[0];
      links.forEach(function (link) {
        link.classList.toggle('active', Boolean(first) && link.getAttribute('href') === '#' + first.id);
      });
    }, { rootMargin: '0px 0px -72% 0px' });
    targets.forEach(function (target) { observer.observe(target); });
  }
})();
</script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ main */

/**
 * Parse argv into an options record.
 * @param argv - arguments after the script.
 * @returns options, or undefined when help was requested.
 */
function options(argv) {
	const opts = { single: true, mermaid: true, detailed: false, quiet: false, out: undefined, title: undefined, input: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') return undefined;
		else if (arg === '--single') opts.single = true;
		else if (arg === '--folder') opts.single = false;
		else if (arg === '--detailed') opts.detailed = true;
		else if (arg === '--no-mermaid') opts.mermaid = false;
		else if (arg === '--quiet') opts.quiet = true;
		else if (arg === '--out' || arg === '--title') {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} needs a value`);
			if (arg === '--out') opts.out = value;
			else opts.title = value;
		} else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
		else if (!opts.input) opts.input = arg;
		else throw new Error(`unexpected argument: ${arg}`);
	}
	if (!opts.input) throw new Error('missing <report.md>');
	return opts;
}

/**
 * Build one report.
 * @param opts - parsed options.
 */
async function main(opts) {
	const inputPath = resolve(opts.input);
	let raw;
	try {
		raw = await readFile(inputPath, 'utf8');
	} catch {
		throw new Error(`cannot read ${opts.input}`);
	}

	const { data, body, offset } = frontmatter(raw);
	const { blocks, problems } = parseBlocks(body, offset);
	const readingTitle = blocks.find((block) => block.kind === 'heading' && block.depth === 1)?.text;
	const title = opts.title || data.title || readingTitle || basename(inputPath, '.md');

	// The register is the page's visual voice. It follows the stated audience
	// when the report names one, and stays out of the way otherwise.
	const REGISTERS = ['paper', 'instrument', 'blueprint', 'editorial'];
	const stated = String(data.register || '').toLowerCase().trim();
	const audience = String(data.audience || '').toLowerCase();
	const register = REGISTERS.includes(stated)
		? stated
		: /decision|deciding|exec|leader|board|stakeholder|approve/.test(audience)
			? 'editorial'
			: /architect|design|system/.test(audience)
				? 'blueprint'
				: /engineer|review|audit|qa|sre|incident/.test(audience)
					? 'instrument'
					: opts.detailed
						? 'paper'
						: 'standard';

	const ctx = {
		inputPath,
		single: opts.single,
		assets: new Map(),
		copies: new Map(),
		problems,
		notes: [],
		detailed: opts.detailed,
		register: register,
	};

	await resolveImages(ctx, imageReferences(body, offset));

	// A paragraph that is only an image becomes a figure; the sidebar can
	// then point at it by number.
	for (const block of blocks) {
		if (block.kind !== 'paragraph') continue;
		const only = block.text.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
		if (!only) continue;
		block.kind = 'figure';
		block.figure = { src: only[2], alt: only[1], caption: only[3] || '' };
	}

	if (opts.mermaid && blocks.some((block) => block.kind === 'code' && block.lang === 'mermaid')) {
		const mermaidPath = findMermaid();
		const browser = findBrowser();
		if (!mermaidPath) problems.push('no Mermaid build found — vendor mermaid.min.js or set HTML_REPORT_MERMAID');
		else if (!browser) problems.push('no headless browser found — install chromium or set HTML_REPORT_CHROMIUM');
		else {
			let index = 0;
			for (const block of blocks) {
				if (block.kind !== 'code' || block.lang !== 'mermaid') continue;
				try {
					const svg = await renderMermaid(block.text, index, browser, mermaidPath);
					const bytes = Buffer.from(svg, 'utf8');
					const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
					const name = `diagram-${index + 1}-${digest}.svg`;
					const href = opts.single
						? `data:image/svg+xml;base64,${bytes.toString('base64')}`
						: `assets/${name}`;
					if (!opts.single) ctx.copies.set(name, bytes);
					ctx.assets.set(`mermaid:${index}`, { href, group: 'diagrams', name });
					block.kind = 'figure';
					block.figure = { src: `mermaid:${index}`, alt: `Diagram ${index + 1}`, caption: '', diagram: true };
					index++;
				} catch (error) {
					problems.push(`${block.line}: ${error.message}`);
				}
			}
		}
	} else if (!opts.mermaid) {
		for (const block of blocks) {
			if (block.kind === 'code' && block.lang === 'mermaid') ctx.notes.push(`${block.line}: diagram kept as source (--no-mermaid)`);
		}
	}

	const rendered = renderBlocks(blocks, ctx);

	const outPath = opts.out
		? resolve(opts.out)
		: opts.single
			? join(dirname(inputPath), `${basename(inputPath, '.md')}.html`)
			: join(dirname(inputPath), `${basename(inputPath, '.md')}-report`);
	const isFile = opts.single || extname(outPath).toLowerCase() === '.html';
	const htmlPath = isFile ? outPath : join(outPath, 'index.html');
	const outDir = dirname(htmlPath);

	const groups = new Map();
	for (const figure of rendered.figures) {
		const key = figure.diagram ? 'diagrams' : figure.group || 'evidence';
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(figure);
	}

	const html = template({
		title,
		subtitle: data.subtitle || '',
		status: data.status || '',
		date: data.date ? String(data.date) : '',
		source: data.source || '',
		audience: data.audience || '',
		decision: data.decision || '',
		lede: data.lede || '',
		detailed: opts.detailed,
		register,
		body: rendered.html,
		toc: rendered.toc,
		groups: [...groups.entries()],
	});

	await mkdir(outDir, { recursive: true });
	await writeFile(htmlPath, html, 'utf8');

	if (!opts.single) {
		const assetsDir = join(outDir, 'assets');
		await rm(assetsDir, { recursive: true, force: true });
		await mkdir(assetsDir, { recursive: true });
		for (const [name, bytes] of [...ctx.copies.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			await writeFile(join(assetsDir, name), bytes);
		}
	}

	if (!opts.quiet) {
		const summary = [relative(process.cwd(), htmlPath), `${rendered.figures.length} figure(s)`, `${rendered.toc.length} heading(s)`];
		if (!opts.single) summary.push(`${ctx.copies.size} asset(s)`);
		console.log(summary.join(' · '));
	}
	for (const problem of [...new Set(ctx.problems)]) console.error(`  problem: ${problem}`);
	for (const note of ctx.notes) console.error(`  note: ${note}`);
	if (ctx.problems.length > 0) process.exitCode = 1;
}

/* ------------------------------------------------------------------- cli */

let parsedOptions;
try {
	parsedOptions = options(process.argv.slice(2));
} catch (error) {
	console.error(`render-report: ${error.message}\n\n${USAGE}`);
	process.exit(2);
}

if (!parsedOptions) {
	console.log(USAGE);
	process.exit(0);
}

try {
	await main(parsedOptions);
} catch (error) {
	console.error(`render-report: ${error.message}`);
	process.exit(1);
}
