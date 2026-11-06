import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { validateDelegationRoute, __internals } from '../index.js'

const { settingsOf, workspacePathOf, outcomeOf, reportOf, textOf, steerDelegation, alreadyDelivered, deliverPendingReports, chatStatus } = __internals

test('settings default to an Agent in the Harness home', () => {
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = '/tmp/sidebar-agent-test'
	try {
		const settings = settingsOf({})
		assert.equal(settings.title, 'Agent')
		assert.equal(settings.dataDir, '/tmp/sidebar-agent-test/sidebar-agent')
		assert.equal(settings.cwd, '/tmp/sidebar-agent-test/sidebar-agent/workspace')
		assert.equal(settings.provider, undefined)
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
	}
})

test('settings keep a configured title, directory, and route', () => {
	const settings = settingsOf({
		title: '  Hermes  ',
		dataDir: '/tmp/agent-data',
		cwd: '/tmp/agent-work',
		provider: 'sparks',
		model: 'deepseek-v4.1-flash',
		reasoningEffort: 'high',
	})
	assert.equal(settings.title, 'Hermes')
	assert.equal(settings.dataDir, '/tmp/agent-data')
	assert.equal(settings.cwd, '/tmp/agent-work')
	assert.deepEqual(
		{ provider: settings.provider, model: settings.model, reasoningEffort: settings.reasoningEffort },
		{ provider: 'sparks', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
	)
})

test('workspace paths expand ~ and resolve relative arguments', () => {
	assert.equal(workspacePathOf('~', '/work/base'), homedir())
	assert.equal(workspacePathOf('~/projects/app', '/work/base'), join(homedir(), 'projects/app'))
	assert.equal(workspacePathOf('/srv/app', '/work/base'), '/srv/app')
	assert.equal(workspacePathOf('app', '/work/base'), resolve('/work/base', 'app'))
})

test('turn end reasons become the states a card shows', () => {
	assert.equal(outcomeOf({ kind: 'completed' }), 'done')
	assert.equal(outcomeOf({ kind: 'error' }), 'failed')
	assert.equal(outcomeOf({ kind: 'max-tokens' }), 'failed')
	assert.equal(outcomeOf({ kind: 'aborted' }), 'stopped')
	assert.equal(outcomeOf({ kind: 'blocked' }), 'blocked')
	assert.equal(outcomeOf({ kind: 'interrupted' }), 'interrupted')
})

test('a delegation report names its session, title, workspace, state, and last line', () => {
	const record = {
		sessionId: 'session-abc',
		title: 'Fix the tests',
		workspaceTitle: 'App',
		outcome: 'done',
		lastLine: 'All tests pass.',
	}
	assert.equal(
		reportOf(record),
		'[delegation session-abc "Fix the tests" in App ended: done]\nAll tests pass.',
	)
	assert.equal(
		reportOf({ ...record, title: null, lastLine: null }),
		'[delegation session-abc "session-abc" in App ended: done]\nNo reply.',
	)
	assert.equal(
		reportOf({ ...record, endedAt: 1234 }),
		'[delegation session-abc "Fix the tests" in App ended: done at 1234]\nAll tests pass.',
	)
})

function delegationEvent(seq, time, text) {
	return {
		type: 'user/message',
		seq,
		time,
		data: { id: `delegation-${seq}`, source: { kind: 'delegation' }, content: [{ type: 'text', text }] },
	}
}

function reportSession(events) {
	return {
		snapshotEvents: () => events,
		surface: { nodes: events.map((event) => event.seq) },
	}
}

function deliveryRuntime(record) {
	return {
		delegations: new Map([[record.sessionId, record]]),
		store: { saves: 0, save() { this.saves += 1 } },
		snapshot: () => ({}),
	}
}

test('a completion report is delivered once and legacy text is not re-emitted', () => {
	const record = {
		sessionId: 'session-report', title: 'Report', workspaceTitle: 'App', outcome: 'done',
		endedAt: 1000, lastLine: 'Same reply.',
	}
	const events = []
	const agent = {
		session: null,
		injected: [],
		inject(message) {
			this.injected.push(message)
			const seq = events.length
			events.push(delegationEvent(seq, 1000 + seq, message.content[0].text))
		},
	}
	agent.session = reportSession(events)
	const runtime = deliveryRuntime(record)
	assert.equal(deliverPendingReports(agent, runtime), true)
	assert.equal(agent.injected.length, 1)
	assert.equal(record.reportedEndedAt, 1000)
	assert.equal(deliverPendingReports(agent, runtime), false, 'a reload does not append the old Done')
	assert.equal(agent.injected.length, 1)
	assert.equal(runtime.store.saves, 1)
})

test('legacy Done text is recognized, but an identical new completion is still delivered', () => {
	const record = {
		sessionId: 'session-report', title: 'Report', workspaceTitle: 'App', outcome: 'done',
		endedAt: 1000, lastLine: 'Same reply.',
	}
	const legacyText = reportOf({ ...record, endedAt: undefined })
	const events = [delegationEvent(0, 1010, legacyText)]
	assert.equal(alreadyDelivered({ ...record }, { keys: new Set(), legacy: [{ text: legacyText, time: 1010 }] }), true,
		'the legacy receipt belongs to the old completion')
	record.endedAt = 2000
	const agent = {
		session: reportSession(events),
		injected: [],
		inject(message) { this.injected.push(message) },
	}
	const runtime = deliveryRuntime(record)
	assert.equal(alreadyDelivered(record, { keys: new Set(), legacy: [{ text: legacyText, time: 1010 }] }), false,
		'an old identical reply before the new completion is not this occurrence')
	assert.equal(deliverPendingReports(agent, runtime), true)
	assert.equal(agent.injected.length, 1, 'the genuine second completion is delivered')
	assert.equal(agent.injected[0].content[0].text.includes('at 2000'), true, 'the new report carries its actual end time')
})

test('legacy delivery state is adopted instead of replaying old Done reports', () => {
	const record = {
		sessionId: 'session-old', title: 'Old', workspaceTitle: 'App', outcome: 'done',
		endedAt: 1000, lastLine: 'Old body.',
	}
	const agent = { session: reportSession([]), injected: [], inject(message) { this.injected.push(message) } }
	const runtime = deliveryRuntime(record)
	assert.equal(deliverPendingReports(agent, runtime, { adoptLegacy: true }), true)
	assert.equal(agent.injected.length, 0, 'no hours-old report is injected into the Agent')
	assert.equal(record.reportedEndedAt, 1000)
	assert.equal(runtime.reportDeliveryVersion, 1, 'the state is migrated once')
})

test('chat status places committed reports at their completion time and does not duplicate them', () => {
	const reportText = '[delegation session-r "Report" in App ended: done at 150]\nBody.'
	const events = [
		{ type: 'user/message', seq: 0, time: 100, data: { id: 'user-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] } },
		{ type: 'assistant/message', seq: 1, time: 200, data: { message: { id: 'assistant-1', content: [{ type: 'text', text: 'Answer' }] } } },
		{ type: 'user/message', seq: 2, time: 500, data: { id: 'delegation-1', source: { kind: 'delegation' }, content: [{ type: 'text', text: reportText }] } },
	]
	const session = {
		snapshotEvents: () => events,
		surface: { nodes: events.map((event) => event.seq) },
	}
	const runtime = {
		ready: true, agent: { status: 'idle', options: {}, session }, title: 'Agent', error: null,
		delegations: new Map([
			['session-r', { sessionId: 'session-r', title: 'Report', workspaceTitle: 'App', outcome: 'done', endedAt: 150, lastLine: 'Body', reportedEndedAt: 150 }],
			['session-r2', { sessionId: 'session-r2', title: 'Later', workspaceTitle: 'App', outcome: 'done', endedAt: 400, lastLine: 'Later body' }],
		]),
		selectionRef: { current: null }, streamText: '',
	}
	const status = chatStatus(runtime)
	const committed = status.messages.find((message) => message.source === 'delegation')
	assert.equal(committed.time, 150, 'the receipt is displayed at its completion time')
	assert.equal(committed.reportKey, 'session-r:150')
	assert.equal(status.messages.find((message) => message.id === 'assistant-1').time, 200)
	assert.deepEqual(status.reports.map((report) => ({ id: report.id, time: report.time })), [{ id: 'report:session-r2:400', time: 400 }])
})

test('message text keeps text blocks and drops the rest', () => {
	assert.equal(textOf([{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }]), 'one\ntwo')
	assert.equal(textOf([{ type: 'text', text: '   ' }]), null)
	assert.equal(textOf(undefined), null)
})

/**
 * A Host context whose delegation session is not live: its log holds the given
 * events, and resume records the options it was handed.
 */
function coldDelegationHost(events) {
	const resumed = []
	const agent = { status: 'idle', followup() {}, steer() {} }
	const ctx = {
		get: (name) => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'reef', model: 'qwen3.8-27b' }) } : undefined),
		agents: {
			get: () => undefined,
			async resume(options) {
				resumed.push(options.agentOptions)
				return { agent }
			},
		},
		sessionQuery: {
			listEvents: async () => events.map(({ type }, seq) => ({ type, seq })),
			readEvent: async ({ seq }) => ({ target: events[seq] }),
		},
	}
	return { ctx, resumed }
}

const header = (config, adapterDefaults = {}) => ({ type: 'request/header', data: { header: { config, adapterDefaults } } })

test('a cold delegation resumes on the route its last request ran', async () => {
	const { ctx, resumed } = coldDelegationHost([
		{ type: 'session' },
		header({ provider: 'sparks', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }),
		header({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }),
		{ type: 'turn/end' },
	])
	const runtime = { agent: { options: { provider: 'openai-codex', model: 'gpt-6.1-sol' } } }
	await steerDelegation(ctx, runtime, { sessionId: 'session-cold' }, 'continue', new AbortController().signal)
	assert.deepEqual(resumed, [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }])
})

test('a resumed route drops an effort the adapter defaulted', async () => {
	const { ctx, resumed } = coldDelegationHost([
		header({ provider: 'reef', model: 'qwen3.8-27b', reasoningEffort: 'high' }, { reasoningEffort: true }),
	])
	await steerDelegation(ctx, { agent: { options: {} } }, { sessionId: 'session-cold' }, 'continue', new AbortController().signal)
	assert.deepEqual(resumed, [{ provider: 'reef', model: 'qwen3.8-27b' }])
})

test('a cold delegation that never ran a request resumes on the agent route, else the default', async () => {
	const first = coldDelegationHost([{ type: 'session' }])
	await steerDelegation(first.ctx, { agent: { options: { provider: 'sparks', model: 'deepseek-v4.1-flash' } } }, { sessionId: 'session-cold' }, 'go', new AbortController().signal)
	assert.deepEqual(first.resumed, [{ provider: 'sparks', model: 'deepseek-v4.1-flash' }])

	const second = coldDelegationHost([{ type: 'session' }])
	await steerDelegation(second.ctx, { agent: { options: {} } }, { sessionId: 'session-cold' }, 'go', new AbortController().signal)
	assert.deepEqual(second.resumed, [{ provider: 'reef', model: 'qwen3.8-27b' }])
})


test('delegate validation rejects a reversed provider/model pair and names the valid orientation', async () => {
	const ctx = { llm: { resolveModelInfo: async (provider, model) => {
		if (provider === 'deepseek-official' && model === 'deepseek-flash') return { provider, model }
		throw new Error(`unknown ${provider}/${model}`)
	} } }
	await assert.rejects(
		validateDelegationRoute(ctx, 'deepseek-flash', 'deepseek-official'),
		/provider\/model are reversed; use provider "deepseek-official" and model "deepseek-flash"/,
	)
	await assert.rejects(
		validateDelegationRoute(ctx, 'nope', 'missing'),
		/unknown model provider "nope" \/ model "missing"/,
	)
	await assert.rejects(
		validateDelegationRoute(ctx, 'deepseek-official', 'deepseek-official'),
		/model "deepseek-official" is the provider id/,
	)
	await assert.doesNotReject(validateDelegationRoute(ctx, 'deepseek-official', 'deepseek-flash'))
})


test('delegate validation rejects a provider id passed as the wire model even when resolveModelInfo is permissive', async () => {
	const ctx = {
		llm: {
			// The DeepSeek adapter deliberately resolves unknown ids; this is the
			// permissive behavior that let `model: deepseek-official` reach the wire.
			resolveModelInfo: async (provider, model) => ({ provider, model }),
			listModels: async (provider) => provider === 'deepseek-official'
				? [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]
				: [{ id: 'GLM-5.3-Flash-EXL3' }],
		},
	}
	await assert.rejects(
		validateDelegationRoute(ctx, 'deepseek-official', 'deepseek-official'),
		/model "deepseek-official" is the provider id/,
	)
	await assert.rejects(
		validateDelegationRoute(ctx, 'deepseek-official', 'deepseek-flash-typo'),
		/not offered by provider "deepseek-official"; valid models: deepseek-flash, deepseek-v4-pro/,
	)
	await assert.doesNotReject(validateDelegationRoute(ctx, 'deepseek-official', 'deepseek-flash'))
	await assert.doesNotReject(validateDelegationRoute(ctx, 'sparks', 'GLM-5.3-Flash-EXL3'))
})
