import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentService, __internals } from '../index.js'

const { chatStatus: chatStatusOf, lastUsageOf } = __internals
const chatStatus = (runtime) => chatStatusOf(runtime)

function runtime({ usage, contextWindow = 1000 } = {}) {
  const events = []
  if (usage !== undefined) {
    events.push({
      type: 'assistant/message', seq: 7, time: 1794254040320,
      data: {
        message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
        usage,
      },
    })
  }
  const agent = {
    status: 'idle',
    options: { provider: 'p', model: 'm' },
    session: { snapshotEvents() { return events }, surface: { nodes: [] } },
  }
  return {
    ready: true, title: 'mAgent', sessionId: 'agent-1', agent,
    selectionRef: { current: { provider: 'p', model: 'm' } },
    contextWindowRef: { provider: 'p', model: 'm', current: contextWindow },
    delegations: new Map(), streamText: null, catalogCache: null, telegram: null,
  }
}

test('chatStatus exposes usage percent from the cached window and clamps it', () => {
  const view = chatStatus(runtime({ usage: { inputTokens: 800, cacheReadTokens: 150, cacheWriteTokens: 50, outputTokens: 1 } })).usage
  assert.equal(view.percent, 100)
  assert.equal(view.window, 1000)
  assert.equal(view.used, 1000)
  assert.equal(view.seq, 7)
})

test('chatStatus omits usage when the window is unknown instead of inventing one', () => {
  assert.equal(chatStatus(runtime({ contextWindow: null, usage: { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } })).usage, null)
  assert.equal(chatStatus(runtime({ usage: undefined })).usage, null)
})

test('cache read and write count toward used tokens, matching agentStatusOf semantics', () => {
  const events = [{ type: 'assistant/message', seq: 3, time: 1, data: { message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 } } }]
  const usage = lastUsageOf({ snapshotEvents: () => events })
  assert.equal(usage.input + usage.cacheRead + usage.cacheWrite, 60)
})

test('a model switch drops the old window and resolves the new one', async () => {
  const usage = { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }
  const state = runtime({ usage, contextWindow: 1000 })
  const asked = []
  state.host = { llm: { async resolveModelInfo(provider, model) { asked.push(`${provider}/${model}`); return { context: { contextWindow: 2000 } } } } }
  assert.equal(chatStatus(state).usage.percent, 50, 'cached window for p/m')

  state.selectionRef = { current: { provider: 'q', model: 'n' } }
  assert.equal(chatStatus(state).usage, null, 'no ring from the previous model\'s window')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(asked, ['q/n'])
  assert.equal(chatStatus(state).usage.percent, 25, 'new window once resolved')
  assert.deepEqual(asked, ['q/n'], 'resolved once, then cached')
})
