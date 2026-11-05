import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { __internals } from '../index.js'
import { createTelegramHost } from '../telegram-host.js'
import { FakeBotApi } from '../../dsh-telegram-session-bridge/test/helpers/fake-bot-api.js'
import { createBridge } from '../../dsh-telegram-session-bridge/src/bridge.js'
import { dmKey } from '../../dsh-telegram-session-bridge/src/state.js'

const { createOwnerStatusControl } = __internals
const AGENT = 'agent-status-1'
const DM = dmKey({ botId: 777, chatId: 42, senderId: 42 })
const silent = { debug() {}, info() {}, warn() {}, error() {} }

async function harness(t, options = {}) {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-status-'))
	const fake = await new FakeBotApi({ token: '777:status-token' }).start()
	const events = options.events ?? [{
		type: 'assistant/message', seq: 42, time: 1793845507961,
		data: {
			message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
			usage: { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 10, outputTokens: 20, totalTokens: 170 },
		},
	}]
	const session = {
		id: AGENT,
		surface: { nodes: [] },
		append(type, data) { events.push({ type, data }) },
		snapshotEvents() { return events },
		requestHeader() { return undefined },
	}
	const calls = { steer: 0, followup: 0, cancel: 0, prompt: 0 }
	const agent = {
		session,
		status: options.agentStatus ?? 'idle',
		options: { provider: 'p', model: 'm' },
		steer() { calls.steer += 1 },
		followup() { calls.followup += 1 },
		cancel() { calls.cancel += 1 },
	}
	const delegations = new Map((options.delegations ?? []).map((record) => [record.sessionId, record]))
	const runtime = {
		ready: true, title: 'Agent', sessionId: AGENT, agent,
		selectionRef: { current: options.model ?? { provider: 'p', model: 'm', reasoningEffort: 'high' } },
		model: options.model ?? { provider: 'p', model: 'm', reasoningEffort: 'high' },
		delegations, streamText: null, catalogCache: null, telegram: null,
	}
	const live = options.live ?? {}
	const ctx = {
		llm: {
			async resolveModelInfo(provider, model) {
				const window = options.contextWindow === undefined ? 1000 : options.contextWindow
				if (window === null) return { provider, id: model, name: 'Model M' }
				return { provider, id: model, name: 'Model M', context: { contextWindow: window } }
			},
		},
		agents: { get(sessionId) { return live[sessionId] ?? undefined } },
	}
	const forward = {
		async prompt() { calls.prompt += 1; throw new Error('status must not prompt') },
		async cancel() { throw new Error('status must not cancel') },
		async list() { return { items: [] } },
		async create() { throw new Error('status must not create') },
		async inspect() { return { events: [] } },
	}
	const statusControl = options.statusControl ?? createOwnerStatusControl(ctx, runtime)
	const glue = createTelegramHost({
		runtime,
		statusControl,
		config: { enabled: true, tokenRef: 'T', allowedChatIds: [42], dshHome: root, poll: false, baseUrl: fake.baseUrl },
		env: { T: '777:status-token' },
		forward: () => forward,
		importBridge: async () => ({ createBridge }),
		install: () => () => {},
		logger: silent,
		clock: () => 1_700_000_000_000,
	})
	t.after(async () => {
		await glue.stop().catch(() => {})
		await fake.stop().catch(() => {})
		await rm(root, { recursive: true, force: true })
	})
	await glue.start()
	await glue.bridge.store.setDm({ key: DM, sessionId: AGENT, mode: 'created' })
	return { root, fake, ctx, runtime, events, calls, forward, glue, statusControl }
}

function dm(text = '/status', id = 1) {
	return { update_id: id, message: { message_id: 100 + id, chat: { id: 42, type: 'private' }, from: { id: 42 }, text } }
}

test('Agent-bound /status renders model, real context usage, busy state, binding and delegations', async (t) => {
	const h = await harness(t, {
		agentStatus: 'running',
		delegations: [
			{ sessionId: 'deleg-1', title: 'First delegation', outcome: undefined, startedAt: 1 },
			{ sessionId: 'deleg-2', title: 'Second delegation', outcome: undefined, startedAt: 2 },
			{ sessionId: 'deleg-done', title: 'Done delegation', outcome: 'done', endedAt: 3 },
		],
		live: { 'deleg-1': { status: 'running' }, 'deleg-2': { status: 'running' }, 'deleg-done': { status: 'idle' } },
	})
	const result = await h.glue.handleUpdate(dm())
	assert.equal(result.handled, true)
	const text = h.fake.messages.at(-1).text
	assert.match(text, /Binding agent-st · quiet/)
	assert.match(text, /Model: p\/m · high/)
	assert.match(text, /Context: 150 \/ 1,000 \(15%\) · assistant\/message #42/)
	assert.match(text, /Agent: Busy/)
	assert.match(text, /Delegations: 2 running — First delegation, Second delegation/)
	assert.equal(h.calls.steer + h.calls.followup + h.calls.cancel + h.calls.prompt, 0, 'status is read-only')
	assert.ok(!/777:status-token/.test(text))
})

test('unknown context usage is shown as Unknown, never fabricated', async (t) => {
	const h = await harness(t, { events: [] })
	await h.glue.handleUpdate(dm())
	const text = h.fake.messages.at(-1).text
	assert.match(text, /Context: Unknown \(no assistant\/message usage\)/)
	assert.ok(!/Context: 0|Context: \d/.test(text))
	await h.glue.handleUpdate(dm('/status', 2))
	assert.match(h.fake.messages.at(-1).text, /Context: Unknown/)
})

test('ordinary-session /status is byte-for-byte unchanged', async (t) => {
	const h = await harness(t)
	await h.glue.bridge.store.bind({ chatId: 42, threadId: 5, sessionId: 'ordinary-session' })
	await h.glue.handleUpdate({
		update_id: 3,
		message: { message_id: 3, chat: { id: 42, type: 'supergroup' }, message_thread_id: 5, from: { id: 42 }, text: '/status' },
	})
	assert.equal(h.fake.messages.at(-1).text, 'Session ordinary · quiet')
})

test('delegation titles cap at three with an exact running count', async (t) => {
	const delegations = Array.from({ length: 5 }, (_, index) => ({
		sessionId: `deleg-${index}`, title: `Delegation ${index + 1}`, outcome: undefined, startedAt: index,
	}))
	const live = Object.fromEntries(delegations.map((record) => [record.sessionId, { status: 'running' }]))
	const h = await harness(t, { delegations, live })
	await h.glue.handleUpdate(dm())
	const text = h.fake.messages.at(-1).text
	assert.match(text, /Delegations: 5 running — Delegation 1, Delegation 2, Delegation 3 \+2 more/)
})

test('a failed owner status provider degrades to binding/verbosity without prompting', async (t) => {
	const h = await harness(t, {
		statusControl: {
			available: true,
			sessionId: () => AGENT,
			isOwnerSession: (sessionId) => sessionId === AGENT,
			async status() { throw new Error('status backend offline') },
		},
	})
	const result = await h.glue.handleUpdate(dm())
	assert.equal(result.handled, true)
	const text = h.fake.messages.at(-1).text
	assert.match(text, /Binding agent-st · quiet/)
	assert.match(text, /Agent status unavailable/)
	assert.equal(h.calls.prompt + h.calls.steer + h.calls.followup + h.calls.cancel, 0)
})

test('production poller dispatches rich /status through the patched handler, read-only', async (t) => {
	const h = await harness(t, {
		agentStatus: 'running',
		delegations: [{ sessionId: 'deleg-1', title: 'First delegation', outcome: undefined, startedAt: 1 }],
		live: { 'deleg-1': { status: 'running' } },
	})
	const before = h.events.length
	h.fake.pushUpdate({
		update_id: 50,
		message: { message_id: 150, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/status' },
	})
	await h.glue.bridge.pollOnce()
	const text = h.fake.messages.at(-1).text
	assert.match(text, /Binding agent-st · quiet/)
	assert.match(text, /Model: p\/m · high/)
	assert.match(text, /Context: 150 \/ 1,000 \(15%\) · assistant\/message #42/)
	assert.match(text, /Agent: Busy/)
	assert.match(text, /Delegations: 1 running — First delegation/)
	assert.equal(h.events.length, before, 'status must not append session events')
	assert.equal(h.calls.steer + h.calls.followup + h.calls.cancel + h.calls.prompt, 0, 'status must not drive the Agent')
})

test('production poller keeps ordinary-session /status unchanged', async (t) => {
	const h = await harness(t)
	await h.glue.bridge.store.bind({ chatId: 42, threadId: 5, sessionId: 'ordinary-session' })
	h.fake.pushUpdate({
		update_id: 51,
		message: { message_id: 151, chat: { id: 42, type: 'supergroup' }, message_thread_id: 5, from: { id: 42 }, text: '/status' },
	})
	await h.glue.bridge.pollOnce()
	assert.equal(h.fake.messages.at(-1).text, 'Session ordinary · quiet')
})
