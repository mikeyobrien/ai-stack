import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { TELEGRAM_MAX_TEXT } from './chunk.js';

/** Default env var holding the bridge's own bot token (never dsh-im's bot). */
export const DEFAULT_TOKEN_REF = 'DSH_TELEGRAM_SESSION_BRIDGE_BOT_TOKEN';
export const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_POLL_TIMEOUT_SEC = 25;
export const STATE_DIR_NAME = 'telegram-session-bridge';
export const STATE_FILE_NAME = 'state.json';

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) return null;
  return number;
}

function chatIdList(value) {
  if (value === undefined || value === null || value === '') return [];
  const source = Array.isArray(value) ? value : String(value).split(',');
  const ids = [];
  for (const entry of source) {
    const number = typeof entry === 'string' ? Number(entry.trim()) : entry;
    if (!Number.isSafeInteger(number)) {
      throw new ConfigError('config-invalid', `allowedChatIds entries must be integer chat ids (got ${JSON.stringify(entry)})`);
    }
    ids.push(number);
  }
  return [...new Set(ids)];
}

/**
 * Resolve the operator config once, at boot. The bot token is read only from
 * the env var named by `tokenRef`: the bridge must be a second bot identity,
 * never dsh-im's credential, and it never reads another plugin's config file.
 */
export function resolveConfig(input = {}, env = process.env) {
  if (input === null || input === undefined) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError('config-invalid', 'telegram-session-bridge config must be a mapping');
  }

  const tokenRef = nonEmptyString(input.tokenRef) ?? DEFAULT_TOKEN_REF;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenRef)) {
    throw new ConfigError(
      'token-ref-invalid',
      `tokenRef must name an environment variable, not a path or file (got ${JSON.stringify(tokenRef)})`,
    );
  }
  if (/dsh[-_]?im/i.test(tokenRef)) {
    throw new ConfigError(
      'token-ref-conflict',
      'tokenRef must not point at dsh-im\'s bot identity: two long-polls on one token conflict, so the bridge needs its own bot',
    );
  }
  const token = nonEmptyString(env[tokenRef]);
  if (!token) {
    throw new ConfigError('token-missing', `env var ${tokenRef} (tokenRef) is not set; export the bridge bot token before starting DSH`);
  }

  const home = resolve(nonEmptyString(input.dshHome) ?? nonEmptyString(env.DSH_HOME) ?? join(homedir(), '.dsh'));
  const stateDir = join(home, STATE_DIR_NAME);
  const stallTimeoutMs = positiveInt(input.stallTimeoutMs, DEFAULT_STALL_TIMEOUT_MS, { min: 1_000 });
  if (stallTimeoutMs === null) {
    throw new ConfigError('config-invalid', 'stallTimeoutMs must be an integer >= 1000');
  }
  const pollTimeoutSec = positiveInt(input.pollTimeoutSec, DEFAULT_POLL_TIMEOUT_SEC, { min: 0, max: 50 });
  if (pollTimeoutSec === null) {
    throw new ConfigError('config-invalid', 'pollTimeoutSec must be an integer in [0, 50]');
  }
  const maxChunkChars = positiveInt(input.maxChunkChars, TELEGRAM_MAX_TEXT, { min: 1, max: TELEGRAM_MAX_TEXT });
  if (maxChunkChars === null) {
    throw new ConfigError('config-invalid', `maxChunkChars must be an integer in [1, ${TELEGRAM_MAX_TEXT}]`);
  }
  const dedupeRetentionMs = positiveInt(input.dedupeRetentionMs, 7 * 24 * 60 * 60 * 1000);
  const dedupeMaxEntries = positiveInt(input.dedupeMaxEntries, 5000);
  if (dedupeRetentionMs === null || dedupeMaxEntries === null) {
    throw new ConfigError('config-invalid', 'dedupeRetentionMs and dedupeMaxEntries must be positive integers');
  }

  const baseUrl = nonEmptyString(input.baseUrl) ?? 'https://api.telegram.org';
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new ConfigError('config-invalid', 'baseUrl must be an http(s) URL');
  }

  return Object.freeze({
    tokenRef,
    token,
    baseUrl,
    stateDir,
    stateFile: join(stateDir, STATE_FILE_NAME),
    allowedChatIds: Object.freeze(chatIdList(input.allowedChatIds)),
    stallTimeoutMs,
    pollTimeoutSec,
    maxChunkChars,
    dedupeRetentionMs,
    dedupeMaxEntries,
    poll: input.poll !== false,
  });
}
export function botIdFromToken(token){const n=Number(String(token).split(":",1)[0]);return Number.isSafeInteger(n)&&n>0?n:0;}
