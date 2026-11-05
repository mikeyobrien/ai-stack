import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentService, __internals } from '../index.js'

const { selectModel, createOwnerModelControl, persistedSelection, initialSelectionOf, chatStatus } = __internals
const AGENT = 'agent-model-1'

function harness({ current = { provider: 'p', model: 'm1', reasoningEffort: 'high' } } = {}) {
	const events = []
	const models = [
		{ id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
		{ id: 'm2', name: 'Model Two', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
		{ id: 'm3', name: 'Model Three', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } },
		{ id: 'plain', name: 'Plain Model' },
	]
	const session = {
		id: AGENT,
		surface: { nodes: [] },
		append(type, data) { events.push({ type, data }) },
		snapshotEvents() { return events },
		requestHeader() { return undefined },
	}
	const agent = { session, status: 'idle', options: { provider: 'p', model: 'm1' }, steer() {}, followup() {}, cancel() {} }
	const runtime = {
		ready: true,
		title: 'Agent',
		sessionId: AGENT,
		agent,
		selectionRef: { current },
		model: current,
		delegations: new Map(),
		streamText: null,
		catalogCache: null,
		telegram: null,
		settingsNs: 'sidebar-agent',
	}
	const ctx = {
		events,
		llm: {
			listProviders() { return [{ id: 'p', name: 'Provider P' }] },
			async listModels() { return models.map(({ id, name }) => ({ id, name })) },
			async resolveModelInfo(provider, model) {
				const found = models.find((entry) => entry.id === model)
				if (provider !== 'p' || found === undefined) throw new Error(`unknown model ${provider}/${model}`)
				return { provider, id: found.id, name: found.name, reasoning: found.reasoning }
			},
		},
		sessionQuery: {
			async observeSession() {
				return {
					events: [...events],
					projections: { values: {} },
					[Symbol.dispose]() {},
				}
			},
		},
	}
	return { ctx, runtime, events, models }
}

test('the shared setter persists only an explicit effort, keeping Default semantics', async () => {
	const { ctx, runtime, events } = harness()
	const plain = await selectModel(ctx, runtime, { provider: 'p', model: 'm2' })
	assert.deepEqual(plain.model, { provider: 'p', model: 'm2' })
	assert.deepEqual(runtime.selectionRef.current, { provider: 'p', model: 'm2' })

	const high = await selectModel(ctx, runtime, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.deepEqual(high.model, { provider: 'p', model: 'm2', reasoningEffort: 'high' })

	const medium = await selectModel(ctx, runtime, { provider: 'p', model: 'm3', reasoningEffort: 'medium' })
	assert.deepEqual(medium.model, { provider: 'p', model: 'm3', reasoningEffort: 'medium' })

	const none = await selectModel(ctx, runtime, { provider: 'p', model: 'plain' })
	assert.deepEqual(none.model, { provider: 'p', model: 'plain' })
	assert.equal(events.filter((event) => event.type === 'model/selection').length, 4)
	assert.deepEqual(events.at(-1).data, { provider: 'p', model: 'plain' })
})

test('the shared setter validates explicit effort and leaves selection unchanged on failure', async () => {
	const { ctx, runtime, events } = harness()
	await assert.rejects(selectModel(ctx, runtime, { provider: 'p', model: 'm2', reasoningEffort: 'low' }), /does not offer/i)
	assert.deepEqual(runtime.selectionRef.current, { provider: 'p', model: 'm1', reasoningEffort: 'high' })
	assert.equal(events.length, 0)
	await assert.rejects(selectModel(ctx, runtime, { provider: 'p', model: 'missing' }), /unknown model/i)
	assert.deepEqual(runtime.selectionRef.current, { provider: 'p', model: 'm1', reasoningEffort: 'high' })
})

test('the durable model/selection event reads back as the persisted next selection', async () => {
	const { ctx, runtime } = harness()
	await selectModel(ctx, runtime, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	const persisted = await persistedSelection(ctx, AGENT)
	assert.deepEqual(persisted, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
})

test('reload initialization prefers the durable selection over a stale request header', async () => {
	const { ctx, runtime } = harness()
	await selectModel(ctx, runtime, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	runtime.agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'm1', reasoningEffort: 'high' } })
	const initial = await initialSelectionOf(ctx, runtime.agent)
	assert.deepEqual(initial, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
})

test('reload initialization falls back to the request header when no durable selection exists', async () => {
	const { ctx, runtime } = harness()
	runtime.agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'm3', reasoningEffort: 'medium' } })
	assert.deepEqual(await initialSelectionOf(ctx, runtime.agent), { provider: 'p', model: 'm3', reasoningEffort: 'medium' })
})

test('the actual GUI Remote setModel path writes the durable selection and preserves Default semantics', async () => {
	const { ctx, runtime, events } = harness()
	runtime.host = ctx
	const Service = agentService(runtime)
	const service = new Service(new Context())
	const noEffort = await service.setModel({ provider: 'p', model: 'm2' })
	assert.deepEqual(noEffort.model, { provider: 'p', model: 'm2' })
	assert.deepEqual(events.at(-1), { type: 'model/selection', data: { provider: 'p', model: 'm2' } })
	const explicit = await service.setModel({ provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.deepEqual(explicit.model, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.deepEqual(events.at(-1).data, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.deepEqual(chatStatus(runtime).model, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
})

test('the owner control uses this live Agent and the shared GUI selection state', async () => {
	const { ctx, runtime } = harness()
	const control = createOwnerModelControl(ctx, runtime)
	assert.equal(control.sessionId(), AGENT)
	assert.equal(control.isOwnerSession(AGENT), true)
	assert.equal(control.isOwnerSession('other-agent'), false)
	assert.deepEqual(control.current(), { provider: 'p', model: 'm1', reasoningEffort: 'high' })
	const catalog = await control.catalog()
	assert.deepEqual(catalog.groups.map((group) => group.id), ['p'])
	const result = await control.select({ provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.deepEqual(result.model, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.deepEqual(chatStatus(runtime).model, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.equal(runtime.agent.session.snapshotEvents().at(-1).type, 'model/selection')
})
