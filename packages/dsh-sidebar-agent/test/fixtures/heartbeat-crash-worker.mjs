// Disposable process-crash fixture: no external inference, runtime activation,
// production profile, timers/sleeps or real-user Session controls.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as domain from '@deepseek-ai/dsh-storage-domain'
import * as json from '@deepseek-ai/dsh-storage-json'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { createHeartbeat } from '../../heartbeat.js'
import { __internals } from '../../index.js'
const [root, mode] = process.argv.slice(2)
if (!root?.startsWith('/tmp/heartbeat-process-crash-')) throw new Error('invalid disposable fixture root')
const ctx = new Context()
const fibers = []
async function mount(plugin, config) { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber }
class Capture extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Reviewed crash evidence.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Reviewed crash evidence.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
await mount(Storage); await mount(json, { root: join(root, 'storage') }); await mount(domain, { backend: 'json' })
await mount(SessionStore); await mount(Projections); await mount(persistence, { root: join(root, 'sessions'), compression: 'none' })
await mount(Prompt, { includeHarnessIdentity: false }); await mount(Tools); await mount(AgentRegistry); await mount(LlmRuntime)
const capture = new Capture(); ctx.llm.registerAdapter(['fixture'], capture); await mount(AgentLoop)
const options = { provider: 'fixture', model: 'capture' }
const handle = mode === 'recover'
  ? await ctx.agents.resume({ resumeSessionId: 'heartbeat-crash-owner', agentOptions: options })
  : await ctx.agents.create({ sessionId: 'heartbeat-crash-owner', agentOptions: options })
const owner = handle.agent
const path = join(root, 'heartbeat.json')
const store = new __internals.StateStore(path)
let source, target
if (mode === 'recover') source = JSON.parse(await readFile(join(root, 'source.json'), 'utf8'))
else {
  target = ctx.sessions.create('heartbeat-crash-target', { meta: { parentSession: owner.id, agentPreset: 'cordis' } })
  source = { header: target.header, events: [] }
}
const grant = { ownerId: owner.id, sessionId: source.header.id, createdAt: source.header.createdAt, agentPreset: 'cordis', source: 'delegate', assignmentRef: 'process-crash-fixture' }
const engine = createHeartbeat({ owner: () => owner,
  state: mode === 'recover' ? JSON.parse(await readFile(path, 'utf8')) : undefined,
  inspect: async () => source, authorize: (value) => value.ownerId === owner.id && value.sessionId === source.header.id,
  blocked: () => false,
  save: async (state) => {
    await store.save(state)
    if (mode === 'after-receipt' && state.admitted.length) process.exit(0)
  },
  flush: async (session) => {
    const result = await ctx.sessions.flush(session)
    if (mode === 'after-inbox-flush') process.exit(0)
    return result
  },
})
if (mode !== 'recover') {
  await engine.enroll(grant, source)
  target.append('turn/start', { turn: 0 }); source.events = target.snapshotEvents(); await engine.observe(target.id)
  target.append('turn/end', { turn: 0, reason: { kind: 'completed' } }); source.events = target.snapshotEvents()
  await writeFile(join(root, 'source.json'), JSON.stringify(source))
  await engine.observe(target.id)
  throw new Error('crash boundary was not reached')
}
await engine.restore(); await owner.whenIdle(); await engine.idle()
const originalAdmissions = owner.session.snapshotEvents().filter((event) => event.type === 'agent/inbox/spliced')
  .flatMap((event) => event.data.inserted).filter((message) => message.id.startsWith('heartbeat-') && !message.id.startsWith('heartbeat-resume-')).length
const result = { requests: capture.requests.length, originalAdmissions, markerInModel: capture.requests.some((request) => request.messages.some((message) => message.id.startsWith('heartbeat-resume-'))), pending: owner.inbox.nextTurn.length }
await engine.close(); await handle.dispose()
for (const fiber of fibers.toReversed()) await fiber.dispose()
await ctx.fiber.dispose()
console.log(JSON.stringify(result))
