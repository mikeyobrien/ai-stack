import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as sessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { apply, __internals } from '../index.js'

// Genuine tool dispatch, loop, request assembly and session persistence. Only
// inference and the preset registry boundary are controlled. The marker proves
// scoped selection reaches requests, not that the installed Creator tree mounts.
class Capture extends LlmAdapter {
  requests = []
  call = null
  owner = null
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    this.requests.push(request)
    const call = request.sessionId === this.owner ? this.call : null
    if (call) this.call = null
    const block = call
      ? { type: 'tool-call', id: `call-${this.requests.length}`, name: call.name, arguments: JSON.stringify(call.args) }
      : { type: 'text', text: 'Read-only fixture complete.' }
    yield { type: 'block-start', index: 0, blockType: block.type }
    if (call) yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
    else yield { type: 'text-delta', index: 0, text: block.text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } }
  }
}
class Query extends SessionQueryEngine {
  async searchSessions() { throw new Error('Unexpected search') }
  async searchEvents() { throw new Error('Unexpected search') }
}
async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'fixture deadline'); await delay(5) }
}
const text = (message) => message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
async function fixture(t, withRegistry = true) {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-preset-'))
  const ctx = new Context()
  const fibers = []
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber }
  t.after(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
    await ctx.fiber.dispose()
    assert.equal(resolve(root), root)
    assert.ok(root.startsWith(join(tmpdir(), 'sidebar-preset-')))
    await rm(root, { recursive: true, force: true })
  })
  await mount(Storage)
  await mount(storageJson, { root: join(root, 'storage') })
  await mount(storageDomain, { backend: 'json' })
  await mount(SessionStore)
  await mount(SessionProjectionRegistry)
  await mount(sessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await mount(WorkspaceRegistry)
  await mount(SystemPrompt, { includeHarnessIdentity: false })
  await mount(ToolRuntime)
  for (const name of ['ask_user_question', 'exit_plan_mode']) ctx.tools.register({
    name, description: 'Unavailable interactive fixture tool.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'null' }, render: () => [] },
    execute() { throw new Error('Unexpected interactive tool') },
  })
  await mount(AgentRegistry)
  await mount(LlmRuntime)
  const adapter = new Capture()
  ctx.llm.registerAdapter(['fixture'], adapter)
  await mount(LocalFileSystem, { cwd: root })
  await mount(WorkingDirectoryService, { defaultDirectory: root })
  await mount(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 100, maxTitleBytes: 200 })
  await mount(Query)
  ctx.provide('attachments', { saveImages() { throw new Error('Unexpected upload') } })
  await mount(AgentLoop)
  if (withRegistry) ctx.provide('agentPresets', {
    async resolve(id = 'main') {
      if (!['main', 'cordis', 'broken', 'denied'].includes(id)) throw new Error('Unknown preset')
      if (id === 'denied') throw new Error('Preset selection denied')
      return { id, ...(id === 'broken' ? { broken: 'Activation failed' } : {}) }
    },
    async mount(scope, id) {
      scope.systemPrompt.section({ name: 'fixture:preset', order: 90, text: `Fixture scoped preset: ${id}`, interpolate: false })
      return { id }
    },
  })
  // Retain public lifecycle handles solely to make tracked children cold.
  const handles = new Map()
  const create = ctx.agents.create.bind(ctx.agents)
  ctx.agents.create = async (...args) => {
    const handle = await create(...args)
    handles.set(handle.agent.id, handle)
    return handle
  }
  const dataDir = join(root, 'sidebar')
  await mount({ name: 'sidebar-preset-under-test', apply }, { dataDir, cwd: root, provider: 'fixture', model: 'test' })
  await until(() => ctx.get('agent')?.status().ready || ctx.get('agent')?.status().error)
  assert.equal(ctx.agent.status().error, null)
  const owner = ctx.agents.list().find((a) => a.id.startsWith('agent-'))
  adapter.owner = owner.id
  async function delegate(args) {
    adapter.call = { name: 'delegate', args: { workspace: join(root, 'project'), task: 'Read-only original brief; no writes.', ...args } }
    await ctx.agent.chat({ text: 'Run the bounded fixture delegation.' })
    await owner.whenIdle()
  }
  await mkdir(join(root, 'project'))
  return { ctx, root, dataDir, adapter, owner, delegate, handles }
}

test('explicit preset reaches tracked child, request scope, durable state and cold resume without replacing identity', { timeout: 20000 }, async (t) => {
  const h = await fixture(t)
  await h.delegate({ agentPreset: 'cordis', provider: 'fixture', model: 'test' })
  const child = h.ctx.agents.list().find((a) => a.session.header.parentSession === h.owner.id)
  assert.ok(child)
  await child.whenIdle()
  assert.equal(child.session.header.agentPreset, 'cordis')
  const request = h.adapter.requests.find((r) => r.sessionId === child.id)
  assert.ok(request.messages.some((m) => text(m).includes('Fixture scoped preset: cordis')))
  assert.ok(request.messages.some((m) => text(m) === 'Read-only original brief; no writes.'))
  let state
  await until(async () => { try { state = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8')); return state.delegations.some((r) => r.sessionId === child.id && r.agentPreset === 'cordis') } catch { return false } })
  const record = state.delegations.find((r) => r.sessionId === child.id)
  const id = child.id
  await h.handles.get(id).dispose()
  assert.equal(h.ctx.agents.get(id), undefined, 'child is genuinely cold')
  await __internals.steerDelegation(h.ctx, { agent: h.owner }, record, 'Continue read-only.')
  const resumed = h.ctx.agents.get(id)
  await resumed.whenIdle()
  assert.equal(resumed.id, id)
  assert.equal(resumed.session.header.agentPreset, 'cordis')
  const last = h.adapter.requests.filter((r) => r.sessionId === id).at(-1)
  assert.ok(last.messages.some((m) => text(m).includes('Fixture scoped preset: cordis')))
  assert.ok(last.messages.some((m) => text(m) === 'Read-only original brief; no writes.'))
  assert.ok(last.messages.some((m) => text(m) === 'Continue read-only.'))
  assert.equal(h.owner.session.header.agentPreset, undefined, 'no owner preset mutation')
})

test('omitted preset preserves registry default and provider/model route', { timeout: 20000 }, async (t) => {
  const h = await fixture(t)
  await h.delegate({})
  const child = h.ctx.agents.list().find((a) => a.session.header.parentSession === h.owner.id)
  assert.ok(child)
  await child.whenIdle()
  assert.equal(child.session.header.agentPreset, 'main')
  assert.equal(child.options.provider, 'fixture')
  assert.equal(child.options.model, 'test')
})

test('unknown, unavailable, denied and empty presets create no child or workspace and preserve error evidence', { timeout: 20000 }, async (t) => {
  const h = await fixture(t)
  const count = h.ctx.workspaceRegistry.list().length
  for (const agentPreset of ['unknown', 'broken', 'denied', '']) {
    const before = h.owner.session.snapshotEvents().length
    await h.delegate({ agentPreset })
    assert.equal(h.ctx.agents.list().filter((a) => a.session.header.parentSession === h.owner.id).length, 0)
    assert.equal(h.ctx.workspaceRegistry.list().length, count)
    assert.ok(h.owner.session.snapshotEvents().slice(before).some((e) => e.type === 'tool/result' && e.data.message.isError), 'caller observes this selection error')
  }
})

test('explicit selection fails closed without registry while ordinary delegation remains available', { timeout: 20000 }, async (t) => {
  const h = await fixture(t, false)
  await h.delegate({ agentPreset: 'cordis' })
  assert.equal(h.ctx.agents.list().filter((a) => a.session.header.parentSession === h.owner.id).length, 0)
  await h.delegate({})
  const child = h.ctx.agents.list().find((a) => a.session.header.parentSession === h.owner.id)
  assert.ok(child)
  await child.whenIdle()
  assert.equal(child.session.header.agentPreset, undefined)
})
