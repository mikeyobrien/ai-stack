import { randomUUID } from 'node:crypto';

/** Join the text parts of a DSH message body. */
export function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** Final visible assistant text from one durable session event, or null. */
export function assistantFinalText(event) {
  if (event?.type !== 'assistant/message') return null;
  if (event.data?.interrupted === true) return null;
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null;
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return null;
  // A message that still issues tool calls is a preamble, not the turn's answer.
  if (content.some((part) => part?.type === 'tool-call')) return null;
  const text = textFromContent(content);
  return text.trim() ? text : null;
}

/**
 * Visible user text from one durable session event, or null.
 *
 * 0.2.1-rc.5 v4 records make the payload the message itself: `data.content`
 * plus `data.source`. Synthetic loop traffic (runtime context, time context,
 * heartbeats, skill catalogs) arrives as `user/message` too, so only
 * `source.kind === 'user'` is a real human turn. Telegram-originated prompts
 * also use kind `user`.
 */
export function userMessageText(event) {
  if (event?.type !== 'user/message') return null;
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null;
  if (event.data?.source?.kind !== 'user') return null;
  const text = textFromContent(event.data?.content);
  return text.trim() ? text : null;
}

/**
 * Reasoning digests from one durable assistant message. 0.2.1-rc.5 has no
 * assistant/thinking event: reasoning is a `{type:'reasoning', text}` content
 * block inside `assistant/message.data.message.content` (the same shape as
 * live `agent/assistant-stream` frames).
 */
export function assistantReasoningTexts(event) {
  if (event?.type !== 'assistant/message') return [];
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return [];
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === 'reasoning' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean);
}

/** Last assistant text in a session log; used for restore-with-replay. */
export function lastAssistantTextFromEvents(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event ?? events[index];
    const text = assistantFinalText(event);
    if (text) return text;
  }
  return null;
}

/**
 * Adapter over the host's session service. The bridge is in-host: prompt,
 * cancel and history go through the same Remote the GUI uses, with no HTTP hop
 * and no external poller.
 *
 * 0.2.1-rc.5 Remotes that declare `cancellation: { parameter: 'signal' }` get
 * that signal injected by the RPC gateway. An in-host caller gets no such
 * injection: `SessionController.prompt(request, signal)` calls
 * `signal.throwIfAborted()` unconditionally
 * (`dsh-api-session-controller` lib/index.js:3219), so the adapter owns one
 * lifetime signal and hands it to every Remote that accepts one. Aborting it on
 * `stop()` cancels anything still in flight when the plugin is disposed.
 *
 * History reads use `inspect`, which is cold-safe: for a Session that is not
 * attached it returns the persisted event prefix (lib/index.js:3046-3054 →
 * `inspectApiSession`). `page` is deliberately not used for the replay: its
 * `throughSeq` must be the Session's current cursor, which only `inspect` or a
 * follow snapshot provides, and any larger value is rejected as "past cursor"
 * (lib/index.js:1487). Once `inspect` has returned the full prefix `page` cannot
 * add anything, so the old fallback was both uncallable and redundant.
 */
export function createHostAdapter(services = {}, { logger = console } = {}) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const controller = services.sessionController;
  const requireMethod = (name) => {
    if (typeof controller?.[name] !== 'function') {
      throw new Error(`sessionController.${name} is unavailable; the bridge needs a 0.2.1-compatible DSH host`);
    }
    return controller[name].bind(controller);
  };
  const prompt = requireMethod('prompt');
  const cancel = requireMethod('cancel');
  const list = requireMethod('list');
  const inspect = typeof controller?.inspect === 'function' ? controller.inspect.bind(controller) : null;
  const create = typeof controller?.create === 'function' ? controller.create.bind(controller) : null;

  return {
    /**
     * `requestId` is the prompt's idempotency identity. Callers may pin it (the
     * DM path pins it to the Telegram update identity so a redelivered update
     * cannot double-prompt); unpinned calls keep the fresh-UUID behavior.
     */
    async prompt(sessionId, text, { requestId } = {}) {
      return prompt(
        {
          requestId: typeof requestId === 'string' && requestId ? requestId : randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        signal,
      );
    },

    /**
     * The 0.2.1-rc.5 session/cancel Remote takes only { sessionId } and its
     * implementation calls `agent.cancel({ kind: 'user' }, { keepInbox: true })`
     * (dsh-api-session-controller lib/index.js:1065) — exactly the M8 recovery
     * semantics: stop the stalled turn, keep queued input.
     */
    async cancel(sessionId) {
      return cancel({ sessionId });
    },

    async listSessions() {
      const value = await list({}, signal);
      return Array.isArray(value?.items) ? value.items : [];
    },

    async createSession() {
      if (!create) throw new Error('sessionController.create is unavailable');
      const value = await create({});
      if (typeof value?.sessionId !== 'string') throw new Error('session creation returned no sessionId');
      return value.sessionId;
    },

    async readLastAssistant(sessionId) {
      if (!inspect) return null;
      const inspection = await inspect(sessionId, signal);
      return lastAssistantTextFromEvents(inspection?.events);
    },

    /** Abort in-flight Remote calls and make every later call fail closed. */
    stop() {
      lifetime.abort();
    },
  };
}
