/**
 * Reader and render behavior tests: the markdown-to-HTML converter and the
 * sandboxed HTML document the reader wraps.
 *
 * @module @local/dsh-artifact-library/test/render
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, escapeHtml, looksLikeHtml, safeDocument } from '../render.js';
import { HTML_SANDBOX } from '../security.js';

test('markdown renders headings, lists, code and tables', () => {
	const html = markdownToHtml('# T\n\n- one\n- two\n\n```js\nlet x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
	assert.ok(html.includes('<h1>T</h1>'));
	assert.ok(html.includes('<li>one</li>'));
	assert.ok(html.includes('<li>two</li>'));
	assert.ok(html.includes('<pre><code>'), 'code fence rendered');
	assert.ok(html.includes('<table>'));
	assert.ok(html.includes('<th>a</th>'));
});

test('inline code, bold, italic and safe links are converted', () => {
	const html = markdownToHtml('Use `npm install` and **bold** plus *em* and [a link](https://example.com/x).');
	assert.ok(html.includes('<code>npm install</code>'));
	assert.ok(html.includes('<strong>bold</strong>'));
	assert.ok(html.includes('<em>em</em>'));
	assert.ok(html.includes('href="https://example.com/x"'));
	assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('a javascript: link is refused and left as plain text', () => {
	const html = markdownToHtml('[click](javascript:alert(1))');
	assert.ok(!html.includes('javascript:'), 'no javascript: href survives');
	assert.ok(html.includes('click'), 'the label is still shown as text');
});

test('embedded raw HTML is escaped, not executed', () => {
	const html = markdownToHtml('before\n\n<script>bad()</script>\n\n<img src=x onerror="bad()">\n\nafter');
	assert.ok(!html.includes('<script>'), 'no script tag in the rendered output');
	assert.ok(!html.includes('onerror="'), 'no unescaped attribute handler in the rendered output');
	assert.ok(html.includes('&lt;script&gt;'), 'the raw markup is escaped into text');
	assert.ok(html.includes('before'));
	assert.ok(html.includes('after'));
});

test('escapeHtml escapes markup and quotes', () => {
	assert.equal(escapeHtml("<a b=\"c\" d='e'>"), '&lt;a b=&quot;c&quot; d=&#39;e&#39;&gt;');
});

test('looksLikeHtml is true for a doctype and false for prose', () => {
	assert.equal(looksLikeHtml('<!DOCTYPE html><html><body></body></html>'), true);
	assert.equal(looksLikeHtml('# Just markdown prose'), false);
});

test('an html artifact returns its raw document for the sandboxed iframe', () => {
	const { mode, html } = safeDocument({ path: 'x.html', format: 'html' }, '<html><body>hi</body></html>');
	assert.equal(mode, 'html');
	assert.equal(html, '<html><body>hi</body></html>');
});

test('a text artifact is wrapped in a pre block with its class', () => {
	const { mode, html } = safeDocument({ path: 'x.txt' }, 'plain <text>');
	assert.equal(mode, 'text');
	assert.ok(html.includes('<pre class="'), 'wrapped in a pre block');
	assert.ok(html.includes('&lt;text&gt;'), 'angle brackets escaped');
});

test('the html sandbox attributes are empty and the CSP forbids script', () => {
	assert.equal(HTML_SANDBOX.attributes, 'sandbox=""');
	assert.ok(!/allow-modals/.test(HTML_SANDBOX.attributes), 'no modal allowance');
	assert.ok(/default-src\s+'none'/.test(HTML_SANDBOX.csp), 'CSP defaults to none');
});
