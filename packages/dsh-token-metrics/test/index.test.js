/**
 * Behaviour tests for activation: the panel's overview reflects live session
 * events, rows survive a reload through the state file, and a malformed state
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

import { activeProfile, apply, readState, stateFilePath, writeState } from '../index.js';

/** One settled model call carrying a usage field. */
function modelCall(callId, model, usage) {
	return {
		type: 'assistant/message', seq: 1, time: 1790000000000,
		data: { turn: 1, step: 1, message: { role: 'assistant', source: { provider: 'test', model } }, usage },
	};
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
	const directory = mkdtempSync(join(tmpdir(), 'token-metrics-'));
	return { file: join(directory, 'state.json'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('a settled model call on the live feed appears once, and the panel says when counting began', () => {
	const { file, cleanup } = temporaryState();
	try {
		const host = boot(file);
		const before = Date.now();
		host.emit('session/event', { id: 'session-a' }, modelCall('c1', 'reef', { inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
		const overview = host.overview();
		assert.equal(overview.models.length, 1);
		assert.deepEqual(overview.models[0].model, 'reef');
		assert.equal(overview.models[0].calls, 1);
		assert.ok(overview.activatedAt >= before - 1000 && overview.activatedAt <= Date.now());
		host.dispose();
	} finally {
		cleanup();
	}
});

test('a settled call with no usage field and a non-usage event add nothing', () => {
	const { file, cleanup } = temporaryState();
	try {
		const host = boot(file);
		host.emit('session/event', { id: 'session-a' }, modelCall('c1', 'reef', undefined));
		host.emit('session/event', { id: 'session-b' }, { type: 'tool/call', data: { callId: 'c2', name: 'skill' } });
		assert.deepEqual(host.overview().models, []);
		host.dispose();
	} finally {
		cleanup();
	}
});

test('rows persist to the state file and a restart continues them', () => {
	const { file, cleanup } = temporaryState();
	try {
		const host = boot(file);
		host.emit('session/event', { id: 'session-a' }, modelCall('c1', 'reef', { inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
		host.dispose();
		assert.equal(existsSync(file), true);
		const persisted = JSON.parse(readFileSync(file, 'utf8'));
		assert.equal(persisted.models.reef.calls, 1);

		const host2 = boot(file);
		assert.equal(host2.overview().models[0].calls, 1, 'the restored row is kept, not reset');
		host2.emit('session/event', { id: 'session-a' }, modelCall('c2', 'reef', { inputTokens: 1, outputTokens: 1, totalTokens: 2 }));
		assert.equal(host2.overview().models[0].calls, 2, 'a new call after restart adds to the row');
		host2.dispose();
	} finally {
		cleanup();
	}
});

test('a malformed state file starts a fresh count at activation', () => {
	const { file, cleanup } = temporaryState();
	try {
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, 'not json');
		const host = boot(file);
		assert.deepEqual(host.overview().models, []);
		assert.ok(host.overview().activatedAt >= Date.now() - 1000);
		host.dispose();
	} finally {
		cleanup();
	}
});

test('activeProfile reads the --profile value from argv', () => {
	assert.equal(activeProfile(['node', 'index.js', '--profile', 'web']), 'web');
	assert.equal(activeProfile(['node', 'index.js', '--profile=web']), 'web');
	assert.equal(activeProfile(['node', 'index.js']), undefined);
	assert.equal(activeProfile(['node', 'index.js', '--profile', '']), undefined);
});

test('stateFilePath defaults to the DSH home and honours a config override', () => {
	process.env.DSH_HOME = '';
	assert.equal(stateFilePath({ stateFile: '/tmp/override.json' }, { argv: ['node', 'index.js'] }), '/tmp/override.json');
});

test('writeState persists a state file and readState reads it back', () => {
	const { file, cleanup } = temporaryState();
	try {
		const state = { version: 1, activatedAt: 1, models: { reef: { calls: 1 } } };
		const rollup = { toState: () => state };
		assert.equal(writeState(file, rollup), true);
		assert.deepEqual(readState(file), { activatedAt: 1, models: { reef: { calls: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } });
	} finally {
		cleanup();
	}
});
