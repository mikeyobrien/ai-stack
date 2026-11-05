/**
 * Sidebar Agent ↔ Telegram glue.
 *
 * The Telegram feature already exists as one in-host bridge. This module does
 * not fork it: it is the explicit owner seam that lets the existing bridge be
 * hosted by the sidebar Agent later, with the Agent's own live handle as the
 * target of a bound chat and the ordinary Session Controller kept for every
 * non-migrated binding.
 *
 * Stage 1 never starts this glue. Creating it with the default config is a
 * no-op (`state: 'off'`): no bridge import, no token read, no poller, no state
 * write. Activation is the coordinated handoff step that removes the bridge
 * bundle row and calls `start()` once.
 *
 * `requestId` dedupe retains failed operations as well as successful ones: a
 * redelivered update returns the cached rejection and never re-prompts. The
 * 256-entry cache bound is unchanged; after eviction, a very old redelivery can
 * prompt again. That post-eviction residual is intentional and documented here.
 *
 * @module @local/dsh-sidebar-agent/telegram-host
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Default env var holding the bridge bot token (same identity as the bridge). */
export const DEFAULT_TELEGRAM_TOKEN_REF = 'DSH_TELEGRAM_SESSION_BRIDGE_BOT_TOKEN'

/** The one message an Agent-bound chat gets for `/new`. */
const AGENT_NEW_REPLY = 'Unsupported in the Agent chat: /new would replace the Agent binding. Use the Agent page.'

/** Raised when a command would create/replace a session for an Agent binding. */
export class AgentTargetUnsupportedError extends Error {
	/** Stable machine code for callers that branch on the reason. */
	code = 'agent-target-unsupported'

	/** @param {string} [message] - readable explanation. */
	constructor(message = 'the Agent binding has no /new: it would fork the Agent') {
		super(message)
		this.name = 'AgentTargetUnsupportedError'
	}
}

/**
 * Read one config member that may be a resolved volatile reference.
 * @param {unknown} value - plain value or `{get()}` reference.
 * @returns {unknown} the plain value.
 */
function plain(value) {
	return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * The session-controller facade handed to the existing bridge. Agent-target
 * calls (the Agent's own session id) use the live Agent handle; every other
 * call is forwarded byte-for-byte to the host Session Controller.
 *
 * @param {object} options - owner seam options.
 * @param {any} options.runtime - the sidebar Agent runtime (`sessionId`, `agent`).
 * @param {() => any} [options.forward] - returns the ordinary `sessionController`.
 * @param {Record<string, any>} [options.logger] - logger.
 * @returns {Record<string, any>} the facade plus its target scope.
 */
export function createAgentOwnerController({ runtime, forward = () => undefined, logger = console } = {}) {
	const targetScope = new AsyncLocalStorage()
	/** @type {Map<string, Promise<any>>} */
	const applied = new Map()
	let tail = Promise.resolve()

	const controller = () => {
		const service = forward()
		if (service === undefined || service === null) {
			throw new Error('sidebar-agent owner: the host Session Controller is unavailable')
		}
		return service
	}

	const callForward = (method, ...args) => {
		const service = controller()
		if (typeof service[method] !== 'function') {
			throw new Error(`sidebar-agent owner: sessionController.${method} is unavailable`)
		}
		return service[method](...args)
	}

	const isAgentSession = (sessionId) => typeof sessionId === 'string'
		&& typeof runtime.sessionId === 'string'
		&& sessionId === runtime.sessionId

	const requireAgent = (sessionId) => {
		const agent = runtime.agent
		if (agent === null || agent === undefined) throw new Error('sidebar-agent owner: the Agent is not running')
		if (agent.session?.id !== sessionId) throw new Error('sidebar-agent owner: the live Agent does not own that session id')
		return agent
	}

	/**
	 * Serialize owner-side prompt application. A failed prompt does not block
	 * the next one; only the Agent-local ordering is shared.
	 * @param {() => Promise<any>} operation - work to run.
	 * @returns {Promise<any>} its result.
	 */
	const exclusive = (operation) => {
		const run = tail.then(operation, operation)
		tail = run.then(() => undefined, () => undefined)
		return run
	}

	/**
	 * Apply one text prompt to the live Agent. The bridge's `requestId` is the
	 * correlation identity; a redelivered update is applied at most once.
	 */
	const prompt = async (request, signal) => {
		signal?.throwIfAborted?.()
		const sessionId = request?.sessionId
		if (!isAgentSession(sessionId)) return callForward('prompt', request, signal)
		const agent = requireAgent(sessionId)
		const content = Array.isArray(request?.content) ? request.content : []
		if (content.length === 0 || content.some((part) => part?.type !== 'text' || typeof part.text !== 'string' || part.text.trim() === '')) {
			throw new Error('sidebar-agent owner: only non-empty text prompts are supported')
		}
		const requestId = typeof request?.requestId === 'string' && request.requestId !== '' ? request.requestId : undefined
		if (requestId !== undefined && applied.has(requestId)) return applied.get(requestId)
		const operation = exclusive(async () => {
			signal?.throwIfAborted?.()
			const text = content.map((part) => part.text).join('\n')
			if (runtime.gate !== null && runtime.gate !== undefined && typeof runtime.gate.deliver === 'function') {
				const delivered = await runtime.gate.deliver(agent, text)
				return { ...delivered, sessionId }
			}
			const message = createUserMessage({ content, source: { kind: 'user' } })
			const running = agent.status === 'running'
			if (running) agent.steer(message)
			else agent.followup(message)
			return { messageId: message.id, running, sessionId }
		})
		if (requestId !== undefined) {
			applied.set(requestId, operation)
			if (applied.size > 256) {
				const oldest = applied.keys().next().value
				if (oldest !== undefined) applied.delete(oldest)
			}
		}
		return operation
	}

	/**
	 * Stop the Agent's running turn, or forward a normal session cancel.
	 */
	const cancel = async (request) => {
		const sessionId = request?.sessionId
		if (!isAgentSession(sessionId)) return callForward('cancel', request)
		const agent = requireAgent(sessionId)
		if (agent.status !== 'running') return { cancelled: false }
		agent.cancel({ kind: 'user' })
		return { cancelled: true }
	}

	/**
	 * List sessions for `/sessions` and `/bind`: the Agent's own session first,
	 * then the ordinary host list.
	 */
	const list = async (request, signal) => {
		const forwarded = await callForward('list', request ?? {}, signal)
		const items = Array.isArray(forwarded?.items) ? [...forwarded.items] : []
		if (typeof runtime.sessionId === 'string' && !items.some((item) => item?.sessionId === runtime.sessionId)) {
			items.unshift({
				sessionId: runtime.sessionId,
				projections: { values: { title: runtime.title } },
				owner: 'sidebar-agent',
			})
		}
		return { ...(forwarded !== null && typeof forwarded === 'object' ? forwarded : {}), items }
	}

	/**
	 * Read history for restore-with-replay. The live Agent's session is a real
	 * session, so its v4 events are the truthful prefix; a cold/absent Agent
	 * yields none rather than inventing events.
	 */
	const inspect = async (sessionId, signal) => {
		if (!isAgentSession(sessionId)) return callForward('inspect', sessionId, signal)
		const agent = runtime.agent
		if (agent === null || agent === undefined || agent.session?.id !== sessionId) return { events: [] }
		const events = typeof agent.session.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
		return { events: Array.isArray(events) ? events : [] }
	}

	/**
	 * Session creation for `/new` and first-message DM routing. With no target
	 * context (a normal binding) it forwards; inside an Agent-bound chat the
	 * glue's ingress scope refuses before a session can be created or adopted.
	 */
	const create = async (request) => {
		if (targetScope.getStore() === 'agent') throw new AgentTargetUnsupportedError()
		return callForward('create', request)
	}

	return {
		prompt,
		cancel,
		list,
		create,
		inspect,
		isAgentSession,
		withAgentTarget(kind, operation) {
			return targetScope.run(kind, operation)
		},
		targetKind() {
			return targetScope.getStore() ?? 'session'
		},
		/** Drop prompt idempotency and serialization state for a stop/start cycle. */
		reset() {
			applied.clear()
			tail = Promise.resolve()
		},
	}
}

/**
 * Load the bridge factory. The package now exports `./bridge`; a link-resolved
 * plugin whose bare specifier is not on its real-path resolution falls back to
 * the documented sibling file, which is the same source tree.
 * @returns {Promise<{createBridge: Function}>} the factory module.
 */
async function defaultImportBridge() {
	try {
		return await import('dsh-telegram-session-bridge/bridge')
	} catch (error) {
		if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
		return import('../dsh-telegram-session-bridge/src/bridge.js')
	}
}

/**
 * Create the dormant glue object. Nothing is imported, read, or started until
 * `start()` is called; with the default config that never happens in stage 1.
 *
 * @param {object} options - glue options.
 * @param {any} options.runtime - sidebar Agent runtime.
 * @param {Record<string, any>} [options.config] - `telegram` config object.
 * @param {Record<string, string>} [options.env] - environment for the token ref.
 * @param {() => any} [options.forward] - ordinary Session Controller accessor.
 * @param {Record<string, any>} [options.modelControl] - owner model control service.
 * @param {Record<string, any>} [options.statusControl] - owner read-only rich status service.
 * @param {() => Promise<any>} [options.importBridge] - bridge module loader.
 * @param {(bridge: any) => (() => void) | undefined} [options.install] - subscription installer.
 * @param {Record<string, any>} [options.logger] - logger.
 * @param {() => number} [options.clock] - injectable clock for the bridge.
 * @param {{timeout?: Function, interval?: Function}} [options.scheduler] - injectable scheduler.
 * @returns {Record<string, any>} the glue.
 */
export function createTelegramHost({
	runtime,
	config = {},
	env = process.env,
	forward = () => undefined,
	modelControl = null,
	statusControl = null,
	importBridge = defaultImportBridge,
	install,
	logger = console,
	clock,
	scheduler,
} = {}) {
	const enabled = plain(config?.enabled) === true
	const ownerController = createAgentOwnerController({ runtime, forward, logger })
	const tokenRef = typeof config?.tokenRef === 'string' && config.tokenRef !== '' ? config.tokenRef : DEFAULT_TELEGRAM_TOKEN_REF
	let bridge
	let state = enabled ? 'inactive' : 'off'
	let reason
	let starting
	let disposeInstall
	let generation = 0

	const sanitize = (error) => {
		let message = String(error?.message ?? error ?? 'unknown error')
		const secret = env?.[tokenRef]
		if (typeof secret === 'string' && secret !== '') message = message.split(secret).join('[redacted]')
		return message
	}

	const allowed = (chatId) => {
		const list = bridge?.options?.allowedChatIds ?? config?.allowedChatIds ?? []
		return Array.isArray(list) && list.includes(chatId)
	}

	/**
	 * Which kind of target owns this chat/thread. Read-only: the bridge's own
	 * store is the source of truth, and a private DM is required for thread 0.
	 */
	const targetKindOf = (update) => {
		const message = update?.message
		if (message === undefined || message === null) return 'session'
		const chatId = message.chat?.id
		if (!Number.isSafeInteger(chatId)) return 'session'
		const threadId = message.message_thread_id ?? 0
		const privateChat = message.chat?.type === 'private' && message.from?.id === chatId
		if (threadId === 0 && privateChat !== true) return 'session'
		try {
			const binding = bridge?.store?.getBinding?.(chatId, threadId)
			return binding?.sessionId === runtime.sessionId ? 'agent' : 'session'
		} catch {
			return 'session'
		}
	}

	const isNewCommand = (message) => {
		const text = typeof message?.text === 'string' ? message.text.trim() : ''
		return /^\/new(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text)
	}

	const isGateCommand = (message) => {
		const text = typeof message?.text === 'string' ? message.text.trim() : ''
		return /^\/(steer|queue)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)
	}

	const handleUpdate = async (update) => {
		if (bridge === undefined) return { handled: false, reason: 'telegram-inactive' }
		const kind = targetKindOf(update)
		const message = update?.message
		if (kind === 'agent' && message !== undefined && runtime.gate?.mode !== 'off' && isGateCommand(message) && allowed(message.chat?.id)) {
			const chatId = message.chat.id
			const threadId = message.message_thread_id ?? 0
			let binding
			try {
				binding = bridge.store.getBinding(chatId, threadId)
			} catch {
				binding = null
			}
			if (binding?.sessionId !== runtime.sessionId) return { handled: false, reason: 'gate-target' }
			const text = message.text.trim()
			const requestId = Number.isSafeInteger(message.message_id)
				? `tg-gate:${chatId}:${threadId}:${message.message_id}`
				: undefined
			try {
				const result = await ownerController.prompt({
					...(requestId === undefined ? {} : { requestId }),
					sessionId: binding.sessionId,
					content: [{ type: 'text', text }],
				})
				const emoji = bridge.gateReactionOf?.(result) ?? null
				if (emoji !== null) {
					await bridge.presence?.reactDecision?.({
						sessionId: binding.sessionId,
						chatId,
						threadId,
						messageId: message.message_id,
						emoji,
					})
				} else {
					await bridge.presence?.reactPrompt?.({
						sessionId: binding.sessionId,
						chatId,
						threadId,
						messageId: message.message_id,
					})
				}
				return { handled: true, prompted: true, sessionId: binding.sessionId, gate: result }
			} catch (error) {
				try {
					await bridge.api.sendMessage({ chatId, threadId, text: `⚠️ ${sanitize(error)}` })
				} catch (sendError) {
					logger?.warn?.(`[sidebar-agent] could not answer gate command: ${sanitize(sendError)}`)
				}
				return { handled: true, reason: 'gate-failed', sessionId: binding.sessionId }
			}
		}
		if (kind === 'agent' && message !== undefined && isNewCommand(message) && allowed(message.chat?.id)) {
			const chatId = message.chat.id
			const threadId = message.message_thread_id ?? 0
			try {
				// The composed bridge exposes its Bot API as `api`. Reuse it so
				// the refusal is a real, visible Telegram message.
				await bridge.api.sendMessage({ chatId, threadId, text: AGENT_NEW_REPLY })
			} catch (error) {
				logger?.warn?.(`[sidebar-agent] could not answer /new: ${sanitize(error)}`)
			}
			return { handled: true, reason: 'agent-new-unsupported' }
		}
		return ownerController.withAgentTarget(kind, () => originalHandleUpdate.call(bridge, update))
	}
	let originalHandleUpdate = async () => ({ handled: false, reason: 'bridge-unavailable' })

	const dmCandidates = () => {
		const candidates = []
		if (bridge === undefined || typeof bridge.store?.listBindings !== 'function') return candidates
		try {
			for (const record of bridge.store.listBindings()) {
				if (typeof record?.key !== 'string' || !record.key.startsWith('dm:')) continue
				if (!Number.isSafeInteger(record.chatId) || record.senderId !== record.chatId) continue
				if (!allowed(record.chatId)) continue
				if (record.sessionId === runtime.sessionId) continue
				candidates.push({ key: record.key, chatId: record.chatId })
			}
		} catch {
			// A status read never changes the binding state.
		}
		return candidates
	}

	const status = () => {
		let binding = { kind: 'none' }
		try {
			const record = bridge?.store?.getBindingForSession?.(runtime.sessionId)
			if (record !== null && record !== undefined && record.sessionId === runtime.sessionId) {
				binding = { kind: 'agent', chatId: record.chatId, threadId: record.threadId ?? 0 }
			}
		} catch {
			// A status read never changes the binding state.
		}
		return {
			state,
			enabled,
			binding,
			candidates: dmCandidates(),
			...(bridge === undefined ? {} : {
				model: {
					available: bridge.model?.available === true,
					registered: bridge.modelDiscovery?.registered === true,
					...(bridge.modelDiscovery === null || bridge.modelDiscovery === undefined
						? {}
						: {
							checkedAt: bridge.modelDiscovery.checkedAt ?? null,
							chats: Array.isArray(bridge.modelDiscovery.chats) ? bridge.modelDiscovery.chats : [],
							...(typeof bridge.modelDiscovery.error === 'string' ? { error: bridge.modelDiscovery.error } : {}),
						}),
				},
			}),
			...(reason === undefined ? {} : { reason }),
		}
	}

	/**
	 * Adopt one already-authorized private DM for this live Agent. The target is
	 * always this runtime's session id; the caller can only name an existing DM
	 * record. The previous ordinary session is kept for rollback, and offset,
	 * dedupe and the allowlist are untouched by the store write.
	 */
	const adoptDm = async (request = {}) => {
		if (state !== 'ready' || bridge === undefined) throw new Error('Telegram is not active')
		const key = request?.key
		if (typeof key !== 'string' || !key.startsWith('dm:')) throw new Error('Invalid private DM binding')
		const agent = runtime.agent
		if (agent === null || agent === undefined || typeof runtime.sessionId !== 'string') {
			throw new Error('The Agent is not running')
		}
		if (agent.session?.id !== runtime.sessionId) throw new Error('The live Agent does not own this session')
		let record
		try {
			record = bridge.store.listBindings().find((entry) => entry?.key === key)
		} catch (error) {
			throw new Error(`Could not read Telegram bindings: ${sanitize(error)}`)
		}
		if (record === undefined) throw new Error('That private chat is not a known DM binding')
		if (!Number.isSafeInteger(record.chatId) || record.senderId !== record.chatId) throw new Error('Only a private DM can be adopted')
		if (!allowed(record.chatId)) throw new Error('That chat is not authorized')
		if (record.sessionId === runtime.sessionId) {
			return { adopted: false, already: true, key, chatId: record.chatId, previousSessionId: record.previousSessionId ?? null, telegram: status() }
		}
		const result = await bridge.store.setDm({ key, sessionId: runtime.sessionId, mode: 'replaced' })
		try { await bridge.registerCommands?.() } catch (error) {
			logger?.warn?.(`[sidebar-agent] Telegram command registration after adoption failed: ${sanitize(error)}`)
		}
		return {
			adopted: true,
			key,
			chatId: record.chatId,
			previousSessionId: result?.previousSessionId ?? record.sessionId ?? null,
			telegram: status(),
		}
	}

	const start = () => {
		if (!enabled) {
			state = 'off'
			return Promise.resolve(status())
		}
		if (state === 'ready') return Promise.resolve(status())
		if (starting !== undefined) return starting
		const run = ++generation
		ownerController.reset()
		starting = (async () => {
			state = 'inactive'
			try {
				const module = await importBridge()
				const factory = module?.createBridge
				if (typeof factory !== 'function') throw new Error('the Telegram bridge factory is unavailable')
				const created = await factory({
					config,
					env,
					services: {
						sessionController: ownerController,
						...(modelControl === null ? {} : { modelControl }),
						...(statusControl === null ? {} : { statusControl }),
					},
					logger,
					...(clock === undefined ? {} : { clock }),
					...(scheduler === undefined ? {} : { scheduler }),
				})
				if (created === undefined || created === null) throw new Error('the Telegram bridge is disabled by its configuration')
				if (run !== generation) {
					if (typeof created.stop === 'function') await created.stop()
					return status()
				}
				bridge = created
				// Keep the exact original method so stop() restores handler identity.
				originalHandleUpdate = typeof bridge.handleUpdate === 'function'
					? bridge.handleUpdate
					: async () => ({ handled: false, reason: 'bridge-unavailable' })
				bridge.handleUpdate = handleUpdate
				if (typeof install === 'function') disposeInstall = install(bridge)
				if (typeof bridge.start === 'function') await bridge.start()
				if (run !== generation) {
					await stop()
					return status()
				}
				state = 'ready'
				reason = undefined
			} catch (error) {
				if (run !== generation) return status()
				state = 'error'
				reason = sanitize(error)
				logger?.error?.(`[sidebar-agent] Telegram unavailable: ${reason}`)
			} finally {
				if (run === generation) starting = undefined
			}
			return status()
		})()
		return starting
	}

	const stop = async () => {
		generation += 1
		starting = undefined
		state = enabled ? 'inactive' : 'off'
		reason = undefined
		if (typeof disposeInstall === 'function') {
			try {
				disposeInstall()
			} catch (error) {
				logger?.warn?.(`[sidebar-agent] Telegram subscription cleanup: ${sanitize(error)}`)
			}
		}
		disposeInstall = undefined
		const current = bridge
		if (current !== undefined && typeof originalHandleUpdate === 'function') {
			current.handleUpdate = originalHandleUpdate
		}
		bridge = undefined
		originalHandleUpdate = async () => ({ handled: false, reason: 'bridge-unavailable' })
		ownerController.reset()
		if (current !== undefined && typeof current.stop === 'function') await current.stop()
	}

	return {
		enabled,
		ownerController,
		status,
		start,
		stop,
		handleUpdate,
		adoptDm,
		handleSessionEvent: (session, event) => bridge?.handleSessionEvent?.(session, event),
		handleApproval: (request, next) => (bridge?.handleApproval === undefined ? next?.() : bridge.handleApproval(request, next)),
		handleQuestion: (request, next) => (bridge?.handleQuestion === undefined ? next?.() : bridge.handleQuestion(request, next)),
		get state() {
			return state
		},
		get bridge() {
			return bridge
		},
	}
}
