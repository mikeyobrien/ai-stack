import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as sessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { createHeartbeat } from '../heartbeat.js'
import { __internals } from '../index.js'

const { StateStore, loadState } = __internals
class Clock {
  time = 1000000
  timers = new Map()
  next = 0
  now = () => this.time
  schedule = (fn, delay) => { const id = ++this.next; this.timers.set(id, { fn, at: this.time + delay }); return () => this.timers.delete(id) }
  async advance(ms, engine) {
    const end = this.time + ms
    let count = 0
    while (true) {
      const next = [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      assert.ok(++count <= 100, 'no timer storm')
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn()
      await engine.settled()
    }
    this.time = end
  }
}
class Capture extends LlmAdapter {
  requests = []
  release = null
  wait = null
  hold() { this.wait = new Promise((resolve) => { this.release = resolve }) }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    this.requests.push(request)
    if (this.wait) { const wait = this.wait; this.wait = null; await wait }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Reviewed evidence.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Reviewed evidence.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const human = (value) => createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
const heartbeatMessages = (session) => session.snapshotEvents().filter((e) => e.type === 'agent/inbox/spliced')
  .flatMap((e) => e.data.inserted).filter((m) => m.id.startsWith('heartbeat-') && !m.id.startsWith('heartbeat-resume-'))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'heartbeat-boundary-'))
  const ctx = new Context()
  const fibers = []
  const engines = []
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber }
  const adapter = new Capture()
  t.after(async () => {
    adapter.release?.()
    for (const engine of engines) await engine.close()
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    await ctx.fiber.dispose()
    assert.equal(resolve(root), root)
    assert.ok(root.startsWith(join(tmpdir(), 'heartbeat-boundary-')))
    await rm(root, { recursive: true, force: true })
  })
  await mount(Storage)
  await mount(storageJson, { root: join(root, 'storage') })
  await mount(storageDomain, { backend: 'json' })
  await mount(SessionStore)
  await mount(SessionProjectionRegistry)
  await mount(sessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await mount(SystemPrompt, { includeHarnessIdentity: false })
  await mount(ToolRuntime)
  await mount(AgentRegistry)
  await mount(LlmRuntime)
  ctx.llm.registerAdapter(['fixture'], adapter)
  await mount(LocalFileSystem, { cwd: root })
  await mount(WorkingDirectoryService, { defaultDirectory: root })
  await mount(AgentLoop)
  const options = { provider: 'fixture', model: 'capture' }
  let handle = await ctx.agents.create({ sessionId: 'heartbeat-owner', meta: { cwd: root }, agentOptions: options })
  let owner = handle.agent
  const targets = new Map()
  const grants = new Map()
  const clock = new Clock()
  t.mock.method(Date, 'now', clock.now)
  let barrier = false
  let saveHook = null
  let flushHook = null
  const store = new StateStore(join(root, 'heartbeat.json'))
  const inspect = async (id) => {
    const session = targets.get(id)
    if (!session) throw new Error('No authorized target')
    const events = session.snapshotEvents()
    return { header: session.header, events, paused: events.findLast((e) => e.type === 'goal/change')?.data?.goal?.phase === 'paused' }
  }
  const build = (state) => {
    const engine = createHeartbeat({ owner: () => owner, state, now: clock.now, schedule: clock.schedule,
      inspect, authorize: (grant) => JSON.stringify(grants.get(grant.sessionId)) === JSON.stringify(Object.fromEntries(
        ['ownerId', 'sessionId', 'createdAt', 'agentPreset', 'source', 'assignmentRef'].map((key) => [key, grant[key]]))),
      blocked: () => barrier,
      save: async (state) => { if (saveHook) await saveHook(state); await store.save(state) },
      flush: async (session) => { if (flushHook) await flushHook(session); return ctx.sessions.flush(session) },
    })
    engines.push(engine)
    return engine
  }
  let engine = build()
  async function target(id = 'worker', source = 'delegate') {
    const session = ctx.sessions.create(id, { meta: { cwd: root, ...(source === 'delegate' ? { parentSession: owner.id } : {}), agentPreset: 'cordis' } })
    targets.set(id, session)
    const grant = { ownerId: owner.id, sessionId: id, createdAt: session.header.createdAt, agentPreset: 'cordis', source, assignmentRef: `assigned:${id}` }
    grants.set(id, grant)
    await engine.enroll(grant, await inspect(id))
    return session
  }
  const event = (session, type, data) => type === 'tool/result'
    ? session.append(type, data, { surfaceOp: 'append' }) : session.append(type, data)
  async function start(session) { event(session, 'turn/start', { turn: 0 }); await engine.observe(session.id) }
  async function end(session, kind = 'completed') {
    event(session, 'turn/end', { turn: 0, reason: kind === 'error' ? { kind, error: { code: 'FIXTURE', message: 'Not a secret', status: 500 } } : { kind } })
    await engine.observe(session.id)
  }
  async function restart(state) { engine.close(); engine = build(state ?? JSON.parse(await readFile(join(root, 'heartbeat.json'), 'utf8'))); await engine.restore(); return engine }
  return { root, ctx, adapter, clock, target, event, start, end, inspect, grants, restart,
    get engine() { return engine }, get owner() { return owner },
    set barrier(value) { barrier = value }, set saveHook(value) { saveHook = value }, set flushHook(value) { flushHook = value },
    async coldOwner() { await handle.dispose(); handle = await ctx.agents.resume({ resumeSessionId: 'heartbeat-owner', agentOptions: options }); owner = handle.agent },
  }
}

test('120s checks are quiet; exactly at 300s one evidence-limited alert, never cancel or steer', async (t) => {
  const h = await fixture(t)
  const target = await h.target()
  await h.start(target)
  h.barrier = true
  const owner = h.owner
  let cancellations = 0
  const cancel = owner.cancel.bind(owner)
  owner.cancel = (...args) => { cancellations++; return cancel(...args) }
  owner.steer = () => { throw new Error('Forbidden steer') }
  await h.clock.advance(119999, h.engine)
  assert.equal(h.engine.status().lastCheckAt, null)
  await h.clock.advance(1, h.engine)
  assert.equal(h.engine.status().lastCheckAt, 1120000)
  await h.clock.advance(179999, h.engine)
  assert.equal(h.engine.status().queuedWake, 0)
  assert.equal(h.adapter.requests.length, 0)
  await h.clock.advance(1, h.engine)
  assert.equal(h.engine.status().queuedWake, 1)
  assert.equal(h.adapter.requests.length, 0)
  h.barrier = false
  await h.engine.idle(); await owner.whenIdle()
  assert.equal(heartbeatMessages(owner.session).length, 1)
  assert.equal(heartbeatMessages(owner.session)[0].source.kind, 'delegation')
  assert.match(heartbeatMessages(owner.session)[0].content[0].text, /not observable/)
  assert.equal(h.adapter.requests.length, 1)
  await h.clock.advance(600000, h.engine)
  assert.equal(heartbeatMessages(owner.session).length, 1)
  assert.equal(h.engine.status().cancellation, false)
  assert.equal(cancellations, 0)
})

for (const kind of ['completed', 'error', 'blocked']) test(`terminal ${kind} wakes immediately once through genuine followup/request/flush`, async (t) => {
  const h = await fixture(t)
  const target = await h.target()
  await h.start(target)
  await h.end(target, kind); await h.owner.whenIdle()
  assert.equal(h.clock.time, 1000000, 'no timer advance required')
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  assert.equal(h.engine.status().activeCount, 0)
  await h.engine.observe(target.id); await h.engine.idle()
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  assert.equal(h.clock.timers.size, 0)
  await h.coldOwner(); await h.restart()
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  assert.equal(h.engine.status().queuedWake, 0)
})

test('busy owner defers and coalesces terminal wakes; queued humans run before one bounded batch', async (t) => {
  const h = await fixture(t)
  const first = await h.target('first'); const second = await h.target('second')
  await h.start(first); await h.start(second)
  h.adapter.hold()
  h.owner.followup(human('Foreground work'))
  const requestsBefore = h.adapter.requests.length
  h.owner.steer = () => { throw new Error('No steering') }
  await h.end(first); await h.end(second, 'error')
  await h.engine.observe(first.id); await h.engine.idle()
  assert.equal(heartbeatMessages(h.owner.session).length, 0)
  assert.equal(h.engine.status().queuedWake, 2)
  h.owner.followup(human('Human queued followup'))
  h.adapter.release(); await h.owner.whenIdle()
  assert.ok(h.adapter.requests.length >= requestsBefore)
  assert.equal(heartbeatMessages(h.owner.session).length, 0)
  await h.engine.idle(); await h.owner.whenIdle()
  const messages = heartbeatMessages(h.owner.session)
  assert.equal(messages.length, 1)
  assert.match(messages[0].content[0].text, /first/)
  assert.match(messages[0].content[0].text, /second/)
  const userEvents = h.owner.session.snapshotEvents().filter((e) => e.type === 'user/message')
  assert.ok(userEvents.findIndex((e) => e.data.id === messages[0].id) > userEvents.findIndex((e) => e.data.content[0]?.text === 'Human queued followup'))
})

test('human input arriving during persistence wins admission; approval/question barrier is never answered', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  h.barrier = true
  await h.end(target)
  assert.equal(h.engine.status().queuedWake, 1)
  assert.equal(heartbeatMessages(h.owner.session).length, 0)
  h.barrier = false
  let injected = false
  h.saveHook = async (state) => {
    if (state.batch && !injected) { injected = true; h.adapter.hold(); h.owner.followup(human('Human wins this race')) }
  }
  await h.engine.idle()
  assert.equal(heartbeatMessages(h.owner.session).length, 0)
  h.saveHook = null; h.adapter.release(); await h.owner.whenIdle()
  await h.engine.idle(); await h.owner.whenIdle()
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
})

test('public idle during maintenance is not admitted; a later idle recovery safely delivers', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  let release
  const maintenance = h.owner.runMaintenance(() => new Promise((resolve) => { release = resolve }))
  assert.equal(h.owner.status, 'idle')
  await h.end(target)
  assert.equal(heartbeatMessages(h.owner.session).length, 0)
  assert.equal(h.engine.status().queuedWake, 1)
  release(); await maintenance
  await h.engine.idle(); await h.owner.whenIdle()
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
})

test('restart recovers pending terminal intent and a missed terminal event without old completion replay', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  h.barrier = true
  await h.end(target)
  await h.restart()
  assert.equal(h.engine.status().queuedWake, 1)
  assert.equal(heartbeatMessages(h.owner.session).length, 0)
  h.barrier = false; await h.engine.idle(); await h.owner.whenIdle()
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  const missed = await h.target('missed'); await h.start(missed)
  h.event(missed, 'turn/end', { turn: 0, reason: { kind: 'error', error: { code: 'FAIL', message: 'fixture' } } })
  await h.restart(); await h.owner.whenIdle()
  assert.equal(heartbeatMessages(h.owner.session).length, 2)
  await h.restart(); assert.equal(heartbeatMessages(h.owner.session).length, 2)
})

test('crash after admission before receipt reconciles stable ID even after consumption and surface compaction', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  let intent
  h.saveHook = async (state) => {
    if (state.batch) intent = structuredClone(state)
    if (intent && !state.batch && !state.pending.length) throw Object.assign(new Error('receipt disk failure'), { code: 'ENOSPC' })
  }
  await assert.rejects(h.end(target))
  await h.owner.whenIdle()
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  assert.equal(h.engine.status().error.code, 'ENOSPC')
  assert.ok(intent.batch.id.startsWith('heartbeat-'))
  h.saveHook = null
  // Hide the visible user-message surface with a valid replacement while the
  // raw inbox admission remains in history. Recovery must not inspect the view.
  const surface = h.owner.session.surface.nodes.filter((seq) => h.owner.session.eventAt(seq).type !== 'system/message')
  h.owner.session.append('user/message', human('Compacted fixture summary'), { surfaceOp: { op: 'replace', startSeq: surface[0], endSeq: surface.at(-1) }, sourceEventSeqs: surface })
  await h.ctx.sessions.flush(h.owner.session)
  await h.coldOwner(); await h.restart(intent)
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  assert.equal(h.engine.status().queuedWake, 0)
})

for (const crash of ['after-inbox-flush', 'after-receipt']) test(`orderly Host teardown cancels parked input ${crash}; cancellation is not silently reversed`, async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  if (crash === 'after-inbox-flush') h.flushHook = async (session) => {
    await h.ctx.sessions.flush(session)
    // Simulate shutdown while maintenance owns idle, preserving durable inbox.
    h.owner.cancel({ kind: 'disposed' }, { keepInbox: true })
    throw new Error('simulated process shutdown before receipt')
  }
  else h.saveHook = async (state) => {
    if (state.admitted.length) h.owner.cancel({ kind: 'disposed' }, { keepInbox: true })
  }
  if (crash === 'after-inbox-flush') await assert.rejects(h.end(target))
  else await h.end(target)
  assert.equal(h.adapter.requests.length, 0)
  assert.equal(h.owner.inbox.nextTurn.filter((m) => m.id.startsWith('heartbeat-') && !m.id.startsWith('heartbeat-resume-')).length, 1)
  h.flushHook = null; h.saveHook = null
  await h.coldOwner()
  assert.equal(h.owner.status, 'idle')
  assert.equal(h.adapter.requests.length, 0, 'Host resume itself does not wake the parked inbox')
  await h.restart(); await h.owner.whenIdle(); await h.engine.idle()
  assert.equal(heartbeatMessages(h.owner.session).length, 1, 'original occurrence was not reinserted')
  assert.equal(h.adapter.requests.length, 0, 'teardown cancellation has no durable cause; do not invent reauthorization')
  assert.equal(h.engine.status().canceledWakeCount, 1)
  assert.match(h.engine.status().deliveryWarning, /Host teardown/)
  assert.equal(h.owner.inbox.nextTurn.length, 0)
  await h.restart(); await h.owner.whenIdle()
  assert.equal(h.adapter.requests.length, 0)
})

for (const crash of ['after-inbox-flush', 'after-receipt']) test(`actual process crash ${crash} recovers once without a model-visible recovery marker`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'heartbeat-process-crash-'))
  t.after(async () => { assert.ok(resolve(root).startsWith(join(tmpdir(), 'heartbeat-process-crash-'))); await rm(root, { recursive: true, force: true }) })
  const script = new URL('./fixtures/heartbeat-crash-worker.mjs', import.meta.url).pathname
  execFileSync(process.execPath, [script, root, crash], { timeout: 10000 })
  const recover = () => JSON.parse(execFileSync(process.execPath, [script, root, 'recover'], { timeout: 10000, encoding: 'utf8' }).trim())
  assert.deepEqual(recover(), { requests: 1, originalAdmissions: 1, markerInModel: false, pending: 0 })
  assert.deepEqual(recover(), { requests: 0, originalAdmissions: 1, markerInModel: false, pending: 0 })
})

test('storage failure before admission is visible and latches without retry/message/model loops', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  let saves = 0
  h.saveHook = async () => { saves++; throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) }
  await assert.rejects(h.end(target))
  assert.equal(heartbeatMessages(h.owner.session).length, 0)
  assert.equal(h.engine.status().error.code, 'ENOSPC')
  await h.clock.advance(600000, h.engine); await h.engine.idle()
  assert.equal(saves, 1)
  assert.equal(h.adapter.requests.length, 0)
  h.saveHook = null
  await h.restart(); await h.owner.whenIdle()
  assert.equal(heartbeatMessages(h.owner.session).length, 1, 'old cursor recovers terminal after storage restored')
})

test('session flush failure is surfaced; later restart reconciles the existing admission, never re-sends', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  h.flushHook = () => { throw Object.assign(new Error('flush failed'), { code: 'EIO' }) }
  await assert.rejects(h.end(target)); await h.owner.whenIdle()
  assert.equal(h.engine.status().error.code, 'EIO')
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  h.flushHook = null; await h.restart()
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
})

test('HOST CONTRACT LIMIT: human queued during inbox flush follows the already-parked machine input', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  let added = false
  h.flushHook = () => {
    if (!added) { added = true; h.owner.followup(human('Human arriving during inbox durability checkpoint')) }
  }
  await h.end(target); await h.owner.whenIdle()
  const inputs = h.owner.session.snapshotEvents().filter((e) => e.type === 'user/message')
    .filter((e) => ['user', 'delegation'].includes(e.data.source.kind))
  assert.equal(inputs[0].data.source.kind, 'delegation')
  assert.equal(inputs[1].data.source.kind, 'user')
  // Characterizes a blocker, NOT a passing human-priority acceptance check.
  // The public Host has no durable low-priority enqueue/commit-wake primitive;
  // rewriting human queue entries or manufacturing a cancel cause is forbidden.
})

test('unrelated native enrollment and owner-binding forgery are refused; explicit observation never reparents', async (t) => {
  const h = await fixture(t)
  const native = await h.target('native', 'observation')
  assert.equal(native.header.parentSession, undefined)
  await h.start(native); await h.end(native); await h.owner.whenIdle()
  assert.equal(native.header.parentSession, undefined)
  assert.equal(native.header.agentPreset, 'cordis')
  await assert.rejects(h.engine.enroll({ ...h.grants.get('native'), sessionId: 'unrelated' }, await h.inspect('native')))
  const snapshot = h.engine.snapshot()
  h.engine.close()
  assert.throws(() => createHeartbeat({ owner: () => h.owner, state: { ...snapshot, ownerId: 'someone-else' } }), /mismatch/)
})

test('paused and already-completed assignments are quiet; revocation drops queued wake without control', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  h.barrier = true; await h.end(target)
  h.grants.delete(target.id)
  await h.engine.idle()
  assert.equal(h.engine.status().queuedWake, 0)
  h.barrier = false
  await h.clock.advance(900000, h.engine)
  assert.equal(h.adapter.requests.length, 0)
  assert.equal(h.engine.status().activeCount, 0)
})

test('noisy presence and identical polls are not progress; distinct artifact/test evidence resets the deadline', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  h.barrier = true
  const tool = async (name, args, result, id) => {
    h.event(target, 'tool/call', { turn: 0, step: 0, callId: id, name, arguments: JSON.stringify(args) })
    h.event(target, 'tool/result', { turn: 0, step: 0, message: { id: `result-${id}`, role: 'tool', source: { kind: 'tool', toolCallId: id }, toolCallId: id, content: [{ type: 'text', text: result }] } })
    await h.engine.observe(target.id)
  }
  await h.clock.advance(200000, h.engine)
  await tool('bash', { description: 'Test progress', command: 'tail logfile' }, 'log changed', 'log1')
  assert.equal(h.engine.status().targets[0].lastMilestoneAt, 1000000)
  await tool('edit', { file_path: '/fixture/file', old_string: 'a', new_string: 'b' }, 'Updated file', 'edit1')
  assert.equal(h.engine.status().targets[0].lastMilestoneAt, 1200000)
  await h.clock.advance(200000, h.engine)
  await tool('edit', { file_path: '/fixture/file', old_string: 'a', new_string: 'b' }, 'Updated file', 'edit2')
  assert.equal(h.engine.status().targets[0].lastMilestoneAt, 1200000, 'identical evidence does not postpone')
  await h.clock.advance(99999, h.engine)
  assert.equal(h.engine.status().queuedWake, 0)
  await h.clock.advance(1, h.engine)
  assert.equal(h.engine.status().queuedWake, 1)
  await tool('bash', { command: 'node --test test/feature.mjs' }, '1 test passed', 'test1')
  assert.equal(h.engine.status().queuedWake, 0, 'new milestone removes obsolete queued stall')
  assert.equal(h.engine.status().targets[0].lastMilestoneAt, 1500000)
  assert.equal(h.adapter.requests.length, 0)
  assert.ok(!JSON.stringify(h.engine.status()).includes('/fixture/file'), 'status has classifications, not raw command/paths')
})

test('waiting tool gets a distinct bounded alert; terminal supersedes a pending stall', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  h.barrier = true
  h.event(target, 'tool/call', { turn: 0, step: 0, callId: 'waiting', name: 'bash', arguments: JSON.stringify({ command: 'long-running-build' }) })
  h.event(target, 'tool/call', { turn: 0, step: 0, callId: 'parallel-poll', name: 'bash', arguments: JSON.stringify({ command: 'tail logfile' }) })
  h.event(target, 'tool/result', { turn: 0, step: 0, message: { id: 'parallel-result', role: 'tool', source: { kind: 'tool', toolCallId: 'parallel-poll' }, toolCallId: 'parallel-poll', content: [{ type: 'text', text: 'unchanged poll' }] } })
  await h.engine.observe(target.id)
  await h.clock.advance(300000, h.engine)
  assert.equal(h.engine.status().targets[0].waiting, true, 'completed parallel poll does not hide the still-running tool')
  assert.equal(h.engine.status().queuedWake, 1)
  // Close the waiting tool before the valid turn-end lifecycle.
  h.event(target, 'tool/result', { turn: 0, step: 0, message: { id: 'wait-result', role: 'tool', source: { kind: 'tool', toolCallId: 'waiting' }, toolCallId: 'waiting', content: [{ type: 'text', text: 'Finished' }] } })
  await h.end(target)
  assert.equal(h.engine.status().queuedWake, 1)
  h.barrier = false; await h.engine.idle(); await h.owner.whenIdle()
  const body = heartbeatMessages(h.owner.session)[0].content[0].text
  assert.match(body, /turn ended completed/)
  assert.ok(!body.includes('no new observable milestone'), 'stale stall was coalesced away')
})

test('active deadlines survive restart, paused tasks disarm, and unchanged idle makes no model requests', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  h.barrier = true
  await h.clock.advance(119999, h.engine)
  await h.restart()
  assert.equal(h.engine.status().nextCheckAt, 1120000)
  await h.clock.advance(1, h.engine)
  assert.equal(h.engine.status().lastCheckAt, 1120000)
  h.event(target, 'goal/change', { version: 1, kind: 'goal/change', operation: 'pause', goal: { id: 'goal-fixture', revision: 1, objective: 'paused task', phase: 'paused' }, roundsStarted: 0, createdAt: h.clock.now(), updatedAt: h.clock.now() })
  await h.engine.observe(target.id)
  assert.equal(h.engine.status().activeCount, 0)
  assert.equal(h.engine.status().targets[0].lifecycle, 'paused')
  await h.restart(); h.barrier = false
  await h.clock.advance(900000, h.engine)
  assert.equal(h.engine.status().queuedWake, 0)
  assert.equal(h.adapter.requests.length, 0)
  assert.equal(h.clock.timers.size, 0)
})

test('canceled durable admission is reconciled, not resurrected after receipt failure', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  let intent
  h.flushHook = () => { for (const message of h.owner.inbox.nextTurn) if (message.id.startsWith('heartbeat-')) h.owner.inbox.remove(message.id) }
  h.saveHook = async (state) => {
    if (state.batch) intent = structuredClone(state)
    if (intent && !state.batch) throw new Error('receipt failure')
  }
  await assert.rejects(h.end(target)); await h.owner.whenIdle()
  assert.equal(h.adapter.requests.length, 0)
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  h.flushHook = null; h.saveHook = null
  await h.coldOwner(); await h.restart(intent)
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  assert.equal(h.adapter.requests.length, 0)
})

test('new explicit observation assignment renews supervision without replaying its old completion', async (t) => {
  const h = await fixture(t)
  const target = await h.target('native-renewal', 'observation')
  await h.start(target); await h.end(target); await h.owner.whenIdle(); await h.engine.idle()
  const grant = { ...h.grants.get(target.id), assignmentRef: 'explicit-new-task' }
  h.grants.set(target.id, grant)
  await h.engine.enroll(grant, await h.inspect(target.id))
  assert.equal(heartbeatMessages(h.owner.session).length, 1)
  assert.equal(h.engine.status().activeCount, 0)
  h.event(target, 'turn/start', { turn: 1 }); await h.engine.observe(target.id)
  assert.equal(h.engine.status().activeCount, 1)
  h.event(target, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); await h.engine.observe(target.id); await h.owner.whenIdle()
  assert.equal(heartbeatMessages(h.owner.session).length, 2)
  assert.equal(target.header.parentSession, undefined)
})

test('disposal drains in-flight persistence without waking owner or leaking its timer', async (t) => {
  const h = await fixture(t)
  const target = await h.target(); await h.start(target)
  const entered = Promise.withResolvers(); const release = Promise.withResolvers()
  h.saveHook = async () => { entered.resolve(); await release.promise }
  const pending = h.end(target)
  await entered.promise
  const closing = h.engine.close()
  release.resolve(); await pending; await closing
  assert.equal(h.engine.status().ready, false)
  assert.equal(h.clock.timers.size, 0)
  assert.equal(heartbeatMessages(h.owner.session).length, 0)
  assert.equal(h.adapter.requests.length, 0)
})

test('StateStore rejects failed acknowledgment, keeps serialization usable, and corrupt owner state fails closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'heartbeat-store-'))
  t.after(async () => { assert.ok(resolve(root).startsWith(join(tmpdir(), 'heartbeat-store-'))); await rm(root, { recursive: true, force: true }) })
  const directory = join(root, 'directory')
  await writeFile(directory, 'not a directory')
  const store = new StateStore(join(directory, 'state.json'))
  await assert.rejects(store.save({ sessionId: 'must-survive' }))
  assert.equal(await readFile(directory, 'utf8'), 'not a directory')
  assert.equal(resolve(directory), join(root, 'directory'))
  await rm(directory); await mkdir(directory)
  await store.save({ sessionId: 'must-survive', delegations: [] })
  assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).sessionId, 'must-survive')
  await writeFile(join(directory, 'state.json'), '{invalid')
  await assert.rejects(loadState(join(directory, 'state.json')))
  await writeFile(join(directory, 'state.json'), JSON.stringify({ version: 999 }))
  await assert.rejects(loadState(join(directory, 'state.json')))
})
