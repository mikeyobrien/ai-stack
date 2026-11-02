import { randomUUID } from 'node:crypto';

export const BACKLOG_PATH = '.agents/backlog.json';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 2000;
const states = new Set(['held', 'pulled', 'dismissed']);
const fail = (message) => { throw new Error(`backlog: ${message}`); };
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20000) fail('idea must contain 1–20000 characters');
  return value.trim();
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) fail('invalid item ID');
  return value;
}
function validate(data) {
  if (data?.schema !== 1 || !Array.isArray(data.items) || data.items.length > MAX_ITEMS) fail('unsupported or corrupt backlog; file was not changed');
  const ids = new Set();
  for (const item of data.items) {
    identifier(item.id);
    if (ids.has(item.id) || text(item.text) !== item.text || !states.has(item.state) ||
        !Number.isSafeInteger(item.revision) || item.revision < 1 ||
        typeof item.originSessionId !== 'string' || !item.originSessionId ||
        !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) {
      fail('corrupt backlog; file was not changed');
    }
    ids.add(item.id);
  }
  return data;
}

/** Uses the host filesystem's atomic, version-guarded writes. Never writes caller-supplied paths. */
export function createBacklogStore({ fs, sessions, now = () => new Date().toISOString() }) {
  const queues = new Map();
  async function locate(sessionId) {
    if (typeof sessionId !== 'string') fail('session is required');
    const cwd = sessions.get(sessionId)?.header?.cwd;
    if (typeof cwd !== 'string') fail('unknown session');
    // Reject repository-owned links before resolving the fixed storage location.
    for (const path of ['.agents', BACKLOG_PATH]) {
      const info = await fs.lstat(path, { cwd });
      if (info && info.type !== (path === '.agents' ? 'directory' : 'file')) fail('storage path must not be a link or special file');
    }
    const root = await fs.resolve(cwd);
    const target = await fs.resolve(BACKLOG_PATH, { cwd });
    if (!fs.contains(root, target)) fail('storage is outside the workspace');
    return { target, cwd };
  }
  async function load(target) {
    const before = await fs.stat(target);
    if (!before) return { data: { schema: 1, items: [] }, intent: { kind: 'createIfAbsent' } };
    if (before.type !== 'file' || before.size > MAX_BYTES) fail('backlog is not a regular file or exceeds 2 MiB');
    const content = await fs.readText(target);
    if (Buffer.byteLength(content) > MAX_BYTES) fail('backlog exceeds 2 MiB');
    const after = await fs.stat(target);
    if (!after || before.version !== after.version) throw Object.assign(new Error('backlog changed while reading'), { code: 'FS_STALE_VERSION' });
    let data;
    try { data = JSON.parse(content); } catch { fail('invalid JSON; file was not changed'); }
    return { data: validate(data), intent: { kind: 'replaceIfVersion', version: after.version } };
  }
  function serialize(key, task) {
    const previous = queues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    queues.set(key, result);
    result.finally(() => { if (queues.get(key) === result) queues.delete(key); }).catch(() => {});
    return result;
  }
  async function run(request) {
    if (!request || !['list', 'add', 'edit', 'state'].includes(request.op)) fail('invalid operation');
    const { target } = await locate(request.sessionId);
    return serialize(target.targetKey, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const { data, intent } = await load(target);
          if (request.op === 'list') return { items: data.items };
          const time = now();
          if (request.op === 'add') {
            const id = identifier(request.id || randomUUID());
            const body = text(request.text);
            const existing = data.items.find((item) => item.id === id);
            // A retried save after a dropped connection must not duplicate an idea.
            if (existing) {
              if (existing.text !== body || existing.originSessionId !== request.sessionId) fail('item ID already exists');
              return { items: data.items };
            }
            if (data.items.length >= MAX_ITEMS) fail('backlog is full (2000 ideas)');
            data.items.unshift({ id, text: body, originSessionId: request.sessionId, createdAt: time, updatedAt: time, state: 'held', revision: 1 });
          } else {
            const item = data.items.find((entry) => entry.id === identifier(request.id));
            if (!item) fail('idea no longer exists; refresh the backlog');
            if (item.revision !== request.revision) fail('idea changed elsewhere; refresh before trying again');
            if (request.op === 'edit') item.text = text(request.text);
            else {
              if (!states.has(request.state)) fail('invalid state');
              item.state = request.state;
            }
            item.revision++;
            item.updatedAt = time;
          }
          const content = JSON.stringify(data, null, 2) + '\n';
          if (Buffer.byteLength(content) > MAX_BYTES) fail('backlog exceeds 2 MiB');
          // Resolve again to recheck containment/link changes before publication.
          const latest = await locate(request.sessionId);
          if (latest.target.targetKey !== target.targetKey) fail('storage path changed; retry');
          await fs.writeText(target, content, intent);
          return { items: data.items };
        } catch (error) {
          if (!['FS_STALE_VERSION', 'FS_NOT_OBSERVED'].includes(error.code) || attempt === 4) throw error;
        }
      }
    });
  }
  return { run };
}
