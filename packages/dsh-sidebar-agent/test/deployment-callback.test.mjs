import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CALLBACK_MARKER, formatDeploymentCallback as formatDeploymentCallbackWithMeta } from '../deployment-callback.js'

const stripMachine = (text) => text.replace(/\n<!--meta:[\s\S]*-->$/, '')
const formatDeploymentCallback = (input) => stripMachine(formatDeploymentCallbackWithMeta(input))

const fields = {
	what: 'rich /status',
	state: 'LIVE',
	changed: 'packages/dsh-mov-agent, packages/dsh-telegram-session-bridge',
	verified: 'sidebar 116 passed; bridge 94 passed; live readback 200,631 / 1,048,576 (19%)',
	stateLine: 'agent-1f1b4db7… / sparks/GLM-5.3-Flash-EXL3 / #5822509701 / one poller',
	live: 'Context 200,631 / 1,048,576 (19%); 0 delegations; idle',
	gaps: 'none',
}

test('LIVE callback snapshot is the deterministic bounded template', () => {
	assert.equal(formatDeploymentCallback(fields), [
		'rich /status: LIVE',
		'Changed: packages/dsh-mov-agent, packages/dsh-telegram-session-bridge',
		'Verified: sidebar 116 passed; bridge 94 passed; live readback 200,631 / 1,048,576 (19%)',
		'State: agent-1f1b4db7… / sparks/GLM-5.3-Flash-EXL3 / #5822509701 / one poller',
		'Live: Context 200,631 / 1,048,576 (19%); 0 delegations; idle',
		'Gaps: none',
		`Automated: ${'deployment callback'}`,
	].join('\n'))
})

test('HOLDING and BLOCKED use Holding and keep at most eight lines', () => {
	const holding = formatDeploymentCallback({ what: 'callback formatter', state: 'holding', changed: 'packages/dsh-mov-agent', holding: 'awaiting reviewer release' })
	assert.equal(holding, [
		'callback formatter: HOLDING',
		'Changed: packages/dsh-mov-agent',
		'Holding: awaiting reviewer release',
		CALLBACK_MARKER,
	].join('\n'))
	const blocked = formatDeploymentCallback({ what: 'callback formatter', state: 'BLOCKED', holding: 'review correction required' })
	assert.match(blocked, /^callback formatter: BLOCKED$/m)
	assert.match(blocked, /^Holding: review correction required$/m)
	for (const value of [holding, blocked]) assert.ok(value.split('\n').length <= 8)
})

test('empty or missing optional keys are omitted, not emitted blank', () => {
	assert.equal(formatDeploymentCallback({ what: 'deploy', state: 'LIVE' }), [
		'deploy: LIVE',
		CALLBACK_MARKER,
	].join('\n'))
	assert.equal(formatDeploymentCallback({ what: 'deploy', state: 'LIVE', changed: '  ', verified: '', stateLine: null, live: '', gaps: '' }), [
		'deploy: LIVE',
		CALLBACK_MARKER,
	].join('\n'))
})

test('long values are truncated on one line without losing the label', () => {
	const long = 'x'.repeat(500)
	const text = formatDeploymentCallback({ what: 'deploy', state: 'LIVE', changed: long, verified: 'ok' })
	const lines = text.split('\n')
	const changed = lines.find((line) => line.startsWith('Changed: '))
	assert.ok(changed)
	assert.ok(changed.length < long.length)
	assert.ok(changed.endsWith('…'))
	assert.equal(lines.length, 4)
	assert.ok(lines.every((line) => line.length <= 220))
})

test('newlines in values are flattened and cannot add callback lines', () => {
	const text = formatDeploymentCallback({ what: 'deploy\nnow', state: 'LIVE', changed: 'one\ntwo\r\nthree', live: 'a\nb' })
	assert.equal(text, [
		'deploy now: LIVE',
		'Changed: one two three',
		'Live: a b',
		CALLBACK_MARKER,
	].join('\n'))
	assert.equal(text.split('\n').length, 4)
})

test('malformed fields fail closed to a minimal safe form without echoing input', () => {
	const cases = [undefined, null, 'not-an-object', {}, { what: 'x', state: 'DONE', token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }]
	for (const value of cases) {
		const text = formatDeploymentCallback(value)
		assert.equal(text, [
			'Deployment callback: BLOCKED',
			'Holding: malformed callback fields',
			CALLBACK_MARKER,
		].join('\n'))
		assert.ok(!text.includes('not-an-object'))
		assert.ok(!text.includes('123456'))
		assert.ok(!text.includes('token'))
	}
})

test('token and API-key shaped values are redacted and never emitted', () => {
	const telegram = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'
	const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz'
	const text = formatDeploymentCallback({ what: 'deploy', state: 'LIVE', changed: `token ${telegram}`, live: `key ${apiKey}` })
	assert.ok(!text.includes(telegram))
	assert.ok(!text.includes(apiKey))
	assert.match(text, /\[redacted\]/)
})

test('the marker is always present and output never exceeds eight lines', () => {
	const values = [
		fields,
		{ what: 'a\nb\nc', state: 'LIVE', changed: 'x'.repeat(400), verified: 'y'.repeat(400), stateLine: 'z'.repeat(400), live: 'q'.repeat(400), gaps: 'g'.repeat(400) },
		{ what: 'deploy', state: 'BLOCKED', holding: 'h'.repeat(400) },
	]
	for (const value of values) {
		const text = formatDeploymentCallback(value)
		assert.ok(text.endsWith(CALLBACK_MARKER))
		assert.ok(text.split('\n').length <= 8)
	}
})


test('callback appends a parseable final machine-meta line', () => {
	const text = formatDeploymentCallbackWithMeta({ what: 'deploy', state: 'LIVE', changed: 'a', verified: 'b', live: 'c' })
	const line = text.split('\n').at(-1)
	assert.match(line, /^<!--meta:.*-->$/)
	const meta = JSON.parse(line.slice('<!--meta:'.length, -3))
	assert.equal(meta.kind, 'deployment')
	assert.equal(meta.title, 'deploy')
	assert.equal(meta.state, 'LIVE')
	assert.equal(meta.changed, 'a')
	assert.equal(meta.verified, 'b')
	assert.equal(meta.live, 'c')
})
