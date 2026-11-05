/**
 * Pulse feed — one bounded completion digest per watched-session turn, delivered
 * to the parent Agent through the same internal owner chat channel as callbacks.
 *
 * The feed is deliberately quiet: no digest is delivered until `pulse.sessions`
 * is non-empty, deliveries are spaced by `pulse.minQuietSeconds`, and multiple turns in
 * the quiet window coalesce into one message. Restart dedupe uses the persisted
 * last turn/end sequence per session.
 *
 * @module @local/dsh-sidebar-agent/pulse-feed
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { withMachineMeta } from './machine-meta.js'

/** Cordis plugin name. */
const DEFAULTS = {
	sessions: [],
	minQuietSeconds: 60,
	maxDigestChars: 1200,
}

const MAX_PROMPT = 200
const MAX_RESULT = 400
const TOKEN_SHAPED = /\b\d{5,}:[A-Za-z0-9_-]{15,}\b|\bsk-[A-Za-z0-9_-]{16,}\b/g

/** Validate the row config; unknown keys fail loudly. */
export function resolvePulseConfig(config = {}) {
	if (config === null || typeof config !== 'object' || Array.isArray(config)) {
		throw new TypeError('sidebar-agent pulse feed: config must be an object')
	}
	for (const key of Object.keys(config)) {
		if (!(key in DEFAULTS)) throw new Error(`sidebar-agent pulse feed: unknown config key "${key}"`)
	}
	const sessions = config.sessions ?? DEFAULTS.sessions
	if (!Array.isArray(sessions) || sessions.some((id) => typeof id !== 'string' || id.trim() === '')) {
		throw new TypeError('sidebar-agent pulse feed: sessions must be an array of session ids')
	}
	const minQuietSeconds = config.minQuietSeconds ?? DEFAULTS.minQuietSeconds
	if (typeof minQuietSeconds !== 'number' || !Number.isFinite(minQuietSeconds) || minQuietSeconds < 0) {
		throw new TypeError('sidebar-agent pulse feed: minQuietSeconds must be a non-negative number')
	}
	const maxDigestChars = config.maxDigestChars ?? DEFAULTS.maxDigestChars
	if (!Number.isSafeInteger(maxDigestChars) || maxDigestChars < MAX_PROMPT) {
		throw new TypeError(`sidebar-agent pulse feed: maxDigestChars must be an integer >= ${MAX_PROMPT}`)
	}
	return {
		sessions: [...new Set(sessions.map((id) => id.trim()))],
		minQuietSeconds,
		maxDigestChars,
	}
}

/** Redact credential-shaped values from feed content. */
export function redact(text) {
	return typeof text === 'string' ? text.replace(TOKEN_SHAPED, '[redacted]') : ''
}

/** Flatten and bound one line. */
function oneLine(value, max) {
	const text = redact(String(value ?? '')).replace(/\s+/g, ' ').trim()
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Text blocks from a message payload. */
function contentText(content) {
	if (!Array.isArray(content)) return ''
	return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
}

/** Human-readable end reason. */
function reasonOf(reason) {
	if (typeof reason === 'string') return reason
	if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
	return 'completed'
}

/** Duration in a compact form; null when the start is unknown. */
function durationOf(ms) {
	if (!Number.isFinite(ms) || ms < 0) return null
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds === 0) return '<1s'
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** One turn digest, before coalescing/truncation. Unknown fields are omitted. */
export function buildDigest({ sessionId, title, endReason, durationMs, prompt, result }) {
	const lines = [
		'pulse',
		`session: ${sessionId}`,
		`title: ${oneLine(title, 120)}`,
		`reason: ${oneLine(endReason, 80)}`,
	]
	const duration = durationOf(durationMs)
	if (duration !== null) lines.push(`duration: ${duration}`)
	const promptText = oneLine(prompt, MAX_PROMPT)
	if (promptText !== '') lines.push(`prompt: ${promptText}`)
	const resultText = oneLine(result, MAX_RESULT)
	if (resultText !== '') lines.push(`result: ${resultText}`)
	return withMachineMeta(lines.join('\n'), {
		kind: 'pulse',
		session: sessionId,
		title: oneLine(title, 120),
		reason: oneLine(endReason, 80),
		durationMs: Number.isFinite(durationMs) ? durationMs : null,
		prompt: promptText,
		result: resultText,
	})
}

/** Bound a combined digest while keeping the literal header first. */
function boundDigest(text, maxChars) {
	if (text.length <= maxChars) return text
	const marker = text.lastIndexOf('\n<!--meta:')
	if (marker >= 0) {
		const tail = text.slice(marker)
		if (tail.length + 1 < maxChars) return `${text.slice(0, maxChars - tail.length - 1)}…${tail}`
	}
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Create a feed instance; exported for the integration tests.
 * @param {object} options - dependencies.
 * @param {any} options.ctx - Cordis context (sessionTitle, logger).
 * @param {any} options.runtime - sidebar Agent runtime; delivery uses its live Agent handle.
 * @param {Record<string, any>} [options.config] - sidebar row sponsor config.
 * @param {{lastSeen: Record<string, number>}} options.state - persisted lastSeen state.
 * @param {() => Promise<any>} options.persist - persist the sidebar state.
 * @param {() => number} [options.clock] - injectable clock.
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] - timers.
 * @param {Record<string, any>} [options.logger] - logger.
 * @returns {Promise<Record<string, any>>} feed handle.
 */
export async function createPulseFeed({ ctx, runtime, config = {}, state, persist, clock = () => Date.now(), timers = { setTimeout, clearTimeout }, logger = console } = {}) {
	const cfg = resolvePulseConfig(config)
	const watched = new Set(cfg.sessions)
	if (state === null || typeof state !== 'object' || state.lastSeen === null || typeof state.lastSeen !== 'object') {
		throw new TypeError('sidebar-agent pulse feed: state.lastSeen is required')
	}
	if (typeof persist !== 'function') throw new TypeError('sidebar-agent pulse feed: persist is required')

	const turns = new Map()
	const lastTurnEnd = new Map()
	const pending = []
	let timer = null
	let lastDeliveryAt = Number.NEGATIVE_INFINITY
	let tail = Promise.resolve()
	let closed = false

	const save = () => persist()

	const titleOf = (session) => {
		try {
			const snapshot = ctx.get?.('sessionTitle')?.get?.(session)
			if (typeof snapshot?.title === 'string' && snapshot.title !== '') return snapshot.title
		} catch {
			// Title is presentation only.
		}
		return typeof session?.header?.title === 'string' && session.header.title !== '' ? session.header.title : session.id
	}

	const deliver = (text) => {
		const agent = runtime.agent
		if (agent === null || agent === undefined) throw new Error('sidebar-agent pulse feed: the Agent is not live')
		const message = createUserMessage({
			content: [{ type: 'text', text }],
			source: { kind: 'user' },
		})
		if (agent.status === 'running') agent.steer(message)
		else agent.followup(message)
	}

	const retryOnce = (text) => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				deliver(text)
				return true
			} catch (error) {
				if (attempt === 1) {
					logger?.warn?.(`sidebar-agent pulse feed: delivery failed after retry: ${error?.message ?? error}`)
				}
			}
		}
		return false
	}

	const flush = async () => {
		if (timer !== null) {
			timers.clearTimeout(timer)
			timer = null
		}
		if (pending.length === 0) return false
		const batch = pending.splice(0, pending.length)
		const text = boundDigest(batch.join('\n\n'), cfg.maxDigestChars)
		lastDeliveryAt = clock()
		return retryOnce(text)
	}

	const schedule = () => {
		if (closed || timer !== null || pending.length === 0) return
		const wait = lastDeliveryAt + cfg.minQuietSeconds * 1000 - clock()
		if (wait <= 0) {
			void flush()
			return
		}
		timer = timers.setTimeout(() => {
			timer = null
			void flush()
		}, wait)
	}

	const processEvent = async (session, event) => {
		if (!watched.has(session?.id) || session.id === runtime.sessionId || event === null || typeof event !== 'object') return
		const data = event.data ?? {}
		const current = turns.get(session.id)
		if (event.type === 'turn/start') {
			turns.set(session.id, { startedAt: Number.isFinite(event.time) ? event.time : null, prompt: '', result: '' })
			return
		}
		if (event.type === 'user/message' && data.source?.kind === 'user') {
			const turn = current ?? { startedAt: null, prompt: '', result: '' }
			turn.prompt = contentText(data.content)
			turns.set(session.id, turn)
			return
		}
		if (event.type === 'assistant/message' && data.interrupted !== true) {
			const text = contentText(data.message?.content)
			if (text !== '') {
				const turn = current ?? { startedAt: null, prompt: '', result: '' }
				turn.result = text
				turns.set(session.id, turn)
			}
			return
		}
		if (event.type !== 'turn/end') return
		const seq = Number.isSafeInteger(event.seq) ? event.seq : null
		if (seq !== null && seq <= (state.lastSeen[session.id] ?? -1)) return
		if (seq !== null) {
			state.lastSeen[session.id] = seq
			await save()
		}
		const turn = current ?? { startedAt: null, prompt: '', result: '' }
		const endAt = Number.isFinite(event.time) ? event.time : clock()
		const previousEnd = lastTurnEnd.get(session.id)
		let durationMs = null
		if (Number.isFinite(turn.startedAt) && endAt >= turn.startedAt) durationMs = endAt - turn.startedAt
		else if (Number.isFinite(previousEnd) && endAt >= previousEnd) durationMs = endAt - previousEnd
		turns.delete(session.id)
		lastTurnEnd.set(session.id, endAt)
		pending.push(buildDigest({
			sessionId: session.id,
			title: titleOf(session),
			endReason: reasonOf(data.reason),
			durationMs,
			prompt: turn.prompt,
			result: turn.result,
		}))
		schedule()
	}

	const handle = (session, event) => {
		tail = tail.then(() => processEvent(session, event)).catch((error) => {
			logger?.warn?.(`sidebar-agent pulse feed: event handling failed: ${error?.message ?? error}`)
		})
	}

	const close = async () => {
		closed = true
		if (timer !== null) {
			timers.clearTimeout(timer)
			timer = null
		}
		await tail
		await flush()
	}

	return {
		config: cfg,
		handle,
		flush,
		close,
		pendingCount: () => pending.length,
		idle: async () => { await tail },
	}
}
