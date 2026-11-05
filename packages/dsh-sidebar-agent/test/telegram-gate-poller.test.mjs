import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTelegramHost } from '../telegram-host.js'
import { __internals } from '../index.js'
import { createIngressGate } from '../ingress-gate.js'
import { FakeBotApi } from '../../dsh-telegram-session-bridge/test/helpers/fake-bot-api.js'
import { createBridge } from '../../dsh-telegram-session-bridge/src/bridge.js'
import { dmKey } from '../../dsh-telegram-session-bridge/src/state.js'

const AGENT = 'agent-gate-poller-1'
const DM = dmKey({ botId: 777, chatId: 42, senderId: 42 })
const silent = { debug() {}, info() {}, warn() {}, error() {} }

async function harness(t, mode) {
	const root = await mkdtemp(join(tmpdir(), 'gate-poller-'))
	const fake = await new FakeBotApi({ token: '777:gate-poll-token' }).start()
	const calls = { steer: [], followup: [] }
	const agent = {
		status: 'running',
		id: AGENT,
		session: { id: AGENT },
		steer(message) { calls.steer.push(message) },
		followup(message) { calls.followup.push(message) },
		cancel(...args) { calls.cancel = args },
	}
	const runtime = { sessionId: AGENT, agent, pendingQuestion: () => false }
	runtime.gate = createIngressGate({
		runtime,
		config: { mode, judge: { enabled: false } },
		dataDir: root,
		logger: silent,
	})
	const glue = createTelegramHost({
		runtime,
		config: { enabled: true, tokenRef: 'T', allowedChatIds: [42], dshHome: root, poll: false, baseUrl: fake.baseUrl },
		env: { T: '777:gate-poll-token' },
		forward: () => ({}),
		importBridge: async () => ({ createBridge }),
		install: () => () => {},
		logger: silent,
		clock: () => 1_700_000_000_000,
	})
	t.after(async () => {
		await glue.stop().catch(() => {})
		await fake.stop().catch(() => {})
		await runtime.gate.close()
		await rm(root, { recursive: true, force: true })
	})
	await glue.start()
	await glue.bridge.store.setDm({ key: DM, sessionId: AGENT, mode: 'created' })
	return { fake, glue, calls, runtime, agent, root }
}

function update(id, text) {
	return { update_id: id, message: { message_id: 100 + id, chat: { id: 42, type: 'private' }, from: { id: 42 }, text } }
}

function textOf(message) {
	return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

test('production poller: rules /steer steers and /queue queues through the glue interception', async (t) => {
	const h = await harness(t, 'rules')
	h.fake.pushUpdate(update(1, '/steer hello'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.calls.steer.length, 1)
	assert.equal(textOf(h.calls.steer[0]), 'hello')
	assert.equal(h.fake.messages.length, 0, 'no bridge unknown-command reply')
	assert.equal(h.fake.reactions.length, 1)
	assert.deepEqual(h.fake.reactions[0].reaction, [{ type: 'emoji', emoji: '🔀' }])

	h.fake.pushUpdate(update(2, '/queue later'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.calls.steer.length, 1)
	assert.equal(h.calls.followup.length, 0)
	assert.equal(h.runtime.gate.pendingCount(), 1)
	assert.equal(h.fake.messages.length, 0)
	assert.deepEqual(h.fake.reactions.at(-1).reaction, [{ type: 'emoji', emoji: '🔀' }])
})

test('production poller: gate off leaves /steer and /queue to legacy bridge unknown-command handling', async (t) => {
	const h = await harness(t, 'off')
	h.fake.pushUpdate(update(3, '/steer hello'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.calls.steer.length, 0)
	assert.match(h.fake.messages.at(-1).text, /Unknown command/)

	h.fake.pushUpdate(update(4, '/queue later'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.runtime.gate.pendingCount(), 0)
	assert.equal(h.calls.followup.length, 0)
	assert.equal(h.fake.messages.filter((message) => /Unknown command/.test(message.text)).length, 2)
})

test('production poller: normal mid-turn queue/steer get one gate emoji, idle gets none, failure swallowed', async (t) => {
	const h = await harness(t, 'rules')
	const before = h.fake.reactions.length
	h.fake.pushUpdate(update(5, 'add a section'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.fake.reactions.length, before + 1)
	assert.deepEqual(h.fake.reactions.at(-1).reaction, [{ type: 'emoji', emoji: '⏳' }])
	assert.equal(h.runtime.gate.pendingCount(), 1)

	h.fake.pushUpdate(update(6, 'stop now'))
	await h.glue.bridge.pollOnce()
	assert.deepEqual(h.fake.reactions.at(-1).reaction, [{ type: 'emoji', emoji: '🔀' }])
	assert.equal(h.calls.steer.length, 1)

	h.agent.status = 'idle'
	h.fake.pushUpdate(update(7, 'idle note'))
	await h.glue.bridge.pollOnce()
	assert.deepEqual(h.fake.reactions.at(-1).reaction, [{ type: 'emoji', emoji: '👀' }])

	h.agent.status = 'running'
	h.fake.failReactions = 1
	h.fake.pushUpdate(update(8, 'stop again'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.fake.failedReactions.length, 1)
})


test('production poller: message queued after final turn/end drains on idle and logs drainedAt', async (t) => {
	const h = await harness(t, 'rules')
	assert.equal(__internals.handleAgentTurnEnd(h.runtime, h.agent.session, { type: 'turn/end' }), 0)
	h.fake.pushUpdate(update(20, 'you have a 7900XT as well'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.runtime.gate.pendingCount(), 1)
	assert.equal(h.calls.followup.length, 0)
	await h.runtime.gate.flush()
	const before = await readFile(join(h.root, 'decision-log.ndjson'), 'utf8')
	assert.match(before, /"choice":"queue"/)
	assert.match(before, /"path":"default-queue"/)

	h.agent.status = 'idle'
	assert.equal(__internals.handleAgentStatus(h.runtime, { agent: h.agent, status: 'idle' }), 1)
	assert.deepEqual(h.calls.followup.map(textOf), ['you have a 7900XT as well'])
	assert.equal(__internals.handleAgentTurnEnd(h.runtime, h.agent.session, { type: 'turn/end' }), 0)
	assert.equal(__internals.handleAgentStatus(h.runtime, { agent: h.agent, status: 'idle' }), 0)
	assert.equal(h.calls.followup.length, 1)
	await h.runtime.gate.flush()
	const lines = (await readFile(join(h.root, 'decision-log.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse)
	const marker = lines.find((line) => line.drained === true)
	assert.ok(marker)
	assert.equal(typeof marker.drainedAt, 'string')
	assert.equal(marker.choice, 'queue')
	assert.ok(!JSON.stringify(marker).includes('7900XT'))
})

test('production poller: queue with no turn/end drains on idle alone', async (t) => {
	const h = await harness(t, 'rules')
	h.fake.pushUpdate(update(21, 'queued with no turn end'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.runtime.gate.pendingCount(), 1)
	h.agent.status = 'idle'
	assert.equal(__internals.handleAgentStatus(h.runtime, { agent: h.agent, status: 'idle' }), 1)
	assert.deepEqual(h.calls.followup.map(textOf), ['queued with no turn end'])
})

test('production poller: keepInbox stop preserves and drains the queue on idle', async (t) => {
	const h = await harness(t, 'rules')
	h.fake.pushUpdate(update(22, 'queued before cancellation'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.runtime.gate.pendingCount(), 1)
	h.agent.cancel({ kind: 'user' }, { keepInbox: true })
	h.agent.status = 'idle'
	assert.equal(__internals.handleAgentStatus(h.runtime, { agent: h.agent, status: 'idle' }), 1)
	assert.deepEqual(h.calls.followup.map(textOf), ['queued before cancellation'])
	assert.deepEqual(h.calls.cancel, [{ kind: 'user' }, { keepInbox: true }])
})
