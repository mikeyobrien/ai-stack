import { createServer } from 'node:http';
import { once } from 'node:events';

function fakeScopeKey(scope) {
  if (scope === undefined || scope === null) return 'default';
  if (scope.type === 'chat') return `chat:${scope.chat_id}`;
  return scope.type;
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

/**
 * Fake Telegram Bot API on 127.0.0.1. Real HTTP + the real JSON shapes, so the
 * plugin exercises fetch, long-polling, chunking and callback payloads rather
 * than a mocked method table.
 */
export class FakeBotApi {
  constructor({ token = 'bridge-test-token', updates = [], replayAll = false, rejectParseEntities = 0 } = {}) {
    this.token = token;
    this.updates = [...updates];
    this.replayAll = replayAll;
    // Number of HTML sends to reject with Telegram's real
    // 400 "can't parse entities" response before accepting again.
    this.rejectParseEntities = rejectParseEntities;
    this.hasTopicsEnabled = true;
    this.calls = [];
    this.getUpdatesCalls = [];
    this.messages = [];
    this.edits = [];
    this.callbackAnswers = [];
    this.chatActions = [];
    this.reactions = [];
    this.failedReactions = [];
    this.commandsByScope = { default: [], all_private_chats: [], all_group_chats: [], all_chat_administrators: [] };
    this.menuButtons = new Map();
    this.failSetCommands = false;
    this.dropCommands = false;
    // Number of setMessageReaction calls to reject with Telegram's real 400
    // "message to react not found" response before accepting again.
    this.failReactions = 0;
    this.messageId = 100;
    this.server = createServer((request, response) => this.#handle(request, response));
  }

  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.port = this.server.address().port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async stop() {
    if (!this.server.listening) return;
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  pushUpdate(update) {
    this.updates.push(update);
  }

  reset() {
    this.calls = [];
    this.getUpdatesCalls = [];
    this.messages = [];
    this.edits = [];
    this.callbackAnswers = [];
    this.chatActions = [];
    this.reactions = [];
    this.failedReactions = [];
  }

  #handle(request, response) {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let params = {};
      try {
        params = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(response, 400, { ok: false, description: 'bad json' });
        return;
      }
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(new URL(request.url, 'http://127.0.0.1').pathname);
      if (!match) {
        sendJson(response, 404, { ok: false, description: 'not found' });
        return;
      }
      const [, token, method] = match;
      if (token !== this.token) {
        sendJson(response, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }
      this.calls.push({ method, params });
      switch (method) {
        case 'getMe':
          sendJson(response, 200, {
            ok: true,
            result: {
              id: 777,
              is_bot: true,
              first_name: 'bridge',
              username: 'bridge_test_bot',
              has_topics_enabled: this.hasTopicsEnabled,
            },
          });
          return;
        case 'getUpdates': {
          this.getUpdatesCalls.push(params);
          const offset = Number(params.offset ?? 0);
          const result = this.replayAll ? this.updates : this.updates.filter((update) => update.update_id >= offset);
          sendJson(response, 200, { ok: true, result });
          return;
        }
        case 'getMyCommands': {
          const key = fakeScopeKey(params.scope);
          const commands = key.startsWith('chat:') ? this.commandsByScope[key] ?? [] : this.commandsByScope[key] ?? [];
          sendJson(response, 200, { ok: true, result: commands.map((entry) => ({ ...entry })) });
          return;
        }
        case 'setMyCommands': {
          if (this.failSetCommands) {
            sendJson(response, 500, { ok: false, error_code: 500, description: 'fixture setMyCommands failure' });
            return;
          }
          if (!this.dropCommands) {
            const key = fakeScopeKey(params.scope);
            this.commandsByScope[key] = (params.commands ?? []).map((entry) => ({ ...entry }));
          }
          sendJson(response, 200, { ok: true, result: true });
          return;
        }
        case 'getChatMenuButton': {
          const chatId = params.chat_id;
          sendJson(response, 200, { ok: true, result: this.menuButtons.get(chatId) ?? { type: 'default' } });
          return;
        }
        case 'setChatMenuButton': {
          this.menuButtons.set(params.chat_id, params.menu_button ?? { type: 'default' });
          sendJson(response, 200, { ok: true, result: true });
          return;
        }
        case 'sendMessage': {
          if (params.parse_mode === 'HTML' && this.rejectParseEntities > 0) {
            this.rejectParseEntities -= 1;
            sendJson(response, 400, {
              ok: false,
              error_code: 400,
              description: "Bad Request: can't parse entities: Unsupported start tag",
            });
            return;
          }
          this.messages.push({ ...params });
          this.messageId += 1;
          sendJson(response, 200, {
            ok: true,
            result: {
              message_id: this.messageId,
              chat: { id: params.chat_id },
              message_thread_id: params.message_thread_id,
            },
          });
          return;
        }
        case 'sendChatAction': {
          this.chatActions.push({ ...params });
          sendJson(response, 200, { ok: true, result: true });
          return;
        }
        case 'setMessageReaction': {
          if (this.failReactions > 0) {
            this.failReactions -= 1;
            this.failedReactions.push({ ...params });
            sendJson(response, 400, {
              ok: false,
              error_code: 400,
              description: 'Bad Request: message to react not found',
            });
            return;
          }
          this.reactions.push({ ...params });
          sendJson(response, 200, { ok: true, result: true });
          return;
        }
        case 'editMessageText': {
          this.edits.push({ ...params });
          sendJson(response, 200, { ok: true, result: true });
          return;
        }
        case 'answerCallbackQuery': {
          this.callbackAnswers.push({ ...params });
          sendJson(response, 200, { ok: true, result: true });
          return;
        }
        default:
          sendJson(response, 404, { ok: false, description: `unsupported method ${method}` });
      }
    });
  }
}
