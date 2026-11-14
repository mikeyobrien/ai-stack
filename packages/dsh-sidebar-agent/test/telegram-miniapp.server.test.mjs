import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMiniApp, validateInitData } from '../telegram-miniapp.js'

// Independent published Telegram Mini Apps vector (docs.telegram-mini-apps.com).
const VECTOR_TOKEN = '5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8'
const VECTOR_DATA = 'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2'
const VECTOR_NOW = 1662771648000
const VECTOR_USER = 279058397

import { createHmac } from 'node:crypto'
const secretOf = (token) => createHmac('sha256', 'WebAppData').update(token).digest()
function signedInitData(token, { authDate, user, queryId = 'test-query' } = {}) {
  const pairs = `auth_date=${authDate}\nquery_id=${queryId}\nuser=${JSON.stringify(user)}`
  const hash = createHmac('sha256', secretOf(token)).update(pairs).digest('hex')
  return `auth_date=${authDate}&query_id=${queryId}&user=${encodeURIComponent(JSON.stringify(user))}&hash=${hash}`
}

const AUTH = { 'x-telegram-init-data': VECTOR_DATA }
const RUNTIME = () => ({ sessionId: 'agent-1', model: { provider: 'p', model: 'm' }, agent: { status: 'idle' }, pulseHistory: [] })

function startApp(handler, basePath = '/telegram-miniapp') {
  return new Promise((resolve) => {
    const server = createServer((req, res) => Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)) }))
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}${basePath}`,
      close: () => new Promise((done) => server.close(done)),
    }))
  })
}

test('static assets resolve at the exact bot menu path, canonical prefix and bare prefix', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const app = createMiniApp({ runtime: RUNTIME(), botToken: VECTOR_TOKEN, allowedUserIds: [VECTOR_USER], staticDir: dir, dataDir: '/tmp/none' })
  const { server, base, close } = await startApp(app)
  t.after(close)

  const expected = { '/': 'mAgent', '/index.html': 'mAgent', '/app.js': 'Telegram', '/style.css': '--bg' }
  for (const [path, needle] of Object.entries(expected)) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 200, `GET ${path}`)
    assert.match(await response.text(), new RegExp(needle), `body of GET ${path}`)
  }
  const shell = await (await fetch(`${base}/`)).text()
  assert.match(shell, /telegram\.org\/js\/telegram-web-app\.js/, 'shell loads the official Telegram SDK')
  assert.match(shell, /<script src="app\.js"/, 'shell loads app.js from the served path')
  const appJs = await (await fetch(`${base}/app.js`)).text()
  assert.match(appJs, /ready\(\)/, 'app.js drives Telegram WebApp init')
  assert.match(appJs, /aria-current/, 'app.js marks the active tab')
})

test('bare prefix redirects to the canonical path with a 302', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const app = createMiniApp({ runtime: RUNTIME(), botToken: VECTOR_TOKEN, allowedUserIds: [VECTOR_USER], staticDir: dir, dataDir: '/tmp/none' })
  const { server, base, close } = await startApp(app)
  t.after(close)

  // base = http://127.0.0.1:PORT/telegram-miniapp (no trailing slash)
  const bare = await fetch(`${base}`, { redirect: 'manual' })
  assert.equal(bare.status, 302, 'bare prefix 302 redirects to canonical path')
  assert.equal(bare.headers.get('location'), '/telegram-miniapp/')
  const canonical = await fetch(`${base}/`)
  assert.equal(canonical.status, 200)
})

test('auth decisions are per-request, using the request time', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const app = createMiniApp({ runtime: RUNTIME(), botToken: VECTOR_TOKEN, allowedUserIds: [VECTOR_USER], staticDir: dir, dataDir: '/tmp/none', rateLimit: 100 })
  const { server, base, close } = await startApp(app)
  t.after(close)

  // Valid at the published vector's auth_date, 2026-01-01 (auth_date 1767225600), and
  // expired by the next request (default 1 day) — the two requests happen seconds apart.
  const secondsNow = Math.floor(Date.now() / 1000)
  const valid = signedInitData(VECTOR_TOKEN, { authDate: secondsNow, user: { id: VECTOR_USER, first_name: 'V' } })
  const stale = signedInitData(VECTOR_TOKEN, { authDate: secondsNow - 90 * 24 * 3600, user: { id: VECTOR_USER, first_name: 'V' } })

  assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-telegram-init-data': valid } })).status, 200)
  assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-telegram-init-data': stale } })).status, 401)
})

test('unauthorized is 401, disallowed user is 403, non-GET is 405, unknown API is 404', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const secondsNow = Math.floor(Date.now() / 1000)
  const validFor42 = signedInitData(VECTOR_TOKEN, { authDate: secondsNow, user: { id: 42, first_name: 'A' } })
  const app = createMiniApp({ runtime: RUNTIME(), botToken: VECTOR_TOKEN, allowedUserIds: [42], staticDir: dir, dataDir: '/tmp/none', rateLimit: 100 })
  const { server, base, close } = await startApp(app)
  t.after(close)

  assert.equal((await fetch(`${base}/api/status`)).status, 401)
  assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-telegram-init-data': validFor42 } })).status, 200)
  assert.equal((await fetch(`${base}/api/status`, { method: 'POST', headers: { 'x-telegram-init-data': validFor42 } })).status, 405)
  assert.equal((await fetch(`${base}/api/missing`, { headers: { 'x-telegram-init-data': validFor42 } })).status, 404)

  // User 279058397 (freshly signed) is NOT in the allowlist [42] → 403
  const notAllowed = signedInitData(VECTOR_TOKEN, { authDate: secondsNow, user: { id: VECTOR_USER, first_name: 'V' } })
  assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-telegram-init-data': notAllowed } })).status, 403)
  const body = await (await fetch(`${base}/api/status`, { headers: { 'x-telegram-init-data': notAllowed } })).json()
  assert.equal(body.error, 'user-not-allowed')
})

test('malformed, missing and future-dated initData are rejected', () => {
  const now = Math.floor(Date.now() / 1000)
  const user = { id: 1, first_name: 'A' }
  assert.equal(validateInitData('', VECTOR_TOKEN), null)
  assert.equal(validateInitData('hash=deadbeef', VECTOR_TOKEN), null)
  assert.equal(validateInitData(signedInitData(VECTOR_TOKEN, { authDate: now, user }), 'other-token'), null)
  assert.equal(validateInitData(signedInitData(VECTOR_TOKEN, { authDate: now + 6 * 3600, user }), VECTOR_TOKEN), null)
})

test('decision-log serves records, and reports a fallback for a missing file', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'miniapp-declog-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const secondsNow = Math.floor(Date.now() / 1000)
  const auth = signedInitData(VECTOR_TOKEN, { authDate: secondsNow, user: { id: VECTOR_USER, first_name: 'V' } })
  const runtime = { ...RUNTIME(), pendingQuestion: () => null }
  const app = createMiniApp({ runtime, botToken: VECTOR_TOKEN, allowedUserIds: [VECTOR_USER], staticDir: dir, dataDir, rateLimit: 100 })
  const { server, base, close } = await startApp(app)
  t.after(close)

  const missing = await (await fetch(`${base}/api/decision-log`, { headers: { 'x-telegram-init-data': auth } })).json()
  assert.deepEqual(missing, { records: [], fallback: true })

  await writeFile(join(dataDir, 'decision-log.ndjson'), [
    JSON.stringify({ kind: 'decision', title: 'approve', reason: 'tests pass' }),
    JSON.stringify({ kind: 'decision', title: 'defer', reason: 'later' }),
    'not-json',
  ].join('\n'))
  const populated = await (await fetch(`${base}/api/decision-log`, { headers: { 'x-telegram-init-data': auth } })).json()
  assert.equal(populated.records.length, 2)
  assert.equal(populated.records[0].title, 'approve')
  assert.equal(populated.fallback, undefined)
})

test('questions and pulses keep their real DTO shapes in the response', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const runtime = {
    ...RUNTIME(),
    pendingQuestion: () => ({ question: 'Which model?', options: ['a', 'b'] }),
    pulseHistory: ['🎤 deploy ok\n<!--meta:{"kind":"pulse","title":"deploy","state":"LIVE"}-->'],
  }
  const app = createMiniApp({ runtime, botToken: VECTOR_TOKEN, allowedUserIds: [VECTOR_USER], staticDir: dir, dataDir: '/tmp/none', rateLimit: 100 })
  const { server, base, close } = await startApp(app)
  t.after(close)

  const secondsNow2 = Math.floor(Date.now() / 1000)
  const auth2 = signedInitData(VECTOR_TOKEN, { authDate: secondsNow2, user: { id: VECTOR_USER, first_name: 'V' } })
  const questions = await (await fetch(`${base}/api/questions`, { headers: { 'x-telegram-init-data': auth2 } })).json()
  assert.equal(questions.pending.question, 'Which model?')
  assert.deepEqual(questions.questions, [])

  const pulses = await (await fetch(`${base}/api/pulses`, { headers: { 'x-telegram-init-data': auth2 } })).json()
  assert.equal(pulses.pulses.length, 1)
  assert.match(pulses.pulses[0], /deploy ok/)
})

test('bare prefix redirect preserves the query string', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const app = createMiniApp({ runtime: RUNTIME(), botToken: VECTOR_TOKEN, allowedUserIds: [VECTOR_USER], staticDir: dir, dataDir: '/tmp/none' })
  const { server, base, close } = await startApp(app)
  t.after(close)

  // base = http://127.0.0.1:PORT/telegram-miniapp (no trailing slash)
  const response = await fetch(`${base}?a=1&b=2`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/telegram-miniapp/?a=1&b=2')
})

test('slash-configured basePath: canonical form serves directly without a redirect loop', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const app = createMiniApp({
    runtime: RUNTIME(), botToken: VECTOR_TOKEN, allowedUserIds: [VECTOR_USER],
    staticDir: dir, dataDir: '/tmp/none', basePath: '/telegram-miniapp/',
  })
  const { server, close } = await startApp(app, '/telegram-miniapp/')
  t.after(close)

  // The base already ends with a slash: http://127.0.0.1:PORT/telegram-miniapp/
  // Fetching the canonical form must return 200, not a 302 to itself.
  const port = server.address().port
  const response = await fetch(`http://127.0.0.1:${port}/telegram-miniapp/`)
  assert.equal(response.status, 200, 'canonical form with slash returns 200, not a redirect loop')
  assert.match(await response.text(), /mAgent/)
})

test('static paths outside the allowlist 404; no path traversal', async (t) => {
  const dir = new URL('../telegram-miniapp/', import.meta.url).pathname
  const app = createMiniApp({ runtime: RUNTIME(), botToken: VECTOR_TOKEN, allowedUserIds: [VECTOR_USER], staticDir: dir, dataDir: '/tmp/none' })
  const { server, base, close } = await startApp(app)
  t.after(close)

  assert.equal((await fetch(`${base}/..%2f..%2findex.js`)).status, 404)
  assert.equal((await fetch(`${base}/..%2findex.js`)).status, 404)
  assert.equal((await fetch(`${base}/nope.txt`)).status, 404)
})
