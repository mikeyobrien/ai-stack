import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBindingStore } from '../src/state.js';
import { TelegramBotApi } from '../src/telegram.js';
import { Delivery } from '../src/delivery.js';
import { Commands } from '../src/commands.js';
import { htmlToPlain, renderMarkdown } from '../src/render.js';
import { FakeBotApi } from './helpers/fake-bot-api.js';
import {
  assistantEvent,
  makeTempDir,
  messageUpdate,
  removeDir,
  toolCallEvent,
  turnEndEvent,
  userEvent,
} from './helpers/fixtures.js';

const CHAT = 111;
const THREAD = 42;
const SESSION = 'session-a';
const ALLOWED_TAGS = new Set(['b', 'i', 's', 'code', 'pre', 'a', 'blockquote']);

async function setup(t, { rejectParseEntities = 0 } = {}) {
  const dir = await makeTempDir();
  const bot = await new FakeBotApi({ rejectParseEntities }).start();
  t.after(async () => {
    await bot.stop();
    await removeDir(dir);
  });
  const store = await openBindingStore({ file: join(dir, 'telegram-session-bridge', 'state.json'), logger: quietLogger });
  const logger = { warnings: [], info() {}, warn(message) { this.warnings.push(String(message)); }, error() {}, debug() {} };
  const api = new TelegramBotApi({ token: bot.token, baseUrl: bot.baseUrl, logger });
  const delivery = new Delivery({ store, bot: api, logger });
  await store.bind({ chatId: CHAT, threadId: THREAD, sessionId: SESSION, managedMode: 'auto' });
  return { bot, store, api, delivery, logger };
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Every tag is complete, allowed, and closed in order; no cut inside a tag. */
function assertBalancedTags(html) {
  const open = [];
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start === -1) break;
    const end = html.indexOf('>', start + 1);
    assert.notEqual(end, -1, `chunk ends inside a tag: ${html.slice(start)}`);
    const raw = html.slice(start, end + 1);
    const match = /^<(\/?)([a-z]+)(?:\s[^>]*)?>$/.exec(raw);
    assert.ok(match, `malformed tag ${raw}`);
    assert.ok(ALLOWED_TAGS.has(match[2]), `Telegram does not accept <${match[2]}>`);
    if (match[1]) assert.equal(open.pop(), match[2], `unbalanced </${match[2]}>`);
    else open.push(match[2]);
    index = end + 1;
  }
  assert.deepEqual(open, [], 'every tag is closed by the end of the chunk');
}

async function answer(delivery, markdown) {
  await delivery.handleSessionEvent({ id: SESSION }, assistantEvent(markdown));
}

test('[rich] assistant Markdown is sent as Telegram HTML with parse_mode', async (t) => {
  const { bot, delivery } = await setup(t);
  await answer(
    delivery,
    '**bold** and __strong__ and *italic* and _em_ and `inline code` and ~~strike~~ and ' +
      '[docs](https://example.com/a?b=1&c=2)',
  );

  assert.equal(bot.messages.length, 1);
  assert.equal(bot.messages[0].parse_mode, 'HTML');
  assert.equal(
    bot.messages[0].text,
    '<b>bold</b> and <b>strong</b> and <i>italic</i> and <i>em</i> and <code>inline code</code> and ' +
      '<s>strike</s> and <a href="https://example.com/a?b=1&amp;c=2">docs</a>',
  );
  assertBalancedTags(bot.messages[0].text);
});

test('[rich] fenced code renders as pre/code with its language', async (t) => {
  const { bot, delivery } = await setup(t);
  await answer(delivery, '```js\nconst x = 1 < 2 && 3 > 2;\n```');

  assert.equal(bot.messages[0].parse_mode, 'HTML');
  assert.equal(
    bot.messages[0].text,
    '<pre><code class="language-js">const x = 1 &lt; 2 &amp;&amp; 3 &gt; 2;</code></pre>',
  );
  assertBalancedTags(bot.messages[0].text);

  // A fence without an info string still uses pre, never an invented <p>/<code> wrapper.
  assert.equal(renderMarkdown('```\nplain <code>\n```'), '<pre>plain &lt;code&gt;</pre>');
});

test('[rich] headings and blockquotes use only accepted tags', async (t) => {
  const { bot, delivery } = await setup(t);
  await answer(delivery, '## Results\n\n> quoted line\n> second line');

  assert.equal(bot.messages[0].text, '<b>Results</b>\n\n<blockquote>quoted line\nsecond line</blockquote>');
  assertBalancedTags(bot.messages[0].text);
});

test('[rich] parse_mode is set only for answers; operational lines stay plain text', async (t) => {
  const { bot, store, api, delivery } = await setup(t);
  await store.setVerbosity({ chatId: CHAT, threadId: THREAD, level: 'verbose' });
  const session = { id: SESSION };

  await delivery.handleSessionEvent(session, userEvent('asked from the web GUI'));
  await delivery.handleSessionEvent(session, toolCallEvent('bash', { command: 'ls -la' }));
  await delivery.handleSessionEvent(session, assistantEvent('**the answer**', { reasoning: 'checked the files' }));
  await delivery.handleSessionEvent(session, turnEndEvent({ reason: { kind: 'error', error: { message: 'boom' } } }));

  assert.equal(bot.messages.length, 5);
  assert.deepEqual(
    bot.messages.map((message) => [message.text[0], message.parse_mode]),
    [
      ['▸', undefined],
      ['⚙', undefined],
      ['✎', undefined],
      ['<', 'HTML'],
      ['⚠', undefined],
    ],
  );

  const commands = new Commands({
    store,
    bot: api,
    host: { async listSessions() { return []; } },
    delivery,
    allowedChatIds: [CHAT],
    logger: quietLogger,
  });
  await commands.handleMessage(messageUpdate({ updateId: 3, text: '/help', chatId: CHAT, threadId: THREAD }).message);
  assert.equal(bot.messages.at(-1).parse_mode, undefined, '/help reply must not be parsed as HTML');
  assert.match(bot.messages.at(-1).text, /Telegram session bridge/);
});

test('[rich] user content stays plain, and rendered prose escapes <script> and stray <b>', async (t) => {
  const { bot, delivery } = await setup(t);
  const session = { id: SESSION };

  await delivery.handleSessionEvent(session, userEvent('<script>alert(1)</script> <b>from the user</b>'));
  assert.equal(bot.messages.at(-1).parse_mode, undefined);
  assert.equal(bot.messages.at(-1).text, '▸ <script>alert(1)</script> <b>from the user</b>');

  await answer(delivery, 'Raw <script>alert(1)</script> and <b>a stray tag</b> & 5 > 3.');
  assert.equal(bot.messages.at(-1).parse_mode, 'HTML');
  assert.equal(
    bot.messages.at(-1).text,
    'Raw &lt;script&gt;alert(1)&lt;/script&gt; and &lt;b&gt;a stray tag&lt;/b&gt; &amp; 5 &gt; 3.',
  );
  assertBalancedTags(bot.messages.at(-1).text);

  // The renderer is what user-supplied text crosses when it appears inside an
  // answer (link labels included); nothing may become executable markup.
  assert.equal(
    renderMarkdown('[<script>alert(1)</script>](https://example.com)'),
    '<a href="https://example.com">&lt;script&gt;alert(1)&lt;/script&gt;</a>',
  );
  assert.equal(
    renderMarkdown('> user said <b>hello</b>'),
    '<blockquote>user said &lt;b&gt;hello&lt;/b&gt;</blockquote>',
  );
});

test('[rich] a long formatted answer is split into balanced chunks without loss', async (t) => {
  const { bot, delivery } = await setup(t);
  const markdown = Array.from(
    { length: 160 },
    (_, index) => `**Paragraph ${index}** — ${'word '.repeat(12)}and \`code ${index}\` with 🙂.`,
  ).join('\n\n');
  const rendered = renderMarkdown(markdown);
  assert.ok(rendered.length > 4096, 'fixture must exceed Telegram’s limit');

  await answer(delivery, markdown);

  assert.ok(bot.messages.length > 1);
  for (const message of bot.messages) {
    assert.equal(message.parse_mode, 'HTML');
    assert.ok(message.text.length <= 4096, `chunk is ${message.text.length} characters`);
    assert.ok(message.text.isWellFormed(), 'no chunk splits a surrogate pair');
    assertBalancedTags(message.text);
  }
  assert.equal(bot.messages.map((message) => htmlToPlain(message.text)).join(''), htmlToPlain(rendered));
});

test('[rich] blank lines inside fenced code do not break block splitting', async (t) => {
  const { bot, delivery } = await setup(t);
  const code = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`).join('\n\n');

  await answer(delivery, `\`\`\`js\n${code}\n\`\`\``);

  assert.ok(bot.messages.length > 1);
  for (const message of bot.messages) {
    assert.equal(message.parse_mode, 'HTML');
    assert.ok(message.text.length <= 4096);
    assertBalancedTags(message.text);
  }
  assert.equal(bot.messages.map((message) => htmlToPlain(message.text)).join(''), code);
});

test('[rich] a split inside markup closes and re-opens tags across chunks', async (t) => {
  const { bot, delivery } = await setup(t);
  const visible = `${'long bold content '.repeat(599)}end`;
  const markdown = `**${visible}**`;

  await answer(delivery, markdown);

  assert.ok(bot.messages.length > 1);
  for (const message of bot.messages) {
    assert.equal(message.parse_mode, 'HTML');
    assert.ok(message.text.length <= 4096);
    assert.ok(message.text.startsWith('<b>'), 'the next chunk re-opens the bold tag');
    assert.ok(message.text.endsWith('</b>'), 'the boundary closes the bold tag');
    assertBalancedTags(message.text);
  }
  assert.equal(bot.messages.map((message) => htmlToPlain(message.text)).join(''), visible);
});

test('[rich] a 400 can\'t-parse-entities rejection retries once as plain text', async (t) => {
  const { bot, delivery, logger } = await setup(t, { rejectParseEntities: 1 });
  await answer(delivery, '**bold** and <script>alert(1)</script>');

  const sends = bot.calls.filter((call) => call.method === 'sendMessage');
  assert.equal(sends.length, 2, 'one rejected HTML send plus one plain retry');
  assert.equal(sends[0].params.parse_mode, 'HTML');
  assert.equal(sends[0].params.text, '<b>bold</b> and &lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(sends[1].params.parse_mode, undefined);
  assert.equal(sends[1].params.text, 'bold and <script>alert(1)</script>');

  assert.equal(bot.messages.length, 1, 'the rejected send is not stored as delivered');
  assert.equal(bot.messages[0].parse_mode, undefined);
  assert.equal(bot.messages[0].text, htmlToPlain(sends[0].params.text));
  assert.ok(
    logger.warnings.some((message) => /falling back to plain text/.test(message)),
    'the fallback is logged',
  );

  await answer(delivery, '**next answer**');
  assert.equal(bot.messages.at(-1).parse_mode, 'HTML');
  assert.equal(bot.messages.at(-1).text, '<b>next answer</b>');
});
