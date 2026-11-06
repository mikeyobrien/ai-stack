import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	AgentTargetUnsupportedError,
	createAgentOwnerController,
	createTelegramHost,
} from '../telegram-host.js'
import { FakeBotApi } from '../../dsh-telegram-session-bridge/test/helpers/fake-bot-api.js'
import { createIngressGate } from '../ingress-gate.js'
import { dmKey } from '../../dsh-telegram-session-bridge/src/state.js'

const AGENT_SESSION = 'agent-session-1'
const silent = { debug() {}, info() {}, warn() {}, error() {} }

function agentRuntime({ status = 'idle', sessionId = AGENT_SESSION, title = 'Agent' } = {}) {
	const calls = { steer: [], followup: [], cancel: [] }
	const agent = {
		session: { id: sessionId, snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'last' }] } } }] },
		status,
		options: { provider: 'p', model: 'm' },
		steer(message) { calls.steer.push(message) },
		followup(message) { calls.followup.push(message) },
		cancel(request) { calls.cancel.push(request) },
	}
	return { ready: true, title, sessionId: AGENT_SESSION, agent, calls }
}

function messageOf(block) {
	return block.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

test('the owner adapter steers a running Agent and follows up an idle one', async () => {
	const runtime = agentRuntime({ status: 'running' })
	const forward = { async prompt() { throw new Error('normal route used for the Agent') } }
	const owner = createAgentOwnerController({ runtime, forward: () => forward, logger: silent })
	const result = await owner.prompt({ requestId: 'r1', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'hello' }] })
	assert.equal(result.running, true)
	assert.equal(runtime.calls.steer.length, 1)
	assert.equal(runtime.calls.followup.length, 0)
	assert.equal(messageOf(runtime.calls.steer[0]), 'hello')
	assert.equal(runtime.calls.steer[0].source.kind, 'user')

	const idle = agentRuntime({ status: 'idle' })
	const idleOwner = createAgentOwnerController({ runtime: idle, forward: () => forward, logger: silent })
	await idleOwner.prompt({ sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'later' }] })
	assert.equal(idle.calls.followup.length, 1)
	assert.equal(idle.calls.steer.length, 0)
})

test('the owner adapter forwards non-Agent sessions untouched', async () => {
	const runtime = agentRuntime()
	const forwarded = []
	const forward = {
		async prompt(request, signal) {
			forwarded.push({ request, signal })
			return { accepted: true }
		},
	}
	const owner = createAgentOwnerController({ runtime, forward: () => forward, logger: silent })
	const controller = new AbortController()
	const request = { requestId: 'normal-1', sessionId: 'session-ordinary', content: [{ type: 'text', text: 'hi' }] }
	const result = await owner.prompt(request, controller.signal)
	assert.deepEqual(result, { accepted: true })
	assert.equal(forwarded.length, 1)
	assert.equal(forwarded[0].request, request)
	assert.equal(forwarded[0].signal, controller.signal)
	assert.equal(runtime.calls.steer.length, 0)
	assert.equal(runtime.calls.followup.length, 0)
})

test('a duplicated request id is applied once and returned again', async () => {
	const runtime = agentRuntime({ status: 'running' })
	const owner = createAgentOwnerController({ runtime, forward: () => undefined, logger: silent })
	const request = { requestId: 'tg-dm:0:42:42:9', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'once' }] }
	const [first, second] = await Promise.all([owner.prompt(request), owner.prompt(request)])
	assert.equal(runtime.calls.steer.length, 1, 'a redelivered update cannot double-prompt')
	assert.equal(first.messageId, second.messageId)
	const third = await owner.prompt(request)
	assert.equal(runtime.calls.steer.length, 1)
	assert.equal(third.messageId, first.messageId)
})

test('one failed owner prompt does not block the next serialized prompt', async () => {
	const runtime = agentRuntime({ status: 'idle' })
	let fail = true
	runtime.agent.followup = (message) => {
		if (fail) {
			fail = false
			throw new Error('fixture failure')
		}
		runtime.calls.followup.push(message)
	}
	const owner = createAgentOwnerController({ runtime, forward: () => undefined, logger: silent })
	await assert.rejects(owner.prompt({ requestId: 'a', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'boom' }] }), /fixture failure/)
	await owner.prompt({ requestId: 'b', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'still works' }] })
	assert.equal(runtime.calls.followup.length, 1)
	assert.equal(messageOf(runtime.calls.followup[0]), 'still works')
})

test('a failed request id stays cached: redelivery returns the same rejection once', async () => {
	const runtime = agentRuntime({ status: 'idle' })
	let attempts = 0
	runtime.agent.followup = () => {
		attempts += 1
		throw new Error('fixture rejected')
	}
	const owner = createAgentOwnerController({ runtime, forward: () => undefined, logger: silent })
	const request = { requestId: 'tg-dm:0:42:42:failed', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'fail once' }] }
	await assert.rejects(owner.prompt(request), /fixture rejected/)
	await assert.rejects(owner.prompt(request), /fixture rejected/)
	assert.equal(attempts, 1, 'a redelivered request id must not prompt twice')
})

test('a new request id after a failure is still executed', async () => {
	const runtime = agentRuntime({ status: 'idle' })
	let fail = true
	runtime.agent.followup = (message) => {
		if (fail) {
			fail = false
			throw new Error('fixture failure')
		}
		runtime.calls.followup.push(message)
	}
	const owner = createAgentOwnerController({ runtime, forward: () => undefined, logger: silent })
	await assert.rejects(owner.prompt({ requestId: 'failed-id', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'boom' }] }), /fixture failure/)
	await owner.prompt({ requestId: 'new-id', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'after failure' }] })
	assert.equal(runtime.calls.followup.length, 1)
	assert.equal(messageOf(runtime.calls.followup[0]), 'after failure')
})

test('the idempotency cache stays at 256 entries; an evicted id can be retried', async () => {
	const runtime = agentRuntime({ status: 'idle' })
	const owner = createAgentOwnerController({ runtime, forward: () => undefined, logger: silent })
	for (let index = 0; index < 257; index += 1) {
		await owner.prompt({ requestId: `evict-${index}`, sessionId: AGENT_SESSION, content: [{ type: 'text', text: `m${index}` }] })
	}
	assert.equal(runtime.calls.followup.length, 257)
	await owner.prompt({ requestId: 'evict-0', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'old id' }] })
	assert.equal(runtime.calls.followup.length, 258, 'the oldest entry was evicted at the 256-entry bound')
})

test('cancel, inspect, and list keep the Agent owner boundary', async () => {
	const runtime = agentRuntime({ status: 'running' })
	const forwardCalls = []
	const forward = {
		async prompt() {},
		async cancel(request) { forwardCalls.push(['cancel', request]); return { cancelled: false } },
		async list(request) { forwardCalls.push(['list', request]); return { items: [{ sessionId: 'session-ordinary' }] } },
		async inspect(sessionId) { forwardCalls.push(['inspect', sessionId]); return { events: [] } },
		async create(request) { forwardCalls.push(['create', request]); return { sessionId: 'session-new' } },
	}
	const owner = createAgentOwnerController({ runtime, forward: () => forward, logger: silent })

	assert.deepEqual(await owner.cancel({ sessionId: AGENT_SESSION }), { cancelled: true })
	assert.deepEqual(runtime.calls.cancel, [{ kind: 'user' }])

	await owner.cancel({ sessionId: 'session-ordinary' })
	assert.deepEqual(forwardCalls.pop(), ['cancel', { sessionId: 'session-ordinary' }])

	const inspection = await owner.inspect(AGENT_SESSION)
	assert.equal(inspection.events[0].type, 'assistant/message')
	await owner.inspect('session-ordinary')
	assert.deepEqual(forwardCalls.pop(), ['inspect', 'session-ordinary'])

	const listed = await owner.list({})
	assert.deepEqual(listed.items.map((item) => item.sessionId), [AGENT_SESSION, 'session-ordinary'])
})

test('create refuses an Agent target and forwards normal targets', async () => {
	const runtime = agentRuntime()
	const forward = { async create() { return { sessionId: 'session-new' } } }
	const owner = createAgentOwnerController({ runtime, forward: () => forward, logger: silent })
	await assert.rejects(
		owner.withAgentTarget('agent', () => owner.create({})),
		(error) => error instanceof AgentTargetUnsupportedError && /new|fork|Agent/.test(error.message),
	)
	assert.deepEqual(await owner.create({}), { sessionId: 'session-new' })
	assert.deepEqual(await owner.withAgentTarget('session', () => owner.create({})), { sessionId: 'session-new' })
})

test('the owner adapter refuses a session id that does not match the live Agent', async () => {
	const runtime = agentRuntime({ sessionId: 'agent-different' })
	const owner = createAgentOwnerController({ runtime, forward: () => undefined, logger: silent })
	await assert.rejects(owner.prompt({ sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'hi' }] }), /not running|owner/i)
})

test('an aborted prompt is not delivered', async () => {
	const runtime = agentRuntime()
	const owner = createAgentOwnerController({ runtime, forward: () => undefined, logger: silent })
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(owner.prompt({ sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'hi' }] }, controller.signal))
	assert.equal(runtime.calls.steer.length + runtime.calls.followup.length, 0)
})

test('Telegram is off by default and does not import or start the bridge', async () => {
	let imported = 0
	const glue = createTelegramHost({
		runtime: agentRuntime(),
		config: { enabled: false },
		env: {},
		importBridge: async () => { imported += 1; throw new Error('must not import') },
		logger: silent,
	})
	assert.equal(glue.state, 'off')
	assert.deepEqual(glue.status(), { state: 'off', enabled: false, binding: { kind: 'none' }, candidates: [] })
	await glue.start()
	assert.equal(imported, 0)
	assert.equal(glue.bridge, undefined)
	assert.equal(glue.status().state, 'off')
	await glue.stop()
})

test('an enabled glue stays inactive until an explicit start', () => {
	let imported = 0
	const glue = createTelegramHost({
		runtime: agentRuntime(),
		config: { enabled: true },
		importBridge: async () => { imported += 1; return { createBridge: async () => ({}) } },
		logger: silent,
	})
	assert.equal(glue.state, 'inactive')
	assert.equal(imported, 0)
	assert.deepEqual(glue.status(), { state: 'inactive', enabled: true, binding: { kind: 'none' }, candidates: [] })
})

function fakeBridge({ agentSession = AGENT_SESSION, allowedChatIds = [42], binding = null } = {}) {
	const sent = []
	const forwarded = []
	const bridge = {
		options: { allowedChatIds },
		store: {
			getBindingForSession(sessionId) {
				return sessionId === agentSession ? binding : null
			},
			getBinding(chatId, threadId) {
				if (binding === null) return null
				if (binding.chatId !== chatId) return null
				if (threadId !== (binding.threadId ?? 0)) return null
				return binding
			},
			listBindings() {
				if (binding === null) return []
				return [{
					...binding,
					key: binding.key ?? `dm:0:${binding.chatId}:${binding.chatId}`,
					senderId: binding.senderId ?? binding.chatId,
				}]
			},
			async setDm({ key, sessionId, mode }) {
				const previous = binding?.sessionId ?? null
				binding = {
					...(binding ?? {}),
					key,
					chatId: Number(key.split(':')[2]),
					senderId: Number(key.split(':')[3]),
					threadId: 0,
					sessionId,
					previousSessionId: previous,
					managedMode: mode,
				}
				return { sessionId, previousSessionId: previous, entry: binding }
			},
		},
		api: { async sendMessage(message) { sent.push(message) } },
		async handleUpdate(update) {
			forwarded.push(update)
			return { handled: true, reason: 'original' }
		},
		async handleSessionEvent() { return 'event' },
		handleApproval() { return 'approval' },
		handleQuestion() { return 'question' },
		async stop() { bridge.stopped = true },
		async start() { bridge.started = true },
		sent,
		forwarded,
	}
	return bridge
}

function startedGlue(bridge, overrides = {}) {
	const calls = { create: [], install: [], start: 0 }
	const runtime = agentRuntime()
	const glue = createTelegramHost({
		runtime,
		config: { enabled: true, tokenRef: 'A_TOKEN', allowedChatIds: [42], stateFile: '/tmp/never-used.json' },
		env: { A_TOKEN: '123:supersecret' },
		importBridge: async () => ({
			createBridge: async (options) => {
				calls.create.push(options)
				calls.start += 1
				return bridge
			},
		}),
		install: (created) => {
			calls.install.push(created)
			return () => { calls.disposed = true }
		},
		logger: silent,
		...overrides,
	})
	return { glue, calls, runtime }
}

test('enabled start creates one bridge with the owner controller and installs the existing subscriptions', async () => {
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 0, sessionId: AGENT_SESSION } })
	const { glue, calls } = startedGlue(bridge)
	await glue.start()
	assert.equal(calls.create.length, 1)
	const options = calls.create[0]
	assert.equal(typeof options.services.sessionController.prompt, 'function')
	assert.equal(typeof options.services.sessionController.cancel, 'function')
	assert.equal(typeof options.services.sessionController.list, 'function')
	assert.equal(typeof options.services.sessionController.create, 'function')
	assert.equal(typeof options.services.sessionController.inspect, 'function')
	assert.equal(options.config.enabled, true)
	assert.equal(options.env.A_TOKEN, '123:supersecret')
	assert.deepEqual(calls.install, [bridge])
	assert.equal(bridge.started, true)
	assert.equal(glue.state, 'ready')
	assert.deepEqual(glue.status(), {
		state: 'ready',
		enabled: true,
		binding: { kind: 'agent', chatId: 42, threadId: 0 },
		candidates: [],
		model: { available: false, registered: false },
	})
	assert.ok(!JSON.stringify(glue.status()).includes('supersecret'))
	assert.ok(!JSON.stringify(glue.status()).includes('A_TOKEN'))

	await glue.start()
	assert.equal(calls.create.length, 1, 'start is idempotent: one poller, one state writer')
	await glue.stop()
	assert.equal(calls.disposed, true)
	assert.equal(bridge.stopped, true)
})

test('the glue forwards bridge session/approval/question handlers unchanged', async () => {
	const bridge = fakeBridge()
	const { glue } = startedGlue(bridge)
	await glue.start()
	assert.equal(await glue.handleSessionEvent({}, {}), 'event')
	assert.equal(glue.handleApproval({}, () => {}), 'approval')
	assert.equal(glue.handleQuestion({}, () => {}), 'question')
})

test('an import failure is reported as sanitized error state, never thrown', async () => {
	const glue = createTelegramHost({
		runtime: agentRuntime(),
		config: { enabled: true, tokenRef: 'A_TOKEN' },
		env: { A_TOKEN: '123:supersecret' },
		importBridge: async () => { throw new Error('cannot load 123:supersecret') },
		logger: silent,
	})
	await glue.start()
	assert.equal(glue.state, 'error')
	assert.match(glue.status().reason, /cannot load/)
	assert.ok(!glue.status().reason.includes('supersecret'))
	assert.ok(glue.status().reason.includes('[redacted]'))
})

test('a create failure with credential text is sanitized', async () => {
	const glue = createTelegramHost({
		runtime: agentRuntime(),
		config: { enabled: true, tokenRef: 'A_TOKEN' },
		env: { A_TOKEN: '123:supersecret' },
		importBridge: async () => ({
			createBridge: async () => { throw new Error('bad token 123:supersecret') },
		}),
		logger: silent,
	})
	await glue.start()
	assert.equal(glue.state, 'error')
	assert.ok(!glue.status().reason.includes('supersecret'))
	assert.ok(glue.status().reason.includes('[redacted]'))
})

test('an Agent-bound /new asks for confirmation and never reaches the bridge', async () => {
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 0, sessionId: AGENT_SESSION } })
	const { glue } = startedGlue(bridge)
	await glue.start()
	const result = await glue.handleUpdate({
		message: { message_id: 7, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/new' },
	})
	assert.equal(result.reason, 'context-new-confirm')
	assert.equal(bridge.forwarded.length, 0)
	assert.equal(bridge.sent.length, 1)
	assert.match(bridge.sent[0].text, /\/new confirm/)
	assert.ok(!/forked|reset/i.test(bridge.sent[0].text))
})

test('an unauthorized Agent-bound /new is left to the bridge fail-closed policy', async () => {
	const bridge = fakeBridge({ binding: { chatId: 7, threadId: 0, sessionId: AGENT_SESSION }, allowedChatIds: [42] })
	const { glue } = startedGlue(bridge)
	await glue.start()
	const update = { message: { message_id: 8, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/new' } }
	const result = await glue.handleUpdate(update)
	assert.deepEqual(result, { handled: true, reason: 'original' })
	assert.equal(bridge.sent.length, 0)
	assert.equal(bridge.forwarded.length, 1)
})

test('a normal binding and a group lobby keep the ordinary bridge route', async () => {
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 5, sessionId: 'session-ordinary' } })
	const { glue } = startedGlue(bridge)
	await glue.start()
	await glue.handleUpdate({ message: { message_id: 9, chat: { id: 42, type: 'supergroup' }, message_thread_id: 5, text: '/new' } })
	assert.equal(bridge.forwarded.length, 1)
	assert.equal(bridge.sent.length, 0)

	await glue.handleUpdate({ message: { message_id: 10, chat: { id: 42, type: 'supergroup' }, message_thread_id: 0, text: '/new' } })
	assert.equal(bridge.forwarded.length, 2)
	assert.equal(bridge.sent.length, 0)
})

test('an Agent-bound topic /new is also refused before dispatch', async () => {
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 9, sessionId: AGENT_SESSION } })
	const { glue } = startedGlue(bridge)
	await glue.start()
	const result = await glue.handleUpdate({
		message: { message_id: 11, chat: { id: 42, type: 'supergroup' }, message_thread_id: 9, text: '/new@bridge_bot' },
	})
	assert.equal(result.reason, 'agent-new-unsupported')
	assert.equal(bridge.forwarded.length, 0)
	assert.equal(bridge.sent.length, 1)
})

test('the actual bridge factory accepts the owner adapter without a second poller', async () => {
	const { createBridge } = await import('../../dsh-telegram-session-bridge/src/bridge.js')
	const root = await mkdtemp(join(tmpdir(), 'sidebar-agent-telegram-'))
	const runtime = agentRuntime({ status: 'running' })
	const forward = {
		async prompt() { throw new Error('ordinary session route used for the Agent') },
		async list() { return { items: [{ sessionId: 'session-ordinary' }] } },
	}
	const owner = createAgentOwnerController({ runtime, forward: () => forward, logger: silent })
	let bridge
	try {
		bridge = await createBridge({
			config: { dshHome: root, allowedChatIds: [42], poll: false },
			env: { DSH_TELEGRAM_SESSION_BRIDGE_BOT_TOKEN: '123456:fixture-token' },
			services: { sessionController: owner },
			fetchImpl: async () => { throw new Error('no network in tests') },
			logger: silent,
			clock: () => 1_700_000_000_000,
		})
		assert.equal(bridge.started, false, 'the factory alone does not poll')
		await bridge.host.prompt(AGENT_SESSION, 'from telegram', { requestId: 'tg-dm:0:42:42:1' })
		await bridge.host.prompt(AGENT_SESSION, 'from telegram', { requestId: 'tg-dm:0:42:42:1' })
		assert.equal(runtime.calls.steer.length, 1, 'redelivered update prompts the Agent once')
		assert.equal(messageOf(runtime.calls.steer[0]), 'from telegram')
		await bridge.host.cancel(AGENT_SESSION)
		assert.deepEqual(runtime.calls.cancel, [{ kind: 'user' }])
		const sessions = await bridge.host.listSessions()
		assert.deepEqual(sessions.map((item) => item.sessionId), [AGENT_SESSION, 'session-ordinary'])
	} finally {
		await bridge?.stop()
		await rm(root, { recursive: true, force: true })
	}
})

function forwardStub() {
	const calls = { prompt: [], cancel: [], create: [], inspect: [], list: 0 }
	return {
		calls,
		async prompt(request) { calls.prompt.push(request); return { accepted: true } },
		async cancel(request) { calls.cancel.push(request); return { cancelled: false } },
		async create(request) { calls.create.push(request); return { sessionId: 'ordinary-new' } },
		async inspect(sessionId) { calls.inspect.push(sessionId); return { events: [] } },
		async list() { calls.list += 1; return { items: [{ sessionId: 'ordinary-a' }] } },
	}
}

async function realGlue({ root, fake, runtime, forward, allowedChatIds = [42] }) {
	const { createBridge } = await import('../../dsh-telegram-session-bridge/src/bridge.js')
	return createTelegramHost({
		runtime,
		config: { enabled: true, tokenRef: 'A_TOKEN', allowedChatIds, dshHome: root, poll: false, baseUrl: fake.baseUrl },
		env: { A_TOKEN: '777:fixture-token' },
		importBridge: async () => ({ createBridge }),
		install: () => () => {},
		...(forward === undefined ? {} : { forward: () => forward }),
		logger: silent,
		clock: () => 1_700_000_000_000,
	})
}

test('the real bridge factory sends one /new confirmation and never creates an ordinary session', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-agent-new-'))
	const fake = await new FakeBotApi({ token: '777:fixture-token' }).start()
	const runtime = agentRuntime({ status: 'idle' })
	const forward = forwardStub()
	const glue = await realGlue({ root, fake, runtime, forward })
	try {
		await glue.start()
		const key = dmKey({ botId: 777, chatId: 42, senderId: 42 })
		const seeded = await glue.bridge.store.setDm({ key, sessionId: 'ordinary-dm', mode: 'created' })
		assert.equal(seeded.entry.sessionId, 'ordinary-dm')
		const adopted = await glue.adoptDm({ key })
		assert.equal(adopted.adopted, true)
		assert.equal(adopted.previousSessionId, 'ordinary-dm')
		assert.equal(glue.status().binding.kind, 'agent')

		const result = await glue.handleUpdate({
			update_id: 5,
			message: { message_id: 7, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/new' },
		})
		assert.equal(result.reason, 'context-new-confirm')
		assert.equal(forward.calls.create.length, 0, '/new must not reach ordinary create')
		assert.equal(forward.calls.prompt.length, 0)
		assert.equal(runtime.calls.followup.length + runtime.calls.steer.length, 0, '/new must not prompt the Agent')
		assert.equal(fake.messages.length, 1, 'the refusal is one real Bot API send')
		assert.match(fake.messages[0].text, /\/new confirm/)
		const state = JSON.parse(await readFile(join(root, 'telegram-session-bridge', 'state.json'), 'utf8'))
		assert.equal(state.dms[key].sessionId, runtime.sessionId, 'the Agent binding survives /new')
	} finally {
		await glue.stop()
		await fake.stop()
		await rm(root, { recursive: true, force: true })
	}
})

test('explicit DM adoption survives reload and preserves offset, dedupe, allowlist and the ordinary previous session', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-agent-adopt-'))
	const fake = await new FakeBotApi({ token: '777:fixture-token' }).start()
	const key = dmKey({ botId: 777, chatId: 42, senderId: 42 })
	const firstRuntime = agentRuntime({ status: 'idle' })
	const firstForward = forwardStub()
	const firstGlue = await realGlue({ root, fake, runtime: firstRuntime, forward: firstForward })
	let stateBefore
	try {
		await firstGlue.start()
		await firstGlue.bridge.store.setDm({ key, sessionId: 'ordinary-dm', mode: 'created' })
		stateBefore = JSON.parse(await readFile(join(root, 'telegram-session-bridge', 'state.json'), 'utf8'))
		const adopted = await firstGlue.adoptDm({ key, sessionId: 'caller-supplied-agent' })
		assert.equal(adopted.adopted, true)
		assert.equal(adopted.previousSessionId, 'ordinary-dm')
		const stateAfter = JSON.parse(await readFile(join(root, 'telegram-session-bridge', 'state.json'), 'utf8'))
		assert.equal(stateAfter.dms[key].sessionId, firstRuntime.sessionId, 'adoption always targets this live Agent')
		assert.notEqual(stateAfter.dms[key].sessionId, 'caller-supplied-agent')
		assert.equal(stateAfter.dms[key].previousSessionId, 'ordinary-dm')
		assert.equal(stateAfter.offset, stateBefore.offset)
		assert.deepEqual(stateAfter.dedupe, stateBefore.dedupe)
		assert.deepEqual(stateAfter.bindings, stateBefore.bindings)
		assert.deepEqual(stateAfter.verbosity, stateBefore.verbosity)
		assert.equal((await firstGlue.ownerController.inspect(firstRuntime.sessionId)).events[0].type, 'assistant/message')
	} finally {
		await firstGlue.stop()
		await fake.stop()
	}

	const secondFake = await new FakeBotApi({ token: '777:fixture-token' }).start()
	const secondRuntime = agentRuntime({ status: 'running' })
	const secondForward = forwardStub()
	const secondGlue = await realGlue({ root, fake: secondFake, runtime: secondRuntime, forward: secondForward })
	try {
		await secondGlue.start()
		assert.equal(secondGlue.status().binding.kind, 'agent', 'the adopted DM is the Agent after a fresh bridge/reload')
		await secondGlue.handleUpdate({
			update_id: 6,
			message: { message_id: 8, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'ping after reload' },
		})
		assert.equal(secondRuntime.calls.steer.length, 1, 'the reloaded DM steers the live Agent')
		assert.equal(secondForward.calls.prompt.length, 0, 'the ordinary controller is never prompted for the Agent')
		assert.equal(secondForward.calls.create.length, 0)
		const afterReload = JSON.parse(await readFile(join(root, 'telegram-session-bridge', 'state.json'), 'utf8'))
		assert.equal(afterReload.dms[key].sessionId, secondRuntime.sessionId)
		assert.equal(afterReload.offset, stateBefore.offset, 'the offset advanced only by the handled update ack path, not by adoption')
	} finally {
		await secondGlue.stop()
		await secondFake.stop()
		await rm(root, { recursive: true, force: true })
	}
})

test('adoption refuses unauthorized, unknown, and non-DM records without writing', async () => {
	const bridge = fakeBridge({ binding: { chatId: 7, threadId: 0, sessionId: 'ordinary-7' }, allowedChatIds: [42] })
	const { glue } = startedGlue(bridge)
	await glue.start()
	await assert.rejects(glue.adoptDm({ key: 'dm:0:7:7' }), /not authorized/i)
	assert.equal(glue.status().binding.kind, 'none', 'the ordinary DM record is unchanged')
	await assert.rejects(glue.adoptDm({ key: 'not-a-dm' }), /Invalid private DM/i)
	await assert.rejects(glue.adoptDm({ key: 'dm:0:999:999' }), /not a known DM/i)
	assert.equal(glue.status().candidates.length, 0)
	await glue.stop()
})

test('cross-chat isolation: adopting one DM leaves every other DM on its ordinary session', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-agent-cross-'))
	const fake = await new FakeBotApi({ token: '777:fixture-token' }).start()
	const runtime = agentRuntime({ status: 'running' })
	const forward = forwardStub()
	const glue = await realGlue({ root, fake, runtime, forward, allowedChatIds: [42, 43] })
	try {
		await glue.start()
		const adoptedKey = dmKey({ botId: 777, chatId: 42, senderId: 42 })
		const otherKey = dmKey({ botId: 777, chatId: 43, senderId: 43 })
		await glue.bridge.store.setDm({ key: adoptedKey, sessionId: 'ordinary-42', mode: 'created' })
		await glue.bridge.store.setDm({ key: otherKey, sessionId: 'ordinary-43', mode: 'created' })
		await glue.adoptDm({ key: adoptedKey })
		await glue.handleUpdate({
			update_id: 10,
			message: { message_id: 11, chat: { id: 43, type: 'private' }, from: { id: 43 }, text: 'ordinary ping' },
		})
		assert.equal(forward.calls.prompt.length, 1)
		assert.equal(forward.calls.prompt[0].sessionId, 'ordinary-43')
		assert.equal(runtime.calls.steer.length + runtime.calls.followup.length, 0, 'another chat never reaches the Agent')
		await glue.handleUpdate({
			update_id: 11,
			message: { message_id: 12, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'agent ping' },
		})
		assert.equal(forward.calls.prompt.length, 1, 'the adopted chat still never uses the ordinary controller')
		assert.equal(runtime.calls.steer.length, 1)
	} finally {
		await glue.stop()
		await fake.stop()
		await rm(root, { recursive: true, force: true })
	}
})

test('stop restores the original bridge handler and resets request-id state for a clean restart', async () => {
	const runtime = agentRuntime({ status: 'running' })
	const originals = []
	let creations = 0
	const glue = createTelegramHost({
		runtime,
		config: { enabled: true, tokenRef: 'A_TOKEN', allowedChatIds: [42] },
		env: { A_TOKEN: '777:fixture-token' },
		importBridge: async () => ({
			createBridge: async () => {
				creations += 1
				const created = fakeBridge({ binding: { chatId: 42, threadId: 0, sessionId: AGENT_SESSION } })
				originals.push(created.handleUpdate)
				return created
			},
		}),
		install: () => () => {},
		logger: silent,
	})
	await glue.start()
	const first = glue.bridge
	assert.equal(creations, 1)
	assert.notEqual(first.handleUpdate, originals[0], 'the glue installs its ingress wrapper')
	await glue.ownerController.prompt({ requestId: 'same', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'one' }] })
	assert.equal(runtime.calls.steer.length, 1)
	await glue.stop()
	assert.equal(first.handleUpdate, originals[0], 'stop restores the exact original handler')
	await glue.start()
	const second = glue.bridge
	assert.equal(creations, 2)
	assert.notEqual(second, first, 'restart creates one fresh bridge')
	await glue.ownerController.prompt({ requestId: 'same', sessionId: AGENT_SESSION, content: [{ type: 'text', text: 'two' }] })
	assert.equal(runtime.calls.steer.length, 2, 'a request id from the prior run is not reused after restart')
	await glue.stop()
})


test('the glue intercepts Agent /steer and /queue before the bridge command parser', async () => {
	const root = await mkdtemp(join(tmpdir(), 'glue-gate-'))
	const runtime = agentRuntime({ status: 'running' })
	runtime.pendingQuestion = () => false
	runtime.gate = createIngressGate({
		runtime,
		config: { mode: 'rules', judge: { enabled: false } },
		dataDir: root,
		logger: silent,
	})
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 0, sessionId: AGENT_SESSION } })
	const { glue } = startedGlue(bridge, { runtime })
	try {
		await glue.start()
		await glue.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/steer actually change it' } })
		assert.equal(runtime.calls.steer.length, 1)
		assert.equal(messageOf(runtime.calls.steer[0]), 'actually change it')
		assert.equal(bridge.forwarded.length, 0, 'the bridge command parser is bypassed')
		await glue.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/queue do this after' } })
		assert.equal(runtime.calls.steer.length, 1)
		assert.equal(runtime.gate.pendingCount(), 1)
		assert.equal(bridge.forwarded.length, 0)
	} finally {
		await glue.stop()
		await runtime.gate.close()
		await rm(root, { recursive: true, force: true })
	}
})

test('no allowed non-text update can vanish silently', async () => {
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 0, sessionId: AGENT_SESSION } })
	const { glue } = startedGlue(bridge)
	await glue.start()
	const cases = [
		['voice', { voice: { file_id: 'v1', file_size: 10, mime_type: 'audio/ogg' } }],
		['audio', { audio: { file_id: 'a1', file_size: 10, mime_type: 'audio/mpeg' } }],
		['document', { document: { file_id: 'd1', file_size: 10, mime_type: 'application/pdf' } }],
		['photo', { photo: [{ file_id: 'p1', file_size: 10 }] }],
		['video', { video: { file_id: 'vid1', file_size: 10 } }],
		['sticker', { sticker: { file_id: 's1' } }],
		['location', { location: { latitude: 1, longitude: 2 } }],
	]
	for (const [type, payload] of cases) {
		const before = bridge.sent.length
		const result = await glue.handleUpdate({
			message: {
				message_id: 500 + before,
				chat: { id: 42, type: 'private' },
				from: { id: 42 },
				...payload,
			},
		})
		assert.equal(result.handled, true, `${type} must be handled`)
		assert.ok(bridge.sent.length > before, `${type} must get an observable reply`)
	}
	assert.equal(bridge.forwarded.length, 0, 'non-text updates never fall through to the bridge')
})

test('ordinary text still reaches the original bridge handler', async () => {
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 0, sessionId: AGENT_SESSION } })
	const { glue } = startedGlue(bridge)
	await glue.start()
	const result = await glue.handleUpdate({
		message: { message_id: 600, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'hello' },
	})
	assert.deepEqual(result, { handled: true, reason: 'original' })
	assert.equal(bridge.forwarded.length, 1)
})

test('edited and business message shapes receive the same media catch-all', async () => {
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 0, sessionId: AGENT_SESSION } })
	const { glue } = startedGlue(bridge)
	await glue.start()
	for (const key of ['edited_message', 'business_message', 'edited_business_message']) {
		const before = bridge.sent.length
		const result = await glue.handleUpdate({
			[key]: { message_id: 700 + before, chat: { id: 42, type: 'private' }, from: { id: 42 }, photo: [{ file_id: 'p' }] },
		})
		assert.equal(result.handled, true, `${key} must be handled`)
		assert.ok(bridge.sent.length > before, `${key} must get a reply`)
	}
	assert.equal(bridge.forwarded.length, 0)
})

test('traced replay: message 871, agent chat 5822509701, stt enabled reaches full voice branch', async () => {
	const bridge = fakeBridge({ allowedChatIds: [5822509701], binding: { chatId: 5822509701, threadId: 0, sessionId: AGENT_SESSION } })
	bridge.api.getFile = async () => ({ file_path: 'voice/871.ogg', file_size: 3 })
	bridge.api.downloadFile = async () => ({ bytes: new Uint8Array([1, 2, 3]) })
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () => new Response(JSON.stringify({ text: 'traced voice transcript' }), { status: 200, headers: { 'content-type': 'application/json' } })
	try {
		const { glue, runtime } = startedGlue(bridge, {
			config: { enabled: true, tokenRef: 'A_TOKEN', allowedChatIds: [5822509701], stateFile: '/tmp/never-used.json' },
			stt: { enabled: true, url: 'http://stt.test/v1/audio/transcriptions', model: 'm', timeoutMs: 500 },
		})
		await glue.start()
		const update = {
			message: {
				message_id: 871,
				chat: { id: 5822509701, type: 'private' },
				from: { id: 5822509701 },
				voice: { file_id: 'voice-871', file_size: 3, mime_type: 'audio/ogg' },
			},
		}
		const result = await glue.handleUpdate(update)
		await glue.handleUpdate(update)
		assert.equal(result.prompted, true)
		assert.equal(runtime.calls.followup.length, 1, 'redelivery is idempotent')
		const content = runtime.calls.followup[0].content.map((part) => part.text).join('')
		assert.equal(content, '🎤 traced voice transcript')
		assert.equal(content.split('🎤').length - 1, 1, 'exactly one marker')
		assert.equal(bridge.sent.length, 0, 'successful transcript sends no error reply')
		assert.equal(bridge.forwarded.length, 0, 'voice does not fall through')
		assert.equal(glue.state, 'ready')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('Agent-bound /compact and /new are controls, never model messages', async () => {
	const bridge = fakeBridge({ binding: { chatId: 42, threadId: 0, sessionId: AGENT_SESSION } })
	const { glue, runtime } = startedGlue(bridge)
	let compacted = 0
	let created = 0
	runtime.contextControls = {
		async compact() { compacted += 1; return { message: 'Context compacted.' } },
		async newConversation() { created += 1; return { message: 'New conversation started.' } },
	}
	await glue.start()
	const update = (text) => ({ message: { message_id: 900 + text.length, chat: { id: 42, type: 'private' }, from: { id: 42 }, text } })
	assert.equal((await glue.handleUpdate(update('/compact'))).reason, 'context-compact')
	assert.equal(compacted, 1)
	assert.equal(bridge.forwarded.length, 0, '/compact never reaches the model')
	await glue.handleUpdate(update('/new'))
	assert.equal(created, 0, '/new requires confirmation')
	assert.match(bridge.sent.at(-1).text, /Reply \/new confirm/)
	await glue.handleUpdate(update('/new confirm'))
	assert.equal(created, 1)
	assert.equal(bridge.forwarded.length, 0, '/new confirm never reaches the model')
})
