/**
 * Host half of the sidebar editor: the one write path the panel needs.
 *
 * The Client reads through `workspaceFiles`, but nothing on that namespace writes, so saving has to be a
 * Host Remote of our own. It is deliberately the smallest one that can exist: one method, one
 * precondition, and a containment check between the two.
 *
 * The method marker is written by hand because this bundle ships plain JavaScript — `Remote()` exists to
 * write exactly this descriptor, and the Gateway's discovery reads it off the prototype.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

/** Prototype key the Typert Gateway reads to discover Remote methods. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * Save one file, but only over the version the reader started from.
 *
 * `replaceIfVersion` is the whole conflict strategy: the filesystem backend compares its own freshness
 * token and refuses on mismatch, so a save that raced an agent edit fails instead of clobbering it.
 */
/**
 * The guarded write, as a plain function so it can be tested without a Cordis context.
 *
 * Every refusal is a thrown Error with a stable message: the Client maps them to copy, and a test can
 * assert the reason without reading an RPC envelope.
 * @param host - the two services the write needs: the filesystem and the session registry.
 * @param request - `{ sessionId, path, text, version }`.
 * @returns `{ version, before, after, operation, path }`.
 */
export async function guardedSave(host, request) {
  const { sessionId, path, text, version } = request ?? {};
  if (typeof path !== 'string' || path.length === 0) throw new Error('sidebar-editor: a path is required');
  if (typeof text !== 'string') throw new Error('sidebar-editor: text is required');
  // I2: no unconditional write. A caller without a version has not read the file, so it cannot
  // claim to be replacing a known content.
  if (typeof version !== 'string' || version.length === 0) throw new Error('sidebar-editor: a version is required');

  const record = sessionId === undefined || sessionId === null ? undefined : host.sessions?.get?.(sessionId);
  const root = record?.header?.cwd;
  if (root === undefined) throw new Error('sidebar-editor: unknown session');

  const [rootTarget, target] = await Promise.all([
    host.fs.resolve(root),
    host.fs.resolve(path, { cwd: root }),
  ]);
  if (!host.fs.contains(rootTarget, target)) throw new Error('sidebar-editor: outside-workspace');

  const outcome = await host.fs.writeText(target, text, { kind: 'replaceIfVersion', version });
  return {
    version: outcome.version,
    before: outcome.before,
    after: outcome.after,
    operation: outcome.operation,
    path: host.fs.processPath(target),
  };
}

export class SidebarEditorService extends TypertRemoteService {
  static inject = ['fs', 'sessions'];

  /**
   * @param ctx - Host context carrying the filesystem and the session registry.
   */
  constructor(ctx) {
    super(ctx, 'sidebarEditor');
    this.ctx = ctx;
  }

  /**
   * Write a file the user has been editing.
   * @param request - `{ sessionId, path, text, version }`; `version` is the token the text was read at.
   * @returns the new version, the prior text and the written text the Client diffs from.
   */
  async save(request) {
    return guardedSave({ fs: this.ctx.fs, sessions: this.ctx.sessions }, request);
  }
}

Object.defineProperty(SidebarEditorService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([Object.freeze({ method: 'save', invocation: Object.freeze({ kind: 'direct' }) })]),
  }),
});

/**
 * Mount the write path.
 * @param ctx - the bundle's Host context.
 */
export function apply(ctx) {
  ctx.plugin(SidebarEditorService);
}
