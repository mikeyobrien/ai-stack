#!/usr/bin/env node
/**
 * Interactive browser session for the ui-ux-pass skill.
 *
 * The pass is agentic: the agent opens a session, observes after every action,
 * and chooses the next action from what it saw. This helper provides the
 * browser primitives and a transcript; it does not prescribe a step list.
 *
 *   node ux-pass.mjs start --out evidence/
 *   node ux-pass.mjs do --session evidence/session.json '{"action":"open","url":"https://example.test/"}'
 *   node ux-pass.mjs do --session evidence/session.json '{"action":"screenshot","name":"default"}'
 *   node ux-pass.mjs do --session evidence/session.json '{"action":"inspect","selector":"h1","style":["font-size"],"box":true}'
 *   node ux-pass.mjs replay --session evidence/session.json
 *   node ux-pass.mjs stop --session evidence/session.json
 *
 * Playwright is optional and not vendored. Resolution order:
 *   --playwright <specifier-or-path>, UX_PASS_PLAYWRIGHT, `playwright`, `playwright-core`.
 *
 * Every command appends to `manifest.json` in the evidence directory. Replay
 * re-executes the successful path in a fresh browser, so a finding can be
 * checked for reproducibility without turning the method into a fixed script.
 * Failed attempts remain in the manifest but are skipped on replay: they are
 * dead ends, not the path.
 *
 * @module @local/mov-skills/skills/ui-ux-pass/scripts/ux-pass
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

const ACTIONS = new Set([
  'open', 'click', 'fill', 'press', 'waitFor', 'wait',
  'assertText', 'assertVisible', 'assertHidden', 'inspect',
  'screenshot', 'text', 'route', 'unroute', 'viewport', 'media',
  'back', 'reload', 'url', 'close',
]);
const MAX_TEXT = 8000;
const DEFAULT_TIMEOUT = 15000;
const CLIENT_TIMEOUT = 120000;

const USAGE = `Usage:
  node ux-pass.mjs start  --out <dir> [options]
  node ux-pass.mjs do     --session <session.json> '<json command>'
  node ux-pass.mjs replay --session <session.json> [--out <dir>] [options]
  node ux-pass.mjs stop   --session <session.json>

Options:
  --out <dir>            Evidence directory (start requires it; replay defaults to <session-dir>/replay)
  --session <file>       session.json written by start
  --json <json>          Command JSON for do (alternative to the positional argument)
  --playwright <spec>    Playwright module specifier or path to its index.mjs
  --executable <path>    Chromium executable (default: UX_PASS_BROWSER or Playwright's own)
  --headed               Show the browser
  --allow-destructive    Permit commands marked destructive (off by default)
  --ignore-https-errors  Accept self-signed certificates
  -h, --help             Show this help

Commands (send one at a time, after reading the previous result):
  {"action":"open","url":"..."}
  {"action":"click","selector":"..."}
  {"action":"fill","selector":"...","value":"..."}
  {"action":"press","key":"Enter","selector":"..."}
  {"action":"waitFor","selector":"...","state":"visible"}
  {"action":"assertText","selector":"...","text":"..."}
  {"action":"assertVisible","selector":"..."}
  {"action":"assertHidden","selector":"..."}
  {"action":"inspect","selector":"...","style":["color","font-size"],"attributes":["aria-label"],"box":true}
  {"action":"screenshot","name":"default","fullPage":false}
  {"action":"text","selector":"body","maxChars":4000}
  {"action":"route","url":"**/api/items","abort":true}
  {"action":"route","url":"**/api/items","delayMs":2000}
  {"action":"unroute","url":"**/api/items"}
  {"action":"viewport","width":390,"height":844}
  {"action":"media","colorScheme":"dark","reducedMotion":"reduce"}
  {"action":"back"}  {"action":"reload"}  {"action":"url"}  {"action":"close"}

"text" and "inspect" also return "visible"; a hidden node can still return its
text, so check "visible" before treating text as rendered state.
`;

/**
 * Throw a user-facing failure. The top-level dispatch prints it and exits;
 * the session server catches it and returns it as a command error.
 * @param message - what went wrong.
 * @returns never.
 */
function fail(message) {
  throw new Error(message);
}

/**
 * Parse flags for one subcommand.
 * @param argv - arguments after the subcommand.
 * @returns flags plus positional values.
 */
function parseArgs(argv) {
  const options = { headed: false, allowDestructive: false, ignoreHttpsErrors: false, positional: [] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) fail(`${flag} needs a value`);
      return next;
    };
    if (flag === '--out') options.out = value();
    else if (flag === '--session') options.session = value();
    else if (flag === '--json') options.json = value();
    else if (flag === '--playwright') options.playwright = value();
    else if (flag === '--executable') options.executable = value();
    else if (flag === '--headed') options.headed = true;
    else if (flag === '--allow-destructive') options.allowDestructive = true;
    else if (flag === '--ignore-https-errors') options.ignoreHttpsErrors = true;
    else if (flag === '-h' || flag === '--help') { console.log(USAGE); process.exit(0); }
    else if (flag.startsWith('--')) fail(`unknown option ${flag}`);
    else options.positional.push(flag);
  }
  return options;
}

/**
 * Load Playwright from the first available specifier.
 * @param specifier - optional explicit specifier or path.
 * @returns the Playwright module namespace.
 */
async function loadPlaywright(specifier) {
  const candidates = [specifier, process.env.UX_PASS_PLAYWRIGHT, 'playwright', 'playwright-core'].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const target = isAbsolute(candidate) || candidate.startsWith('.')
        ? pathToFileURL(resolve(candidate)).href
        : candidate;
      return await import(target);
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  fail(`cannot load Playwright. Install it, pass --playwright <path>, or set UX_PASS_PLAYWRIGHT.\n  ${failures.join('\n  ')}`);
}

/**
 * Validate one command.
 * @param raw - parsed command object.
 * @returns normalized command.
 */
function validateCommand(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('command must be a JSON object');
  const action = raw.action;
  if (typeof action !== 'string' || !ACTIONS.has(action)) fail(`unknown action ${JSON.stringify(action)}`);
  const command = { ...raw };
  const string = (field) => {
    if (typeof command[field] !== 'string' || command[field].length === 0) fail(`"${field}" must be a non-empty string`);
  };
  const optionalTimeout = () => {
    if (command.timeout !== undefined && (!Number.isInteger(command.timeout) || command.timeout <= 0 || command.timeout > 120000)) {
      fail('"timeout" must be a positive integer up to 120000');
    }
  };
  if (command.destructive !== undefined && typeof command.destructive !== 'boolean') fail('"destructive" must be a boolean');
  optionalTimeout();
  if (action === 'open') {
    string('url');
    try { new URL(command.url); } catch { fail('"url" is not a valid URL'); }
  }
  if (['click', 'waitFor', 'assertText', 'assertVisible', 'assertHidden', 'inspect'].includes(action)) string('selector');
  if (action === 'fill') {
    string('selector');
    if (typeof command.value !== 'string') fail('"value" must be a string');
  }
  if (action === 'press') {
    string('key');
    if (command.selector !== undefined) string('selector');
  }
  if (action === 'waitFor' && command.state !== undefined &&
      !['attached', 'detached', 'visible', 'hidden'].includes(command.state)) {
    fail('"state" must be attached, detached, visible, or hidden');
  }
  if (action === 'assertText') string('text');
  if (action === 'wait') {
    if (!Number.isInteger(command.ms) || command.ms < 0 || command.ms > 60000) fail('"ms" must be an integer from 0 to 60000');
  }
  if (action === 'inspect') {
    for (const field of ['style', 'attributes']) {
      if (command[field] !== undefined) {
        if (!Array.isArray(command[field]) || command[field].length === 0 || command[field].length > 12 ||
            command[field].some((value) => typeof value !== 'string' || !/^[a-z-]+$/.test(value))) {
          fail(`"${field}" must be an array of 1–12 CSS property or attribute names`);
        }
      }
    }
    if (command.box !== undefined && typeof command.box !== 'boolean') fail('"box" must be a boolean');
    if (command.style === undefined && command.attributes === undefined && command.box !== true) {
      fail('inspect needs at least one of style, attributes, or box');
    }
  }
  if (action === 'screenshot') {
    if (command.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,60}$/i.test(command.name)) {
      fail('"name" must be letters, digits, and dashes');
    }
    if (command.selector !== undefined) string('selector');
    if (command.fullPage !== undefined && typeof command.fullPage !== 'boolean') fail('"fullPage" must be a boolean');
  }
  if (action === 'text') {
    if (command.selector !== undefined) string('selector');
    if (command.maxChars !== undefined && (!Number.isInteger(command.maxChars) || command.maxChars < 1 || command.maxChars > MAX_TEXT)) {
      fail(`"maxChars" must be an integer from 1 to ${MAX_TEXT}`);
    }
  }
  if (action === 'route' || action === 'unroute') string('url');
  if (action === 'route') {
    if (command.abort !== undefined && typeof command.abort !== 'boolean') fail('"abort" must be a boolean');
    if (command.delayMs !== undefined && (!Number.isInteger(command.delayMs) || command.delayMs < 0 || command.delayMs > 30000)) {
      fail('"delayMs" must be an integer from 0 to 30000');
    }
  }
  if (action === 'viewport') {
    if (!Number.isInteger(command.width) || command.width < 200 || command.width > 5000 ||
        !Number.isInteger(command.height) || command.height < 200 || command.height > 5000) {
      fail('"width" and "height" must be integers between 200 and 5000');
    }
  }
  if (action === 'media') {
    if (command.colorScheme !== undefined && !['light', 'dark', 'no-preference'].includes(command.colorScheme)) {
      fail('"colorScheme" must be light, dark, or no-preference');
    }
    if (command.reducedMotion !== undefined && !['reduce', 'no-preference'].includes(command.reducedMotion)) {
      fail('"reducedMotion" must be reduce or no-preference');
    }
  }
  return command;
}

/**
 * Sanitize a screenshot name.
 * @param name - caller-supplied name.
 * @param fallback - fallback stem.
 * @returns safe stem.
 */
function screenshotStem(name, fallback) {
  return (name ?? fallback).replace(/[^a-z0-9-]/gi, '-').replace(/^-+|-+$/g, '') || fallback;
}

/**
 * Attach event collectors to a page.
 * @param page - Playwright page.
 * @param events - mutable event arrays.
 */
function collectEvents(page, events) {
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return;
    events.console.push({ type: message.type(), text: message.text().slice(0, 2000), location: message.location() });
  });
  page.on('pageerror', (error) => events.pageErrors.push({ message: error.message, stack: (error.stack ?? '').slice(0, 4000) }));
  page.on('requestfailed', (request) => events.requestFailures.push({
    url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? 'unknown',
  }));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      events.httpErrors.push({ url: response.url(), status: response.status(), method: response.request().method() });
    }
  });
}

/**
 * One interactive browser session.
 */
class Session {
  /**
   * @param browser - Playwright browser.
   * @param context - browser context.
   * @param page - page under test.
   * @param options - CLI options.
   */
  constructor(browser, context, page, options) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.out = resolve(options.out);
    this.shotsDir = join(this.out, 'screenshots');
    this.manifestPath = join(this.out, 'manifest.json');
    this.events = { console: [], pageErrors: [], requestFailures: [], httpErrors: [] };
    this.cursor = { console: 0, pageErrors: 0, requestFailures: 0, httpErrors: 0 };
    this.manifest = {
      tool: 'ui-ux-pass',
      version: 2,
      startedAt: new Date().toISOString(),
      environment: {
        browser: options.executable ?? process.env.UX_PASS_BROWSER ?? 'playwright-default',
        headed: options.headed,
        ignoreHttpsErrors: options.ignoreHttpsErrors,
      },
      actions: [],
      screenshots: [],
      console: [],
      pageErrors: [],
      requestFailures: [],
      httpErrors: [],
    };
    this.shots = 0;
    this.allowDestructive = options.allowDestructive;
    collectEvents(page, this.events);
  }

  /** Write the manifest to disk. */
  async save() {
    this.manifest.finishedAt = new Date().toISOString();
    await writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2) + '\n');
  }

  /**
   * Execute one command and return its observation.
   * @param command - validated command.
   * @returns response object.
   */
  async perform(command) {
    const startedAt = Date.now();
    const response = { ok: true, action: command.action };
    const record = { index: this.manifest.actions.length, command, status: 'ok', startedAt: new Date(startedAt).toISOString() };
    try {
      if (command.destructive === true && !this.allowDestructive) {
        throw new Error('destructive command refused; restart with --allow-destructive after confirming disposable data');
      }
      const timeout = command.timeout ?? DEFAULT_TIMEOUT;
      const { page, context } = this;
      if (command.action === 'open') {
        await page.goto(command.url, { waitUntil: command.waitUntil ?? 'load', timeout });
      } else if (command.action === 'click') {
        await page.locator(command.selector).click({ timeout, force: command.force === true });
      } else if (command.action === 'fill') {
        await page.locator(command.selector).fill(command.value, { timeout });
      } else if (command.action === 'press') {
        if (command.selector === undefined) await page.keyboard.press(command.key);
        else await page.locator(command.selector).press(command.key, { timeout });
      } else if (command.action === 'waitFor') {
        await page.locator(command.selector).waitFor({ state: command.state ?? 'visible', timeout });
      } else if (command.action === 'wait') {
        await new Promise((resolveWait) => setTimeout(resolveWait, command.ms));
      } else if (command.action === 'assertText') {
        const locator = page.locator(command.selector).first();
        await locator.waitFor({ state: 'visible', timeout });
        const actual = await locator.innerText({ timeout });
        response.observed = actual.slice(0, MAX_TEXT);
        if (!actual.includes(command.text)) throw new Error(`expected text ${JSON.stringify(command.text)} in ${JSON.stringify(actual.slice(0, 300))}`);
      } else if (command.action === 'assertVisible') {
        const locator = page.locator(command.selector).first();
        await locator.waitFor({ state: 'visible', timeout });
        response.observed = (await locator.innerText({ timeout }).catch(() => '')).slice(0, 500);
      } else if (command.action === 'assertHidden') {
        await page.locator(command.selector).first().waitFor({ state: 'hidden', timeout });
      } else if (command.action === 'inspect') {
        const spec = { style: command.style ?? [], attributes: command.attributes ?? [], box: command.box === true };
        response.visible = await page.locator(command.selector).first().isVisible().catch(() => false);
        response.observed = await page.locator(command.selector).first().evaluate((element, input) => {
          const result = { tag: element.tagName.toLowerCase(), text: (element.innerText ?? '').slice(0, 500) };
          if (input.attributes.length > 0) {
            result.attributes = Object.fromEntries(input.attributes.map((name) => [name, element.getAttribute(name)]));
          }
          if (input.style.length > 0) {
            const computed = getComputedStyle(element);
            result.style = Object.fromEntries(input.style.map((property) => [property, computed.getPropertyValue(property)]));
          }
          if (input.box) {
            const rect = element.getBoundingClientRect();
            result.box = {
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
              scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
            };
          }
          return result;
        }, spec);
      } else if (command.action === 'screenshot') {
        this.shots += 1;
        const stem = `${String(this.shots).padStart(2, '0')}-${screenshotStem(command.name, command.action)}`;
        const path = join(this.shotsDir, `${stem}.png`);
        if (command.selector === undefined) await page.screenshot({ path, fullPage: command.fullPage === true, timeout });
        else await page.locator(command.selector).screenshot({ path, timeout });
        response.screenshot = path;
        this.manifest.screenshots.push({ path, name: stem, url: page.url(), title: await page.title() });
      } else if (command.action === 'text') {
        const locator = command.selector === undefined ? page.locator('body') : page.locator(command.selector).first();
        response.visible = await locator.isVisible().catch(() => false);
        response.observed = (await locator.innerText({ timeout })).slice(0, command.maxChars ?? MAX_TEXT);
      } else if (command.action === 'route') {
        const delayMs = command.delayMs ?? 0;
        await context.route(command.url, async (route) => {
          if (command.abort === true) { await route.abort('failed'); return; }
          if (delayMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
          await route.continue();
        });
      } else if (command.action === 'unroute') {
        await context.unroute(command.url);
      } else if (command.action === 'viewport') {
        await page.setViewportSize({ width: command.width, height: command.height });
      } else if (command.action === 'media') {
        await page.emulateMedia({
          colorScheme: command.colorScheme ?? 'light',
          reducedMotion: command.reducedMotion ?? 'no-preference',
        });
      } else if (command.action === 'back') {
        await page.goBack({ timeout });
      } else if (command.action === 'reload') {
        await page.reload({ waitUntil: command.waitUntil ?? 'load', timeout });
      } else if (command.action === 'url') {
        response.observed = page.url();
      }
      response.url = page.url();
      response.title = await page.title();
    } catch (error) {
      response.ok = false;
      response.error = error.message;
      response.hint = hintFor(command, error);
      record.status = 'failed';
      record.error = error.message;
      try {
        this.shots += 1;
        const path = join(this.shotsDir, `${String(this.shots).padStart(2, '0')}-failure.png`);
        await this.page.screenshot({ path, timeout: 5000 });
        response.failureScreenshot = path;
      } catch { /* A broken page may refuse even a failure screenshot. */ }
    }
    record.ms = Date.now() - startedAt;
    record.url = response.url;
    record.title = response.title;
    if (response.observed !== undefined) record.observed = response.observed;
    if (response.visible !== undefined) record.visible = response.visible;
    if (response.screenshot !== undefined) record.screenshot = response.screenshot;
    this.manifest.actions.push(record);
    response.newConsole = this.since('console');
    response.newPageErrors = this.since('pageErrors');
    response.newRequestFailures = this.since('requestFailures');
    response.newHttpErrors = this.since('httpErrors');
    await this.save();
    return response;
  }

  /**
   * Events added since the previous command.
   * @param kind - event array name.
   * @returns new entries.
   */
  since(kind) {
    const list = this.events[kind];
    const fresh = list.slice(this.cursor[kind]);
    this.cursor[kind] = list.length;
    return fresh;
  }

  /** Close the browser and flush the manifest. */
  async dispose() {
    await this.save();
    await this.browser.close().catch(() => {});
  }
}

/**
 * A short, actionable hint for a failed command.
 * @param command - failed command.
 * @param error - thrown error.
 * @returns hint text.
 */
function hintFor(command, error) {
  const message = error.message ?? '';
  if (/timeout|not visible|strict mode/i.test(message)) {
    return 'The selector may be wrong or the state may not be ready. Try {"action":"text","selector":"body"} or an inspect on a nearby element, then retry with a selector you can see.';
  }
  if (/destroyed|closed/i.test(message)) return 'The page or browser closed; restart the session and reopen the URL.';
  return 'Read the current URL and page text, then choose the next command from what is visible.';
}

/**
 * Start a session server and keep it running.
 * @param options - parsed flags.
 */
async function start(options) {
  if (!options.out) fail('start requires --out');
  const out = resolve(options.out);
  const shotsDir = join(out, 'screenshots');
  await mkdir(shotsDir, { recursive: true });
  const playwright = await loadPlaywright(options.playwright);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (chromium === undefined) fail('the loaded module does not export chromium');
  const browser = await chromium.launch({
    headless: !options.headed,
    executablePath: options.executable ?? process.env.UX_PASS_BROWSER ?? undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
  });
  const page = await context.newPage();
  const session = new Session(browser, context, page, options);
  await session.save();

  const token = randomBytes(24).toString('hex');
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handle(line, socket).catch((error) => {
          socket.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
        });
      }
    });
  });
  let queue = Promise.resolve();
  async function handle(line, socket) {
    queue = queue.then(async () => {
      let request;
      try { request = JSON.parse(line); } catch { socket.write(JSON.stringify({ ok: false, error: 'request is not JSON' }) + '\n'); return; }
      if (request.token !== token) { socket.write(JSON.stringify({ ok: false, error: 'bad token' }) + '\n'); return; }
      let command;
      try { command = validateCommand(request.command); } catch (error) { socket.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); return; }
      const response = await session.perform(command);
      socket.write(JSON.stringify(response) + '\n');
      if (command.action === 'close') {
        await session.dispose();
        server.close();
        setTimeout(() => process.exit(0), 50);
      }
    });
  }
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  const sessionPath = join(out, 'session.json');
  await writeFile(sessionPath, JSON.stringify({ port, token, out, pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  await chmod(sessionPath, 0o600);
  console.log(JSON.stringify({ ready: true, session: sessionPath, port, out }));

  const shutdown = async () => {
    await session.dispose();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Send one command to a running session.
 * @param options - parsed flags.
 */
async function send(options) {
  if (!options.session) fail('do requires --session');
  const raw = options.json ?? options.positional[0];
  if (raw === undefined) fail('do requires a JSON command');
  let command;
  try { command = JSON.parse(raw); } catch (error) { fail(`command is not JSON: ${error.message}`); }
  validateCommand(command);
  const sessionFile = resolve(options.session);
  let session;
  try { session = JSON.parse(await readFile(sessionFile, 'utf8')); }
  catch (error) { fail(`cannot read ${sessionFile}: ${error.message}. Start a session first.`); }
  const socket = await connect(session.port).catch((error) => fail(`cannot reach the session: ${error.message}. Start a session first.`));
  const response = await request(socket, { token: session.token, command });
  socket.end();
  console.log(JSON.stringify(response, null, 2));
  process.exit(response.ok ? 0 : 1);
}

/**
 * Open a client socket to the session server.
 * @param port - server port.
 * @returns connected socket.
 */
function connect(port) {
  return new Promise((resolveConnect, reject) => {
    const socket = new Socket();
    socket.setTimeout(CLIENT_TIMEOUT);
    socket.once('connect', () => resolveConnect(socket));
    socket.once('timeout', () => reject(new Error('session did not answer')));
    socket.once('error', reject);
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Send one request and read one JSON line.
 * @param socket - connected socket.
 * @param payload - request object.
 * @returns parsed response.
 */
function request(socket, payload) {
  return new Promise((resolveResponse, reject) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { resolveResponse(JSON.parse(buffer.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    socket.once('error', reject);
    socket.write(JSON.stringify(payload) + '\n');
  });
}

/**
 * Replay the recorded transcript in a fresh browser.
 * @param options - parsed flags.
 */
async function replay(options) {
  if (!options.session) fail('replay requires --session');
  const sessionFile = resolve(options.session);
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  const out = resolve(options.out ?? join(session.out, 'replay'));
  const shotsDir = join(out, 'screenshots');
  await mkdir(shotsDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(session.out, 'manifest.json'), 'utf8'));
  if (!options.allowDestructive && manifest.actions.some((entry) => entry.command.destructive === true)) {
    fail('the recorded transcript contains destructive commands; rerun with --allow-destructive only against disposable data');
  }
  const playwright = await loadPlaywright(options.playwright);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  const browser = await chromium.launch({
    headless: !options.headed,
    executablePath: options.executable ?? process.env.UX_PASS_BROWSER ?? undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
  });
  const page = await context.newPage();
  const events = { console: [], pageErrors: [], requestFailures: [], httpErrors: [] };
  collectEvents(page, events);
  const result = { tool: 'ui-ux-pass', replayedAt: new Date().toISOString(), source: session.out, steps: [], skipped: [], screenshots: [], ok: true };
  let shots = 0;
  for (const entry of manifest.actions) {
    if (entry.command.action === 'close') continue;
    // Dead ends are part of the record, not the successful path: replaying a
    // failed attempt would stop at the same wall and hide the recovery.
    if (entry.status === 'failed') {
      result.skipped.push({ index: entry.index, action: entry.command.action, error: entry.error });
      continue;
    }
    const command = { ...entry.command };
    const record = { index: entry.index, action: command.action, status: 'ok' };
    try {
      if (command.action === 'open') await page.goto(command.url, { waitUntil: command.waitUntil ?? 'load', timeout: command.timeout ?? DEFAULT_TIMEOUT });
      else if (command.action === 'click') await page.locator(command.selector).click({ timeout: command.timeout ?? DEFAULT_TIMEOUT, force: command.force === true });
      else if (command.action === 'fill') await page.locator(command.selector).fill(command.value, { timeout: command.timeout ?? DEFAULT_TIMEOUT });
      else if (command.action === 'press') {
        if (command.selector === undefined) await page.keyboard.press(command.key);
        else await page.locator(command.selector).press(command.key, { timeout: command.timeout ?? DEFAULT_TIMEOUT });
      } else if (command.action === 'waitFor') await page.locator(command.selector).waitFor({ state: command.state ?? 'visible', timeout: command.timeout ?? DEFAULT_TIMEOUT });
      else if (command.action === 'wait') await new Promise((resolveWait) => setTimeout(resolveWait, command.ms));
      else if (command.action === 'assertText') {
        const actual = await page.locator(command.selector).first().innerText({ timeout: command.timeout ?? DEFAULT_TIMEOUT });
        if (!actual.includes(command.text)) throw new Error(`expected ${JSON.stringify(command.text)} in ${JSON.stringify(actual.slice(0, 300))}`);
      } else if (command.action === 'assertVisible') await page.locator(command.selector).first().waitFor({ state: 'visible', timeout: command.timeout ?? DEFAULT_TIMEOUT });
      else if (command.action === 'assertHidden') await page.locator(command.selector).first().waitFor({ state: 'hidden', timeout: command.timeout ?? DEFAULT_TIMEOUT });
      else if (command.action === 'inspect') {
        record.observed = await page.locator(command.selector).first().evaluate((element, input) => {
          const result = { tag: element.tagName.toLowerCase(), text: (element.innerText ?? '').slice(0, 500) };
          if (input.attributes.length > 0) result.attributes = Object.fromEntries(input.attributes.map((name) => [name, element.getAttribute(name)]));
          if (input.style.length > 0) {
            const computed = getComputedStyle(element);
            result.style = Object.fromEntries(input.style.map((property) => [property, computed.getPropertyValue(property)]));
          }
          if (input.box) {
            const rect = element.getBoundingClientRect();
            result.box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
          }
          return result;
        }, { style: command.style ?? [], attributes: command.attributes ?? [], box: command.box === true });
      } else if (command.action === 'screenshot') {
        shots += 1;
        const stem = `${String(shots).padStart(2, '0')}-replay-${screenshotStem(command.name, command.action)}`;
        const path = join(shotsDir, `${stem}.png`);
        if (command.selector === undefined) await page.screenshot({ path, fullPage: command.fullPage === true, timeout: command.timeout ?? DEFAULT_TIMEOUT });
        else await page.locator(command.selector).screenshot({ path, timeout: command.timeout ?? DEFAULT_TIMEOUT });
        record.screenshot = path;
        result.screenshots.push(path);
      } else if (command.action === 'text') {
        const locator = command.selector === undefined ? page.locator('body') : page.locator(command.selector).first();
        record.visible = await locator.isVisible().catch(() => false);
        record.observed = (await locator.innerText({ timeout: command.timeout ?? DEFAULT_TIMEOUT })).slice(0, command.maxChars ?? MAX_TEXT);
      } else if (command.action === 'route') {
        const delayMs = command.delayMs ?? 0;
        await context.route(command.url, async (route) => {
          if (command.abort === true) { await route.abort('failed'); return; }
          if (delayMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
          await route.continue();
        });
      } else if (command.action === 'unroute') await context.unroute(command.url);
      else if (command.action === 'viewport') await page.setViewportSize({ width: command.width, height: command.height });
      else if (command.action === 'media') await page.emulateMedia({ colorScheme: command.colorScheme ?? 'light', reducedMotion: command.reducedMotion ?? 'no-preference' });
      else if (command.action === 'back') await page.goBack({ timeout: command.timeout ?? DEFAULT_TIMEOUT });
      else if (command.action === 'reload') await page.reload({ waitUntil: command.waitUntil ?? 'load', timeout: command.timeout ?? DEFAULT_TIMEOUT });
      else if (command.action === 'url') record.observed = page.url();
    } catch (error) {
      record.status = 'failed';
      record.error = error.message;
      result.ok = false;
    }
    record.url = page.url();
    result.steps.push(record);
    if (record.status === 'failed') break;
  }
  await browser.close();
  result.console = events.console;
  result.pageErrors = events.pageErrors;
  result.requestFailures = events.requestFailures;
  result.httpErrors = events.httpErrors;
  await writeFile(join(out, 'replay.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ok: result.ok, steps: result.steps.length, failed: result.steps.filter((step) => step.status === 'failed').length, skipped: result.skipped.length, out }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

/**
 * Stop a running session by asking it to close.
 * @param options - parsed flags.
 */
async function stop(options) {
  if (!options.session) fail('stop requires --session');
  const session = JSON.parse(await readFile(resolve(options.session), 'utf8'));
  const socket = await connect(session.port).catch((error) => fail(`cannot reach the session: ${error.message}`));
  const response = await request(socket, { token: session.token, command: { action: 'close' } });
  socket.end();
  console.log(JSON.stringify(response, null, 2));
}

try {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === undefined || subcommand === '-h' || subcommand === '--help') { console.log(USAGE); process.exit(0); }
  const options = parseArgs(rest);
  if (subcommand === 'start') await start(options);
  else if (subcommand === 'do') await send(options);
  else if (subcommand === 'replay') await replay(options);
  else if (subcommand === 'stop') await stop(options);
  else fail(`unknown subcommand ${subcommand}`);
} catch (error) {
  console.error(`ux-pass: ${error.message}`);
  process.exit(1);
}
