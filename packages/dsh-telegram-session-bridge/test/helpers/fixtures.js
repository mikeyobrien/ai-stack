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

export function assistantEvent(text, { seq = 10, step = 1 } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: { step, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

export function userEvent(text, { seq = 9 } = {}) {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { message: { role: 'user', content: [{ type: 'text', text }] } },
  };
}

export function toolCallEvent(name = 'bash', args = { command: 'ls' }, { seq = 11 } = {}) {
  return {
    type: 'tool/call',
    seq,
    time: Date.now(),
    data: { callId: 'call-1', name, arguments: args },
  };
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
