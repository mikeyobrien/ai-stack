import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentService, __internals } from '../index.js'

const {
	settingsOf, noteDelegationEvent, sanitizeStallRecord, sweepDelegations, stallNoteOf,
	delegationStateOf, loadState, delegationsOf, handleDelegationSessionEvent,
} = __internals
const MINUTE = 60_000
const TIMEOUT = 30 * MINUTE

function runtimeOf({ autoCancel = false, agent = true, records = [] } = {}) {
	const notes = []
	const cancels = []
	const runtime = {
		stallTimeoutMs: TIMEOUT,
		stallAutoCancel: autoCancel,
		delegations: new Map(records.map((record) => [record.sessionId, record])),
		agent: agent ? {
			inject(message) { notes.push(message) },
			cancel(...args) { cancels.push(args) },
		} : null,
	}
	return { runtime, notes, cancels }
}

function ctxOf(extra = {}) {
	return { agents: { get: () => ({ status: 'running', ...extra }) } }
}

function recordOf(overrides = {}) {
	return {
		sessionId: 'deleg-1', title: 'Research delegation', workspaceTitle: 'ai-stack',
		startedAt: 0, outcome: undefined, lastLine: null, endedAt: null,
		turnActive: false, lastActivityAt: null, stalledAt: null, stalledNotified: false,
		...overrides,
	}
}

function textOf(message) {
	return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

test('settings default to a 30-minute threshold and auto-cancel off', () => {
	const settings = settingsOf({})
	assert.equal(settings.stallTimeoutMs, TIMEOUT)
	assert.equal(settings.stallAutoCancel, false)
	const custom = settingsOf({ delegationStallMs: 5 * MINUTE, delegationStallAutoCancel: true })
	assert.equal(custom.stallTimeoutMs, 5 * MINUTE)
	assert.equal(custom.stallAutoCancel, true)
})

test('turn start arms, activity postpones, and turn end disarms without stalling', () => {
	const record = recordOf()
	noteDelegationEvent(record, { type: 'turn/start', time: 1000 }, 1000)
	assert.equal(record.turnActive, true)
	assert.equal(record.lastActivityAt, 1000)
	noteDelegationEvent(record, { type: 'tool/call', time: 10 * MINUTE }, 10 * MINUTE)
	assert.equal(record.lastActivityAt, 10 * MINUTE)
	const { runtime, notes } = runtimeOf({ records: [record] })
	const result = sweepDelegations(ctxOf(), runtime, 10 * MINUTE + TIMEOUT - 1)
	assert.deepEqual(result.stalled, [])
	assert.equal(notes.length, 0)
	noteDelegationEvent(record, { type: 'turn/end', time: 20 * MINUTE }, 20 * MINUTE)
	assert.equal(record.turnActive, false)
	const after = sweepDelegations(ctxOf(), runtime, 100 * MINUTE)
	assert.deepEqual(after.stalled, [])
	assert.equal(notes.length, 0)
})

test('a quiet delegation stalls, notifies once, keeps its outcome and re-arms on activity', () => {
	const record = recordOf()
	noteDelegationEvent(record, { type: 'turn/start', time: 1000 }, 1000)
	const { runtime, notes } = runtimeOf({ records: [record] })
	const first = sweepDelegations(ctxOf(), runtime, 1000 + TIMEOUT)
	assert.deepEqual(first.stalled, ['deleg-1'])
	assert.equal(record.stalledAt, 1000 + TIMEOUT)
	assert.equal(record.stalledNotified, true)
	assert.equal(record.outcome, undefined)
	assert.equal(notes.length, 1)
	const note = textOf(notes[0])
	assert.match(note, /^\[delegation deleg-1 "Research delegation" in ai-stack stalled: no activity for 30m at /)
	assert.match(note, /Still running/)
	assert.equal(notes[0].source.kind, 'delegation')
	sweepDelegations(ctxOf(), runtime, 1000 + TIMEOUT + 1)
	assert.equal(notes.length, 1, 'one note per stall episode')

	noteDelegationEvent(record, { type: 'assistant/message', time: 2000 + TIMEOUT }, 2000 + TIMEOUT)
	assert.equal(record.stalledAt, null)
	assert.equal(record.stalledNotified, false)
	assert.equal(delegationStateOf(record, 'running'), 'running')
	const second = sweepDelegations(ctxOf(), runtime, 2000 + TIMEOUT + TIMEOUT)
	assert.deepEqual(second.stalled, ['deleg-1'])
	assert.equal(notes.length, 2, 'a later episode notifies again')
	assert.equal(record.outcome, undefined)
})

test('a long-but-active turn never stalls and auto-cancel is off by default', () => {
	const record = recordOf()
	noteDelegationEvent(record, { type: 'turn/start', time: 0 }, 0)
	noteDelegationEvent(record, { type: 'step/start', time: 29 * MINUTE }, 29 * MINUTE)
	const { runtime, notes, cancels } = runtimeOf({ records: [record] })
	const result = sweepDelegations(ctxOf(), runtime, 31 * MINUTE)
	assert.deepEqual(result.stalled, [])
	assert.equal(notes.length, 0)
	assert.equal(cancels.length, 0)
})

test('auto-cancel is an opt-in single keep-inbox cancel', () => {
	const record = recordOf()
	noteDelegationEvent(record, { type: 'turn/start', time: 0 }, 0)
	const { runtime, cancels } = runtimeOf({ autoCancel: true, records: [record] })
	const ctx = { agents: { get: () => ({ status: 'running', cancel: (...args) => cancels.push(args) }) } }
	sweepDelegations(ctx, runtime, TIMEOUT)
	assert.equal(cancels.length, 1)
	assert.deepEqual(cancels[0], [{ kind: 'user' }, { keepInbox: true }])
	sweepDelegations(ctx, runtime, TIMEOUT + 1)
	assert.equal(cancels.length, 1, 'cancel happens once per stall episode')
})

test('restart sanitization keeps valid stalled state and fails safe on corrupt/missing fields', () => {
	const valid = recordOf({ turnActive: true, lastActivityAt: 1000, stalledAt: 2000, stalledNotified: true, stallCancelled: true })
	assert.equal(sanitizeStallRecord(valid), true)
	assert.equal(delegationStateOf(valid, 'running'), 'stalled')
	const missing = recordOf({ turnActive: true, lastActivityAt: 1000, stalledAt: 'bad', stalledNotified: 'yes' })
	sanitizeStallRecord(missing)
	assert.equal(missing.stalledAt, null)
	assert.equal(missing.stalledNotified, false)
	const noActivity = recordOf({ turnActive: true, lastActivityAt: null, stalledAt: 2000, stalledNotified: true })
	sanitizeStallRecord(noActivity)
	assert.equal(noActivity.stalledAt, null)
	const legacy = recordOf({ turnActive: undefined, lastActivityAt: undefined, stalledAt: undefined, stalledNotified: undefined })
	sanitizeStallRecord(legacy)
	assert.equal(legacy.stalledAt, null)
	assert.equal(legacy.turnActive, false)
})

test('loadState sanitizes persisted stall fields and preserves valid ones', async () => {
	const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { join } = await import('node:path')
	const root = await mkdtemp(join(tmpdir(), 'sidebar-stall-state-'))
	try {
		const file = join(root, 'state.json')
		await writeFile(file, JSON.stringify({
			version: 1,
			sessionId: null,
			delegations: [
				{ ...recordOf({ sessionId: 'valid', turnActive: true, lastActivityAt: 1, stalledAt: 2, stalledNotified: true }) },
				{ ...recordOf({ sessionId: 'corrupt', stalledAt: 'x', stalledNotified: 'yes', turnActive: true, lastActivityAt: 1 }) },
			],
		}))
		const state = await loadState(file)
		assert.equal(state.delegations[0].stalledAt, 2)
		assert.equal(state.delegations[1].stalledAt, null)
		assert.equal(state.delegations[1].stalledNotified, false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('delegated Remote and delegations tool expose stalled separately from running', async () => {
	const stalled = recordOf({ sessionId: 'stalled-1', turnActive: true, lastActivityAt: 1, stalledAt: 2, stalledNotified: true })
	const running = recordOf({ sessionId: 'running-1', turnActive: true, lastActivityAt: 1 })
	const done = recordOf({ sessionId: 'done-1', outcome: 'done', endedAt: 3 })
	const runtime = { delegations: new Map([[stalled.sessionId, stalled], [running.sessionId, running], [done.sessionId, done]]), host: null }
	const Service = agentService(runtime)
	const service = new Service(new Context())
	assert.deepEqual(service.delegated(), { sessionIds: ['stalled-1', 'running-1', 'done-1'], stalledSessionIds: ['stalled-1'] })
	const ctx = {
		agents: { get(sessionId) { return sessionId === 'running-1' ? { status: 'running' } : undefined } },
		sessionQuery: { async readTitleSnapshots() { return [] } },
		workspaceRegistry: { get() { return undefined } },
	}
	const view = await delegationsOf(ctx, runtime)
	assert.equal(view.delegations.find((entry) => entry.sessionId === 'stalled-1').state, 'stalled')
	assert.equal(view.delegations.find((entry) => entry.sessionId === 'running-1').state, 'running')
})

test('the status note names the episode time and stays machine-worded', () => {
	const note = stallNoteOf(recordOf({ stalledAt: 123456, lastActivityAt: 0 }), TIMEOUT)
	assert.match(note, /^\[delegation deleg-1 "Research delegation" in ai-stack stalled: no activity for 30m at 123456\]/)
	assert.match(note, /Still running/)
	assert.ok(note.split('\n').length <= 3)
})


test('the production session-event handler arms on turn start and clears on turn end', () => {
	const record = recordOf()
	const notes = []
	const runtime = {
		stallTimeoutMs: TIMEOUT,
		stallAutoCancel: false,
		delegations: new Map([[record.sessionId, record]]),
		agent: { inject(message) { notes.push(message) } },
		store: { save() {} },
		snapshot() { return { sessionId: null, delegations: [record] } },
	}
	const session = {
		id: record.sessionId,
		snapshotEvents() { return [{ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'done reply' }] } } }] },
	}
	handleDelegationSessionEvent({}, runtime, session, { type: 'turn/start', time: 1000 })
	assert.equal(record.turnActive, true)
	assert.equal(record.lastActivityAt, 1000)
	handleDelegationSessionEvent({}, runtime, session, { type: 'tool/call', time: 2000 })
	assert.equal(record.lastActivityAt, 2000)
	handleDelegationSessionEvent({}, runtime, session, { type: 'turn/end', time: 3000, data: { reason: { kind: 'completed' } } })
	assert.equal(record.turnActive, false)
	assert.equal(record.stalledAt, null)
	assert.equal(record.outcome, 'done')
	assert.equal(notes.length, 1)
	assert.match(textOf(notes[0]), /ended: done at 3000/)
})
