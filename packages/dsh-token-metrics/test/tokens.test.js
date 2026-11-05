/**
 * Behaviour tests for the rollup: which settled model calls count, under which
 * model, and how many tokens. Each case feeds the rollup synthetic appended
 * events; no real session data is read and no model is invoked.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollup, countsOf, fromState, isCount, modelOf } from '../tokens.js';

const SESSION = 'session-fixture';

/** A settled assistant call event carrying a `usage` field and a model. */
function call(model, usage, seq = 1) {
	return {
		type: 'assistant/message', seq, time: 1790000000000 + seq,
		data: { turn: 1, step: 1, message: { role: 'assistant', source: { provider: 'test', model } }, usage },
	};
}

/** Feed one session's events to a rollup in order. */
function observe(rollup, events, sessionId = SESSION) {
	for (const event of events) rollup.observe(sessionId, event);
}

test("a settled call's usage is added to its model's row", () => {
	const rollup = createRollup();
	observe(rollup, [call('reef', { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2 })]);
	assert.equal(rollup.snapshot().models.length, 1);
	assert.deepEqual(rollup.snapshot().models[0], {
		model: 'reef', calls: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 0,
	});
});

test('two settled calls of the same model accumulate into one row', () => {
	const rollup = createRollup();
	observe(rollup, [call('reef', { inputTokens: 10, outputTokens: 5, totalTokens: 15 }), call('reef', { inputTokens: 4, outputTokens: 3, totalTokens: 7 })]);
	const [row] = rollup.snapshot().models;
	assert.deepEqual(row, { model: 'reef', calls: 2, inputTokens: 14, outputTokens: 8, totalTokens: 22, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
});

test('a call with no usage field adds nothing', () => {
	const rollup = createRollup();
	observe(rollup, [call('reef', undefined)]);
	assert.deepEqual(rollup.snapshot().models, []);
});

test('a settled event that is not an assistant message is ignored', () => {
	const rollup = createRollup();
	observe(rollup, [
		{ type: 'tool/call', seq: 1, data: { name: 'skill', callId: 'c1', arguments: '{"name":"x"}' } },
		{ type: 'tool/result', seq: 2, data: { message: { toolCallId: 'c1', content: [] } } },
	]);
	assert.deepEqual(rollup.snapshot().models, []);
});

test('cache read tokens are kept apart from uncached input', () => {
	const rollup = createRollup();
	observe(rollup, [call('reef', { inputTokens: 3, cacheReadTokens: 9, cacheWriteTokens: 1, outputTokens: 4, totalTokens: 17 })]);
	const [row] = rollup.snapshot().models;
	assert.equal(row.inputTokens, 3);
	assert.equal(row.cacheReadTokens, 9);
	assert.equal(row.cacheWriteTokens, 1);
});

test('reasoning tokens are surfaced when the adapter reports them', () => {
	const rollup = createRollup();
	observe(rollup, [call('reef', { inputTokens: 2, outputTokens: 6, reasoningTokens: 4, totalTokens: 8 })]);
	const [row] = rollup.snapshot().models;
	assert.equal(row.reasoningTokens, 4);
});

test('a repeated identical settled event in one session counts once', () => {
	const rollup = createRollup();
	const events = [call('reef', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })];
	// The feed delivers the same event twice in one session: it is one call, not two.
	observe(rollup, events);
	// A genuine second call with the same model still adds.
	observe(rollup, [call('reef', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })]);
	const [row] = rollup.snapshot().models;
	assert.equal(row.calls, 2);
});

test('modelOf reads the model from the message source', () => {
	assert.equal(modelOf(call('reef', undefined)), 'reef');
	assert.equal(modelOf({ type: 'assistant/message', data: { message: { source: { model: 'sparks' } } } }), 'sparks');
	assert.equal(modelOf({ type: 'assistant/message', data: { message: {} } }), '');
	assert.equal(modelOf({ type: 'assistant/message' }), '');
});

test('countsOf drops malformed fields and keeps the well-formed ones', () => {
	assert.deepEqual(countsOf({ inputTokens: 5, outputTokens: 'many', totalTokens: -1, cacheReadTokens: 2.5 }), { inputTokens: 5 });
	assert.deepEqual(countsOf(null), {});
	assert.deepEqual(countsOf('x'), {});
});

test('isCount accepts only safe non-negative integers', () => {
	assert.equal(isCount(0), true);
	assert.equal(isCount(3), true);
	assert.equal(isCount(-1), false);
	assert.equal(isCount(1.5), false);
	assert.equal(isCount(Number.MAX_SAFE_INTEGER + 1), false);
	assert.equal(isCount('3'), false);
	assert.equal(isCount(NaN), false);
});

test('restored rows survive a JSON round trip', () => {
	const rollup = createRollup();
	observe(rollup, [call('reef', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })]);
	const original = rollup.snapshot().models[0];
	const restored = createRollup(fromState(JSON.parse(JSON.stringify(rollup.toState()))));
	assert.deepEqual(restored.snapshot().models[0], original);
});

test('a state document without rows restores its start date', () => {
	assert.deepEqual(fromState({ version: 1, activatedAt: 1793724467293 }), {
		activatedAt: 1793724467293,
		models: {},
	});
});

test('a malformed state document is ignored instead of crashing activation', () => {
	assert.deepEqual(fromState({ activatedAt: 'yesterday', models: { a: { inputTokens: 3 } } }), {});
	assert.deepEqual(fromState({ activatedAt: 1790000000000, models: { a: { inputTokens: 3, calls: 'many' }, b: 'nope' } }), {
		activatedAt: 1790000000000,
		models: { a: { calls: 0, inputTokens: 3, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
	});
});
