import assert from 'node:assert/strict'
import { test } from 'node:test'

test('the package exposes the public bridge factory subpath', async () => {
	const module = await import('dsh-telegram-session-bridge/bridge')
	assert.equal(typeof module.createBridge, 'function')
})
