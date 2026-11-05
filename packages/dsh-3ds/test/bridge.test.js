import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';

import {
  Bridge,
  displayItem,
  messageText,
  pairingPayload,
  renderInkPng,
  renderQrSvg,
  tokenMatches,
} from '../index.js';

/** A wait helper that fails with the last response body. */
async function waitFor(check, label = 'condition') {
  const deadline = Date.now() + 3000;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Minimal WAV body; the fake recognizer ignores samples. */
function wavBytes() {
  const audio = Buffer.alloc(44 + 320);
  audio.write('RIFF', 0, 'ascii');
  audio.writeUInt32LE(36 + 320, 4);
  audio.write('WAVE', 8, 'ascii');
  audio.write('fmt ', 12, 'ascii');
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36, 'ascii');
  audio.writeUInt32LE(320, 40);
  return audio;
}

/** Fake Host services with a push-driven follow stream. */
class FakeHost {
  constructor() {
    this.prompts = [];
    this.cancelled = [];
    this.queues = new Map();
    this.items = [
      {
        sessionId: 's-one',
        running: false,
        blank: false,
        updatedAt: Date.now(),
        projections: { values: { title: 'Bridge test' } },
      },
      {
        sessionId: 's-two',
        running: true,
        blank: false,
        updatedAt: Date.now() - 1000,
        projections: { values: { title: 'Second' } },
      },
      {
        sessionId: 'child',
        parentSessionId: 's-one',
        origin: 'subagent',
        running: false,
        blank: false,
        updatedAt: Date.now(),
        projections: { values: {} },
      },
    ];
  }

  push(sessionId, event) {
    const queue = this.queues.get(sessionId);
    if (queue !== undefined) queue.push(event);
  }

  async list() {
    return { items: this.items };
  }

  async create() {
    return { sessionId: 's-new', agentPreset: undefined };
  }

  async prompt(request) {
    this.prompts.push(request);
    const queue = this.queues.get(request.sessionId) ?? [];
    this.queues.set(request.sessionId, queue);
    this.push(request.sessionId, { type: 'turn/start', seq: 4, data: { turn: 1 } });
    this.push(request.sessionId, {
      type: 'user/message',
      seq: 5,
      data: { source: { kind: 'user' }, content: request.content.filter((part) => part.type === 'text') },
    });
    this.push(request.sessionId, {
      type: 'assistant/message',
      seq: 6,
      data: { message: { content: [{ type: 'text', text: 'Done' }] } },
    });
    this.push(request.sessionId, { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } } });
    return { accepted: true };
  }

  async cancel(request) {
    this.cancelled.push(request.sessionId);
    return { accepted: true };
  }

  async *follow(request, signal) {
    const sessionId = request.address.sessionId;
    if (!this.queues.has(sessionId)) this.queues.set(sessionId, []);
    yield {
      type: 'snapshot',
      cursor: 3,
      hasMore: false,
      records: [
        { type: 'event', event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Hi' }] } } },
        { type: 'event', event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'Hello' }] } } } },
      ],
      projections: { asOfSeq: 3, values: { title: 'Bridge test' } },
    };
    while (!signal.aborted) {
      const queue = this.queues.get(sessionId);
      const next = queue?.shift();
      if (next !== undefined) yield { type: 'event', event: next };
      else await delay(5);
    }
  }
}

class FakeSpeech {
  constructor() {
    this.requests = [];
  }

  resolve(request) {
    this.requests.push(request);
    return { ...request, provider: this };
  }

  async transcribe(spec) {
    assert.ok(spec.audio instanceof Uint8Array);
    return { text: 'send the report', audioSeconds: 1, inferenceSeconds: 0.1 };
  }
}

test('token comparison accepts only the exact secret', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches(undefined, 'abc'), false);
});

test('pairing payload is compact JSON a console can parse', () => {
  const payload = JSON.parse(pairingPayload({ origin: 'http://192.168.1.50:7080', token: 'secret-token-1234567890', name: 'columba' }));
  assert.deepEqual(payload, { v: 1, url: 'http://192.168.1.50:7080', token: 'secret-token-1234567890', name: 'columba' });
});

test('QR SVG carries a quiet zone and a dark module path', () => {
  const svg = renderQrSvg('{"v":1,"url":"http://127.0.0.1:7080"}', { size: 300, margin: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /width="300" height="300"/);
  assert.match(svg, /<path d="M/);
  assert.match(svg, /fill="#000000"/);
});

test('harness instruction messages stay out of the console transcript', () => {
  assert.equal(displayItem({ type: 'user/message', seq: 4, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'context' }] } }), undefined);
});

test('message projection keeps text and notes images', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'one' }, { type: 'image' }] }), 'one\n[image]');
  assert.equal(displayItem({ type: 'tool/call', seq: 2, data: {} }), undefined);
  assert.deepEqual(displayItem({ type: 'user/message', seq: 9, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }), {
    seq: 9,
    role: 'user',
    text: 'hi',
  });
});

test('ink renders a valid RGB PNG with dark pixels', () => {
  const png = renderInkPng({ width: 100, height: 80, strokes: [[10, 10, 80, 40]] });
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 100 * 2 + 32);
  assert.equal(png.readUInt32BE(20), 80 * 2 + 32);
  const idat = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  assert.ok(raw.includes(Buffer.from([0x18, 0x18, 0x18])), 'the stroke is painted');
});

test('bridge exposes sessions, prompts, voice, ink, and cancellation', async (t) => {
  const host = new FakeHost();
  const speech = new FakeSpeech();
  const bridge = new Bridge({
    sessionController: host,
    speechToText: speech,
    host: '127.0.0.1',
    port: 0,
    advertiseHost: '192.168.1.50',
    tokenPath: '/tmp/dsh-3ds-test-token.json',
    logger: { warn() {} },
  });
  await bridge.start();
  t.after(() => bridge.stop());

  const base = `http://127.0.0.1:${new URL(bridge.origin).port}`;
  const token = bridge.token;
  const headers = { 'x-3ds-token': token, 'content-type': 'application/json' };

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const denied = await fetch(`${base}/api/hello`);
  assert.equal(denied.status, 401);

  const helloResponse = await fetch(`${base}/api/hello`, { headers: { 'x-3ds-token': token } });
  const hello = await helloResponse.json();
  assert.equal(hello.ok, true);
  assert.equal(hello.sessions.length, 2);
  assert.equal(hello.sessions[0].id, 's-one');
  assert.equal(hello.sessions[0].title, 'Bridge test');
  assert.equal(typeof bridge.status().token, 'string');
  assert.ok(bridge.status().token.length >= 24);

  const promptResponse = await fetch(`${base}/api/prompt?sessionId=s-one`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Run the tests' }),
  });
  assert.equal(promptResponse.status, 200);
  assert.equal(host.prompts.length, 1);
  assert.deepEqual(host.prompts[0].content, [{ type: 'text', text: 'Run the tests' }]);

  const state = await waitFor(async () => {
    const response = await fetch(`${base}/api/state?sessionId=s-one&after=0`, { headers: { 'x-3ds-token': token } });
    const value = await response.json();
    return value.session?.messages?.some((item) => item.text === 'Done') ? value : undefined;
  }, 'the assistant reply');
  assert.equal(state.session.title, 'Bridge test');
  assert.equal(state.session.ready, true);
  assert.equal(state.session.running, false);
  const assistant = state.session.messages.find((item) => item.role === 'assistant' && item.text === 'Done');
  assert.ok(assistant.seq > 5);

  const voiceResponse = await fetch(`${base}/api/voice?sessionId=s-one`, {
    method: 'POST',
    headers: { 'x-3ds-token': token, 'content-type': 'audio/wav' },
    body: wavBytes(),
  });
  const voice = await voiceResponse.json();
  assert.equal(voiceResponse.status, 200);
  assert.equal(voice.text, 'send the report');
  assert.equal(host.prompts.at(-1).content[0].text, 'send the report');
  assert.equal(speech.requests.length, 1);

  const inkResponse = await fetch(`${base}/api/ink?sessionId=s-one`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ width: 120, height: 80, strokes: [[10, 10, 70, 40, 100, 20]] }),
  });
  assert.equal(inkResponse.status, 200);
  const inkPrompt = host.prompts.at(-1);
  assert.equal(inkPrompt.content[0].type, 'text');
  assert.equal(inkPrompt.content[1].type, 'image');
  const image = Buffer.from(inkPrompt.content[1].data, 'base64');
  assert.equal(image.toString('ascii', 1, 4), 'PNG');

  const emptyInk = await fetch(`${base}/api/ink?sessionId=s-one`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ width: 320, height: 200, strokes: [] }),
  });
  assert.equal(emptyInk.status, 400);

  const cancelResponse = await fetch(`${base}/api/cancel?sessionId=s-one`, { method: 'POST', headers });
  assert.equal(cancelResponse.status, 200);
  assert.deepEqual(host.cancelled, ['s-one']);

  const created = await fetch(`${base}/api/session/new`, { method: 'POST', headers });
  assert.equal((await created.json()).sessionId, 's-new');
});

test('bridge pages the transcript by sequence', async (t) => {
  const host = new FakeHost();
  const bridge = new Bridge({
    sessionController: host,
    host: '127.0.0.1',
    port: 0,
    advertiseHost: '127.0.0.1',
    tokenPath: '/tmp/dsh-3ds-test-token.json',
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const base = `http://127.0.0.1:${new URL(bridge.origin).port}`;
  const headers = { 'x-3ds-token': bridge.token, 'content-type': 'application/json' };
  const first = await waitFor(async () => {
    const value = await (await fetch(`${base}/api/state?sessionId=s-one&after=0`, { headers })).json();
    return value.session?.messages?.length === 2 ? value : undefined;
  }, 'the opening snapshot');
  assert.equal(first.session.messages[0].text, 'Hi');
  assert.equal(first.session.messages[1].text, 'Hello');
  assert.equal(first.session.cursor, 3);
  const next = await (await fetch(`${base}/api/state?sessionId=s-one&after=3`, { headers })).json();
  assert.equal(next.session.messages.length, 0);
});
