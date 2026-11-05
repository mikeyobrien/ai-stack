import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { test } from 'node:test'
import { agentService } from '../index.js'

function harness({ status = 'running', gate = null } = {}) {
	const calls = { followup: [], steer: [] }
	const agent = {
		status,
		session: { id: 'agent-chat-1' },
		followup(message) { calls.followup.push(message) },
		steer(message) { calls.steer.push(message) },
	}
	const runtime = { host: {}, agent, sessionId: 'agent-chat-1', gate, pendingQuestion: () => false }
	const Service = agentService(runtime)
	return { service: new Service(new Context()), calls, runtime }
}

function textOf(message) {
	return message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

test('GUI chat text shares the gate and queues mid-turn', async () => {
	const delivered = []
	const gate = {
		async deliver(agent, text) {
			delivered.push({ text, running: agent.status })
			return { messageId: 'm-1', running: true, queued: true, choice: 'queue', path: 'default-queue' }
		},
	}
	const h = harness({ gate })
	const result = await h.service.chat({ text: 'ordinary mid-turn message' })
	assert.equal(result.queued, true)
	assert.deepEqual(delivered, [{ text: 'ordinary mid-turn message', running: 'running' }])
	assert.equal(h.calls.steer.length, 0)
	assert.equal(h.calls.followup.length, 0)
})

test('deploymentCallback bypasses the gate and still uses the owner chat path', async () => {
	let gateCalls = 0
	const gate = { async deliver() { gateCalls += 1; throw new Error('gate must be bypassed') } }
	const h = harness({ status: 'idle', gate })
	const result = await h.service.deploymentCallback({ fields: { what: 'deploy', state: 'LIVE' } })
	assert.equal(gateCalls, 0)
	assert.equal(h.calls.followup.length, 1)
	assert.match(textOf(h.calls.followup[0]), /^deploy: LIVE/m)
})

test('files bypass the text gate and keep the legacy chat path', async () => {
	let gateCalls = 0
	const gate = { async deliver() { gateCalls += 1; return { messageId: 'm' } } }
	const h = harness({ gate })
	h.runtime.host = { attachments: { async saveFile() { return { attachment: 'a' } } } }
	const result = await h.service.chat({ text: 'file message', files: [{ data: Buffer.from('x').toString('base64'), name: 'x.txt', mediaType: 'text/plain' }] })
	assert.equal(gateCalls, 0)
	assert.equal(h.calls.steer.length, 1)
	assert.equal(result.messageId.length > 0, true)
})
