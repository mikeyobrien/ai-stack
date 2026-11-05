import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentService } from '../index.js'
import { CALLBACK_MARKER, formatDeploymentCallback } from '../deployment-callback.js'

const fields = {
	what: 'callback formatter',
	state: 'LIVE',
	changed: 'packages/dsh-sidebar-agent',
	verified: 'sidebar 116 passed; bridge 94 passed',
	stateLine: 'agent-status-1 / p/m / #5822509701 / one poller',
	live: 'formatter live; no Telegram send',
	gaps: 'real Telegram render unobserved',
}

function harness({ status = 'idle' } = {}) {
	const calls = { followup: [], steer: [], cancel: 0 }
	const agent = {
		status,
		followup(message) { calls.followup.push(message) },
		steer(message) { calls.steer.push(message) },
		cancel() { calls.cancel += 1 },
	}
	const runtime = { host: {}, agent, statusControl: null, telegram: null, modelControl: null, sessionId: 'agent-status-1' }
	const Service = agentService(runtime)
	const service = new Service(new Context())
	return { service, calls }
}

test('deploymentCallback sends the exact rendered template through the owner chat channel', async () => {
	const { service, calls } = harness()
	const result = await service.deploymentCallback({ fields })
	assert.equal(result.automated, true)
	assert.equal(result.running, false)
	assert.equal(result.text, formatDeploymentCallback(fields))
	assert.equal(result.lines, result.text.split('\n').length)
	assert.equal(calls.followup.length, 1)
	assert.equal(calls.steer.length, 0)
	const message = calls.followup[0]
	const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
	assert.equal(text, result.text)
	assert.ok(text.includes(`\n${CALLBACK_MARKER}\n<!--meta:`))
	assert.match(text.split('\n').at(-1), /^<!--meta:.*-->$/)
	assert.ok(!text.includes('123456:'))
})

test('deploymentCallback steers a running Agent and never cancels or prompts through Telegram', async () => {
	const { service, calls } = harness({ status: 'running' })
	const fieldsWithSecret = { ...fields, changed: 'token 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }
	const result = await service.deploymentCallback({ fields: fieldsWithSecret })
	assert.equal(result.running, true)
	assert.equal(calls.steer.length, 1)
	assert.equal(calls.followup.length, 0)
	assert.equal(calls.cancel, 0)
	assert.ok(!result.text.includes('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'))
	assert.match(result.text, /\[redacted\]/)
	assert.ok(result.text.split('\n').filter((line) => !line.startsWith('<!--meta:')).length <= 8)
})

test('malformed fields still send only the minimal safe form', async () => {
	const { service, calls } = harness()
	const result = await service.deploymentCallback({ fields: { what: 'x', state: 'DONE', token: 'secret' } })
	assert.equal(result.text, [
		'Deployment callback: BLOCKED',
		'Holding: malformed callback fields',
		CALLBACK_MARKER,
	].join('\n'))
	assert.equal(calls.followup.length, 1)
	assert.ok(!result.text.includes('secret'))
})

test('direct fields and the fields wrapper render identically through the sender', async () => {
	const direct = harness()
	const wrapped = harness()
	const first = await direct.service.deploymentCallback(fields)
	const second = await wrapped.service.deploymentCallback({ fields })
	assert.equal(first.text, second.text)
	assert.equal(first.text, formatDeploymentCallback(fields))
})
