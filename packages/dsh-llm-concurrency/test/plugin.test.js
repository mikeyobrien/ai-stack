/**
 * Behavior tests for `@local/dsh-llm-concurrency`: a provider's request ceiling
 * is enforced through the `llm/stream` waterfall, so the assertions are made
 * against observable stream behavior — how many requests run at once, the order
 * they are admitted in, and whether a slot comes back after failure or abort.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { InFlightLimiter, apply } from '../index.js';

/** Resolve after a real delay, so stream overlap is observable. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake Cordis context that captures the waterfall listener.
 * @returns the listeners registered by the plugin.
 */
function fakeContext() {
	const listeners = [];
	const lines = [];
	const ctx = {
		logger: {
			info: (...args) => lines.push(args),
			debug: (...args) => lines.push(args),
		},
		on(event, listener) {
			listeners.push({ event, listener });
			return () => {};
		},
	};
	return { ctx, listeners, lines };
}

/**
 * The plugin's `llm/stream` listener.
 * @param listeners - captured registrations.
 * @returns the listener function.
 */
function streamListener(listeners) {
	const found = listeners.find((each) => each.event === 'llm/stream');
	assert.ok(found, 'plugin did not register an llm/stream listener');
	return found.listener;
}

/**
 * A downstream request that records its own overlap and finish order.
 * @param state - shared counters.
 * @param label - identity recorded at admission.
 * @param holdMs - how long the request stays in flight.
 * @returns a `next` callback for the listener.
 */
function instrumentedNext(state, label, holdMs) {
	return () => (async function* () {
		state.active += 1;
		state.peak = Math.max(state.peak, state.active);
		state.admitted.push(label);
		try {
			await delay(holdMs);
			yield { type: 'text', text: label };
		} finally {
			state.active -= 1;
			state.finished.push(label);
		}
	})();
}

/** Counters for one concurrency experiment. */
function newState() {
	return { active: 0, peak: 0, admitted: [], finished: [] };
}

/**
 * Drive one stream to completion.
 * @param stream - async iterable of chunks.
 * @returns the chunk list.
 */
async function drain(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

test('admits at most the configured number of requests at once', async () => {
	const { ctx, listeners } = fakeContext();
	apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 4 }] });
	const stream = streamListener(listeners);
	const state = newState();
	const request = () => stream({ provider: 'sparks', model: 'deepseek-v4.1-flash' }, instrumentedNext(state, 'r', 20));

	const all = Array.from({ length: 8 }, () => drain(request()));
	assert.equal(state.active, 0, 'a stream must not start before it is iterated');
	await Promise.all(all);

	assert.equal(state.peak, 4, 'peak overlap must equal the configured ceiling');
	assert.equal(state.finished.length, 8, 'every queued request must finish');
});

test('admits queued requests in arrival order', async () => {
	const { ctx, listeners } = fakeContext();
	apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 1 }] });
	const stream = streamListener(listeners);
	const state = newState();
	const request = (label) => stream({ provider: 'sparks', model: 'm' }, instrumentedNext(state, label, 10));

	await Promise.all([drain(request('a')), drain(request('b')), drain(request('c'))]);

	assert.deepEqual(state.admitted, ['a', 'b', 'c']);
});

test('returns the slot when a downstream request fails', async () => {
	const { ctx, listeners } = fakeContext();
	apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 1 }] });
	const stream = streamListener(listeners);
	const failing = () => (async function* () {
		await delay(5);
		throw new Error('provider exploded');
	})();
	const state = newState();

	const failed = stream({ provider: 'sparks', model: 'm' }, failing);
	const survivor = stream({ provider: 'sparks', model: 'm' }, instrumentedNext(state, 'after', 5));

	await assert.rejects(drain(failed), /provider exploded/);
	await drain(survivor);
	assert.deepEqual(state.admitted, ['after'], 'a failed request must not keep its slot');
});

test('an aborted waiter leaves the queue without taking a slot', async () => {
	const { ctx, listeners } = fakeContext();
	apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 1 }] });
	const stream = streamListener(listeners);
	const state = newState();
	const controller = new AbortController();

	const holder = drain(stream({ provider: 'sparks', model: 'm' }, instrumentedNext(state, 'holder', 25)));
	const queued = drain(stream({ provider: 'sparks', model: 'm', signal: controller.signal }, instrumentedNext(state, 'queued', 5)));
	setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 5);

	await assert.rejects(queued, (error) => error.name === 'AbortError');
	await holder;
	assert.deepEqual(state.finished, ['holder'], 'the cancelled waiter must never reach the provider');
});

test('a cancelled consumer releases its slot', async () => {
	const { ctx, listeners } = fakeContext();
	apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 1 }] });
	const stream = streamListener(listeners);
	let produced = 0;

	const first = stream({ provider: 'sparks', model: 'm' }, () => (async function* () {
		produced += 1;
		yield { type: 'text', text: 'one' };
		yield { type: 'text', text: 'two' };
		await delay(50);
	})());
	const second = stream({ provider: 'sparks', model: 'm' }, () => (async function* () {
		produced += 1;
		yield { type: 'text', text: 'done' };
	})());

	for await (const chunk of first) {
		assert.equal(chunk.text, 'one');
		break;
	}
	assert.equal(produced, 1);

	await drain(second);
	assert.equal(produced, 2, 'breaking out of a stream must hand the slot to the queue');
});

test('passes unconfigured providers straight through', async () => {
	const { ctx, listeners } = fakeContext();
	apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 1 }] });
	const stream = streamListener(listeners);
	const downstream = (async function* () { yield { type: 'text', text: 'untouched' }; })();
	const passed = stream({ provider: 'deepseek-official', model: 'deepseek-flash' }, () => downstream);

	assert.equal(passed, downstream, 'an unlimited provider must not be wrapped at all');
});

test('limits only the listed models of a provider', async () => {
	const { ctx, listeners } = fakeContext();
	apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 1, models: ['limited'] }] });
	const stream = streamListener(listeners);
	const request = (model, label, state) => stream({ provider: 'sparks', model }, instrumentedNext(state, label, 15));

	const unlimited = newState();
	await Promise.all([drain(request('other', 'x', unlimited)), drain(request('other', 'y', unlimited))]);
	assert.equal(unlimited.peak, 2, 'an unlisted model must not be capped');

	const capped = newState();
	await Promise.all([drain(request('limited', 'p', capped)), drain(request('limited', 'q', capped))]);
	assert.equal(capped.peak, 1, 'the listed model keeps its ceiling');
});

test('rejects malformed configuration at load', () => {
	const { ctx } = fakeContext();
	assert.throws(() => apply(ctx, { rules: [{ provider: 'sparks' }] }), /maxInFlight/);
	assert.throws(() => apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 0 }] }), /maxInFlight/);
	assert.throws(() => apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 2, extra: true }] }), /unknown key "extra"/);
	assert.throws(() => apply(ctx, { rules: [{ provider: '', maxInFlight: 2 }] }), /provider/);
	assert.throws(
		() => apply(ctx, { rules: [{ provider: 'sparks', maxInFlight: 1 }, { provider: 'sparks', maxInFlight: 2 }] }),
		/configured more than once/,
	);
	assert.throws(() => apply(ctx, { cap: 4 }), /unknown config key "cap"/);
});

test('the limiter releases a slot exactly once per acquisition', async () => {
	const limiter = new InFlightLimiter(1);
	const release = await limiter.acquire();
	assert.equal(limiter.active, 1);
	release();
	release();
	assert.equal(limiter.active, 0);

	const blocker = await limiter.acquire();
	const waiting = limiter.acquire();
	assert.equal(limiter.waiting, 1);
	blocker();
	await waiting;
	assert.equal(limiter.active, 1);
	assert.equal(limiter.peak, 1);
});
