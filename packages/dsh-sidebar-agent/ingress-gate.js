/**
 * Steer/queue ingress gate for the sidebar Agent.
 *
 * The gate owns the delivery decision, FIFO queue and bounded decision log.
 * Message text is used for the decision and is never written to the log.
 * @module @local/dsh-sidebar-agent/ingress-gate
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createDecisionLog } from './decision-log.js'
import { createJudge } from './judge.js'

const URGENT = /\b(?:actually|stop|wait|now|instead|rather|change|correct|fix|redo|revert|switch|adjust|update|replace|undo)\b/i
const EXPLICIT = /^\/(steer|queue)(?:@[A-Za-z0-9_]+)?(?:\s+|$)/i

/** Whether text carries an urgency/correction marker. */
export function urgencyOf(text) {
	return typeof text === 'string' && URGENT.test(text)
}

/**
 * Parse a leading /steer or /queue. Only the leading command is honored.
 * @param {string} text - inbound text.
 * @returns {{command: 'steer'|'queue', text: string} | null} parsed command.
 */
export function explicitCommandOf(text) {
	if (typeof text !== 'string') return null
	const match = EXPLICIT.exec(text)
	if (match === null) return null
	const command = match[1].toLowerCase()
	const rest = text.slice(match[0].length)
	return { command, text: rest.trim() }
}

/** Current settings-shaped gate config. */
function gateSettings(config) {
	const source = config !== null && typeof config === 'object' ? config : {}
	const mode = source.mode === 'off' || source.mode === 'judge' || source.mode === 'rules' ? source.mode : 'rules'
	const judgeSource = source.judge !== null && typeof source.judge === 'object' ? source.judge : {}
	return {
		mode,
		judge: {
			enabled: judgeSource.enabled === true,
			url: typeof judgeSource.url === 'string' && judgeSource.url !== '' ? judgeSource.url : 'http://127.0.0.1:8098/v1',
			model: typeof judgeSource.model === 'string' && judgeSource.model !== '' ? judgeSource.model : 'clef-flash',
			timeoutMs: Number.isSafeInteger(judgeSource.timeoutMs) && judgeSource.timeoutMs > 0 ? judgeSource.timeoutMs : 2500,
		},
	}
}

/**
 * Create the gate for one live Agent.
 * @param {object} options - gate options.
 * @param {any} options.runtime - shared sidebar runtime.
 * @param {Record<string, any>} [options.config] - `gate` config block.
 * @param {string} options.dataDir - state/log directory.
 * @param {Record<string, any>} [options.logger] - logger.
 * @param {() => number} [options.clock] - injectable clock.
 * @param {typeof fetch} [options.fetchImpl] - judge fetch.
 * @param {number} [options.logMaxBytes] - test/rotation cap.
 * @returns {Record<string, any>} gate.
 */
export function createIngressGate({ runtime, config = {}, dataDir, logger = console, clock = Date.now, fetchImpl = fetch, logMaxBytes = 5 * 1024 * 1024 } = {}) {
	const settings = gateSettings(config)
	const judge = createJudge({ config: settings.judge, fetchImpl })
	const queue = []
	const log = createDecisionLog({ path: `${dataDir}/decision-log.ndjson`, maxBytes: logMaxBytes, logger })
	let closed = false

	const defaultMessage = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

	function rulesChoice(text, busy) {
		if (!busy) return { choice: 'queue', path: 'idle-followup' }
		if (urgencyOf(text)) return { choice: 'steer', path: 'urgent' }
		return { choice: 'queue', path: 'default-queue' }
	}

	function makeRecord(features, choice, path, started) {
		return {
			ts: new Date(clock()).toISOString(),
			session: typeof runtime.sessionId === 'string' ? runtime.sessionId : 'unknown',
			features,
			choice,
			path,
			latencyMs: Math.max(0, Math.round(clock() - started)),
		}
	}

	function record(features, choice, path, started) {
		const line = makeRecord(features, choice, path, started)
		log.append(line)
		return line
	}

	/**
	 * Queue drain used at turn end and before an idle delivery.
	 * @param {any} agent - live Agent.
	 * @returns {number} number delivered.
	 */
	function onTurnEnd(agent) {
		let delivered = 0
		while (queue.length > 0) {
			const entry = queue[0]
			try {
				agent.followup(entry.message)
				queue.shift()
				log.append({ ...entry.record, drained: true, drainedAt: new Date(clock()).toISOString() })
				delivered += 1
			} catch {
				break
			}
		}
		return delivered
	}

	/**
	 * Decide and deliver one text ingress.
	 * @param {any} agent - live Agent.
	 * @param {string} text - inbound text.
	 * @param {{createMessage?: (text: string) => any}} [options] - message factory.
	 * @returns {Promise<Record<string, any>>} delivery decision.
	 */
	async function deliver(agent, text, { createMessage = defaultMessage } = {}) {
		if (closed) throw new Error('the ingress gate is closed')
		const started = clock()
		const original = typeof text === 'string' ? text : ''
		const explicit = explicitCommandOf(original)
		const finalText = explicit === null ? original.trim() : explicit.text
		if (finalText === '') {
			const error = new Error('the message is empty')
			error.code = 'EMPTY_GATE_MESSAGE'
			throw error
		}
		const busy = agent?.status === 'running'
		const pendingQuestion = runtime.pendingQuestion?.() === true
		const features = {
			pendingQuestion,
			urgent: urgencyOf(finalText),
			explicit: explicit?.command ?? null,
			queuedCount: queue.length,
			msgLen: original.trim().length,
		}
		let choice
		let path
		if (settings.mode === 'off') {
			choice = busy ? 'steer' : 'queue'
			path = 'legacy'
		} else if (!busy) {
			choice = 'queue'
			path = 'idle-followup'
		} else if (pendingQuestion) {
			choice = 'answer'
			path = 'pending-question'
		} else if (explicit !== null) {
			choice = explicit.command === 'steer' ? 'steer' : 'queue'
			path = explicit.command === 'steer' ? 'explicit-steer' : 'explicit-queue'
		} else if (settings.mode === 'judge' && judge.enabled === true) {
			let verdict = null
			try {
				verdict = await judge.classify({ text: finalText, features })
			} catch {
				verdict = { ok: false, reason: 'unavailable' }
			}
			if (verdict?.ok === true && verdict.choice !== 'answer') {
				choice = verdict.choice
				path = 'judge'
			} else {
				const fallback = rulesChoice(finalText, busy)
				choice = fallback.choice
				path = 'judge-fallback'
			}
		} else {
			const fallback = rulesChoice(finalText, busy)
			choice = fallback.choice
			path = fallback.path
		}
		if (!busy && queue.length > 0) onTurnEnd(agent)
		const message = createMessage(finalText)
		const decision = makeRecord(features, choice, path, started)
		let queued = false
		let running = busy
		if (choice === 'queue' && busy) {
			queue.push({ message, record: decision })
			queued = true
		} else if (choice === 'steer' || choice === 'answer') {
			if (busy) agent.steer(message)
			else agent.followup(message)
			running = busy
		} else {
			// Idle (or legacy idle) follows up through the existing path.
			if (busy) agent.followup(message)
			else agent.followup(message)
			running = false
		}
		log.append(decision)
		return {
			gate: true,
			messageId: message.id,
			running,
			queued,
			choice,
			path,
			queuedCount: features.queuedCount,
			latencyMs: Math.max(0, Math.round(clock() - started)),
		}
	}

	return {
		mode: settings.mode,
		judge,
		deliver,
		onTurnEnd,
		pendingCount: () => queue.length,
		flush: () => log.flush(),
		close: async () => {
			closed = true
			queue.length = 0
			await log.close()
		},
		dispose: () => {
			closed = true
			queue.length = 0
			void log.close()
		},
	}
}
