/**
 * Token-gated Telegram Mini App for mAgent: read-only pulse/delegation/status/
 * decision-log surfaces served by the existing Host webServer.
 *
 * Telegram initData is verified server-side with the bot token. The browser
 * never receives a secret; API responses are read-only and rate-limited.
 *
 * @module @local/dsh-mov-agent/telegram-miniapp
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Validate Telegram WebApp initData; returns parsed user or null. */
export function validateInitData(initData, botToken, { now = Date.now(), maxAgeSeconds = 86400 } = {}) {
	if (typeof initData !== 'string' || initData === '' || typeof botToken !== 'string' || botToken === '') return null
	const params = new URLSearchParams(initData)
	const hash = params.get('hash')
	if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return null
	const pairs = [...params.entries()]
		.filter(([key]) => key !== 'hash')
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join('\n')
	const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
	const expected = createHmac('sha256', secret).update(pairs).digest('hex')
	if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) return null
	const authDate = Number(params.get('auth_date'))
	if (!Number.isSafeInteger(authDate) || authDate <= 0 || now / 1000 - authDate > maxAgeSeconds) return null
	let user = null
	try { user = JSON.parse(params.get('user') ?? 'null') } catch { return null }
	return { user, authDate }
}

function sendJson(response, status, body, extra = {}) {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		...extra,
	})
	response.end(JSON.stringify(body))
}

function securityHeaders(response, contentType) {
	response.setHeader('content-type', contentType)
	response.setHeader('cache-control', 'no-store')
	response.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org")
	response.setHeader('x-content-type-options', 'nosniff')
	response.setHeader('referrer-policy', 'no-referrer')
}

/** Read the last N decision-log records. */
async function decisionTail(dataDir, limit = 50) {
	try {
		const text = await readFile(join(dataDir, 'decision-log.ndjson'), 'utf8')
		return text.trim().split('\n').slice(-limit).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
	} catch { return [] }
}

/**
 * Create the Mini App HTTP handler.
 * @param {object} options - dependencies.
 * @param {any} options.runtime - mAgent runtime.
 * @param {string} options.botToken - Telegram bot token, server-side only.
 * @param {string} options.basePath - route prefix.
 * @param {string} options.staticDir - directory containing index.html/app.js/style.css.
 * @param {() => string | null} [options.publicUrl] - optional bot menu URL.
 * @param {number} [options.rateLimit] - requests per minute per token.
 * @returns {(request: any, response: any) => Promise<void>} handler.
 */
export function createMiniApp({ runtime, botToken, allowedUserIds = [], basePath = '/telegram-miniapp', staticDir, dataDir = process.cwd(), rateLimit = 120, now = Date.now() }) {
	const buckets = new Map()
	const auth = (request) => validateInitData(request.headers?.['x-telegram-init-data'] ?? '', botToken, { now })
	const limited = (key) => {
		const now = Date.now()
		const bucket = buckets.get(key) ?? []
		const fresh = bucket.filter((at) => now - at < 60_000)
		if (fresh.length >= rateLimit) { buckets.set(key, fresh); return true }
		fresh.push(now); buckets.set(key, fresh); return false
	}
	return async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://local')
		let path = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || '/' : '/'
		if (path.startsWith('/api/')) {
			const session = auth(request)
			if (session === null) return sendJson(response, 401, { error: 'telegram-auth-required' })
			if (!allowedUserIds.includes(session.user?.id)) return sendJson(response, 403, { error: 'user-not-allowed' })
			if (limited(String(session.user?.id))) return sendJson(response, 429, { error: 'rate-limited' })
			if (request.method !== 'GET') return sendJson(response, 405, { error: 'read-only' }, { allow: 'GET' })
			if (path === '/api/status') return sendJson(response, 200, { status: 'ok', session: runtime.sessionId, model: runtime.model ?? null, running: runtime.agent?.status === 'running' })
			if (path === '/api/pulses') return sendJson(response, 200, { pulses: (runtime.pulseHistory ?? []).slice(-50) })
			if (path === '/api/questions') return sendJson(response, 200, { questions: [], pending: runtime.pendingQuestion?.() ?? null })
			if (path === '/api/decision-log') return sendJson(response, 200, { records: await decisionTail(dataDir) })
			return sendJson(response, 404, { error: 'not-found' })
		}
		if (limited(request.socket?.remoteAddress ?? 'unknown')) return sendJson(response, 429, { error: 'rate-limited' })
		if (path === '/') path = '/index.html'
		if (!['/index.html', '/app.js', '/style.css'].includes(path)) return sendJson(response, 404, { error: 'not-found' })
		try {
			const body = await readFile(join(staticDir, path.replace(/^\//, '')), 'utf8')
			securityHeaders(response, path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8')
			response.end(body)
		} catch {
			sendJson(response, 404, { error: 'not-found' })
		}
	}
}
