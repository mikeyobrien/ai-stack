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
 */
export function createHostAdapter(services = {}, { logger = console } = {}) {
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
  const page = typeof controller?.page === 'function' ? controller.page.bind(controller) : null;
  const inspect = typeof controller?.inspect === 'function' ? controller.inspect.bind(controller) : null;
  const create = typeof controller?.create === 'function' ? controller.create.bind(controller) : null;

  return {
    async prompt(sessionId, text) {
      return prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      });
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
      const value = await list({});
      return Array.isArray(value?.items) ? value.items : [];
    },

    async createSession() {
      if (!create) throw new Error('sessionController.create is unavailable');
      const value = await create({});
      if (typeof value?.sessionId !== 'string') throw new Error('session creation returned no sessionId');
      return value.sessionId;
    },

    async readLastAssistant(sessionId) {
      if (inspect) {
        const inspection = await inspect(sessionId);
        const text = lastAssistantTextFromEvents(inspection?.events);
        if (text) return text;
      }
      if (!page) return null;
      const value = await page({
        address: { kind: 'session', sessionId },
        throughSeq: Number.MAX_SAFE_INTEGER,
        maxMessages: 40,
      });
      return lastAssistantTextFromEvents(value?.records);
    },
  };
}
