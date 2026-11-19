import { createHash } from 'node:crypto'
import { freezeMessage } from '@deepseek-ai/dsh-llm'

export const HEARTBEAT_INTERVAL_MS = 120000
export const HEARTBEAT_STALL_MS = 300000
const VERSION = 1
const WAKE_TEXT = '[heartbeat recovery wake: control marker; not model input]'
const isWakeMarker = (message) => message.id.startsWith('heartbeat-resume-')
  && message.source?.kind === 'delegation' && textOf(message) === WAKE_TEXT
const digest = (value) => createHash('sha256').update(value).digest('hex')
const textOf = (message) => (message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback
function testCommand(argumentsText) {
  try {
    const command = JSON.parse(argumentsText).command
    return typeof command === 'string' && /(?:^|[;&|]\s*)\s*(?:node\s+--test\b|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|pytest\b|vitest\b|cargo\s+test\b|go\s+test\b)/.test(command)
  } catch { return false }
}
export function heartbeatConfig(value = {}) {
  return {
    enabled: value.enabled !== false,
    intervalMs: positive(value.intervalMs, HEARTBEAT_INTERVAL_MS),
    stallMs: positive(value.stallMs, HEARTBEAT_STALL_MS),
    observations: Array.isArray(value.observations) ? value.observations : [],
  }
}

// Read raw committed events, not the current conversation surface (compaction
// can hide the latter). An inserted ID is an admission, including when later
// consumed or canceled: cancellation never authorizes an automatic replay.
export function heartbeatDispositions(events) {
  const states = new Map()
  const lists = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const removed = lists[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      for (const message of removed) if (message.id.startsWith('heartbeat-')) states.set(message.id, splice.outcome === 'canceled' ? 'canceled' : 'claimed')
      for (const message of splice.inserted) if (message.id.startsWith('heartbeat-')) states.set(message.id, 'pending')
    } else if (event.type === 'user/message' && event.data.id?.startsWith('heartbeat-')) states.set(event.data.id, 'consumed')
  }
  return states
}
export function heartbeatAdmissions(events) { return new Set(heartbeatDispositions(events).keys()) }

/** Plugin-owned state machine. All mutations and admission share one serial
 * lane; timers only submit structural checks. No inference, steering, answers,
 * target activation or cancellation is available to this component. */
export function createHeartbeat({ owner, save, inspect, authorize, blocked, flush, config = {}, state,
  now = Date.now, schedule = (fn, delay) => { const id = setTimeout(fn, delay); return () => clearTimeout(id) },
  onError = () => {}, onTerminal = () => {}, terminalText = null, suppressed = () => false }) {
  const settings = heartbeatConfig(config)
  const agent = owner()
  if (!agent || typeof agent.runMaintenance !== 'function' || typeof agent.followup !== 'function' || typeof agent.send !== 'function') throw new Error('heartbeat requires supported owner idle admission')
  if (state && (state.version !== VERSION || state.ownerId !== agent.id || !Array.isArray(state.targets))) {
    throw new Error('heartbeat state owner/version mismatch; refusing admission')
  }
  const data = state ? structuredClone(state) : {
    version: VERSION, ownerId: agent.id, targets: [], pending: [], admitted: [], batch: null,
    lastCheckAt: null, nextCheckAt: null,
  }
  if (!Array.isArray(data.pending)) throw new Error('invalid heartbeat pending state')
  data.admitted ??= []
  if (!Array.isArray(data.admitted)) throw new Error('invalid heartbeat admitted state')
  // The Host has no wake-only operation for a cold pending inbox item. Use a
  // normal followup control marker, filtered ONLY for our exact provenance and
  // fixed body at the supported scoped pre-step seam. No extra model request.
  const disposeFilter = agent.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (payload.messages.length > 0 && payload.messages.every(isWakeMarker)) return { kind: 'reject' }
    if (decision.kind !== 'enter' || !decision.messages.some(isWakeMarker)) return decision
    const messages = decision.messages.filter((message) => !isWakeMarker(message))
    return messages.length ? { ...decision, messages } : { kind: 'reject' }
  })
  const recoveryWoken = new Set()
  const observing = new Map()
  let tail = Promise.resolve()
  let cancelTimer = null
  let disposed = false
  let fault = null
  let draining = false
  const targets = () => data.targets
  const persist = () => {
    if (!targets().some((t) => t.active && !t.closed) && !data.pending.length && !data.admitted.length) data.nextCheckAt = null
    else data.nextCheckAt ??= now() + settings.intervalMs
    return save(structuredClone(data))
  }
  const exactOwner = () => !disposed && owner() === agent && agent.id === data.ownerId
  const canAdmit = () => exactOwner() && agent.status === 'idle' && !blocked(agent)
    && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
  const fail = (error) => {
    if (!fault) {
      fault = { code: typeof error?.code === 'string' ? error.code : 'heartbeat-failed', at: now() }
      onError(error)
    }
    cancelTimer?.(); cancelTimer = null
  }
  const serial = (operation) => {
    const task = tail.then(async () => {
      if (disposed || fault || !settings.enabled) return
      return operation()
    })
    tail = task.catch(fail)
    return task
  }
  const forgetPending = (targetId) => {
    data.pending = data.pending.filter((p) => p.targetId !== targetId)
    // A not-yet-admitted batch is only a durable intent, not a receipt.
    if (data.batch?.items.some((p) => p.targetId === targetId)) data.batch = null
  }
  const queue = (target, kind, seq) => {
    if (suppressed(target)) { forgetPending(target.sessionId); return }
    const key = `${target.sessionId}:${target.generation}:${kind}:${seq}`
    if (target.deliveredKey === key || data.pending.some((p) => p.key === key)) return
    forgetPending(target.sessionId)
    data.pending.push({ targetId: target.sessionId, key, kind, seq, at: now() })
  }
  const rearm = () => {
    cancelTimer?.(); cancelTimer = null
    if (disposed || fault || !settings.enabled) return
    const active = targets().filter((t) => t.active && !t.closed)
    if (!active.length && !data.pending.length && !data.admitted.length) { data.nextCheckAt = null; return }
    if (data.nextCheckAt === null) data.nextCheckAt = now() + settings.intervalMs
    const deadlines = active.filter((t) => !t.stallQueued).map((t) => t.milestoneAt + settings.stallMs)
    const due = Math.min(data.nextCheckAt, ...deadlines)
    cancelTimer = schedule(() => { cancelTimer = null; void check().catch(() => {}) }, Math.min(2147483647, Math.max(0, due - now())))
  }
  const valid = async (target) => {
    if (target.ownerId !== data.ownerId || !await authorize(target)) return false
    const observation = await inspect(target.sessionId, target.cursor)
    const header = observation.header
    return header.id === target.sessionId && header.createdAt === target.createdAt
      && (header.agentPreset ?? null) === target.agentPreset
      && (target.source !== 'delegate' || header.parentSession === data.ownerId) ? observation : null
  }
  const apply = (target, event) => {
    if (event.seq <= target.cursor) return
    target.cursor = event.seq
    target.lastActivityAt = Math.max(target.lastActivityAt ?? 0, event.time ?? now())
    // A closed assignment needs an explicit new assignment, never a stray turn.
    if (target.closed) return
    if (event.type === 'goal/change' && event.data?.goal?.phase && event.data.goal.phase !== 'active') {
      target.active = false; target.closed = true; target.lifecycle = event.data.goal.phase
      forgetPending(target.sessionId)
      if (target.lifecycle !== 'paused') queue(target, target.lifecycle === 'complete' ? 'completed' : 'blocked', event.seq)
      return
    }
    if (event.type === 'turn/start') {
      target.active = true; target.lifecycle = 'active'
      target.milestoneAt ??= event.time ?? now()
    } else if (event.type === 'tool/call') {
      target.calls ??= []
      target.calls.push({ callId: event.data.callId, name: event.data.name, fingerprint: digest(event.data.arguments),
        // Keep only a classification/hash, never command contents or credentials.
        evidence: ['edit', 'write', 'apply_patch'].includes(event.data.name) ? 'artifact operation'
          : event.data.name === 'bash' && testCommand(event.data.arguments) ? 'test command' : null })
      target.waiting = target.calls[0] ?? null
    } else if (event.type === 'tool/result') {
      const callId = event.data.message?.toolCallId
      const waiting = target.calls?.find((call) => call.callId === callId) ?? (target.waiting?.callId === callId ? target.waiting : null)
      if (waiting) {
        target.calls = (target.calls ?? []).filter((call) => call.callId !== callId)
        target.waiting = target.calls[0] ?? null
        if (waiting.evidence && !event.data.error && !event.data.message.isError) {
          const fingerprint = digest(`${waiting.fingerprint}:${textOf(event.data.message)}`)
          if (!target.seen.includes(fingerprint)) {
            target.seen = [...target.seen.slice(-127), fingerprint]
            target.milestoneAt = event.time ?? now()
            target.milestoneSeq = event.seq
            target.milestone = `${waiting.evidence} result observed (not a guarantee of useful work)`
            target.stallQueued = false
            forgetPending(target.sessionId)
          }
        }
      }
    } else if (event.type === 'turn/end') {
      target.active = false; target.closed = true; target.waiting = null; target.calls = []
      target.lifecycle = event.data.reason.kind
      queue(target, target.lifecycle, event.seq)
      onTerminal(target, event)
    }
  }
  const scan = async (target) => {
    const observation = await valid(target)
    if (!observation) {
      target.active = false; target.closed = true; target.lifecycle = 'unauthorized'
      forgetPending(target.sessionId); return
    }
    for (const event of observation.events) apply(target, event)
    // Paused/disarmed durable goals take precedence over turn presence. This
    // never resumes a goal and never interprets arbitrary transcript text.
    if (observation.paused) {
      target.active = false; target.closed = true; target.lifecycle = 'paused'
      forgetPending(target.sessionId)
    }
  }
  const acknowledge = (batch) => {
    if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => message.id === batch.id)
      && !data.admitted.includes(batch.id)) data.admitted.push(batch.id)
    for (const item of batch.items) {
      const target = targets().find((t) => t.sessionId === item.targetId)
      if (target) {
        target.deliveredKey = item.key
        target.deliveryId = batch.id
        target.delivery = heartbeatDispositions(agent.session.snapshotEvents()).get(batch.id) ?? 'unknown'
      }
    }
    const keys = new Set(batch.items.map((item) => item.key))
    data.pending = data.pending.filter((item) => !keys.has(item.key))
    data.batch = null
  }
  const describe = (item) => {
    const target = targets().find((t) => t.sessionId === item.targetId)
    const elapsed = Math.max(0, now() - target.milestoneAt)
    if (item.kind === 'stall') return `${target.sessionId} (${target.source}, assignment ${target.assignmentRef}): no new observable milestone for ${Math.floor(elapsed / 1000)}s; ${target.waiting ? 'waiting on a tool result' : 'progress not observable'}. Last evidence: ${target.milestone}. Decide whether to inspect or clarify scope; do not cancel from silence.`
    return (terminalText?.(target, item) ?? `${target.sessionId} (${target.source}, assignment ${target.assignmentRef}): turn ended ${item.kind}.`)
      + '\nReview the assigned deliverable or blocker and follow through within the original brief; do not automatically restart paused or user-blocked work.'
  }
  const recoverParked = async () => {
    const dispositions = heartbeatDispositions(agent.session.snapshotEvents())
    let changed = false
    for (const target of targets()) {
      if (!target.deliveryId) continue
      const delivery = dispositions.get(target.deliveryId) ?? 'unknown'
      if (target.delivery !== delivery) { target.delivery = delivery; changed = true }
    }
    const inbox = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    const remaining = data.admitted.filter((id) => inbox.some((message) => message.id === id))
    if (remaining.length !== data.admitted.length) { data.admitted = remaining; changed = true }
    if (changed) await persist()
    const recoverable = () => exactOwner() && agent.status === 'idle' && !blocked(agent)
      && agent.inbox.nextStep.length === 0
      && agent.inbox.nextTurn.every((message) => remaining.includes(message.id) || isWakeMarker(message))
    if (!remaining.some((id) => !recoveryWoken.has(id)) || !recoverable()) return
    let claimed = false
    try {
      await agent.runMaintenance(async () => {
        claimed = true
        if (!recoverable()) return
        const id = `heartbeat-resume-${digest(`${agent.id}:${agent.session.seq}:${now()}`)}`
        agent.followup(freezeMessage({ id, role: 'user', source: { kind: 'delegation' }, content: [{ type: 'text', text: WAKE_TEXT }] }))
        for (const id of remaining) recoveryWoken.add(id)
        if (!await flush(agent.session)) throw new Error('heartbeat recovery has no durability listener')
      })
    } catch (error) { if (claimed) throw error }
  }
  const drain = async () => {
    if (!exactOwner() || draining) return
    draining = true
    try {
      // Reconcile admission BEFORE any new send. This covers crash after inbox
      // insertion/flush but before our state receipt, including consumed/canceled
      // items, and remains valid when the chat surface has been compacted.
      if (data.batch && heartbeatAdmissions(agent.session.snapshotEvents()).has(data.batch.id)) {
        if (!await flush(agent.session)) throw new Error('heartbeat admission has no durability listener')
        acknowledge(data.batch); await persist()
      }
      await recoverParked()
      if (!data.pending.length || !canAdmit()) return
      const items = data.pending.slice(0, 8)
      const id = `heartbeat-${digest(`${data.ownerId}:${items.map((p) => p.key).join('|')}`)}`
      data.batch = { id, items }
      await persist() // Durable occurrence/identity BEFORE waking input.
      if (!canAdmit()) return // Human input during persistence wins.
      // runMaintenance atomically claims true idle, not the public idle label.
      // Its callback runs synchronously to first await: no check/send race.
      let claimed = false
      try {
        await agent.runMaintenance(async () => {
          claimed = true
          if (!canAdmit() || items.some((item) => observing.get(item.targetId)?.dirty)) return
          if (heartbeatAdmissions(agent.session.snapshotEvents()).has(id)) {
            if (!await flush(agent.session)) throw new Error('heartbeat admission has no durability listener')
          } else {
            // Park the actual notification without waking. Only after its
            // inbox admission is durably acknowledged may a model-free marker
            // latch a wake behind this idle claim. A failed flush cannot start
            // inference on non-durable input.
            agent.send(freezeMessage({ id, role: 'user', source: { kind: 'delegation' },
              content: [{ type: 'text', text: '[heartbeat supervision: machine-generated evidence, not a human command or approval answer]\n' + items.map(describe).join('\n') }] }), 'next-turn', false)
            if (!await flush(agent.session)) throw new Error('heartbeat admission has no durability listener')
            if (agent.inbox.nextTurn.some((message) => message.id === id)) {
              const wakeId = `heartbeat-resume-${digest(`${agent.id}:${agent.session.seq}:${now()}`)}`
              agent.followup(freezeMessage({ id: wakeId, role: 'user', source: { kind: 'delegation' }, content: [{ type: 'text', text: WAKE_TEXT }] }))
            }
          }
          acknowledge(data.batch)
          await persist()
        })
      } catch (error) {
        // Another maintenance task legitimately owns public idle. Do not poll
        // or infer success; the shared backstop will try at its next deadline.
        if (claimed) throw error
      }
    } finally { draining = false }
  }
  const enroll = (grant, observation, reassign = false) => serial(async () => {
    if (grant.sessionId === data.ownerId || grant.ownerId !== data.ownerId || !await authorize(grant)) throw new Error('unauthorized heartbeat enrollment')
    const header = observation.header
    if (header.id !== grant.sessionId || header.createdAt !== grant.createdAt
      || (header.agentPreset ?? null) !== grant.agentPreset
      || (grant.source === 'delegate' && header.parentSession !== data.ownerId)) throw new Error('heartbeat identity mismatch')
    const existing = targets().find((t) => t.sessionId === grant.sessionId)
    if (existing && !reassign) {
      const sameGrant = ['ownerId', 'sessionId', 'createdAt', 'agentPreset', 'source', 'assignmentRef'].every((key) => existing[key] === grant[key])
      if (sameGrant) return
      // A changed explicit operator grant is a new observation assignment,
      // never an implicit revival from target activity or workspace visibility.
      if (grant.source !== 'observation') throw new Error('heartbeat assignment identity changed')
      reassign = true
    }
    if (existing) { forgetPending(existing.sessionId); data.targets = targets().filter((t) => t !== existing) }
    const last = observation.events.at(-1)
    const started = observation.events.findLast((e) => e.type === 'turn/start')
    const ended = observation.events.findLast((e) => e.type === 'turn/end')
    const active = !observation.paused && !!started && (!ended || started.seq > ended.seq)
    const target = { ...grant, generation: (existing?.generation ?? 0) + 1,
      cursor: last?.seq ?? -1, active, closed: observation.paused || (!reassign && !!ended && !active),
      lifecycle: observation.paused ? 'paused' : active ? 'active' : !reassign && ended ? ended.data.reason.kind : 'assigned',
      milestoneAt: now(), milestoneSeq: last?.seq ?? -1, milestone: 'assignment baseline; no milestone yet',
      lastActivityAt: last?.time ?? now(), seen: [], stallQueued: false, waiting: null }
    data.targets.push(target)
    await persist(); rearm()
  })
  const observe = (sessionId) => {
    const previous = observing.get(sessionId)
    if (previous) { previous.dirty = true; return previous.promise }
    const pending = { dirty: true, promise: null }
    observing.set(sessionId, pending)
    pending.promise = serial(async () => {
      pending.dirty = false
      const target = targets().find((t) => t.sessionId === sessionId)
      if (!target) return
      await scan(target)
      await persist(); await drain(); rearm()
    }).finally(() => {
      observing.delete(sessionId)
      // At most one queued scan per target. Events during IO trigger one tail
      // scan (including terminal events), never a timer delay or unbounded FIFO.
      if (pending.dirty && !disposed && !fault) void observe(sessionId).catch(() => {})
    })
    return pending.promise
  }
  const check = () => serial(async () => {
    const at = now()
    for (const target of targets().filter((t) => !t.closed)) {
      await scan(target)
      if (target.active && !target.closed && !target.stallQueued && at >= target.milestoneAt + settings.stallMs) {
        target.stallQueued = true
        queue(target, 'stall', target.milestoneSeq)
      }
    }
    // A removed config grant revokes queued terminal wakes too.
    for (const item of [...data.pending]) {
      const target = targets().find((t) => t.sessionId === item.targetId)
      if (!target) forgetPending(item.targetId)
      else await scan(target)
    }
    data.lastCheckAt = at; data.nextCheckAt = at + settings.intervalMs
    await persist(); await drain(); rearm()
  })
  const idle = () => serial(async () => {
    for (const item of [...data.pending]) {
      const target = targets().find((t) => t.sessionId === item.targetId)
      if (!target) forgetPending(item.targetId)
      else await scan(target)
    }
    await drain(); rearm()
  })
  return {
    enroll, observe, check, idle,
    restore: () => serial(async () => { for (const target of targets()) await scan(target); await persist(); await drain(); rearm() }),
    snapshot: () => structuredClone(data),
    owns: (sessionId) => targets().some((t) => t.sessionId === sessionId),
    settled: () => tail,
    close() {
      if (disposed) return tail
      disposed = true; cancelTimer?.(); cancelTimer = null
      // Remove only our model-free control markers; never cancel an Agent or a
      // real notification. No orphan marker may reach a model after unload.
      for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) if (isWakeMarker(message)) agent.inbox.remove(message.id)
      disposeFilter()
      return tail
    },

    status: () => ({ enabled: settings.enabled, ready: !fault && exactOwner(), intervalMs: settings.intervalMs, stallMs: settings.stallMs,
      cancellation: false, lastCheckAt: data.lastCheckAt, nextCheckAt: fault || !exactOwner() || data.nextCheckAt === null ? null
        : Math.min(data.nextCheckAt, ...targets().filter((t) => t.active && !t.closed && !t.stallQueued).map((t) => t.milestoneAt + settings.stallMs)),
      trackedCount: targets().length, activeCount: targets().filter((t) => t.active && !t.closed).length,
      queuedWake: data.pending.length, parkedAdmissions: data.admitted.length, error: fault,
      canceledWakeCount: targets().filter((t) => t.delivery === 'canceled').length,
      deliveryWarning: targets().some((t) => t.delivery === 'canceled')
        ? 'Inbox cancellation omits cause (user versus Host teardown); canceled input is not automatically replayed.' : null,
      omittedTargets: Math.max(0, targets().length - 32),
      targets: targets().slice(-32).map((t) => ({ sessionId: t.sessionId, source: t.source, lifecycle: t.lifecycle,
        lastActivityAt: t.lastActivityAt, lastMilestoneAt: t.milestoneAt, milestone: t.milestone,
        stalled: t.stallQueued, waiting: !!t.waiting, delivery: t.delivery ?? null })) }),
  }
}
