/**
 * Behaviour tests for the metric: which live tool calls count, under which
 * name, and how many. Each case feeds the recorder synthetic appended events;
 * no real session data is read and no real skill or principle is invoked.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecorder, fromState, isSuccessful } from '../usage.js';

const SESSION = 'session-fixture';

/** A recorded tool call event. */
function call(tool, callId, args, seq = 1) {
  return { type: 'tool/call', seq, time: 1790000000000 + seq, data: { turn: 1, step: 1, callId, name: tool, arguments: JSON.stringify(args) } };
}

/** A recorded successful tool result event. */
function result(callId, text = '', seq = 2) {
  return { type: 'tool/result', seq, time: 1790000000000 + seq, data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } } };
}

/** A recorded failed tool result event. */
function failure(callId, seq = 2) {
  return {
    type: 'tool/result', seq, time: 1790000000000 + seq,
    data: {
      message: { role: 'tool', toolCallId: callId, isError: true, content: [{ type: 'text', text: 'failed' }] },
      error: { name: 'ToolError', code: 'TOOL_ERROR' },
    },
  };
}

/** A recorded skill result naming the canonical skill. */
function skillResult(callId, name, seq = 2) {
  return result(callId, `<skill_content name="${name}">\n<skill_instructions>…</skill_instructions>\n</skill_content>`, seq);
}

/** A recorded principle result with the canonical identity line. */
function principleResult(callId, name, version = 'abc123', seq = 2) {
  return result(callId, `# ${name}\nname: ${name} · version: ${version}\n\nWhen it applies: …`, seq);
}

/** Feed one session's events to a recorder in order. */
function observe(recorder, events, sessionId = SESSION) {
  for (const event of events) recorder.observe(sessionId, event);
}

test('a successful skill call observed live is one count under the name the tool recorded', () => {
  const recorder = createRecorder();
  observe(recorder, [call('skill', 'call-1', { name: 'first-principles' }), skillResult('call-1', 'first-principles')]);
  assert.deepEqual(recorder.snapshot().skills, [{ name: 'first-principles', count: 1 }]);
  assert.deepEqual(recorder.snapshot().principles, []);
});

test('a failed call is not a use', () => {
  const recorder = createRecorder();
  observe(recorder, [call('skill', 'call-1', { name: 'first-principles' }), failure('call-1')]);
  assert.deepEqual(recorder.snapshot().skills, []);
});

test('a call with no recorded result — cancelled or never completed — is not a use', () => {
  const recorder = createRecorder();
  observe(recorder, [call('skill', 'call-1', { name: 'first-principles' })]);
  assert.deepEqual(recorder.snapshot().skills, []);
});

test('an error envelope without isError still fails the call', () => {
  const event = { type: 'tool/result', data: { message: { toolCallId: 'call-1', content: [] }, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } } };
  assert.equal(isSuccessful(event), false);
});

test('a result whose call was not observed — a pre-activation or inherited call — adds nothing', () => {
  const recorder = createRecorder();
  observe(recorder, [skillResult('call-before', 'first-principles')]);
  assert.deepEqual(recorder.snapshot().skills, []);
});

test('a repeated identical event pair in one session counts once', () => {
  const recorder = createRecorder();
  const events = [call('skill', 'call-1', { name: 'verified-delivery' }), skillResult('call-1', 'verified-delivery')];
  observe(recorder, [...events, ...events]);
  assert.deepEqual(recorder.snapshot().skills, [{ name: 'verified-delivery', count: 1 }]);
});

test('the same call id in two different sessions is two distinct invocations', () => {
  const recorder = createRecorder();
  observe(recorder, [call('skill', 'call-1', { name: 'verified-delivery' }), skillResult('call-1', 'verified-delivery')], 'session-a');
  observe(recorder, [call('skill', 'call-1', { name: 'verified-delivery' }), skillResult('call-1', 'verified-delivery')], 'session-b');
  assert.deepEqual(recorder.snapshot().skills, [{ name: 'verified-delivery', count: 2 }]);
});

test('two genuine invocations of one skill count twice', () => {
  const recorder = createRecorder();
  observe(recorder, [
    call('skill', 'call-1', { name: 'verified-delivery' }), skillResult('call-1', 'verified-delivery'),
    call('skill', 'call-2', { name: 'verified-delivery' }), skillResult('call-2', 'verified-delivery'),
  ]);
  assert.deepEqual(recorder.snapshot().skills, [{ name: 'verified-delivery', count: 2 }]);
});

test('a principle alias resolves to the canonical name recorded in the result', () => {
  const recorder = createRecorder();
  observe(recorder, [call('principle_read', 'call-1', { name: 'Prove It Works' }), principleResult('call-1', 'prove-it-works')]);
  assert.deepEqual(recorder.snapshot().principles, [{ name: 'prove-it-works', count: 1 }]);
});

test('the result name wins over a stale argument name', () => {
  const recorder = createRecorder();
  observe(recorder, [call('skill', 'call-1', { name: 'old-name' }), skillResult('call-1', 'capability-name')]);
  assert.deepEqual(recorder.snapshot().skills, [{ name: 'capability-name', count: 1 }]);
});

test('a principle result without its identity line falls back to the argument name', () => {
  const recorder = createRecorder();
  observe(recorder, [call('principle_read', 'call-1', { name: 'fix-root-causes' }), result('call-1', 'no metadata line here')]);
  assert.deepEqual(recorder.snapshot().principles, [{ name: 'fix-root-causes', count: 1 }]);
});

test('rows sort by count, highest first, then by name', () => {
  const recorder = createRecorder();
  observe(recorder, [
    call('skill', 'call-1', { name: 'beta' }), skillResult('call-1', 'beta'),
    call('skill', 'call-2', { name: 'beta' }), skillResult('call-2', 'beta'),
    call('skill', 'call-3', { name: 'alpha' }), skillResult('call-3', 'alpha'),
    call('skill', 'call-4', { name: 'alpha' }), skillResult('call-4', 'alpha'),
    call('skill', 'call-5', { name: 'gamma' }), skillResult('call-5', 'gamma'),
  ]);
  assert.deepEqual(recorder.snapshot().skills, [
    { name: 'alpha', count: 2 },
    { name: 'beta', count: 2 },
    { name: 'gamma', count: 1 },
  ]);
});

test('reading the snapshot again changes nothing', () => {
  const recorder = createRecorder();
  observe(recorder, [call('skill', 'call-1', { name: 'verified-delivery' }), skillResult('call-1', 'verified-delivery')]);
  assert.deepEqual(recorder.snapshot(), recorder.snapshot());
});

test('skills and principles stay separate rows', () => {
  const recorder = createRecorder();
  observe(recorder, [
    call('skill', 'call-1', { name: 'prove-it-works' }), skillResult('call-1', 'prove-it-works'),
    call('principle_read', 'call-2', { name: 'prove-it-works' }), principleResult('call-2', 'prove-it-works'),
  ]);
  assert.deepEqual(recorder.snapshot().skills, [{ name: 'prove-it-works', count: 1 }]);
  assert.deepEqual(recorder.snapshot().principles, [{ name: 'prove-it-works', count: 1 }]);
});

test('a disposed session drops its pending call, so a late result cannot count it', () => {
  const recorder = createRecorder();
  observe(recorder, [call('skill', 'call-1', { name: 'verified-delivery' })]);
  recorder.forget(SESSION);
  observe(recorder, [skillResult('call-1', 'verified-delivery')]);
  assert.deepEqual(recorder.snapshot().skills, []);
});

test('the persisted state restores the counts and the activation time', () => {
  const recorder = createRecorder({ activatedAt: 1790000000000 });
  observe(recorder, [call('skill', 'call-1', { name: 'verified-delivery' }), skillResult('call-1', 'verified-delivery')]);
  const restored = createRecorder(fromState(JSON.parse(JSON.stringify(recorder.toState()))));
  assert.equal(restored.activatedAt, 1790000000000);
  assert.deepEqual(restored.snapshot().skills, [{ name: 'verified-delivery', count: 1 }]);
});

test('a state document without rows restores its start date', () => {
  assert.deepEqual(fromState({ version: 1, activatedAt: 1793724467293 }), {
    activatedAt: 1793724467293,
    skills: {},
    principles: {},
  });
});

test('a malformed state document is ignored instead of crashing activation', () => {
  assert.deepEqual(fromState({ activatedAt: 'yesterday', skills: { a: 3 } }), {});
  assert.deepEqual(fromState({ activatedAt: 1790000000000, skills: { a: 3, b: -1, c: 'many' }, principles: { x: 2 } }), {
    activatedAt: 1790000000000,
    skills: { a: 3 },
    principles: { x: 2 },
  });
});
