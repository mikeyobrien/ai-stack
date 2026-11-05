import { TELEGRAM_MAX_TEXT } from './chunk.js';

/**
 * Markdown → Telegram Bot API HTML. Telegram accepts only a small tag set, so
 * this renders to b/i/s/code/pre/a/blockquote and escapes every other angle
 * bracket. No runtime dependencies: the grammar is deliberately the subset
 * assistant answers actually use.
 *
 * Rendering is block-based. Every block is self-contained and balanced, which
 * is what lets the chunker split on block boundaries first.
 */

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(`{3,})\s*([^\s`]*)\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Escape text for Telegram HTML: only &, < and > are significant. */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a URL for an href attribute. */
function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function sanitizeLanguage(info) {
  const language = String(info ?? '').trim();
  return /^[A-Za-z0-9_+#.-]{1,32}$/.test(language) ? language : '';
}

function isWordChar(char) {
  return /[A-Za-z0-9]/.test(char ?? '');
}

/**
 * Find the closing run of `marker`, rejecting empty/space-padded content and,
 * for `_`, intraword matches so `snake_case_names` stay literal.
 */
function findClosingMarker(text, marker, contentStart) {
  let search = contentStart;
  while (search < text.length) {
    const found = text.indexOf(marker, search);
    if (found === -1) return -1;
    const inner = text.slice(contentStart, found);
    let boundary = true;
    if (marker.startsWith('_')) {
      const before = text[contentStart - marker.length - 1];
      const after = text[found + marker.length];
      boundary = !isWordChar(before) && !isWordChar(after);
    }
    if (inner.length > 0 && !/^\s/.test(inner) && !/\s$/.test(inner) && boundary) return found;
    search = found + marker.length;
  }
  return -1;
}

function parseLink(text, start) {
  const closeBracket = text.indexOf(']', start + 1);
  if (closeBracket === -1 || text[closeBracket + 1] !== '(') return null;
  const closeParen = text.indexOf(')', closeBracket + 2);
  if (closeParen === -1) return null;
  const url = text.slice(closeBracket + 2, closeParen).trim().split(/\s+/)[0];
  if (!url) return null;
  return { label: text.slice(start + 1, closeBracket), url, end: closeParen + 1 };
}

function renderInline(text) {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];

    if (char === '\\' && index + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[index + 1])) {
      output += escapeHtml(text[index + 1]);
      index += 2;
      continue;
    }

    if (char === '`') {
      let ticks = 1;
      while (text[index + ticks] === '`') ticks += 1;
      const marker = '`'.repeat(ticks);
      const close = text.indexOf(marker, index + ticks);
      if (close !== -1) {
        let code = text.slice(index + ticks, close);
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        output += `<code>${escapeHtml(code)}</code>`;
        index = close + ticks;
        continue;
      }
      output += escapeHtml(marker);
      index += ticks;
      continue;
    }

    if (char === '[') {
      const link = parseLink(text, index);
      if (link) {
        output += `<a href="${escapeAttribute(link.url)}">${renderInline(link.label)}</a>`;
        index = link.end;
        continue;
      }
    }

    if (char === '~' && text[index + 1] === '~') {
      const close = findClosingMarker(text, '~~', index + 2);
      if (close !== -1) {
        output += `<s>${renderInline(text.slice(index + 2, close))}</s>`;
        index = close + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const strong = char.repeat(2);
      if (text.startsWith(strong, index)) {
        const close = findClosingMarker(text, strong, index + 2);
        if (close !== -1) {
          output += `<b>${renderInline(text.slice(index + 2, close))}</b>`;
          index = close + 2;
          continue;
        }
      }
      const close = findClosingMarker(text, char, index + 1);
      if (close !== -1) {
        output += `<i>${renderInline(text.slice(index + 1, close))}</i>`;
        index = close + 1;
        continue;
      }
    }

    output += escapeHtml(char);
    index += 1;
  }
  return output;
}

function renderFenced(lines, start) {
  const fence = FENCE.exec(lines[start]);
  const ticks = fence[1].length;
  const language = sanitizeLanguage(fence[2]);
  const code = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (new RegExp(`^\\s*\`{${ticks},}\\s*$`).test(line)) {
      index += 1;
      break;
    }
    code.push(line);
    index += 1;
  }
  const body = escapeHtml(code.join('\n'));
  const html = language
    ? `<pre><code class="language-${language}">${body}</code></pre>`
    : `<pre>${body}</pre>`;
  return { html, next: index };
}

/**
 * Render Markdown into balanced HTML blocks. Blocks are joined with a blank
 * line by renderMarkdown; the chunker uses that boundary.
 */
function renderMarkdownBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const fenced = renderFenced(lines, index);
      blocks.push(fenced.html);
      index = fenced.next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const content = renderInline(heading[2].trim());
      if (content) blocks.push(`<b>${content}</b>`);
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]);
        if (!match) break;
        quoted.push(renderInline(match[1]));
        index += 1;
      }
      blocks.push(`<blockquote>${quoted.join('\n')}</blockquote>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (current.trim() === '' || FENCE.test(current) || HEADING.test(current) || QUOTE.test(current)) break;
      paragraph.push(renderInline(current));
      index += 1;
    }
    if (paragraph.length > 0) blocks.push(paragraph.join('\n'));
  }

  return blocks;
}

/** Full rendered HTML for one Markdown document. */
export function renderMarkdown(markdown) {
  return renderMarkdownBlocks(markdown).join('\n\n');
}

/** Decode the HTML this module emits back to the text a user should read. */
export function htmlToPlain(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Split HTML into tags and text. Our own output never contains `<` in text or
 * `>` inside an attribute, so this is exact for rendered answers.
 */
function tokenizeHtml(html) {
  const tokens = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      tokens.push({ type: 'text', text: html.slice(index) });
      break;
    }
    if (open > index) tokens.push({ type: 'text', text: html.slice(index, open) });
    const close = html.indexOf('>', open + 1);
    if (close === -1) {
      tokens.push({ type: 'text', text: html.slice(open) });
      break;
    }
    const raw = html.slice(open, close + 1);
    const match = /^<\s*(\/?)\s*([A-Za-z0-9]+)[^>]*>$/.exec(raw);
    if (!match) tokens.push({ type: 'text', text: raw });
    else tokens.push({ type: 'tag', raw, close: match[1] === '/', name: match[2].toLowerCase() });
    index = close + 1;
  }
  return tokens;
}

function closingLength(stack) {
  let total = 0;
  for (const tag of stack) total += tag.name.length + 3; // </name>
  return total;
}

function closingTags(stack) {
  let out = '';
  for (let index = stack.length - 1; index >= 0; index -= 1) out += `</${stack[index].name}>`;
  return out;
}

function reopeningTags(stack) {
  let out = '';
  for (const tag of stack) out += tag.raw;
  return out;
}

/** Longest prefix of `text` that fits in `budget` UTF-16 units, on a code-point boundary. */
function safePrefix(text, budget) {
  let units = 0;
  let index = 0;
  for (const codePoint of text) {
    if (units + codePoint.length > budget) break;
    units += codePoint.length;
    index += codePoint.length;
  }
  return index;
}

function chooseCut(text, budget, topLevel) {
  if (topLevel && budget >= 2) {
    const blank = text.lastIndexOf('\n\n', budget - 2);
    if (blank !== -1 && blank + 2 <= budget) return blank + 2;
  }
  if (budget >= 1) {
    const newline = text.lastIndexOf('\n', budget - 1);
    if (newline !== -1) return newline + 1;
    const space = text.lastIndexOf(' ', budget - 1);
    if (space !== -1) return space + 1;
  }
  return safePrefix(text, budget);
}

/**
 * Tag-aware split of one balanced block. A boundary closes the open tags and
 * re-opens them at the start of the next chunk, so every chunk is valid
 * Telegram HTML and no content is dropped.
 */
function splitBalanced(html, limit) {
  const chunks = [];
  let chunk = '';
  let units = 0;
  const stack = [];

  const flush = () => {
    if (chunk === '') return;
    chunks.push(chunk + closingTags(stack));
    chunk = reopeningTags(stack);
    units = chunk.length;
  };

  for (const token of tokenizeHtml(html)) {
    if (token.type === 'tag') {
      const nextStack = token.close ? stack.slice(0, -1) : [...stack, token];
      if (units + token.raw.length + closingLength(nextStack) > limit && chunk !== '') flush();
      chunk += token.raw;
      units += token.raw.length;
      if (token.close) stack.pop();
      else stack.push(token);
      continue;
    }

    let remaining = token.text;
    while (remaining.length > 0) {
      const budget = limit - units - closingLength(stack);
      if (budget <= 0) {
        if (chunk === '' || closingLength(stack) + reopeningTags(stack).length >= limit) {
          throw new RangeError('rendered tags do not fit in the chunk limit');
        }
        flush();
        continue;
      }
      if (remaining.length <= budget) {
        chunk += remaining;
        units += remaining.length;
        remaining = '';
        continue;
      }
      const cut = chooseCut(remaining, budget, stack.length === 0);
      if (cut <= 0) {
        if (chunk === '') throw new RangeError('chunk limit is too small for the rendered text');
        flush();
        continue;
      }
      chunk += remaining.slice(0, cut);
      units += cut;
      remaining = remaining.slice(cut);
      flush();
    }
  }

  if (chunk !== '') chunks.push(chunk + closingTags(stack));
  return chunks;
}

/** Top-level blocks of one rendered document (blank-line boundaries at depth 0). */
function splitTopLevel(html) {
  const blocks = [];
  let current = '';
  let depth = 0;
  for (const token of tokenizeHtml(html)) {
    if (token.type === 'tag') {
      current += token.raw;
      if (token.close) depth = Math.max(0, depth - 1);
      else depth += 1;
      continue;
    }
    if (depth > 0) {
      // Blank lines inside <pre>/<blockquote> belong to that block; only a
      // depth-0 blank line separates one rendered block from the next.
      current += token.text;
      continue;
    }
    const parts = token.text.split('\n\n');
    for (let index = 0; index < parts.length; index += 1) {
      current += parts[index];
      if (index < parts.length - 1) {
        if (current !== '') blocks.push(current);
        current = '';
      }
    }
  }
  if (current !== '') blocks.push(current);
  return blocks;
}

/**
 * Split rendered HTML into Telegram-sized chunks. Whole blocks are packed
 * first; only a block larger than the limit is split internally. Each chunk is
 * balanced and at most `limit` UTF-16 units of rendered output.
 */
export function chunkRenderedHtml(html, limit = TELEGRAM_MAX_TEXT) {
  if (!(Number.isSafeInteger(limit) && limit > 0)) throw new RangeError('chunk limit must be a positive integer');
  const source = String(html ?? '');
  if (source === '') return [];
  if (source.length <= limit) return [source];

  const chunks = [];
  let current = '';

  for (const [index, block] of splitTopLevel(source).entries()) {
    // Carry the block separator with its block so concatenating the chunks
    // reproduces the rendered source exactly: no paragraph boundary is lost.
    const piece = index === 0 ? block : `\n\n${block}`;
    if (piece.length <= limit) {
      if (current === '') {
        current = piece;
        continue;
      }
      if (current.length + piece.length <= limit) {
        current += piece;
        continue;
      }
      chunks.push(current);
      current = piece;
      continue;
    }

    if (current !== '') {
      chunks.push(current);
      current = '';
    }
    const pieces = splitBalanced(piece, limit);
    chunks.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }

  if (current !== '') chunks.push(current);
  return chunks;
}
