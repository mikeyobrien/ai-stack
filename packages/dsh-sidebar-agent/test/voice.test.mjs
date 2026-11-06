import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { handleVoiceUpdate, MAX_VOICE_BYTES, transcribeVoice } from '../voice.js'

function fakeBridge({ bytes = new Uint8Array([1, 2, 3]), fileSize = 3 } = {}) {
	const sent = []
	return {
		sent,
		api: {
			async getFile() { return { file_path: 'voice/file.ogg', file_size: fileSize } },
			async downloadFile() { return { bytes } },
			async sendMessage(request) { sent.push(request) },
		},
	}
}

async function fakeStt(handler) {
	const server = createServer((request, response) => handler(request, response))
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	return { url: `http://127.0.0.1:${address.port}/v1/audio/transcriptions`, close: () => new Promise((resolve) => server.close(resolve)) }
}

function voiceMessage(extra = {}) {
	return { message_id: 1, chat: { id: 42 }, voice: { file_id: 'file-1', file_size: 3, mime_type: 'audio/ogg' }, ...extra }
}

test('voice note posts multipart to Parakeet and injects the transcript through the owner prompt', async () => {
	let received = ''
	const stt = await fakeStt((request, response) => {
		const chunks = []
		request.on('data', (chunk) => chunks.push(chunk))
		request.on('end', () => {
			received = Buffer.concat(chunks).toString('latin1')
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ text: 'hello from voice' }))
		})
	})
	const bridge = fakeBridge()
	const prompts = []
	const logs = []
	const ownerController = { prompt: async (request) => { prompts.push(request); return { messageId: 'm1' } } }
	try {
		const result = await handleVoiceUpdate({ message: voiceMessage(), sessionId: 'agent-1', bridge, ownerController, stt: { enabled: true, url: stt.url, model: 'nvidia/parakeet-tdt-0.6b-v3', timeoutMs: 500 }, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } })
		assert.equal(result.handled, true)
		assert.equal(result.prompted, true)
		assert.equal(prompts.length, 1)
		assert.equal(prompts[0].sessionId, 'agent-1')
		assert.equal(prompts[0].content[0].text, '🎤 hello from voice')
		assert.equal(prompts[0].content[0].text.split('🎤').length - 1, 1, 'exactly one marker')
		assert.equal(prompts[0].content[0].text.replace('🎤 ', ''), 'hello from voice', 'body intact')
		assert.match(received, /nvidia\/parakeet-tdt-0\.6b-v3/)
		assert.match(received, /voice\.ogg/)
		assert.ok(logs.some((line) => line.includes('path=voice')))
		assert.equal(bridge.sent.length, 0)
	} finally { await stt.close() }
})

test('STT 5xx returns one sanitized retry reply and never loses the message silently', async () => {
	const stt = await fakeStt((_request, response) => { response.writeHead(503); response.end('down') })
	const bridge = fakeBridge()
	const prompts = []
	const logs = []
	try {
		const result = await handleVoiceUpdate({ message: voiceMessage(), sessionId: 'agent-1', bridge, ownerController: { prompt: async (r) => prompts.push(r) }, stt: { enabled: true, url: stt.url, model: 'm', timeoutMs: 500 }, logger: { info: () => {}, warn: (m) => logs.push(m) } })
		assert.equal(result.reason, 'voice-error')
		assert.equal(prompts.length, 0)
		assert.equal(bridge.sent.length, 1)
		assert.match(bridge.sent[0].text, /could not transcribe|try again/i)
		assert.ok(logs.some((line) => line.includes('path=voice-error')))
	} finally { await stt.close() }
})

test('STT timeout returns one reply and logs voice-error', async () => {
	const stt = await fakeStt(() => { /* never respond */ })
	const bridge = fakeBridge()
	const logs = []
	try {
		const result = await handleVoiceUpdate({ message: voiceMessage(), sessionId: 'agent-1', bridge, ownerController: { prompt: async () => {} }, stt: { enabled: true, url: stt.url, model: 'm', timeoutMs: 25 }, logger: { info: () => {}, warn: (m) => logs.push(m) } })
		assert.equal(result.reason, 'voice-error')
		assert.equal(bridge.sent.length, 1)
		assert.ok(logs.some((line) => line.includes('path=voice-error')))
	} finally { await stt.close() }
})

test('empty transcript is a voice-error, not a silent empty prompt', async () => {
	const stt = await fakeStt((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"text":"  "}') })
	const bridge = fakeBridge()
	const prompts = []
	try {
		const result = await handleVoiceUpdate({ message: voiceMessage(), sessionId: 'agent-1', bridge, ownerController: { prompt: async (r) => prompts.push(r) }, stt: { enabled: true, url: stt.url, model: 'm', timeoutMs: 500 }, logger: { info: () => {}, warn: () => {} } })
		assert.equal(result.reason, 'voice-error')
		assert.equal(prompts.length, 0)
		assert.equal(bridge.sent.length, 1)
	} finally { await stt.close() }
})

test('a voice file over 20 MB gets a polite reply before any download', async () => {
	const bridge = fakeBridge({ fileSize: MAX_VOICE_BYTES + 1 })
	const downloads = []
	bridge.api.downloadFile = async () => { downloads.push(true); return { bytes: new Uint8Array() } }
	const result = await handleVoiceUpdate({ message: voiceMessage({ voice: { file_id: 'big', file_size: MAX_VOICE_BYTES + 1, mime_type: 'audio/ogg' } }), sessionId: 'agent-1', bridge, ownerController: { prompt: async () => {} }, stt: { enabled: true, url: 'http://127.0.0.1:1', model: 'm', timeoutMs: 25 }, logger: { info: () => {}, warn: () => {} } })
	assert.equal(result.reason, 'voice-too-large')
	assert.equal(downloads.length, 0)
	assert.equal(bridge.sent.length, 1)
	assert.match(bridge.sent[0].text, /larger than 20 MB/i)
})

test('an audio document follows the same path', async () => {
	const stt = await fakeStt((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"text":"document audio"}') })
	const bridge = fakeBridge()
	const prompts = []
	try {
		const message = { message_id: 2, chat: { id: 42 }, document: { file_id: 'doc-1', file_name: 'note.ogg', mime_type: 'audio/ogg', file_size: 3 } }
		const result = await handleVoiceUpdate({ message, sessionId: 'agent-1', bridge, ownerController: { prompt: async (r) => prompts.push(r) }, stt: { enabled: true, url: stt.url, model: 'm', timeoutMs: 500 }, logger: { info: () => {}, warn: () => {} } })
		assert.equal(result.prompted, true)
		assert.equal(prompts[0].content[0].text, '🎤 document audio')
	} finally { await stt.close() }
})


test('the voice transcript is the exact text handed to the owner gate/prompt seam', async () => {
	const stt = await fakeStt((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"text":"gate path transcript"}') })
	const bridge = fakeBridge()
	const seen = []
	try {
		await handleVoiceUpdate({ message: voiceMessage(), sessionId: 'agent-1', bridge, ownerController: { prompt: async (request) => { seen.push(request); return { messageId: 'm' } } }, stt: { enabled: true, url: stt.url, model: 'm', timeoutMs: 500 }, logger: { info: () => {}, warn: () => {} } })
		assert.equal(seen.length, 1)
		assert.equal(seen[0].sessionId, 'agent-1')
		assert.deepEqual(seen[0].content, [{ type: 'text', text: '🎤 gate path transcript' }])
		assert.match(seen[0].requestId, /^tg-voice:/)
	} finally { await stt.close() }
})
