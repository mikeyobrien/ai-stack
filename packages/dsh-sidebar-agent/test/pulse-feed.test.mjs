import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPulseFeed, resolvePulseConfig } from '../pulse-feed.js'
import { __internals } from '../index.js'

function harness({ sessions = ['s1'], minQuietSeconds = 0, targetAgent = 'agent-x', maxDigestChars = 1200 } = {}) {
	let now = 0
	const due = []
	const timers = {
		setTimeout(fn, ms) { const entry = { at: now + ms, fn }; due.push(entry); return entry },
		clearTimeout(entry) { const index = due.indexOf(entry); if (index >= 0) due.splice(index, 1) },
	}
	const delivered = []
	const warns = []
	let failures = 0
	const target = {
		status: 'idle',
		steer(message) {
			if (failures > 0) { failures -= 1; throw new Error('fixture delivery failure') }
			delivered.push(message)
		},
		followup(message) {
			if (failures > 0) { failures -= 1; throw new Error('fixture delivery failure') }
			delivered.push(message)
		},
	}
	const state = { lastSeen: {} }
	let saves = 0
	const persist = async () => { saves += 1 }
	const sessionsMap = new Map([['s1', { id: 's1', header: { title: 'Watched session' } }], ['s2', { id: 's2', header: { title: 'Second watched' } }], ['agent-x', { id: 'agent-x', header: { title: 'Target Agent' } }]])
	const ctx = {
		logger: { warn(message) { warns.push(String(message)) } },
		get(name) {
			if (name === 'sessionTitle') return { get(session) { return session.header?.title ? { title: session.header.title } : undefined } }
			return undefined
		},
	}
	const runtime = { sessionId: 'agent-x', agent: target }
	return {
		ctx, runtime, state, persist, timers, delivered, warns, sessions: sessionsMap,
		get now() { return now },
		set now(value) { now = value },
		advance(ms) {
			now += ms
			for (const entry of [...due]) {
				if (entry.at <= now) {
					const index = due.indexOf(entry)
					if (index >= 0) due.splice(index, 1)
					entry.fn()
				}
			}
		},
		failNext(count) { failures = count },
	}
}

async function emit(feed, session, event) {
	feed.handle(session, event)
	await feed.idle()
	await Promise.resolve()
}

async function turn(feed, session, { seq, start = 0, end = 1000, prompt = 'do the work', result = 'finished', reason = { kind: 'completed' }, flush = true } = {}) {
	await emit(feed, session, { type: 'turn/start', seq: seq + 0, time: start, data: { turn: 1 } })
	await emit(feed, session, { type: 'user/message', seq: seq + 1, time: start + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } })
	await emit(feed, session, { type: 'assistant/message', seq: seq + 2, time: end, data: { message: { content: [{ type: 'text', text: result }] } } })
	await emit(feed, session, { type: 'turn/end', seq: seq + 3, time: end, data: { reason } })
	if (flush) await feed.flush()
}

test('config defaults are off and validate unknown keys', () => {
	const config = resolvePulseConfig({})
	assert.deepEqual(config.sessions, [])
	assert.equal(config.minQuietSeconds, 60)
	assert.equal(config.maxDigestChars, 1200)
	assert.throws(() => resolvePulseConfig({ sessions: ['s'], nope: true }), /unknown config key/)
})

test('only watched sessions produce one bounded digest with the literal header', async (t) => {
	const h = harness()
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const feed = await createPulseFeed({ ctx: h.ctx, config: { sessions: ['s1'], minQuietSeconds: 0, maxDigestChars: 1200 }, runtime: h.runtime, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	await turn(feed, h.sessions.get('s1'), { seq: 0, prompt: 'build the report', result: 'report is ready' })
	await turn(feed, h.sessions.get('s2'), { seq: 10, prompt: 'not watched', result: 'ignore me' })
	await feed.close()
	assert.equal(h.delivered.length, 1)
	const message = h.delivered[0]
	const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
	assert.match(text, /^pulse\n/)
	assert.match(text, /session: s1/)
	assert.match(text, /title: Watched session/)
	assert.match(text, /reason: completed/)
	assert.match(text, /duration: 1s/)
	assert.match(text, /prompt: build the report/)
	assert.match(text, /result: report is ready/)
	assert.equal(message.source.kind, 'user')
	assert.ok(text.length <= 1200)
})

test('digests redact token-shaped text and bound prompt/result', async (t) => {
	const h = harness()
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const feed = await createPulseFeed({ ctx: h.ctx, config: { sessions: ['s1'], minQuietSeconds: 0, maxDigestChars: 1200 }, runtime: h.runtime, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	await turn(feed, h.sessions.get('s1'), {
		seq: 0,
		prompt: `token 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef ${'p'.repeat(300)}`,
		result: `sk-abcdefghijklmnopqrstuvwxyz ${'r'.repeat(500)}`,
	})
	await feed.close()
	const text = h.delivered[0].content.map((part) => part.text).join('')
	assert.ok(!text.includes('123456:'))
	assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz'))
	assert.match(text, /\[redacted\]/)
	assert.match(text, /…/)
})

test('multiple turns inside minQuietSeconds coalesce into one delivery', async (t) => {
	const h = harness({ sessions: ['s1', 's2'], minQuietSeconds: 60 })
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const feed = await createPulseFeed({ ctx: h.ctx, config: { sessions: ['s1', 's2'], minQuietSeconds: 60, maxDigestChars: 2000 }, runtime: h.runtime, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	await turn(feed, h.sessions.get('s1'), { seq: 0 })
	assert.equal(h.delivered.length, 1)
	h.now = 20
	await turn(feed, h.sessions.get('s1'), { seq: 10, flush: false })
	h.now = 30
	await turn(feed, h.sessions.get('s2'), { seq: 20, flush: false })
	assert.equal(h.delivered.length, 1, 'second and third waits for the quiet interval')
	h.advance(30)
	await feed.flush()
	assert.equal(h.delivered.length, 2)
	const text = h.delivered[1].content.map((part) => part.text).join('')
	assert.match(text, /session: s1/)
	assert.match(text, /session: s2/)
})

test('restart dedupe ignores an already-seen turn/end seq', async (t) => {
	const h = harness()
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const config = { sessions: ['s1'], minQuietSeconds: 0, maxDigestChars: 1200 }
	const first = await createPulseFeed({ ctx: h.ctx, config, runtime: h.runtime, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	await turn(first, h.sessions.get('s1'), { seq: 100 })
	await first.close()
	assert.equal(h.delivered.length, 1)

	const second = await createPulseFeed({ ctx: h.ctx, config, runtime: h.runtime, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	const session = h.sessions.get('s1')
	await emit(second, session, { type: 'turn/start', seq: 100, time: 0, data: { turn: 1 } })
	await emit(second, session, { type: 'user/message', seq: 101, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'replay' }] } })
	await emit(second, session, { type: 'assistant/message', seq: 102, time: 1000, data: { message: { content: [{ type: 'text', text: 'replay result' }] } } })
	await emit(second, session, { type: 'turn/end', seq: 103, time: 1000, data: { reason: { kind: 'completed' } } })
	assert.equal(h.delivered.length, 1, 'replayed seq must not emit again')
	await turn(second, session, { seq: 110 })
	assert.equal(h.delivered.length, 2)
	await second.close()
})

test('delivery failure is retried once, then logged without throwing', async (t) => {
	const h = harness()
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const feed = await createPulseFeed({ ctx: h.ctx, config: { sessions: ['s1'], minQuietSeconds: 0, maxDigestChars: 1200 }, runtime: h.runtime, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	h.failNext(1)
	await turn(feed, h.sessions.get('s1'), { seq: 0 })
	assert.equal(h.delivered.length, 1, 'the second attempt succeeds')
	await feed.close()

	const second = harness()
	const root2 = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root2, { recursive: true, force: true }))
	const failing = await createPulseFeed({ ctx: second.ctx, config: { sessions: ['s1'], minQuietSeconds: 0, maxDigestChars: 1200 }, runtime: second.runtime, state: second.state, persist: second.persist, clock: () => second.now, timers: second.timers, logger: second.ctx.logger })
	second.failNext(2)
	await turn(failing, second.sessions.get('s1'), { seq: 0 })
	await failing.close()
	assert.ok(second.warns.some((message) => /delivery failed after retry/.test(message)))
})


test('self-echo is ignored even if the parent Agent id is listed', async (t) => {
	const h = harness({ sessions: ['agent-x'] })
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const feed = await createPulseFeed({ ctx: h.ctx, runtime: h.runtime, config: { sessions: ['agent-x'], minQuietSeconds: 0, maxDigestChars: 1200 }, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	await turn(feed, h.sessions.get('agent-x'), { seq: 0 })
	await feed.close()
	assert.equal(h.delivered.length, 0)
})


test('sidebar state.json carries pulseLastSeen across restart', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'sponsor-state-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const file = join(root, 'state.json')
	await writeFile(file, JSON.stringify({ version: 1, sessionId: null, pulseLastSeen: { s1: 42, bad: 'nope' }, delegations: [] }))
	const state = await __internals.loadState(file)
	assert.deepEqual(state.pulseLastSeen, { s1: 42 })
})

test('pulse config prefers pulse{sessions} and keeps sponsor keys as aliases', () => {
	const aliased = __internals.settingsOf({ sponsors: ['alias-session'], sponsorMinQuietSeconds: 5, sponsorMaxDigestChars: 300 })
	assert.deepEqual(aliased.pulse, { sessions: ['alias-session'], minQuietSeconds: 5, maxDigestChars: 300 })
	const preferred = __internals.settingsOf({
		sponsors: ['old-session'],
		sponsorMinQuietSeconds: 5,
		pulse: { sessions: ['new-session'], minQuietSeconds: 12, maxDigestChars: 500 },
	})
	assert.deepEqual(preferred.pulse, { sessions: ['new-session'], minQuietSeconds: 12, maxDigestChars: 500 })
})

test('API-steered turn without turn/start captures prompt and final assistant text', async (t) => {
	const h = harness({ sessions: ['s1'] })
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const feed = await createPulseFeed({ ctx: h.ctx, runtime: h.runtime, config: { sessions: ['s1'], minQuietSeconds: 0, maxDigestChars: 1200 }, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	const session = h.sessions.get('s1')
	// The feed is already active mid-turn: no turn/start is observed.
	await emit(feed, session, { type: 'user/message', seq: 1, time: 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'steered request' }] } })
	await emit(feed, session, { type: 'assistant/message', seq: 2, time: 200, data: { message: { content: [{ type: 'reasoning', text: 'thinking only' }, { type: 'tool-call', name: 'bash' }] } } })
	await emit(feed, session, { type: 'assistant/message', seq: 3, time: 300, data: { message: { content: [{ type: 'text', text: 'final steered answer' }] } } })
	await emit(feed, session, { type: 'turn/end', seq: 4, time: 400, data: { reason: { kind: 'completed' } } })
	await feed.flush()
	const text = h.delivered.at(-1).content.map((part) => part.text).join('')
	assert.match(text, /^pulse\n/)
	assert.match(text, /prompt: steered request/)
	assert.match(text, /result: final steered answer/)
	assert.ok(!/duration: 0s/.test(text))
	await feed.close()
})

test('missing start falls back to the previous turn/end for duration, never 0s', async (t) => {
	const h = harness({ sessions: ['s1'] })
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const feed = await createPulseFeed({ ctx: h.ctx, runtime: h.runtime, config: { sessions: ['s1'], minQuietSeconds: 0, maxDigestChars: 1200 }, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	const session = h.sessions.get('s1')
	await turn(feed, session, { seq: 0, start: 0, end: 1000, prompt: 'first', result: 'first result' })
	await h.gate?.flush?.()
	await emit(feed, session, { type: 'user/message', seq: 10, time: 2000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'steered again' }] } })
	await emit(feed, session, { type: 'assistant/message', seq: 11, time: 3000, data: { message: { content: [{ type: 'text', text: 'final again' }] } } })
	await emit(feed, session, { type: 'turn/end', seq: 12, time: 4000, data: { reason: { kind: 'completed' } } })
	await feed.flush()
	const text = h.delivered.at(-1).content.map((part) => part.text).join('')
	assert.match(text, /duration: 3s/)
	assert.match(text, /prompt: steered again/)
	assert.match(text, /result: final again/)
	await feed.close()
})

test('digest appends parseable pulse machine metadata', async (t) => {
	const h = harness({ sessions: ['s1'] })
	const root = await mkdtemp(join(tmpdir(), 'pulse-'))
	t.after(() => rm(root, { recursive: true, force: true }))
	const feed = await createPulseFeed({ ctx: h.ctx, runtime: h.runtime, config: { sessions: ['s1'], minQuietSeconds: 0, maxDigestChars: 1200 }, state: h.state, persist: h.persist, clock: () => h.now, timers: h.timers, logger: h.ctx.logger })
	await turn(feed, h.sessions.get('s1'), { seq: 0, prompt: 'meta prompt', result: 'meta result' })
	await feed.close()
	const text = h.delivered[0].content.map((part) => part.text).join('')
	const line = text.split('\n').at(-1)
	const meta = JSON.parse(line.slice('<!--meta:'.length, -3))
	assert.equal(meta.kind, 'pulse')
	assert.equal(meta.session, 's1')
	assert.equal(meta.title, 'Watched session')
	assert.equal(meta.reason, 'completed')
	assert.equal(meta.durationMs, 1000)
	assert.equal(meta.prompt, 'meta prompt')
	assert.equal(meta.result, 'meta result')
})
