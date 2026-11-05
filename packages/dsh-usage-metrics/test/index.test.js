/**
 * Behaviour tests for activation: the panel's overview reflects live session
 * events, counts survive a reload through the state file, and a malformed state
 * file starts a fresh count instead of breaking the plugin. No real session is
 * touched: the state lives in a temporary directory.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { activeProfile, adoptLegacyState, apply, readState, stateFilePath } from '../index.js';

/** One call + successful result pair for a skill. */
function skillUse(callId, name) {
  return [
    { type: 'tool/call', seq: 1, data: { callId, name: 'skill', arguments: JSON.stringify({ name }) } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: callId, content: [{ type: 'text', text: `<skill_content name="${name}">…</skill_content>` }] } } },
  ];
}

/**
 * Apply the Host half to a stub context and expose what it wired.
 * @param file - state path.
 */
function boot(file) {
  const listeners = new Map();
  const services = [];
  const disposers = [];
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    plugin(klass) {
      services.push(klass);
      return { dispose() {} };
    },
  };
  apply(ctx, { stateFile: file });
  const service = services[0];
  return {
    emit: (name, ...args) => listeners.get(name)?.(...args),
    listeners,
    overview: () => service.prototype.overview.call({}),
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

/** A temporary state file path for one test. */
function temporaryState() {
  const directory = mkdtempSync(join(tmpdir(), 'usage-metrics-'));
  return { file: join(directory, 'state.json'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('a successful skill call on the live feed appears once, and the panel says when counting began', () => {
  const { file, cleanup } = temporaryState();
  try {
    const host = boot(file);
    const before = Date.now();
    for (const event of skillUse('call-1', 'verified-delivery')) host.emit('session/event', { id: 'session-a' }, event);
    const overview = host.overview();
    assert.deepEqual(overview.skills, [{ name: 'verified-delivery', count: 1 }]);
    assert.deepEqual(overview.principles, []);
    assert.ok(overview.activatedAt >= before - 1000 && overview.activatedAt <= Date.now());
    host.dispose();
  } finally {
    cleanup();
  }
});

test('a failed call and a result with no observed call add nothing', () => {
  const { file, cleanup } = temporaryState();
  try {
    const host = boot(file);
    host.emit('session/event', { id: 'session-a' }, { type: 'tool/call', data: { callId: 'call-1', name: 'skill', arguments: JSON.stringify({ name: 'verified-delivery' }) } });
    host.emit('session/event', { id: 'session-a' }, { type: 'tool/result', data: { message: { toolCallId: 'call-1', isError: true, content: [] }, error: { name: 'ToolError', code: 'TOOL_ERROR' } } });
    host.emit('session/event', { id: 'session-b' }, { type: 'tool/result', data: { message: { toolCallId: 'call-before-activation', content: [{ type: 'text', text: '<skill_content name="first-principles">' }] } } });
    assert.deepEqual(host.overview().skills, []);
    host.dispose();
  } finally {
    cleanup();
  }
});

test('counts survive a reload from the state file and keep their original start date', () => {
  const { file, cleanup } = temporaryState();
  try {
    const first = boot(file);
    for (const event of skillUse('call-1', 'verified-delivery')) first.emit('session/event', { id: 'session-a' }, event);
    const startedAt = first.overview().activatedAt;
    first.dispose();
    const second = boot(file);
    const overview = second.overview();
    assert.deepEqual(overview.skills, [{ name: 'verified-delivery', count: 1 }]);
    assert.equal(overview.activatedAt, startedAt);
    second.dispose();
  } finally {
    cleanup();
  }
});

test('reopening the panel cannot inflate a count', () => {
  const { file, cleanup } = temporaryState();
  try {
    const host = boot(file);
    for (const event of skillUse('call-1', 'verified-delivery')) host.emit('session/event', { id: 'session-a' }, event);
    assert.deepEqual(host.overview().skills, [{ name: 'verified-delivery', count: 1 }]);
    assert.deepEqual(host.overview().skills, [{ name: 'verified-delivery', count: 1 }]);
    host.dispose();
  } finally {
    cleanup();
  }
});

test('a malformed state file starts a fresh count instead of breaking activation', () => {
  const { file, cleanup } = temporaryState();
  try {
    writeFileSync(file, 'not json');
    const host = boot(file);
    const overview = host.overview();
    assert.deepEqual(overview.skills, []);
    assert.ok(Number.isSafeInteger(overview.activatedAt));
    host.dispose();
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).activatedAt > 0);
  } finally {
    cleanup();
  }
});

test('only names, counts and the start date cross to the browser', () => {
  const { file, cleanup } = temporaryState();
  try {
    const host = boot(file);
    const events = skillUse('call-1', 'verified-delivery');
    events[1].data.message.content[0].text += 'SECRET-PAYLOAD-MARKER';
    for (const event of events) host.emit('session/event', { id: 'session-a' }, event);
    assert.equal(JSON.stringify(host.overview()).includes('SECRET-PAYLOAD-MARKER'), false);
    host.dispose();
  } finally {
    cleanup();
  }
});

test('the listener set is exactly the live feed and session disposal', () => {
  const { file, cleanup } = temporaryState();
  try {
    const host = boot(file);
    assert.deepEqual([...host.listeners.keys()].sort(), ['session/disposed', 'session/event']);
    host.dispose();
  } finally {
    cleanup();
  }
});

test('the state file is named for the profile the Host serves', () => {
  assert.equal(stateFilePath({ stateFile: '/tmp/usage-metrics-test.json' }), '/tmp/usage-metrics-test.json');
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/dsh-home-test';
  try {
    assert.equal(stateFilePath({}, { argv: ['node', 'bin.js'] }), '/tmp/dsh-home-test/usage-metrics/state.json');
    assert.equal(stateFilePath({}, { argv: ['node', 'bin.js', '--profile', 'web'] }), '/tmp/dsh-home-test/usage-metrics/state-web.json');
    assert.equal(stateFilePath({}, { argv: ['node', 'bin.js', '--profile=work'] }), '/tmp/dsh-home-test/usage-metrics/state-work.json');
    assert.equal(stateFilePath({}, { argv: ['node', 'bin.js', '--profile', '../escape'] }), '/tmp/dsh-home-test/usage-metrics/state-.._escape.json');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
  assert.equal(activeProfile(['node', 'bin.js', '--profile', 'web']), 'web');
  assert.equal(activeProfile(['node', 'bin.js']), undefined);
});

test('the earlier home-wide state is adopted once by the running profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'usage-metrics-home-'));
  try {
    const legacy = join(home, 'usage-metrics', 'state.json');
    const profileFile = join(home, 'usage-metrics', 'state-web.json');
    // Seed the legacy file the pre-scoping plugin wrote.
    mkdirSync(join(home, 'usage-metrics'), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ version: 1, activatedAt: 1793724467293, skills: { 'ui-ux-pass': 1 }, principles: {} }));
    assert.equal(adoptLegacyState(profileFile, home), true);
    assert.equal(existsSync(legacy), false, 'the adopted file moved instead of being copied');
    assert.deepEqual(readState(profileFile).skills, { 'ui-ux-pass': 1 });
    assert.equal(adoptLegacyState(profileFile, home), false, 'a second activation adopts nothing');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an existing profile state file wins over the earlier home-wide one', () => {
  const home = mkdtempSync(join(tmpdir(), 'usage-metrics-home-'));
  try {
    const legacy = join(home, 'usage-metrics', 'state.json');
    const profileFile = join(home, 'usage-metrics', 'state-web.json');
    mkdirSync(join(home, 'usage-metrics'), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ version: 1, activatedAt: 1 }));
    writeFileSync(profileFile, JSON.stringify({ version: 1, activatedAt: 2 }));
    assert.equal(adoptLegacyState(profileFile, home), false);
    assert.equal(readState(profileFile).activatedAt, 2);
    assert.equal(existsSync(legacy), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a missing state file reads as empty', () => {
  assert.deepEqual(readState('/tmp/definitely-not-a-usage-metrics-state-file.json'), {});
});
