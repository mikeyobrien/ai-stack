import { createServer } from 'node:http';
import { once } from 'node:events';

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
  constructor({ token = 'bridge-test-token', updates = [], replayAll = false } = {}) {
    this.token = token;
    this.updates = [...updates];
    this.replayAll = replayAll;
    this.hasTopicsEnabled = true;
    this.calls = [];
    this.getUpdatesCalls = [];
    this.messages = [];
    this.edits = [];
    this.callbackAnswers = [];
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
        case 'sendMessage': {
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
