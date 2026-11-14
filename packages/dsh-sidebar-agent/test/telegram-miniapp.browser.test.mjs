import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServer } from 'node:http'
// Fixture-only browser (Playwright Chromium) with a stubbed Telegram WebApp SDK
// and stubbed API fixtures. No real Telegram/iPhone verification happens here.
const PLAYWRIGHT = process.env.DSH_PLAYWRIGHT
const CHROME = process.env.DSH_CHROME

async function resolveBrowser() {
  if (PLAYWRIGHT) {
    const target = PLAYWRIGHT.endsWith('.js') || PLAYWRIGHT.endsWith('.mjs') ? PLAYWRIGHT : `${PLAYWRIGHT}/index.mjs`
    const mod = await import(target)
    const chromium = mod.default?.chromium ?? mod.chromium
    return { chromium, executablePath: CHROME ?? chromium.executablePath() }
  }
  try {
    const mod = await import('playwright')
    const chromium = mod.default?.chromium ?? mod.chromium
    return { chromium, executablePath: CHROME ?? chromium.executablePath() }
  } catch {
    // Same fallback as fixture.test.mjs: the running web profile's Playwright
    // and a Chromium build already installed for the harness.
    try {
      const profile = process.env.DSH_WEB_PROFILE ?? join(homedir(), '.dsh/profiles/web')
      const { chromium } = createRequire(join(profile, 'package.json'))('playwright')
      const executablePath = CHROME ?? installedChromium()
      return executablePath === undefined ? null : { chromium, executablePath }
    } catch {
      return null
    }
  }
}

/** A Chromium build in the Playwright cache, if any. */
function installedChromium() {
  const cache = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(cache)) return undefined
  for (const entry of readdirSync(cache)) {
    for (const candidate of [join(cache, entry, 'chrome-headless-shell-linux64/chrome-headless-shell'), join(cache, entry, 'chrome-linux64/chrome')]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}
const VECTOR_DATA = 'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2'

/**
 * Serve the real index.html / app.js / style.css from the repo.
 * - index.html: strip the external SDK <script> tag (replaced by the stub in app.js).
 * - app.js: prepend the SDK stub (or not) before the real app.js code.
 * - api/*: configurable behaviour — 'ok' (200 + fixture DTOs), 'unauthorized' (401),
 *   'forbidden' (403), 'server-error' (500).
 */
async function serveReal(staticDir, { apiBehavior = 'ok', sdkReady = true } = {}) {
  const { readFile } = await import('node:fs/promises')
  const shell = await readFile(join(staticDir, 'index.html'), 'utf8')
  const appJs = await readFile(join(staticDir, 'app.js'), 'utf8')
  const css = await readFile(join(staticDir, 'style.css'), 'utf8')
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    if (url.pathname === '/telegram-miniapp/' || url.pathname === '/telegram-miniapp') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(shell.replace(/<script src="https:\/\/telegram\.org[^"]*"[^>]*><\/script>/, ''))
      return
    }
    if (url.pathname === '/telegram-miniapp/app.js') {
      // Serve the real app.js unmodified. The SDK stub is injected via
      // page.addInitScript (see openPageWithStub) so it runs before this file.
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(appJs)
      return
    }
    if (url.pathname === '/telegram-miniapp/style.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
      response.end(css)
      return
    }
    if (url.pathname.startsWith('/telegram-miniapp/api/')) {
      if (apiBehavior === 'unauthorized') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'telegram-auth-required' }))
        return
      }
      if (apiBehavior === 'forbidden') {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'telegram-forbidden' }))
        return
      }
      if (apiBehavior === 'server-error') {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'boom' }))
        return
      }
      // 'ok' — return fixture DTOs
      const name = url.pathname.replace('/telegram-miniapp/api/', '')
      let body
      if (name === 'status') body = { status: 'ok', session: 'agent-1', model: { provider: 'p', model: 'm' }, running: true }
      else if (name === 'pulses') body = { pulses: ['\u{1F3A4} deploy ok\n<!--meta:{"kind":"pulse","title":"deploy","state":"LIVE"}-->'] }
      else if (name === 'questions') body = { questions: [], pending: { question: 'Which model?', options: ['a', 'b'] } }
      else if (name === 'decision-log') body = { records: [{ kind: 'decision', title: 'approve', reason: 'tests pass' }] }
      else body = { error: 'not-found' }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not-found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

let _chromium
async function getChromium() {
  if (!_chromium) {
    const resolved = await resolveBrowser()
    if (resolved === null) {
      _chromium = null
      return null
    }
    _chromium = resolved
  }
  return _chromium
}

/**
 * Open a Playwright page with the SDK stub injected via addInitScript so it
 * runs before any page script (including the deferred app.js).
 */
async function openPage(t, { sdkReady = true } = {}) {
  const resolved = await getChromium()
  if (resolved === null) {
    t.skip('no playwright module or bundled browser available (set DSH_PLAYWRIGHT / DSH_CHROME)')
    return null
  }
  const { chromium, executablePath } = resolved
  const browser = await chromium.launch({ executablePath })
  const context = await browser.newContext()
  const stub = sdkReady
    ? `window.Telegram = { WebApp: { initData: ${JSON.stringify(VECTOR_DATA)}, ready() { window.__tg_ready__ = true }, expand() {}, setHeaderColor() {} } }`
    : 'window.Telegram = {}'
  await context.addInitScript(stub)
  const page = await context.newPage()
  return { browser, page }
}

test('SDK-ready: ready() called via defer ordering; status, tabs, cards render; no raw JSON', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const { base, close } = await serveReal(dir)
  t.after(close)
  const { browser, page } = await openPage(t)
  if (browser === undefined) return
  t.after(async () => browser.close())
  await page.goto(`${base}/telegram-miniapp/`, { waitUntil: 'networkidle' })

  // The deferred SDK stub runs before the deferred app.js, so ready() is called
  // synchronously at the top of app.js — no polling needed.
  assert.equal(await page.evaluate(() => window.__tg_ready__ === true), true, 'Telegram WebApp.ready() was called')

  await page.waitForSelector('#view .row')
  const text = await page.textContent('#view')
  assert.match(text, /LIVE/, 'status shows running state')
  assert.match(text, /agent-1/, 'status shows the session id')
  assert.match(text, /p \/ m/, 'status shows the model route')
  assert.doesNotMatch(text, /\{.*\}/, 'no raw JSON in the status view')
  assert.doesNotMatch(text, /token|bot/i, 'no secret or bot token in the DOM')

  await page.click('nav button[data-view="pulses"]')
  await page.waitForSelector('#view .card.live')
  const pulseText = await page.textContent('#view')
  assert.match(pulseText, /deploy/)
  assert.doesNotMatch(pulseText, /<!--meta/, 'meta comment is consumed, not shown raw')

  await page.click('nav button[data-view="questions"]')
  await page.waitForFunction(() => {
    const el = document.querySelector('#view')
    return el && !/Loading/.test(el.textContent) && /Which model/.test(el.textContent)
  }, { timeout: 5000 })
  const qText = await page.textContent('#view')
  assert.match(qText, /Which model\?/)
  assert.doesNotMatch(qText, /"options"/, 'no raw JSON for the pending question')

  await page.click('nav button[data-view="log"]')
  await page.waitForFunction(() => {
    const el = document.querySelector('#view')
    return el && !/Loading/.test(el.textContent) && /approve/.test(el.textContent)
  }, { timeout: 5000 })
  const logText = await page.textContent('#view')
  assert.match(logText, /approve/)
  assert.match(logText, /tests pass/)
  assert.doesNotMatch(logText, /"kind"/, 'no raw JSON in the log view')
})

test('401: shows actionable "Authentication required" message with retry button', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const { base, close } = await serveReal(dir, { apiBehavior: 'unauthorized' })
  t.after(close)
  const { browser, page } = await openPage(t)
  if (browser === undefined) return
  t.after(async () => browser.close())
  await page.goto(`${base}/telegram-miniapp/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#view .empty')
  const text = await page.textContent('#view')
  assert.match(text, /Authentication required/i, 'shows the 401 message')
  assert.match(text, /Re-open/i, 'tells the user what to do')
  const retryVisible = await page.isVisible('#retry')
  assert.equal(retryVisible, true, 'retry button is visible')
  assert.doesNotMatch(text, /"error"|"status"/, 'no raw JSON in the error state')
})

test('403: shows actionable "Access denied" message with retry button', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const { base, close } = await serveReal(dir, { apiBehavior: 'forbidden' })
  t.after(close)
  const { browser, page } = await openPage(t)
  if (browser === undefined) return
  t.after(async () => browser.close())
  await page.goto(`${base}/telegram-miniapp/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('#view .empty')
  const text = await page.textContent('#view')
  assert.match(text, /Access denied/i, 'shows the 403 message')
  assert.match(text, /not authorised/i, 'tells the user why')
  const retryVisible = await page.isVisible('#retry')
  assert.equal(retryVisible, true, 'retry button is visible')
  assert.doesNotMatch(text, /"error"|"status"/, 'no raw JSON in the error state')
})
