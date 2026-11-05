import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createIngressGate, explicitCommandOf, urgencyOf } from '../ingress-gate.js'
import { __internals } from '../index.js'

function textOf(message) {
	return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

async function harness(t, { mode = 'rules', pendingQuestion = false, logMaxBytes = 5 * 1024 * 1024 } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'gate-test-'))
	let tick = 1000
	const clock = () => { tick += 1; return tick }
	const calls = { steer: [], followup: [] }
	const agent = {
		status: 'running',
		id: 'agent-gate-1',
		session: { id: 'agent-gate-1' },
		steer(message) { calls.steer.push(message) },
		followup(message) { calls.followup.push(message) },
	}
	const runtime = { sessionId: 'agent-gate-1', agent, pendingQuestion: () => pendingQuestion }
	const gate = createIngressGate({
		runtime,
		config: { mode, judge: { enabled: false, url: 'http://127.0.0.1:8098/v1', model: 'clef-flash', timeoutMs: 2500 } },
		dataDir: root,
		clock,
		logMaxBytes,
		logger: { debug() {}, warn() {}, error() {} },
	})
	runtime.gate = gate
	t.after(async () => {
		await gate.close()
		await rm(root, { recursive: true, force: true })
	})
	return { gate, agent, calls, root, clock, runtime }
}

test('urgency and explicit-command parsing are tiny and case-insensitive', () => {
	for (const text of ['actually use the other file', 'stop now', 'wait', 'do it now', 'use this instead', 'rather use X', 'please fix the test', 'Correct the output', 'revert that change']) {
		assert.equal(urgencyOf(text), true, text)
	}
	assert.equal(urgencyOf('add a short section'), false)
	assert.equal(urgencyOf('knowledge is power'), false)
	assert.deepEqual(explicitCommandOf('/steer use the blue button'), { command: 'steer', text: 'use the blue button' })
	assert.deepEqual(explicitCommandOf('/queue@my_bot later'), { command: 'queue', text: 'later' })
	assert.equal(explicitCommandOf('please /steer this'), null)
})

test('pending question wins over explicit and urgency and is delivered as answer context', async (t) => {
	const h = await harness(t, { pendingQuestion: true })
	const result = await h.gate.deliver(h.agent, '/steer actually answer this')
	assert.equal(result.choice, 'answer')
	assert.equal(result.path, 'pending-question')
	assert.equal(h.calls.steer.length, 1)
	assert.equal(h.calls.followup.length, 0)
	assert.equal(textOf(h.calls.steer[0]), 'actually answer this')
	await h.gate.flush()
	const line = JSON.parse((await readFile(join(h.root, 'decision-log.ndjson'), 'utf8')).trim())
	assert.equal(line.features.pendingQuestion, true)
	assert.equal(line.choice, 'answer')
})

test('busy default queues FIFO, drains at turn end through followup, never delays more than one turn', async (t) => {
	const h = await harness(t)
	const first = await h.gate.deliver(h.agent, 'first queued message')
	const second = await h.gate.deliver(h.agent, 'second queued message')
	assert.equal(first.choice, 'queue')
	assert.equal(second.queuedCount, 1)
	assert.equal(h.calls.steer.length, 0)
	assert.equal(h.calls.followup.length, 0)
	assert.equal(h.gate.pendingCount(), 2)
	const drained = h.gate.onTurnEnd(h.agent)
	assert.deepEqual(drained, 2)
	assert.deepEqual(h.calls.followup.map(textOf), ['first queued message', 'second queued message'])
	assert.equal(h.gate.pendingCount(), 0)
})

test('leading /steer and /queue are honored and stripped', async (t) => {
	const h = await harness(t)
	const steer = await h.gate.deliver(h.agent, '/steer actually change it now')
	assert.equal(steer.choice, 'steer')
	assert.equal(steer.path, 'explicit-steer')
	assert.equal(textOf(h.calls.steer[0]), 'actually change it now')
	const queued = await h.gate.deliver(h.agent, '/queue move this after')
	assert.equal(queued.choice, 'queue')
	assert.equal(queued.path, 'explicit-queue')
	assert.equal(h.gate.pendingCount(), 1)
})

test('urgency steers and ordinary busy work queues; idle follows up unchanged', async (t) => {
	const h = await harness(t)
	const urgent = await h.gate.deliver(h.agent, 'stop and use instead')
	assert.equal(urgent.choice, 'steer')
	assert.equal(urgent.path, 'urgent')
	const ordinary = await h.gate.deliver(h.agent, 'add a section')
	assert.equal(ordinary.choice, 'queue')
	assert.equal(ordinary.path, 'default-queue')
	h.agent.status = 'idle'
	const idle = await h.gate.deliver(h.agent, 'idle message')
	assert.equal(idle.path, 'idle-followup')
	assert.equal(h.calls.followup.length, 2, 'the queued message drains before the idle message')
	assert.equal(h.gate.pendingCount(), 0)
})

test('gate.mode off is legacy always-steer while busy and never queues', async (t) => {
	const h = await harness(t, { mode: 'off' })
	const result = await h.gate.deliver(h.agent, 'ordinary busy text')
	assert.equal(result.choice, 'steer')
	assert.equal(result.path, 'legacy')
	assert.equal(h.calls.steer.length, 1)
	assert.equal(h.gate.pendingCount(), 0)
})

test('every decision logs the exact bounded shape and no message body or secret', async (t) => {
	const h = await harness(t)
	const secret = 'token 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'
	await h.gate.deliver(h.agent, `actually ${secret}`)
	await h.gate.flush()
	const raw = await readFile(join(h.root, 'decision-log.ndjson'), 'utf8')
	assert.ok(!raw.includes(secret))
	assert.ok(!raw.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'))
	const line = JSON.parse(raw.trim())
	assert.deepEqual(Object.keys(line).sort(), ['choice', 'features', 'latencyMs', 'path', 'session', 'ts'])
	assert.deepEqual(Object.keys(line.features).sort(), ['explicit', 'msgLen', 'pendingQuestion', 'queuedCount', 'urgent'])
	assert.equal(line.session, 'agent-gate-1')
	assert.equal(line.choice, 'steer')
	assert.equal(line.path, 'urgent')
	assert.equal(line.features.urgent, true)
	assert.equal(line.features.explicit, null)
	assert.equal(line.features.msgLen, `actually ${secret}`.length)
	assert.equal(typeof line.latencyMs, 'number')
})

test('the decision log rotates at the configured byte cap while remaining append-only', async (t) => {
	const h = await harness(t, { logMaxBytes: 512 })
	for (let index = 0; index < 20; index += 1) await h.gate.deliver(h.agent, `ordinary ${index}`)
	await h.gate.flush()
	const current = await readFile(join(h.root, 'decision-log.ndjson'), 'utf8')
	const rotated = await readFile(join(h.root, 'decision-log.ndjson.1'), 'utf8').catch(() => '')
	assert.ok((current + rotated).length > 512)
	assert.ok((current + rotated).split('\n').filter(Boolean).length >= 20)
})

test('judge failure/low confidence falls back to rules and logs judge-fallback', async (t) => {
	const h = await harness(t, { mode: 'judge' })
	h.gate.judge.enabled = true
	h.gate.judge.classify = async () => ({ ok: false, reason: 'timeout' })
	const result = await h.gate.deliver(h.agent, 'ordinary busy text')
	assert.equal(result.choice, 'queue')
	assert.equal(result.path, 'judge-fallback')
})

test('judge typed answer without a pending question falls back; successful judge choice is used', async (t) => {
	const h = await harness(t, { mode: 'judge' })
	h.gate.judge.enabled = true
	h.gate.judge.classify = async () => ({ ok: true, choice: 'steer', confidence: 0.9, reason: 'correction' })
	const result = await h.gate.deliver(h.agent, 'ordinary busy text')
	assert.equal(result.choice, 'steer')
	assert.equal(result.path, 'judge')
	h.gate.judge.classify = async () => ({ ok: true, choice: 'answer', confidence: 0.9, reason: 'question' })
	const fallback = await h.gate.deliver(h.agent, 'ordinary busy text')
	assert.equal(fallback.choice, 'queue')
	assert.equal(fallback.path, 'judge-fallback')
})


test('settings expose rules as the default gate and disabled judge plumbing', () => {
	const settings = __internals.settingsOf({})
	assert.deepEqual(settings.gate, {
		mode: 'rules',
		judge: { enabled: false, url: 'http://127.0.0.1:8098/v1', model: 'clef-flash', timeoutMs: 2500 },
	})
	const judge = __internals.gateOf({ mode: 'judge', judge: { enabled: true, timeoutMs: 50 } })
	assert.equal(judge.mode, 'judge')
	assert.equal(judge.judge.enabled, true)
	assert.equal(judge.judge.timeoutMs, 50)
})

test('the Agent turn/end handler drains the gate queue through the production event path', async (t) => {
	const h = await harness(t)
	await h.gate.deliver(h.agent, 'queued before end')
	assert.equal(h.calls.followup.length, 0)
	assert.equal(__internals.handleAgentTurnEnd(h.runtime, { id: 'other' }, { type: 'turn/end' }), 0)
	assert.equal(__internals.handleAgentTurnEnd(h.runtime, h.agent.session, { type: 'turn/end' }), 1)
	assert.deepEqual(h.calls.followup.map(textOf), ['queued before end'])
})

test('a queued message drains on the Agent idle event even without a second turn/end', async (t) => {
	const h = await harness(t)
	await h.gate.deliver(h.agent, 'queued at final phase')
	assert.equal(h.calls.followup.length, 0)
	assert.equal(__internals.handleAgentStatus(h.runtime, { agent: h.agent, status: 'idle' }), 1)
	assert.deepEqual(h.calls.followup.map(textOf), ['queued at final phase'])
	assert.equal(h.gate.pendingCount(), 0)
	await h.gate.flush()
	const lines = (await readFile(join(h.root, 'decision-log.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse)
	assert.equal(lines.length, 2)
	assert.equal(lines[0].path, 'default-queue')
	assert.equal(lines[1].drained, true)
	assert.equal(typeof lines[1].drainedAt, 'string')
	assert.equal(lines[1].choice, 'queue')
})

test('a queue created after a final turn/end but before idle still delivers', async (t) => {
	const h = await harness(t)
	await h.gate.deliver(h.agent, 'queued during finalization')
	assert.equal(h.gate.pendingCount(), 1)
	h.agent.status = 'idle'
	__internals.handleAgentStatus(h.runtime, { agent: h.agent, status: 'idle' })
	assert.deepEqual(h.calls.followup.map(textOf), ['queued during finalization'])
	// A later turn/end drain is idempotent for the same episode.
	assert.equal(__internals.handleAgentTurnEnd(h.runtime, h.agent.session, { type: 'turn/end' }), 0)
})

test('stop with keepInbox leaves a queued message deliverable on idle', async (t) => {
	const h = await harness(t)
	const stops = []
	h.agent.cancel = (...args) => stops.push(args)
	await h.gate.deliver(h.agent, 'queued before cancellation')
	h.agent.cancel({ kind: 'user' }, { keepInbox: true })
	h.agent.status = 'idle'
	__internals.handleAgentStatus(h.runtime, { agent: h.agent, status: 'idle' })
	assert.deepEqual(stops, [[{ kind: 'user' }, { keepInbox: true }]])
	assert.deepEqual(h.calls.followup.map(textOf), ['queued before cancellation'])
})
