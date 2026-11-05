/**
 * Typed 3-way judge client for the ingress gate.
 *
 * The endpoint is intentionally loopback-only: ingress message text must never
 * leave the machine. The judge is OpenAI-compatible chat completions and ships
 * disabled until a supported endpoint exists.
 * @module @local/dsh-sidebar-agent/judge
 */

const CHOICES = new Set(['steer', 'queue', 'answer'])
const MIN_CONFIDENCE = 0.6

/** Whether a hostname resolves only to the local machine. */
function loopback(hostname) {
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/** The chat-completions URL for a configured base. */
export function judgeEndpoint(raw) {
	const url = new URL(raw)
	if (!loopback(url.hostname)) throw new Error('judge endpoint must be loopback')
	if (url.pathname.endsWith('/systemone')) return { url, protocol: 'systemone' }
	if (url.pathname.endsWith('/chat/completions')) return { url, protocol: 'chat' }
	if (url.pathname.endsWith('/v1')) url.pathname = `${url.pathname}/chat/completions`
	else url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/chat/completions`
	return { url, protocol: 'chat' }
}

/** Validate one typed decision body. */
function typedDecision(value) {
	if (value === null || typeof value !== 'object') return null
	const { choice, confidence, reason } = value
	if (typeof choice !== 'string' || !CHOICES.has(choice)) return null
	if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
	if (typeof reason !== 'string' || reason.trim() === '') return null
	return { choice, confidence, reason: reason.replace(/\s+/g, ' ').trim().slice(0, 240) }
}

/**
 * Create the judge client. Disabled/failed calls return null or `{ok:false}` so
 * the gate can fall back to rules without throwing.
 * @param {object} options - judge options.
 * @param {{enabled?: boolean, url?: string, model?: string, timeoutMs?: number}} options.config - judge config.
 * @param {typeof fetch} [options.fetchImpl] - injectable fetch for tests.
 * @returns {Record<string, any>} judge.
 */
export function createJudge({ config = {}, fetchImpl = fetch } = {}) {
	const enabled = config.enabled === true
	const url = typeof config.url === 'string' && config.url !== '' ? config.url : 'http://127.0.0.1:8098/v1'
	const model = typeof config.model === 'string' && config.model !== '' ? config.model : 'clef-flash'
	const timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 2500

	/**
	 * Classify one message against the same snapshot the gate logged.
	 * @param {{text: string, features: Record<string, any>}} request - snapshot.
	 * @returns {Promise<null | {ok: boolean, choice?: string, confidence?: number, reason: string}>} result.
	 */
	async function classify({ text, features }) {
		if (!enabled) return null
		let target
		try {
			target = judgeEndpoint(url)
		} catch (error) {
			return { ok: false, reason: error.message === 'judge endpoint must be loopback' ? 'non-local' : 'invalid-url' }
		}
		if (target.protocol === 'systemone') {
			const body = {
				state: JSON.stringify({ features, message: text }),
				questions: {
					delivery: {
						type: 'choice',
						instructions: 'Choose how to deliver this message to a busy agent. steer interrupts for a correction or urgent redirect; queue waits for the next turn; answer is only for a pending question. Use queue when unsure.',
						criteria: {
							steer: 'correction or urgent redirect of current work',
							queue: 'new work or enrichment for a later turn',
							answer: 'reply to a pending question',
						},
					},
				},
			}
			let response
			try {
				response = await fetchImpl(target.url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(timeoutMs),
				})
			} catch (error) {
				return { ok: false, reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unavailable' }
			}
			if (!response?.ok) return { ok: false, reason: 'http' }
			let parsed
			try {
				parsed = await response.json()
			} catch {
				return { ok: false, reason: 'malformed' }
			}
			const answer = parsed?.answers?.delivery
			if (answer === null || typeof answer !== 'object') return { ok: false, reason: 'malformed' }
			const decision = typedDecision({ choice: answer.choice, confidence: answer.confidence, reason: 'systemone' })
			if (decision === null) return { ok: false, reason: 'malformed' }
			if (decision.confidence < MIN_CONFIDENCE) return { ok: false, reason: 'low-confidence' }
			return { ok: true, ...decision }
		}
		const system = [
			'You are a delivery judge for one message sent to an agent that may be busy.',
			'Return ONLY a JSON object: {"choice":"steer"|"queue"|"answer","confidence":0..1,"reason":"one line"}.',
			'steer interrupts the current turn for a correction or urgent redirect; queue waits for the next turn; answer is only for a pending question.',
			'Use queue when unsure. Do not include prose outside the JSON.',
		].join(' ')
		const user = JSON.stringify({ features, message: text })
		let response
		try {
			response = await fetchImpl(target.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model,
					temperature: 0,
					messages: [
						{ role: 'system', content: system },
						{ role: 'user', content: user },
					],
				}),
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (error) {
			return { ok: false, reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unavailable' }
		}
		if (!response?.ok) return { ok: false, reason: 'http' }
		let body
		try {
			body = await response.json()
		} catch {
			return { ok: false, reason: 'malformed' }
		}
		const raw = body?.choices?.[0]?.message?.content
		if (typeof raw !== 'string') return { ok: false, reason: 'malformed' }
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			return { ok: false, reason: 'malformed' }
		}
		const decision = typedDecision(parsed)
		if (decision === null) return { ok: false, reason: 'malformed' }
		if (decision.confidence < MIN_CONFIDENCE) return { ok: false, reason: 'low-confidence' }
		return { ok: true, ...decision }
	}

	return { enabled, classify, url, model, timeoutMs }
}
