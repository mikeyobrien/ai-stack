import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createContextControls } from '../index.js'

function harness({ status = 'idle', pending = 0, compactResult = { shadowedSeqs: [1, 2] } } = {}) {
	const events = { archive: [], dispose: 0, rename: [], rebind: [], save: 0, create: [] }
	const compact = { async compactNow() { return compactResult } }
	const oldAgent = { status, options: { provider: 'deepseek-official', model: 'deepseek-flash' }, session: { id: 'agent-old' } }
	const oldHandle = { async dispose() { events.dispose += 1 } }
	const runtime = {
		agent: oldAgent,
		agentHandle: oldHandle,
		sessionId: 'agent-old',
		title: 'mAgent',
		cwd: '/tmp',
		selectionRef: { current: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } },
		gate: { pendingCount: () => pending },
		delegations: new Map([['d1', { id: 'd1' }]]),
		pulseHistory: ['pulse'],
		setupConversation: async () => { events.setup = true },
		telegram: { async rebindAgentSession(oldId, newId) { events.rebind.push([oldId, newId]); return { rebound: true } } },
		store: { async save() { events.save += 1 } },
		snapshot: () => ({}),
	}
	const ctx = {
		get: (name) => name === 'compaction' ? compact : undefined,
		agents: { async create(options) { events.create.push(options); const id = options.sessionId; return { agent: { session: { id }, options: options.agentOptions, status: 'idle' } , async dispose() { events.dispose += 1 } } } },
		workspaceRegistry: { async archiveSession(id, options) { events.archive.push([id, options]) } },
		sessionTitle: { async rename(session, title) { events.rename.push([session.id, title]) } },
	}
	return { ctx, runtime, events }
}

test('compact uses the native compaction service and reports readable results', async () => {
	const h = harness()
	const controls = createContextControls({ ctx: h.ctx, runtime: h.runtime })
	const result = await controls.compact()
	assert.equal(result.ok, true)
	assert.match(result.message, /Compacted 2 context items/)
})

test('compact/new are blocked with readable errors while running or queued', async () => {
	const running = harness({ status: 'running' })
	const controls = createContextControls({ ctx: running.ctx, runtime: running.runtime })
	await assert.rejects(controls.compact(), /Stop the running turn/)
	await assert.rejects(controls.newConversation(), /Stop the running turn/)
	const queued = harness({ pending: 2 })
	await assert.rejects(createContextControls({ ctx: queued.ctx, runtime: queued.runtime }).newConversation(), /Clear the queued messages/)
})

test('new conversation archives the old session, preserves runtime state, rebinds Telegram and disposes the old agent', async () => {
	const h = harness()
	const controls = createContextControls({ ctx: h.ctx, runtime: h.runtime })
	const result = await controls.newConversation()
	assert.equal(result.ok, true)
	assert.equal(result.archived, 'agent-old')
	assert.notEqual(h.runtime.sessionId, 'agent-old')
	assert.equal(h.events.archive.length, 1)
	assert.equal(h.events.archive[0][0], 'agent-old')
	assert.equal(h.events.archive[0][1].stopActivity, true)
	assert.deepEqual(h.events.rebind, [['agent-old', h.runtime.sessionId]])
	assert.equal(h.events.dispose, 1)
	assert.equal(h.runtime.delegations.size, 1)
	assert.deepEqual(h.runtime.pulseHistory, ['pulse'])
	assert.equal(h.events.save, 1)
	assert.equal(h.runtime.agent.options.model, 'deepseek-flash')
})

test('new conversation creation failure keeps the old agent and does not archive', async () => {
	const h = harness()
	h.ctx.agents.create = async () => { throw new Error('create failed') }
	await assert.rejects(createContextControls({ ctx: h.ctx, runtime: h.runtime }).newConversation(), /Could not start a new conversation/)
	assert.equal(h.runtime.agent.session.id, 'agent-old')
	assert.equal(h.events.archive.length, 0)
	assert.equal(h.events.dispose, 0)
})


test('archive failure rolls back the Telegram rebind and preserves the old conversation', async () => {
	const h = harness()
	h.ctx.workspaceRegistry.archiveSession = async (id) => { h.events.archive.push([id, { stopActivity: true }]); if (id === 'agent-old') throw new Error('archive denied') }
	await assert.rejects(createContextControls({ ctx: h.ctx, runtime: h.runtime }).newConversation(), /archive denied|old conversation was preserved/)
	assert.equal(h.runtime.sessionId, 'agent-old')
	assert.equal(h.events.rebind.length, 2, 'forward rebind then rollback rebind')
	assert.equal(h.events.rebind.length, 2, 'rebind forward then rollback')
	assert.notEqual(h.events.rebind[0][1], 'agent-old')
	assert.equal(h.events.rebind[1][1], 'agent-old')
	assert.ok(h.events.archive.some(([id]) => id === h.events.rebind[0][1]), 'orphan new session archived')
})

test('rebind failure keeps the old binding and cleans up the orphan new session', async () => {
	const h = harness()
	h.runtime.telegram.rebindAgentSession = async () => { throw new Error('telegram rebind denied') }
	await assert.rejects(createContextControls({ ctx: h.ctx, runtime: h.runtime }).newConversation(), /rebind denied|old conversation was preserved/)
	assert.equal(h.runtime.sessionId, 'agent-old')
	assert.equal(h.events.archive.length, 1, 'only orphan new archived')
	assert.notEqual(h.events.archive[0][0], 'agent-old')
	assert.equal(h.events.dispose, 1, 'new agent disposed')
})

test('duplicate new-conversation calls are idempotent and create once', async () => {
	const h = harness()
	const controls = createContextControls({ ctx: h.ctx, runtime: h.runtime })
	const [a, b] = await Promise.all([controls.newConversation(), controls.newConversation()])
	assert.deepEqual(a, b)
	assert.equal(h.events.create.length, 1)
})

test('busy recheck after create aborts and preserves the old conversation', async () => {
	const h = harness()
	const original = h.ctx.agents.create
	h.ctx.agents.create = async (options) => {
		const handle = await original(options)
		h.runtime.agent.status = 'running'
		return handle
	}
	await assert.rejects(createContextControls({ ctx: h.ctx, runtime: h.runtime }).newConversation(), /Stop the running turn|old conversation is unchanged/)
	assert.equal(h.runtime.agent.session.id, 'agent-old')
	assert.equal(h.events.archive.length, 1, 'only orphan new archived')
})
