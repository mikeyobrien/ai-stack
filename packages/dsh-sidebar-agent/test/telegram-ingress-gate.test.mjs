import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAgentOwnerController } from '../telegram-host.js'
import { createIngressGate } from '../ingress-gate.js'

function textOf(message) {
	return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

async function harness(t, mode = 'rules') {
	const root = await mkdtemp(join(tmpdir(), 'owner-gate-'))
	const calls = { steer: [], followup: [] }
	const agent = {
		status: 'running',
		session: { id: 'agent-owner-1' },
		steer(message) { calls.steer.push(message) },
		followup(message) { calls.followup.push(message) },
	}
	const runtime = { sessionId: 'agent-owner-1', agent, pendingQuestion: () => false }
	runtime.gate = createIngressGate({
		runtime,
		config: { mode, judge: { enabled: false, url: 'http://127.0.0.1:8098/v1', model: 'clef-flash', timeoutMs: 2500 } },
		dataDir: root,
		logger: { debug() {}, warn() {}, error() {} },
	})
	const controller = createAgentOwnerController({ runtime, forward: () => { throw new Error('forward must not be called') } })
	t.after(async () => {
		await runtime.gate.close()
		await rm(root, { recursive: true, force: true })
	})
	return { controller, runtime, agent, calls }
}

const content = (text) => ({ sessionId: 'agent-owner-1', requestId: `r-${text}`, content: [{ type: 'text', text }] })

test('owner controller queues an ordinary Telegram prompt mid-turn and drains it at turn end', async (t) => {
	const h = await harness(t)
	const result = await h.controller.prompt(content('ordinary mid-turn message'))
	assert.equal(result.queued, true)
	assert.equal(h.calls.steer.length, 0)
	assert.equal(h.calls.followup.length, 0)
	assert.equal(h.runtime.gate.pendingCount(), 1)
	h.runtime.gate.onTurnEnd(h.agent)
	assert.deepEqual(h.calls.followup.map(textOf), ['ordinary mid-turn message'])
})

test('owner controller steers urgent/explicit text and follows up when idle', async (t) => {
	const h = await harness(t)
	await h.controller.prompt(content('stop now'))
	assert.equal(h.calls.steer.length, 1)
	h.agent.status = 'idle'
	await h.controller.prompt(content('ordinary idle message'))
	assert.equal(h.calls.followup.length, 1)
	assert.equal(textOf(h.calls.followup[0]), 'ordinary idle message')
})

test('owner controller kill switch restores legacy always-steer', async (t) => {
	const h = await harness(t, 'off')
	const result = await h.controller.prompt(content('ordinary mid-turn message'))
	assert.equal(result.choice, 'steer')
	assert.equal(h.calls.steer.length, 1)
	assert.equal(h.runtime.gate.pendingCount(), 0)
})

test('request idempotency still applies through the gate', async (t) => {
	const h = await harness(t)
	const request = content('queued once')
	const first = await h.controller.prompt(request)
	const second = await h.controller.prompt(request)
	assert.equal(second.messageId, first.messageId)
	assert.equal(h.runtime.gate.pendingCount(), 1)
})
