import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function makeTempDir(prefix = 'dsh-telegram-bridge-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(dir) {
  if (dir) await rm(dir, { recursive: true, force: true });
}

export async function readState(dir) {
  return JSON.parse(await readFile(join(dir, 'telegram-session-bridge', 'state.json'), 'utf8'));
}

export async function stateStat(dir) {
  return stat(join(dir, 'telegram-session-bridge', 'state.json'));
}

export function messageUpdate({ updateId = 1, chatId = 111, threadId = 42, messageId = 9, text = 'hi' } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: threadId > 0 ? 'supergroup' : 'private' },
      ...(threadId > 0 ? { message_thread_id: threadId, is_topic_message: true } : {}),
      text,
    },
  };
}

export function callbackUpdate({ updateId = 2, chatId = 111, threadId = 42, messageId = 10, data, callbackId = 'cb-1' } = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: 5, is_bot: false, first_name: 'operator' },
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'supergroup' },
        ...(threadId > 0 ? { message_thread_id: threadId } : {}),
      },
      data,
    },
  };
}

/**
 * Durable events shaped exactly like a 0.2.1-rc.5 v4 session log, captured from
 * real `~/.dsh/sessions/<project>/session.v4.jsonl.zstd` records. Hand-made shapes hid
 * a broken user-turn echo (data.content, not data.message) and dead reasoning
 * digests (a content block, not an assistant/thinking event).
 */
export function assistantEvent(text, { seq = 10, step = 1, turn = 1, reasoning } = {}) {
  const content = [];
  if (reasoning) content.push({ type: 'reasoning', text: reasoning });
  content.push({ type: 'text', text });
  return {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'test', model: 'test-model' },
        id: `assistant-message-${seq}`,
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  };
}

export function userEvent(text, { seq = 9, sourceKind = 'user' } = {}) {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    surfaceOp: 'append',
    data: {
      content: [{ type: 'text', text }],
      source: { kind: sourceKind },
      role: 'user',
      id: `user-message-${seq}`,
    },
  };
}

/** Synthetic loop context also arrives as user/message; never echo it. */
export function syntheticUserEvent(kind, text, { seq = 9 } = {}) {
  return userEvent(text, { seq, sourceKind: kind });
}

export function toolCallEvent(name = 'bash', args = { command: 'ls' }, { seq = 11, turn = 1, step = 1 } = {}) {
  return {
    type: 'tool/call',
    seq,
    time: Date.now(),
    data: {
      turn,
      step,
      callId: 'call-1',
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

export function turnStartEvent({ seq = 1, turn = 1 } = {}) {
  return { type: 'turn/start', seq, time: Date.now(), data: { turn } };
}

export function turnEndEvent({ seq = 20, turn = 1, reason = { kind: 'completed' } } = {}) {
  return { type: 'turn/end', seq, time: Date.now(), data: { turn, reason } };
}

export function approvalRequest({ sessionId = 'session-1', approvalId = 'approval-1', callId = 'call-1', toolName = 'bash', reason = 'rm -rf /tmp/x', signal } = {}) {
  return {
    agent: {
      id: sessionId,
      session: {
        id: sessionId,
        events: [
          { type: 'turn/start', seq: 1, data: { turn: 1 } },
          { type: 'approval/asked', seq: 2, data: { id: approvalId, callId } },
        ],
      },
    },
    callId,
    toolName,
    reason,
    signal,
  };
}

export function questionRequest({ sessionId = 'session-1', questions, signal } = {}) {
  return {
    agent: {
      id: sessionId,
      session: { id: sessionId, events: [{ type: 'turn/start', seq: 1, data: { turn: 1 } }] },
    },
    questions,
    signal,
  };
}

export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Poll until the async bot round-trip has produced the expected side effect. */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}
