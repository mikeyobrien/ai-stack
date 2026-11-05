import { randomUUID } from 'node:crypto';
import { oneLine } from './util.js';

export const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected']);

function sessionOf(request) {
  const session = request?.agent?.session;
  const sessionId = session?.id ?? request?.agent?.id;
  return { session, sessionId: typeof sessionId === 'string' ? sessionId : null };
}

/** Find the approval/asked event the waterfall request is about. */
export function findApprovalId(session, request) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const decided = new Set();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'approval/decided') {
      decided.add(event.data?.id);
      continue;
    }
    if (event?.type !== 'approval/asked') continue;
    const id = event.data?.id;
    if (!id || decided.has(id)) continue;
    if ((request?.callId ?? null) !== (event.data?.callId ?? null)) continue;
    return id;
  }
  return null;
}

function questionLines(questions) {
  const lines = [];
  questions.forEach((question, questionIndex) => {
    const header = question.header ? `[${question.header}] ` : '';
    lines.push(`${header}${question.question}`);
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      lines.push(`  ${optionIndex + 1}. ${option.label}`);
    }
  });
  return lines.join('\n');
}

function questionKeyboard(rpcId, questions) {
  const rows = [];
  questions.forEach((question, questionIndex) => {
    const options = question.options ?? [];
    // Every option stays answerable: wrap three per row instead of hiding the
    // fourth and later options behind a cut.
    for (let start = 0; start < options.length; start += 3) {
      rows.push(
        options.slice(start, start + 3).map((option, offset) => ({
          text: option.label,
          callback_data: `q:${rpcId}:${questionIndex}:${start + offset}`,
        })),
      );
    }
  });
  if (questions.some((question) => question.multiSelect)) {
    rows.push([{ text: 'Done', callback_data: `q:${rpcId}:done` }]);
  }
  return { inline_keyboard: rows };
}

/**
 * In-host interaction owner for bound sessions only. Approvals and questions
 * arrive as cordis push envelopes; the bridge claims them with a one-shot
 * pending map and lets unbound sessions fall through `next()` to the GUI.
 */
export class Interactions {
  #approvals = new Map();
  #byApprovalId = new Map();
  #questions = new Map();

  constructor({ store, bot, logger = console, clock = () => Date.now(), model = null } = {}) {
    this.store = store;
    this.bot = bot;
    this.logger = logger;
    this.clock = clock;
    this.model = model;
  }

  handleApproval(request, next) {
    const { session, sessionId } = sessionOf(request);
    if (!sessionId) return next();
    const binding = this.store.getBindingForSession(sessionId);
    if (!binding) return next();
    const approvalId = findApprovalId(session, request);
    if (!approvalId) return next();
    const existing = this.#byApprovalId.get(approvalId);
    if (existing) return existing.promise;
    if (request.signal?.aborted) return Promise.resolve('cancelled');

    const pending = {
      rpcId: randomUUID(),
      sessionId,
      approvalId,
      binding,
      settled: false,
      resolve: null,
      promise: null,
      cleanup: null,
    };
    pending.promise = new Promise((resolve) => {
      pending.resolve = resolve;
    });
    this.#approvals.set(pending.rpcId, pending);
    this.#byApprovalId.set(approvalId, pending);
    const onAbort = () => this.#settleApproval(pending, 'cancelled');
    request.signal?.addEventListener?.('abort', onAbort, { once: true });
    pending.cleanup = () => request.signal?.removeEventListener?.('abort', onAbort);

    void this.#presentApproval(pending, request).catch((error) => {
      this.logger?.warn?.(`[telegram-session-bridge] approval delivery failed: ${error?.message ?? error}`);
      this.#settleApproval(pending, 'unavailable');
    });
    return pending.promise;
  }

  async #presentApproval(pending, request) {
    const reason = request?.reason ? `\n${oneLine(request.reason, 300)}` : '';
    const text = `🔐 Approval required: ${request?.toolName ?? 'tool'}${reason}`;
    await this.bot.sendMessage({
      chatId: pending.binding.chatId,
      threadId: pending.binding.threadId,
      text,
      replyMarkup: {
        inline_keyboard: [[
          { text: 'Allow once', callback_data: `a:${pending.rpcId}:allow` },
          { text: 'Reject', callback_data: `a:${pending.rpcId}:reject` },
        ]],
      },
    });
  }

  #settleApproval(pending, outcome) {
    if (pending.settled) return false;
    pending.settled = true;
    pending.cleanup?.();
    this.#approvals.delete(pending.rpcId);
    this.#byApprovalId.delete(pending.approvalId);
    pending.resolve(outcome);
    return true;
  }

  handleQuestion(request, next) {
    const { session, sessionId } = sessionOf(request);
    if (!sessionId) return next();
    const binding = this.store.getBindingForSession(sessionId);
    if (!binding) return next();
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (questions.length === 0) return next();
    if (request.signal?.aborted) return Promise.reject(abortError());

    const pending = {
      rpcId: randomUUID(),
      sessionId,
      binding,
      questions,
      selections: questions.map(() => new Set()),
      settled: false,
      resolve: null,
      reject: null,
      promise: null,
      cleanup: null,
    };
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    this.#questions.set(pending.rpcId, pending);
    const onAbort = () => this.#settleQuestionCancelled(pending);
    request.signal?.addEventListener?.('abort', onAbort, { once: true });
    pending.cleanup = () => request.signal?.removeEventListener?.('abort', onAbort);

    void this.#presentQuestion(pending).catch((error) => {
      this.logger?.warn?.(`[telegram-session-bridge] question delivery failed: ${error?.message ?? error}`);
      this.#settleQuestionCancelled(pending);
    });
    return pending.promise;
  }

  async #presentQuestion(pending) {
    await this.bot.sendMessage({
      chatId: pending.binding.chatId,
      threadId: pending.binding.threadId,
      text: `❓ ${questionLines(pending.questions)}`,
      replyMarkup: questionKeyboard(pending.rpcId, pending.questions),
    });
  }

  #answerValue(pending, selected) {
    return {
      answers: pending.questions.map((question, questionIndex) => ({
        id: question.id,
        selected: [...(selected[questionIndex] ?? new Set())],
      })),
    };
  }

  #settleQuestionAnswered(pending, value) {
    if (pending.settled) return false;
    pending.settled = true;
    pending.cleanup?.();
    this.#questions.delete(pending.rpcId);
    pending.resolve(value);
    return true;
  }

  #settleQuestionCancelled(pending) {
    if (pending.settled) return false;
    pending.settled = true;
    pending.cleanup?.();
    this.#questions.delete(pending.rpcId);
    pending.reject(abortError());
    return true;
  }

  async handleCallback(query) {
    const data = typeof query?.data === 'string' ? query.data : '';
    const [kind, rpcId, first, second] = data.split(':');
    try {
      if (kind === 'a' && rpcId) return await this.#handleApprovalCallback(query, rpcId, first);
      if (kind === 'q' && rpcId) return await this.#handleQuestionCallback(query, rpcId, first, second);
      if (kind === 'm' && this.model !== null) return await this.model.handleCallback(query);
      await this.#answerCallback(query, 'This prompt is no longer active', true);
      return { accepted: false, reason: 'not-pending' };
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] callback failed: ${error?.message ?? error}`);
      return { accepted: false, reason: 'error' };
    }
  }

  async #handleApprovalCallback(query, rpcId, action) {
    const pending = this.#approvals.get(rpcId);
    if (!pending) {
      await this.#answerCallback(query, 'This approval is no longer active', true);
      return { accepted: false, reason: 'not-pending' };
    }
    const outcome = action === 'allow' ? 'allowed-once' : action === 'reject' ? 'rejected' : null;
    if (!outcome) {
      await this.#answerCallback(query, 'Unsupported response', true);
      return { accepted: false, reason: 'bad-response' };
    }
    // One-shot: first respond wins, every later press is stale.
    const accepted = this.#settleApproval(pending, outcome);
    await this.#answerCallback(query, outcome === 'allowed-once' ? 'Allowed once' : 'Rejected');
    await this.#editCard(query, outcome === 'allowed-once' ? '✅ Allowed once' : '❌ Rejected');
    return { accepted, kind: 'approval', outcome };
  }

  async #handleQuestionCallback(query, rpcId, questionPart, optionPart) {
    const pending = this.#questions.get(rpcId);
    if (!pending) {
      await this.#answerCallback(query, 'This question is no longer active', true);
      return { accepted: false, reason: 'not-pending' };
    }
    if (questionPart === 'done') {
      if (pending.selections.some((selection) => selection.size === 0)) {
        await this.#answerCallback(query, 'Answer every question first', true);
        return { accepted: false, reason: 'incomplete' };
      }
      const value = this.#answerValue(pending, pending.selections);
      this.#settleQuestionAnswered(pending, value);
      await this.#answerCallback(query, 'Answered');
      await this.#editCard(query, '✅ Answered');
      return { accepted: true, kind: 'question', value };
    }
    const questionIndex = Number(questionPart);
    const optionIndex = Number(optionPart);
    const question = pending.questions[questionIndex];
    const option = question?.options?.[optionIndex];
    if (!option) {
      await this.#answerCallback(query, 'Unsupported response', true);
      return { accepted: false, reason: 'bad-response' };
    }
    const selection = pending.selections[questionIndex];
    if (question.multiSelect) {
      if (selection.has(option.label)) selection.delete(option.label);
      else selection.add(option.label);
      await this.#answerCallback(query, `${selection.has(option.label) ? 'Selected' : 'Deselected'} ${option.label}`);
      return { accepted: true, kind: 'question', pending: true };
    }
    pending.selections[questionIndex] = new Set([option.label]);
    if (pending.selections.every((entry) => entry.size > 0)) {
      const value = this.#answerValue(pending, pending.selections);
      this.#settleQuestionAnswered(pending, value);
      await this.#answerCallback(query, 'Answered');
      await this.#editCard(query, '✅ Answered');
      return { accepted: true, kind: 'question', value };
    }
    await this.#answerCallback(query, 'Selected');
    return { accepted: true, kind: 'question', pending: true };
  }

  async #answerCallback(query, text, showAlert = false) {
    if (!query?.id) return;
    try {
      await this.bot.answerCallbackQuery({ callbackQueryId: query.id, text, showAlert });
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] answerCallbackQuery failed: ${error?.message ?? error}`);
    }
  }

  async #editCard(query, text) {
    const message = query?.message;
    const chatId = message?.chat?.id;
    if (typeof chatId !== 'number' || !Number.isSafeInteger(message?.message_id)) return;
    try {
      await this.bot.editMessageText({
        chatId,
        threadId: message.message_thread_id ?? 0,
        messageId: message.message_id,
        text,
        replyMarkup: { inline_keyboard: [] },
      });
    } catch (error) {
      this.logger?.warn?.(`[telegram-session-bridge] card edit failed: ${error?.message ?? error}`);
    }
  }
}

function abortError() {
  const error = new Error('the question was retired before it was answered');
  error.code = 'ASK_ABORTED';
  return error;
}
