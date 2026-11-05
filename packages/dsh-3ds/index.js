/**
 * DSH Link — the Host half.
 *
 * A plain-HTTP bridge for the New 3DS XL app. The bridge advertises a pairing
 * QR code in the Web UI, then drives ordinary DSH sessions on the console's
 * behalf: it lists sessions, admits typed prompts, transcribes microphone
 * recordings through the composed speech service, and forwards stylus notes as
 * image attachments.
 *
 * The bridge is deliberately a separate LAN listener. A stock 3DS has no TLS
 * stack that can reach the Harness origin, so the QR carries a short-lived
 * route to this listener rather than the Harness URL. The token is the only
 * credential; it stays on the profile's home directory and on the SD card.
 *
 * @module @local/dsh-3ds
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const qrcode = require('./vendor/qrcode.cjs');

/** Wire protocol version understood by the 3DS app. */
export const PROTOCOL_VERSION = 1;

/** Default LAN port; the QR carries the exact port actually bound. */
export const DEFAULT_PORT = 7080;

/** Largest prompt a single 3DS message may carry. */
const MAX_PROMPT_CHARS = 12000;

/** Largest WAV upload accepted from the microphone endpoint. */
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

/** Largest ink request accepted from the touchscreen. */
const MAX_INK_BYTES = 512 * 1024;

/** Messages kept per followed session. */
const MAX_MESSAGES = 160;

/** Messages returned for a fresh transcript request. */
const INITIAL_MESSAGES = 40;

/** Sessions listed to the console. */
const MAX_SESSIONS = 40;

/** One followed session is released after this much console inactivity. */
const FEED_IDLE_MS = 15 * 60_000;

/** Summary rows are reused for this long between state polls. */
const SUMMARY_TTL_MS = 4_000;

/** The token file's basename under the DSH home. */
const TOKEN_FILE = '3ds-bridge.json';

/** The console's language hint for transcription. */
const DEFAULT_LANGUAGE = 'en';

/** Eight-bit QR modules in the generated SVG. */
const QR_QUIET_ZONE = 4;

/**
 * A failure the console can show verbatim.
 */
export class BridgeError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - short user-facing sentence.
   * @param {number} [status] - HTTP status.
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Compare two secrets without leaking their first differing byte.
 * @param {unknown} given - credential presented by the console.
 * @param {unknown} expected - credential held by the Host.
 * @returns {boolean} whether they match.
 */
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length === 0 || expected.length === 0) return false;
  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Choose the LAN address a console on the same network can reach.
 * @returns {string[]} routable IPv4 addresses, best candidate first.
 */
export function lanAddresses() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/^(lo|tailscale|docker|br-|veth|virbr)/.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      candidates.push(address.address);
    }
  }
  const rank = (address) => {
    if (address.startsWith('192.168.')) return 0;
    if (address.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
    if (address.startsWith('169.254.')) return 9;
    return 5;
  };
  return candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Build the pairing payload the QR encodes. The console parses this as JSON.
 * @param {{ origin: string, token: string, name?: string }} input - bridge facts.
 * @returns {string} compact JSON text.
 */
export function pairingPayload({ origin, token, name }) {
  return JSON.stringify({ v: PROTOCOL_VERSION, url: origin, token, name: name ?? hostname() });
}

/**
 * Render one QR code as a standalone SVG document.
 * @param {string} text - payload to encode.
 * @param {{ size?: number, margin?: number }} [options] - pixel size and quiet zone.
 * @returns {string} SVG markup.
 */
export function renderQrSvg(text, options = {}) {
  const size = Math.min(640, Math.max(96, Math.trunc(options.size ?? 240)));
  const margin = Math.min(8, Math.max(2, Math.trunc(options.margin ?? QR_QUIET_ZONE)));
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const parts = [];
  for (let row = 0; row < count; row += 1) {
    let run = -1;
    for (let column = 0; column <= count; column += 1) {
      const dark = column < count && qr.isDark(row, column);
      if (dark && run < 0) run = column;
      if (!dark && run >= 0) {
        parts.push(`M${run} ${row}h${column - run}v1h-${column - run}z`);
        run = -1;
      }
    }
  }
  const span = count + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-margin} ${-margin} ${span} ${span}" shape-rendering="crispEdges"><rect x="${-margin}" y="${-margin}" width="${span}" height="${span}" fill="#ffffff"/><path d="${parts.join('')}" fill="#000000"/></svg>`;
}

/**
 * Flatten one Messages content array into displayable text.
 * @param {unknown} message - wire user or assistant message.
 * @returns {string} text blocks joined by newlines; empty when none.
 */
export function messageText(message) {
  const content = message && typeof message === 'object' && Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('\n').trim();
}

/**
 * Derive the console transcript item for one durable session event.
 * @param {{ type: string, seq: number, data: any }} event - wire event.
 * @returns {{ seq: number, role: 'user' | 'assistant', text: string } | undefined} display item.
 */
export function displayItem(event) {
  if (!event || typeof event !== 'object') return undefined;
  if (event.type === 'user/message') {
    // Harness instructions, runtime context, and skill catalogs ride the user
    // role too. Only an actual person is part of the console transcript.
    if (event.data?.source?.kind !== 'user') return undefined;
    const text = messageText(event.data);
    return text === '' ? undefined : { seq: event.seq, role: 'user', text: truncate(text, 4000) };
  }
  if (event.type === 'assistant/message') {
    const text = messageText(event.data?.message);
    return text === '' ? undefined : { seq: event.seq, role: 'assistant', text: truncate(text, 8000) };
  }
  return undefined;
}

/** Shorten a string to a code-point budget without splitting a surrogate pair. */
function truncate(text, limit) {
  if (text.length <= limit) return text;
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n...`;
}

/** Clamp a number into an integer range. */
function clampInt(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

/** Read an untrusted JSON body field as a string. */
function stringField(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/**
 * Render stylus strokes to a PNG the vision model can read.
 *
 * The console sends flat coordinate arrays; the bridge pads the canvas, draws
 * with a fixed pen width, and encodes a plain RGB PNG. No third-party image
 * code runs on the Host.
 *
 * @param {{ width?: unknown, height?: unknown, strokes?: unknown }} input - wire ink.
 * @returns {Buffer} PNG bytes.
 */
export function renderInkPng(input) {
  const width = clampInt(input?.width, 64, 1024, 320);
  const height = clampInt(input?.height, 64, 768, 180);
  const strokes = Array.isArray(input?.strokes) ? input.strokes : [];
  const scale = 2;
  const pad = 16;
  const outWidth = width * scale + pad * 2;
  const outHeight = height * scale + pad * 2;
  const pixels = Buffer.alloc(outWidth * outHeight * 3, 0xff);
  const radius = 2 * scale;
  const stamp = (cx, cy) => {
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(outWidth - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(outHeight - 1, Math.ceil(cy + radius));
    const r2 = radius * radius;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r2) continue;
        const offset = (y * outWidth + x) * 3;
        pixels[offset] = 0x18;
        pixels[offset + 1] = 0x18;
        pixels[offset + 2] = 0x18;
      }
    }
  };
  let points = 0;
  let last = undefined;
  for (const stroke of strokes) {
    if (!Array.isArray(stroke)) continue;
    let previous;
    for (let index = 0; index + 1 < stroke.length; index += 2) {
      const x = Number(stroke[index]);
      const y = Number(stroke[index + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const px = (Math.min(width - 1, Math.max(0, x)) + 0.5) * scale + pad;
      const py = (Math.min(height - 1, Math.max(0, y)) + 0.5) * scale + pad;
      if (previous !== undefined) {
        const dx = px - previous[0];
        const dy = py - previous[1];
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 1.5));
        for (let step = 0; step <= steps; step += 1) {
          const t = step / steps;
          stamp(previous[0] + dx * t, previous[1] + dy * t);
          points += 1;
          if (points > 200_000) break;
        }
      } else {
        stamp(px, py);
        points += 1;
      }
      previous = [px, py];
      if (points > 200_000) break;
    }
    last = previous;
    if (points > 200_000) break;
  }
  if (last === undefined) {
    // An empty canvas is still a valid image; the caller rejects it before
    // reaching this point, but keeping the renderer total avoids a partial
    // request if that check ever widens.
    stamp(pad, pad);
  }
  return encodePng(pixels, outWidth, outHeight);
}

/** CRC-32 table used by PNG chunks. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Compute a PNG CRC. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build one PNG chunk. */
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode raw RGB pixels as a PNG. */
function encodePng(rgb, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One live transcript feed for a session the console is watching. */
class SessionFeed {
  /** @type {Bridge} */
  #bridge;
  /** @type {string} */
  #sessionId;
  #controller = new AbortController();
  #messages = [];
  #live = '';
  #cursor = 0;
  #running = false;
  #hasTurnState = false;
  #title = '';
  #closed = false;
  #started = false;
  #ready = false;
  #lastAccess = Date.now();
  #error = '';

  /**
   * @param {Bridge} bridge - owner.
   * @param {string} sessionId - ordinary session id.
   */
  constructor(bridge, sessionId) {
    this.#bridge = bridge;
    this.#sessionId = sessionId;
  }

  /** Start following once. */
  start() {
    if (this.#started) return;
    this.#started = true;
    void this.#follow();
  }

  /** Mark console activity so idle cleanup leaves this feed alone. */
  touch() {
    this.#lastAccess = Date.now();
  }

  /** Whether the feed has been idle long enough to release. */
  get stale() {
    return Date.now() - this.#lastAccess > FEED_IDLE_MS;
  }

  /** Current display snapshot. */
  state(after) {
    const rows = after > 0 ? this.#messages.filter((item) => item.seq > after) : this.#messages.slice(-INITIAL_MESSAGES);
    return {
      id: this.#sessionId,
      title: this.#title,
      running: this.#hasTurnState ? this.#running : this.#bridge.runningHint(this.#sessionId, this.#running),
      cursor: this.#cursor,
      ready: this.#ready,
      live: this.#live,
      messages: rows.map((item) => ({ ...item })),
      error: this.#error,
    };
  }

  /** Stop following. */
  close() {
    this.#closed = true;
    this.#controller.abort();
  }

  /** Follow until the session is disposed or the bridge stops. */
  async #follow() {
    while (!this.#closed) {
      try {
        const stream = this.#bridge.sessionController.follow(
          {
            address: { kind: 'session', sessionId: this.#sessionId },
            assistantStream: true,
            maxMessages: 80,
          },
          this.#controller.signal,
        );
        for await (const frame of stream) {
          if (this.#closed) return;
          this.#accept(frame);
        }
        if (this.#closed) return;
        this.#error = 'The session stream ended.';
      } catch (error) {
        if (this.#closed || this.#controller.signal.aborted) return;
        this.#error = error instanceof Error ? error.message : String(error);
      }
      await this.#bridge.sleep(2000);
    }
  }

  /** Fold one follow frame into the transcript. */
  #accept(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'snapshot') {
      this.#error = '';
      this.#ready = true;
      if (typeof frame.cursor === 'number') this.#cursor = Math.max(this.#cursor, frame.cursor);
      const title = frame.projections?.values?.title;
      if (typeof title === 'string' && title.length > 0) this.#title = title;
      for (const record of frame.records ?? []) {
        if (record?.type === 'event') this.#event(record.event);
      }
      return;
    }
    if (frame.type === 'event') {
      this.#error = '';
      this.#event(frame.event);
      return;
    }
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame;
      if (inner?.type === 'start') this.#live = '';
      else if (inner?.type === 'chunk' && inner.chunk?.type === 'text-delta' && typeof inner.chunk.text === 'string') {
        this.#live = truncate(this.#live + inner.chunk.text, 8000);
      } else if (inner?.type === 'end') {
        if (inner.outcome?.kind === 'abandoned') this.#live = '';
      }
    }
  }

  /** Fold one durable event. */
  #event(event) {
    if (!event || typeof event !== 'object') return;
    if (typeof event.seq === 'number') {
      if (event.seq <= this.#cursor && event.type !== 'turn/start' && event.type !== 'turn/end') {
        // Snapshot records can carry the same event twice; once is enough.
        if (this.#messages.some((item) => item.seq === event.seq)) return;
      }
      this.#cursor = Math.max(this.#cursor, event.seq);
    }
    if (event.type === 'turn/start') {
      this.#hasTurnState = true;
      this.#running = true;
      this.#live = '';
      return;
    }
    if (event.type === 'turn/end') {
      this.#hasTurnState = true;
      this.#running = false;
      this.#live = '';
      return;
    }
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      this.#title = event.data.title;
      return;
    }
    const item = displayItem(event);
    if (item === undefined) return;
    if (this.#messages.some((entry) => entry.seq === item.seq)) return;
    this.#messages.push(item);
    if (item.role === 'assistant') this.#live = '';
    if (this.#messages.length > MAX_MESSAGES) this.#messages.splice(0, this.#messages.length - MAX_MESSAGES);
  }
}

/** The LAN bridge and its route handlers. */
export class Bridge {
  /** @type {import('node:http').Server | undefined} */
  #server;
  /** @type {Map<string, SessionFeed>} */
  #feeds = new Map();
  /** @type {Map<string, { seen: number }>} */
  #clients = new Map();
  #summaryAt = 0;
  #summaryRows = [];
  #summaryPromise;
  #summaryTimer;
  #token = '';
  #port = 0;
  #origin = '';
  #stopped = false;

  /**
   * @param {object} options - services and settings.
   * @param {any} options.sessionController - Host session controller.
   * @param {any} [options.speechToText] - optional speech registry.
   * @param {{ warn?: (message: string) => void, info?: (message: string) => void }} [options.logger] - Host logger.
   * @param {string} [options.host] - bind address.
   * @param {number} [options.port] - bind port; 0 picks one.
   * @param {string} [options.advertiseHost] - address encoded in the QR.
   * @param {string} [options.tokenPath] - token store.
   * @param {string} [options.language] - speech language hint.
   * @param {string} [options.cwd] - new session directory.
   * @param {string} [options.name] - console-facing bridge name.
   */
  constructor(options) {
    this.sessionController = options.sessionController;
    this.speechToText = options.speechToText;
    this.logger = options.logger;
    this.host = options.host ?? '0.0.0.0';
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.advertiseHost = options.advertiseHost;
    this.tokenPath = options.tokenPath ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), TOKEN_FILE);
    this.language = options.language ?? DEFAULT_LANGUAGE;
    this.cwd = options.cwd;
    this.name = options.name ?? hostname();
  }

  /** The base URL the console should use. */
  get origin() {
    return this.#origin;
  }

  /** The pairing token (never sent to the browser status route). */
  get token() {
    return this.#token;
  }

  /** Whether the listener is bound. */
  get listening() {
    return this.#server?.listening === true;
  }

  /** Bind the LAN listener and load the pairing token. */
  async start() {
    this.#token = await this.#loadToken();
    const server = createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        try {
          this.#json(response, error instanceof BridgeError ? error.status : 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof BridgeError ? error.code : 'bridge/internal',
          });
        } catch {
          response.destroy();
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.requestedPort, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    this.#port = typeof address === 'object' && address !== null ? address.port : this.requestedPort;
    const host = this.advertiseHost ?? lanAddresses()[0] ?? '127.0.0.1';
    this.#origin = `http://${host}:${this.#port}`;
    this.#server = server;
    this.#summaryTimer = setInterval(() => this.#sweep(), 60_000);
    this.#summaryTimer.unref?.();
    return this;
  }

  /** Stop listening and release every followed session. */
  async stop() {
    this.#stopped = true;
    if (this.#summaryTimer !== undefined) clearInterval(this.#summaryTimer);
    for (const feed of this.#feeds.values()) feed.close();
    this.#feeds.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** The payload encoded in the QR code. */
  payload() {
    return pairingPayload({ origin: this.#origin, token: this.#token, name: this.name });
  }

  /** Facts for the Web settings page. */
  status() {
    const clients = [...this.#clients.entries()].map(([address, state]) => ({ address, seen: state.seen }));
    clients.sort((a, b) => b.seen - a.seen);
    return {
      ok: true,
      version: PROTOCOL_VERSION,
      listening: this.listening,
      origin: this.#origin,
      token: this.#token,
      hostname: this.name,
      lastClient: clients[0]?.address,
      lastClientAt: clients[0]?.seen,
      clients: clients.length,
      speech: this.speechToText !== undefined,
      sessions: this.#feeds.size,
    };
  }

  /** Render the pairing QR for the Web settings page. */
  qrSvg(size) {
    return renderQrSvg(this.payload(), { size });
  }

  /** Provide a running hint while a feed has seen no turn event yet. */
  runningHint(sessionId, fallback) {
    const row = this.#summaryRows.find((item) => item.id === sessionId);
    return row?.running ?? fallback;
  }

  /** A promise-returning sleep that stops early on bridge shutdown. */
  sleep(milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    });
  }

  /** Load the stored token or mint a new one. */
  async #loadToken() {
    try {
      const stored = JSON.parse(await readFile(this.tokenPath, 'utf8'));
      if (typeof stored.token === 'string' && stored.token.length >= 24) return stored.token;
    } catch {
      // First start, or a corrupt store: mint below.
    }
    const token = randomBytes(24).toString('base64url');
    try {
      await mkdir(dirname(this.tokenPath), { recursive: true });
      await writeFile(this.tokenPath, `${JSON.stringify({ token, createdAt: Date.now(), version: PROTOCOL_VERSION }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      this.logger?.warn?.(`3ds: could not persist the pairing token: ${error instanceof Error ? error.message : String(error)}`);
    }
    return token;
  }

  /** Release idle feeds. */
  #sweep() {
    if (this.#stopped) return;
    for (const [id, feed] of this.#feeds) {
      if (feed.stale) {
        feed.close();
        this.#feeds.delete(id);
      }
    }
  }

  /** Dispatch one HTTP request. */
  async #handle(request, response) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('connection', 'close');
    const url = new URL(request.url ?? '/', 'http://bridge.invalid');
    if (url.pathname === '/api/health') {
      this.#json(response, 200, { ok: true, version: PROTOCOL_VERSION, listening: this.listening });
      return;
    }
    const given = request.headers['x-3ds-token'] ?? url.searchParams.get('token');
    if (!tokenMatches(given, this.#token)) {
      this.#json(response, 401, { ok: false, code: 'bridge/unauthorized', error: 'Pair this console again.' });
      return;
    }
    const remote = request.socket.remoteAddress ?? 'unknown';
    this.#clients.set(remote, { seen: Date.now() });
    if (request.method === 'GET' && url.pathname === '/api/hello') {
      this.#json(response, 200, {
        ok: true,
        name: this.name,
        version: PROTOCOL_VERSION,
        origin: this.#origin,
        sessions: await this.#sessions(),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      this.#json(response, 200, { ok: true, sessions: await this.#sessions() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const after = clampInt(url.searchParams.get('after') ?? 0, 0, Number.MAX_SAFE_INTEGER, 0);
      if (sessionId === '') throw new BridgeError('bridge/bad-request', 'A session is required.', 400);
      const feed = this.#feed(sessionId);
      feed.touch();
      const state = feed.state(after);
      const info = await this.#summary(sessionId).catch(() => undefined);
      this.#json(response, 200, {
        ok: true,
        session: {
          ...state,
          title: state.title || info?.title || '',
          running: state.running,
        },
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/session/new') {
      const created = await this.sessionController.create(this.cwd === undefined ? {} : { cwd: this.cwd });
      this.#summaryAt = 0;
      this.#json(response, 200, { ok: true, sessionId: created.sessionId });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/prompt') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (sessionId === '') throw new BridgeError('bridge/bad-request', 'A session is required.', 400);
      const body = await this.#body(request, 64 * 1024);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new BridgeError('bridge/bad-request', 'The message was not valid JSON.', 400);
      }
      const text = stringField(parsed?.text, MAX_PROMPT_CHARS);
      if (text === '') throw new BridgeError('bridge/bad-request', 'Write a message first.', 400);
      await this.#prompt(sessionId, [{ type: 'text', text }]);
      this.#json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/cancel') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (sessionId === '') throw new BridgeError('bridge/bad-request', 'A session is required.', 400);
      await this.sessionController.cancel({ sessionId });
      this.#json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/voice') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (sessionId === '') throw new BridgeError('bridge/bad-request', 'A session is required.', 400);
      if (this.speechToText === undefined) throw new BridgeError('voice/unavailable', 'Voice needs the Voice Input bundle.', 501);
      const audio = await this.#body(request, MAX_AUDIO_BYTES);
      ensureWav(audio);
      let transcript;
      try {
        const spec = this.speechToText.resolve({ audio: new Uint8Array(audio), language: this.language });
        transcript = await this.speechToText.transcribe(spec, AbortSignal.timeout(120_000));
      } catch (error) {
        throw new BridgeError('voice/failed', error instanceof Error ? error.message : String(error), 422);
      }
      const text = transcript.text.trim();
      if (text === '') throw new BridgeError('voice/empty', 'No speech detected.', 422);
      await this.#prompt(sessionId, [{ type: 'text', text }]);
      this.#json(response, 200, { ok: true, text });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/ink') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (sessionId === '') throw new BridgeError('bridge/bad-request', 'A session is required.', 400);
      const body = await this.#body(request, MAX_INK_BYTES);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new BridgeError('bridge/bad-request', 'The note was not valid JSON.', 400);
      }
      const hasStroke = Array.isArray(parsed?.strokes) && parsed.strokes.some((stroke) => Array.isArray(stroke) && stroke.length >= 2);
      if (!hasStroke) throw new BridgeError('bridge/bad-request', 'Draw something first.', 400);
      const png = renderInkPng(parsed);
      await this.#prompt(sessionId, [
        { type: 'text', text: 'A handwritten note from my 3DS. Read the writing in the image and respond to it.' },
        { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: '3ds-note.png' },
      ]);
      this.#json(response, 200, { ok: true });
      return;
    }
    throw new BridgeError('bridge/not-found', 'Unknown bridge endpoint.', 404);
  }

  /** Admit prompt content into a session. */
  async #prompt(sessionId, content) {
    this.#feed(sessionId).touch();
    try {
      await this.sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content,
        },
        AbortSignal.timeout(30_000),
      );
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'bridge/prompt-failed';
      const message = error instanceof Error ? error.message : String(error);
      throw new BridgeError(code, message, 409);
    }
  }

  /** Get or create the feed for one session. */
  #feed(sessionId) {
    let feed = this.#feeds.get(sessionId);
    if (feed === undefined) {
      feed = new SessionFeed(this, sessionId);
      this.#feeds.set(sessionId, feed);
      feed.start();
    }
    return feed;
  }

  /** Read the session list, reusing one snapshot briefly. */
  async #sessions() {
    const now = Date.now();
    if (now - this.#summaryAt < SUMMARY_TTL_MS && this.#summaryRows.length > 0) return this.#summaryRows;
    if (this.#summaryPromise !== undefined) return this.#summaryPromise;
    this.#summaryPromise = (async () => {
      try {
        const value = await this.sessionController.list({}, AbortSignal.timeout(8_000));
        const rows = [];
        for (const item of value.items ?? []) {
          if (item.parentSessionId !== undefined || item.origin === 'subagent') continue;
          const title = item.projections?.values?.title;
          rows.push({
            id: String(item.sessionId),
            title: typeof title === 'string' ? title : '',
            running: item.running === true,
            blank: item.blank === true,
            updatedAt: Number(item.updatedAt) || 0,
          });
          if (rows.length >= MAX_SESSIONS) break;
        }
        this.#summaryRows = rows;
        this.#summaryAt = Date.now();
        return rows;
      } catch (error) {
        if (this.#summaryRows.length > 0) return this.#summaryRows;
        throw new BridgeError('bridge/sessions-unavailable', error instanceof Error ? error.message : String(error), 503);
      } finally {
        this.#summaryPromise = undefined;
      }
    })();
    return this.#summaryPromise;
  }

  /** Find one session row. */
  async #summary(sessionId) {
    const rows = await this.#sessions();
    return rows.find((row) => row.id === sessionId);
  }

  /** Read and bound a request body. */
  async #body(request, limit) {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > limit) throw new BridgeError('bridge/too-large', 'That payload is too large.', 413);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new BridgeError('bridge/too-large', 'That payload is too large.', 413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** Send a JSON response. */
  #json(response, status, value) {
    if (response.writableEnded) return;
    const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      connection: 'close',
    });
    response.end(body);
  }
}

/** Reject bytes that are not a RIFF/WAVE recording. */
function ensureWav(audio) {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new BridgeError('voice/invalid-audio', 'The recording was not a WAV file.', 400);
  }
}

/**
 * Mount the LAN bridge and the authenticated Web settings routes.
 *
 * @param {any} ctx - Host context.
 * @param {{ host?: string, port?: number, advertiseHost?: string, language?: string, cwd?: string }} [config] - bundle row config.
 */
export async function apply(ctx, config = {}) {
  const bridge = new Bridge({
    sessionController: ctx.sessionController,
    speechToText: ctx.get?.('speechToText'),
    logger: ctx.logger,
    host: config.host,
    port: config.port,
    advertiseHost: config.advertiseHost,
    language: config.language,
    cwd: config.cwd,
  });
  await bridge.start();
  const disposers = [];
  try {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/3ds/status',
      handler: (request, response) => {
        if (!ctx.connection.authorizeIndex(request, response)) return;
        const body = Buffer.from(`${JSON.stringify(bridge.status())}\n`, 'utf8');
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store',
        });
        response.end(body);
      },
    }));
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/3ds/qr.svg',
      handler: (request, response) => {
        if (!ctx.connection.authorizeIndex(request, response)) return;
        let svg;
        try {
          const url = new URL(request.url ?? '/', 'http://dsh.invalid');
          svg = bridge.qrSvg(Number(url.searchParams.get('size') ?? 240));
        } catch (error) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('QR generation failed');
          return;
        }
        const body = Buffer.from(svg, 'utf8');
        response.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store',
        });
        response.end(body);
      },
    }));
  } catch (error) {
    for (const dispose of disposers) dispose();
    await bridge.stop();
    throw error;
  }
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
    return bridge.stop();
  }, '3ds: LAN bridge');
  ctx.logger?.info?.(`3ds: bridge listening at ${bridge.origin}`);
}

/** The bundle declares the Host services it cannot run without. */
export const inject = ['sessionController', 'webServer', 'connection'];
