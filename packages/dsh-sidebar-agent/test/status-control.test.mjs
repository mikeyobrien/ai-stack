import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentService, __internals } from '../index.js'

const { agentStatusOf, createOwnerStatusControl } = __internals
const AGENT = 'agent-status-1'

function harness({ usage, contextWindow = 1000, live = {}, agentStatus = 'idle', delegations = [] } = {}) {
	const events = []
	if (usage !== undefined) {
		events.push({
			type: 'assistant/message', seq: 42, time: 1793845507961,
			data: {
				message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
				usage,
			},
		})
	}
	const session = {
		id: AGENT,
		surface: { nodes: [] },
		append() {},
		snapshotEvents() { return events },
		requestHeader() { return undefined },
	}
	const agent = { session, status: agentStatus, options: { provider: 'p', model: 'm' } }
	const records = new Map(delegations.map((record) => [record.sessionId, record]))
	const runtime = {
		ready: true,
		title: 'Agent',
		sessionId: AGENT,
		agent,
		selectionRef: { current: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
		model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
		delegations: records,
		streamText: null,
		catalogCache: null,
		telegram: null,
	}
	const ctx = {
		llm: {
			async resolveModelInfo(provider, model) {
				if (provider !== 'p' || model !== 'm') throw new Error('unknown model')
				return { provider, id: model, name: 'Model M', ...(contextWindow === null || contextWindow === undefined ? {} : { context: { contextWindow } }) }
			},
		},
		agents: {
			get(sessionId) { return live[sessionId] ?? undefined },
		},
	}
	return { ctx, runtime, events, records }
}

test('rich status uses the latest assistant usage and the resolved model context window', async () => {
	const { ctx, runtime } = harness({
		usage: { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 10, outputTokens: 20, totalTokens: 170 },
		delegations: [
			{ sessionId: 'deleg-1', title: 'First delegation', outcome: undefined, startedAt: 1 },
			{ sessionId: 'deleg-2', title: 'Second delegation', outcome: undefined, startedAt: 2 },
			{ sessionId: 'deleg-done', title: 'Done delegation', outcome: 'done', endedAt: 3 },
		],
		live: { 'deleg-1': { status: 'running' }, 'deleg-2': { status: 'running' }, 'deleg-done': { status: 'idle' } },
		agentStatus: 'running',
	})
	const status = await agentStatusOf(ctx, runtime)
	assert.deepEqual(status.model, { provider: 'p', model: 'm', reasoningEffort: 'high' })
	assert.deepEqual(status.usage, {
		used: 150, window: 1000, percent: 15,
		source: 'assistant/message', seq: 42, at: 1793845507961,
		provider: 'p', model: 'm',
	})
	assert.deepEqual(status.delegations, { count: 2, titles: ['First delegation', 'Second delegation'], more: 0 })
	assert.equal(status.agent.state, 'busy')
	assert.equal(status.readOnly, true)
})

test('missing usage or context window is reported Unknown without inventing tokens', async () => {
	const noUsage = harness({ usage: undefined })
	const first = await agentStatusOf(noUsage.ctx, noUsage.runtime)
	assert.equal(first.usage, null)
	assert.equal(first.usageReason, 'no-usage')

	const noWindow = harness({ usage: { inputTokens: 10, outputTokens: 2 }, contextWindow: null })
	const second = await agentStatusOf(noWindow.ctx, noWindow.runtime)
	assert.equal(second.usage.used, 10)
	assert.equal(second.usage.window, null)
	assert.equal(second.usage.percent, null)
	assert.equal(second.usageReason, 'no-context-window')
})

test('delegation titles cap at three while the running count stays exact', async () => {
	const delegations = Array.from({ length: 5 }, (_, index) => ({
		sessionId: `deleg-${index}`, title: `Delegation ${index + 1}`, outcome: undefined, startedAt: index,
	}))
	const live = Object.fromEntries(delegations.map((record) => [record.sessionId, { status: 'running' }]))
	const { ctx, runtime } = harness({ usage: { inputTokens: 1, outputTokens: 1 }, delegations, live })
	const status = await agentStatusOf(ctx, runtime)
	assert.equal(status.delegations.count, 5)
	assert.deepEqual(status.delegations.titles, ['Delegation 1', 'Delegation 2', 'Delegation 3'])
	assert.equal(status.delegations.more, 2)
})

test('status is read-only and degrades when the model context cannot be resolved', async () => {
	const { ctx, runtime, events } = harness({ usage: { inputTokens: 5, outputTokens: 1 } })
	let reads = 0
	const snapshot = runtime.agent.session.snapshotEvents
	runtime.agent.session.snapshotEvents = () => { reads += 1; return snapshot() }
	const status = await agentStatusOf(ctx, runtime)
	assert.equal(status.usage.used, 5)
	assert.equal(reads, 1)
	assert.equal(events.length, 1, 'status does not append or mutate events')

	ctx.llm.resolveModelInfo = async () => { throw new Error('catalog offline') }
	const degraded = await agentStatusOf(ctx, runtime)
	assert.equal(degraded.usage.window, null)
	assert.equal(degraded.usageReason, 'no-context-window')
	assert.equal(degraded.agent.state, 'idle')
})

test('the actual agent Remote exposes the same read-only rich status', async () => {
	const { ctx, runtime } = harness({ usage: { inputTokens: 2, outputTokens: 1 } })
	runtime.statusControl = createOwnerStatusControl(ctx, runtime)
	const Service = agentService(runtime)
	const service = new Service(new Context())
	const status = await service.agentStatus()
	assert.equal(status.readOnly, true)
	assert.equal(status.usage.used, 2)
	assert.equal(status.model.model, 'm')
})

test('owner status control identifies only this live Agent and remains available', async () => {
	const { ctx, runtime } = harness({ usage: { inputTokens: 1, outputTokens: 1 } })
	const control = createOwnerStatusControl(ctx, runtime)
	assert.equal(control.available, true)
	assert.equal(control.sessionId(), AGENT)
	assert.equal(control.isOwnerSession(AGENT), true)
	assert.equal(control.isOwnerSession('other'), false)
	assert.equal((await control.status()).usage.used, 1)
})
