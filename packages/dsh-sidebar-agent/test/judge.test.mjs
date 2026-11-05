import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createJudge } from '../judge.js'

function serverFor(handler) {
	return new Promise((resolve) => {
		const server = createServer(handler)
		server.listen(0, '127.0.0.1', () => resolve(server))
	})
}

function endpoint(server) {
	return `http://127.0.0.1:${server.address().port}/v1`
}

function completion(body, status = 200) {
	return (request, response) => {
		let raw = ''
		request.on('data', (chunk) => { raw += chunk })
		request.on('end', () => {
			request.captured = raw
			response.writeHead(status, { 'content-type': 'application/json' })
			response.end(typeof body === 'string' ? body : JSON.stringify(body))
		})
	}
}

test('judge success sends the same message/features snapshot to the configured local chat endpoint', async (t) => {
	let captured
	const server = await serverFor((request, response) => {
		let raw = ''
		request.on('data', (chunk) => { raw += chunk })
		request.on('end', () => {
			captured = { url: request.url, body: JSON.parse(raw) }
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ choice: 'queue', confidence: 0.82, reason: 'new work' }) } }] }))
		})
	})
	t.after(() => server.close())
	const judge = createJudge({
		config: { enabled: true, url: endpoint(server), model: 'clef-flash', timeoutMs: 500 },
	})
	const result = await judge.classify({
		text: 'move this after the current task',
		features: { pendingQuestion: false, urgent: false, explicit: null, queuedCount: 0, msgLen: 31 },
	})
	assert.equal(result.ok, true)
	assert.equal(result.choice, 'queue')
	assert.equal(result.confidence, 0.82)
	assert.equal(captured.url, '/v1/chat/completions')
	assert.equal(captured.body.model, 'clef-flash')
	assert.match(JSON.stringify(captured.body), /move this after the current task/)
	assert.match(JSON.stringify(captured.body), /pendingQuestion/)
})

test('judge timeout falls back without throwing', async (t) => {
	const server = await serverFor((_request, _response) => {})
	t.after(() => server.close())
	const judge = createJudge({
		config: { enabled: true, url: endpoint(server), model: 'clef-flash', timeoutMs: 50 },
	})
	const result = await judge.classify({ text: 'ordinary', features: {} })
	assert.equal(result.ok, false)
	assert.equal(result.reason, 'timeout')
})

test('judge malformed response and invalid typed values fall back', async (t) => {
	for (const body of ['not json', JSON.stringify({ choices: [{ message: { content: '{bad' } }] }), JSON.stringify({ choices: [] })]) {
		const server = await serverFor(completion(body))
		t.after(() => server.close())
		const judge = createJudge({ config: { enabled: true, url: endpoint(server), model: 'clef-flash', timeoutMs: 500 } })
		const result = await judge.classify({ text: 'x', features: {} })
		assert.equal(result.ok, false)
		assert.equal(result.reason, 'malformed')
	}
	const server = await serverFor(completion({ choices: [{ message: { content: JSON.stringify({ choice: 'explode', confidence: 0.9, reason: 'x' }) } }] }))
	t.after(() => server.close())
	const judge = createJudge({ config: { enabled: true, url: endpoint(server), model: 'clef-flash', timeoutMs: 500 } })
	assert.equal((await judge.classify({ text: 'x', features: {} })).ok, false)
})

test('judge confidence below 0.6 falls back', async (t) => {
	const server = await serverFor(completion({ choices: [{ message: { content: JSON.stringify({ choice: 'steer', confidence: 0.59, reason: 'unsure' }) } }] }))
	t.after(() => server.close())
	const judge = createJudge({ config: { enabled: true, url: endpoint(server), model: 'clef-flash', timeoutMs: 500 } })
	const result = await judge.classify({ text: 'x', features: {} })
	assert.equal(result.ok, false)
	assert.equal(result.reason, 'low-confidence')
})

test('judge disabled makes no request; non-local endpoint is refused', async (t) => {
	let requests = 0
	const server = await serverFor(completion({ choices: [{ message: { content: '{}' } }] }))
	server.on('request', () => { requests += 1 })
	t.after(() => server.close())
	const disabled = createJudge({ config: { enabled: false, url: endpoint(server), model: 'clef-flash', timeoutMs: 500 } })
	assert.equal(await disabled.classify({ text: 'x', features: {} }), null)
	assert.equal(requests, 0)
	const remote = createJudge({ config: { enabled: true, url: 'http://example.com/v1', model: 'clef-flash', timeoutMs: 500 } })
	const result = await remote.classify({ text: 'x', features: {} })
	assert.equal(result.ok, false)
	assert.equal(result.reason, 'non-local')
	assert.equal(requests, 0)
})

test('a /v1/systemone Clef endpoint is called with the typed 3-way choice schema', async (t) => {
	let captured
	const server = await serverFor((request, response) => {
		let raw = ''
		request.on('data', (chunk) => { raw += chunk })
		request.on('end', () => {
			captured = { url: request.url, body: JSON.parse(raw) }
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ answers: { delivery: { type: 'choice', choice: 'steer', confidence: 0.91, probabilities: { steer: 0.91, queue: 0.05, answer: 0.04 } } }, usage: { input_tokens: 12, output_tokens: 0 } }))
		})
	})
	t.after(() => server.close())
	const judge = createJudge({ config: { enabled: true, url: `http://127.0.0.1:${server.address().port}/v1/systemone`, model: 'clef-flash', timeoutMs: 500 } })
	const result = await judge.classify({ text: 'actually use the blue one', features: { pendingQuestion: false, urgent: true, explicit: null, queuedCount: 0, msgLen: 26 } })
	assert.equal(result.ok, true)
	assert.equal(result.choice, 'steer')
	assert.equal(result.confidence, 0.91)
	assert.equal(captured.url, '/v1/systemone')
	assert.deepEqual(Object.keys(captured.body.questions.delivery.criteria), ['steer', 'queue', 'answer'])
	assert.match(captured.body.state, /actually use the blue one/)
	assert.match(captured.body.state, /pendingQuestion/)
})
