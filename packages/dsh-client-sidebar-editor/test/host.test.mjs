/**
 * Host-half tests: the guarded write, exercised without a Cordis context.
 *
 * These cover the two refusals that matter — a wrong Session and a path outside the workspace — and the
 * version precondition that stops a save from clobbering an agent edit.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { guardedSave } from '../index.js';

/** A filesystem double that records what it was asked to do. */
function fakeFs({ contained = true, write = {} } = {}) {
  const calls = [];
  return {
    calls,
    resolve: async (path, options) => ({ path, cwd: options?.cwd }),
    contains: () => contained,
    processPath: (target) => target.path,
    writeText: async (target, text, expected) => {
      calls.push({ target, text, expected });
      return { version: 'v-next', before: 'old', after: text, operation: 'update', ...write };
    },
  };
}

const sessions = { get: (id) => (id === 's1' ? { header: { cwd: '/work' } } : undefined) };

test('a save writes with the version it was given and reports the new one', async () => {
  const fs = fakeFs();
  const result = await guardedSave({ fs, sessions }, { sessionId: 's1', path: 'a.md', text: 'new', version: 'v1' });

  assert.equal(fs.calls.length, 1);
  assert.deepEqual(fs.calls[0].expected, { kind: 'replaceIfVersion', version: 'v1' });
  assert.equal(result.version, 'v-next');
  assert.equal(result.after, 'new');
  assert.equal(result.path, 'a.md');
});

test('a save without a version is refused: I2 has no unconditional path', async () => {
  const fs = fakeFs();
  await assert.rejects(
    guardedSave({ fs, sessions }, { sessionId: 's1', path: 'a.md', text: 'new' }),
    /a version is required/,
  );
  assert.equal(fs.calls.length, 0, 'nothing was written');
});

test('a save for an unknown session is refused before touching the filesystem', async () => {
  const fs = fakeFs();
  await assert.rejects(
    guardedSave({ fs, sessions }, { sessionId: 'nope', path: 'a.md', text: 'new', version: 'v1' }),
    /unknown session/,
  );
  assert.equal(fs.calls.length, 0);
});

test('a path that escapes the workspace is refused', async () => {
  const fs = fakeFs({ contained: false });
  await assert.rejects(
    guardedSave({ fs, sessions }, { sessionId: 's1', path: '../../../etc/passwd', text: 'x', version: 'v1' }),
    /outside-workspace/,
  );
  assert.equal(fs.calls.length, 0, 'the write never ran');
});

test('a stale version surfaces the backend refusal instead of writing', async () => {
  const fs = fakeFs();
  fs.writeText = async () => {
    throw Object.assign(new Error('FS_STALE_VERSION'), { code: 'FS_STALE_VERSION' });
  };
  await assert.rejects(
    guardedSave({ fs, sessions }, { sessionId: 's1', path: 'a.md', text: 'new', version: 'v1' }),
    /FS_STALE_VERSION/,
  );
});
