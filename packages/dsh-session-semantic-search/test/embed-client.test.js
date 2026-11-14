/**
 * Embedding-client policy tests: retry classes, backoff, Retry-After, abort,
 * and the serial in-flight queue (B4).
 */

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { EmbeddingClient, EmbeddingError, parseRetryAfterMs } from '../lib/embed-client.js';
import { bagVector, startEmbedServer } from './helpers.js';

/**
 * Build a client with a recording sleep and the design's real backoff.
 * @param {string} url - endpoint URL.
 * @param {object} [overrides] - client option overrides.
 * @returns {{ client: EmbeddingClient, delays: number[] }} client and recorded delays.
 */
function recordingClient(url, overrides = {}) {
	const delays = [];
	const client = new EmbeddingClient({
		endpointUrl: url,
		model: 'nomic-embed-text-v1.5',
		dim: 768,
		timeoutMs: 2_000,
		maxAttempts: 3,
		retryBaseMs: 30_000,
		retryMaxMs: 300_000,
		sleep: async (ms) => {
			delays.push(ms);
		},
		...overrides,
	});
	return { client, delays };
}

/**
 * Wrap `globalThis.fetch` to count how many embedding HTTP calls are in flight at
 * once. Used to prove the serial queue keeps in-flight concurrency at exactly one.
 * @param {{ max?: number } } [opts] - optional recorder.
 * @returns {() => void} restore function.
 */
function trackInFlight() {
	const state = { current: 0, max: 0 };
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		state.current += 1;
		if (state.current > state.max) state.max = state.current;
		try {
			return await real(input, init);
		} finally {
			state.current -= 1;
		}
	};
	return () => {
		globalThis.fetch = real;
		return state;
	};
}

test('parseRetryAfterMs accepts delta-seconds and HTTP dates', () => {
	assert.equal(parseRetryAfterMs('1'), 1000);
	assert.equal(parseRetryAfterMs('0'), 0);
	assert.equal(parseRetryAfterMs(undefined), undefined);
	const now = Date.parse('2026-01-01T00:00:00Z');
	assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
});

test('a 429 retry honors Retry-After instead of the doubling base delay', async () => {
	const server = await startEmbedServer((body, _request, call) =>
		call === 1 ? { status: 429, headers: { 'retry-after': '1' } } : { body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) } },
	);
	try {
		const { client, delays } = recordingClient(server.url);
		const [vector] = await client.embed(['hello world']);
		assert.equal(vector.length, 768);
		assert.deepEqual(delays, [1000], 'Retry-After wins over the 30 s base delay');
		assert.equal(server.calls, 2);
	} finally {
		await server.close();
	}
});

test('a 500 gives up after three attempts with 30 s then 60 s', async () => {
	const server = await startEmbedServer(() => ({ status: 500, body: { error: 'boom' } }));
	try {
		const { client, delays } = recordingClient(server.url);
		await assert.rejects(client.embed(['hello']), (error) => {
			assert.ok(error instanceof EmbeddingError);
			assert.equal(error.retryable, true);
			assert.match(error.message, /gave up after 3 attempts/u);
			return true;
		});
		assert.deepEqual(delays, [30_000, 60_000]);
		assert.equal(server.calls, 3);
	} finally {
		await server.close();
	}
});

test('retry delay doubles and caps at five minutes', async () => {
	const server = await startEmbedServer(() => ({ status: 503 }));
	try {
		const { client, delays } = recordingClient(server.url, { maxAttempts: 7 });
		await assert.rejects(client.embed(['hello']), EmbeddingError);
		assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
	} finally {
		await server.close();
	}
});

test('a dropped connection is retried and then succeeds', async () => {
	const server = await startEmbedServer((body, _request, call) =>
		call === 1
			? { destroy: true }
			: { body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) } },
	);
	try {
		const { client, delays } = recordingClient(server.url);
		const vectors = await client.embed(['a', 'b']);
		assert.equal(vectors.length, 2);
		assert.deepEqual(delays, [30_000]);
	} finally {
		await server.close();
	}
});

test('a non-retryable 4xx fails on the first attempt', async () => {
	const server = await startEmbedServer(() => ({ status: 400, body: { error: 'bad input' } }));
	try {
		const { client, delays } = recordingClient(server.url);
		await assert.rejects(client.embed(['hello']), (error) => {
			assert.equal(error.retryable, false);
			assert.equal(error.status, 400);
			return true;
		});
		assert.deepEqual(delays, []);
		assert.equal(server.calls, 1);
	} finally {
		await server.close();
	}
});

test('a dimension mismatch is fatal instead of silently stored', async () => {
	const server = await startEmbedServer((body) => ({
		body: { data: body.input.map((_text, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) },
	}));
	try {
		const { client } = recordingClient(server.url);
		await assert.rejects(client.embed(['hello']), (error) => {
			assert.equal(error.retryable, false);
			assert.match(error.message, /dimensions/u);
			return true;
		});
	} finally {
		await server.close();
	}
});

test('an already-aborted signal makes no request', async () => {
	const server = await startEmbedServer((body) => ({
		body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) },
	}));
	try {
		const { client } = recordingClient(server.url);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(client.embed(['hello'], { signal: controller.signal }), /aborted/u);
		assert.equal(server.calls, 0);
	} finally {
		await server.close();
	}
});

test('two concurrent embeds never run more than one request in flight', async () => {
	const restore = trackInFlight();
	const server = await startEmbedServer((body) => ({
		delayMs: 80,
		body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) },
	}));
	try {
		const { client } = recordingClient(server.url, { maxAttempts: 1 });
		const [a, b] = await Promise.all([client.embed(['document one']), client.embed(['document two'])]);
		assert.equal(a[0].length, 768);
		assert.equal(b[0].length, 768);
		assert.equal(server.calls, 2);
	} finally {
		await server.close();
	}
	const state = restore();
	// The serial queue must keep in-flight HTTP calls at exactly one even while
	// two callers are waiting. This is load-independent: we do not rely on the
	// measured elapsed time, only on the observed in-flight count.
	assert.equal(state.max, 1, `two 80 ms calls must never overlap; observed max ${state.max} in flight`);
});

test('a canceled waiter is never dispatched to the endpoint', async () => {
	const server = await startEmbedServer((body) => ({
		delayMs: 80,
		body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) },
	}));
	try {
		const { client } = recordingClient(server.url, { maxAttempts: 1 });
		const blocker = client.embed(['slow document']);
		const controller = new AbortController();
		const cancelled = client.embed(['cancelled document'], { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await assert.rejects(cancelled, (error) => {
			assert.ok(error instanceof EmbeddingError);
			return true;
		});
		const [vector] = await blocker;
		assert.equal(vector.length, 768);
		// Exactly one call reached the endpoint: the blocked document. The aborted
		// waiter never dispatched its HTTP call.
		assert.equal(server.calls, 1);
	} finally {
		await server.close();
	}
});

test('a full backlog rejects immediately instead of trapping a query behind a slow retry', async () => {
	// Both blockers take 3 s each, well past the 1.5 s queryEmbed budget, so the
	// query's slot is never freed in time and it degrades to FTS (returns undefined).
	const server = await startEmbedServer((body, _request) => ({
		delayMs: 3000,
		body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) },
	}));
	try {
		const { client } = recordingClient(server.url, { maxAttempts: 1, maxQueue: 2 });
		const blockers = [
			client.embed(['slow document']),
			client.embed(['slow document two']),
		];
		await new Promise((resolve) => setTimeout(resolve, 30));
		const start = Date.now();
		const vector = await client.queryEmbed('query');
		const waited = Date.now() - start;
		assert.equal(vector, undefined, 'queryEmbed must return undefined when the budget is exhausted');
		assert.ok(waited < 1600, `queryEmbed must give up within ~1.5 s; waited ${waited} ms`);
		await Promise.allSettled(blockers);
	} finally {
		await server.close();
	}
});

test('a query embedding is not queued behind a document batch in retry backoff', async () => {
	const server = await startEmbedServer((body) =>
		body.input.every((text) => text.startsWith('search_query: '))
			? { body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) } }
			: { status: 503, body: { error: 'overloaded' } },
	);
	const client = new EmbeddingClient({ endpointUrl: server.url, dim: 768, timeoutMs: 5_000, maxAttempts: 3, retryBaseMs: 5_000, retryMaxMs: 5_000 });
	const indexer = new AbortController();
	const batch = client.embed(['an indexer document'], { signal: indexer.signal });
	batch.catch(() => {});
	try {
		for (let wait = 0; server.calls === 0 && wait < 100; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
		const startedAt = Date.now();
		const vector = await client.queryEmbed('find the release notes', { timeoutMs: 1_000 });
		const elapsed = Date.now() - startedAt;
		assert.ok(vector instanceof Float32Array, 'the query was answered instead of waiting out the backoff');
		assert.ok(elapsed < 1_000, `query waited ${elapsed} ms`);
	} finally {
		indexer.abort();
		await batch.catch(() => {});
		await server.close();
	}
});

test('aborting a document batch during its retry backoff frees the client at once', async () => {
	const server = await startEmbedServer(() => ({ status: 503 }));
	// The built-in sleep, not an injected one: it must honor the signal.
	const client = new EmbeddingClient({ endpointUrl: server.url, dim: 768, timeoutMs: 5_000, maxAttempts: 3, retryBaseMs: 3_000, retryMaxMs: 3_000 });
	const controller = new AbortController();
	try {
		const batch = client.embed(['document'], { signal: controller.signal });
		for (let wait = 0; server.calls === 0 && wait < 100; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
		const startedAt = Date.now();
		controller.abort();
		await assert.rejects(batch, /aborted/u);
		// The next caller must not wait out the aborted batch's backoff.
		await assert.rejects(client.embed(['next document'], { maxAttempts: 1 }), /HTTP 503/u);
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 1_000, `the next call waited ${elapsed} ms behind an aborted backoff`);
		assert.equal(server.calls, 2, 'the aborted batch made no further attempt');
	} finally {
		await server.close();
	}
});

test('abort listeners do not accumulate on a long-lived signal', async () => {
	const server = await startEmbedServer((body) => ({ body: { data: body.input.map((text, index) => ({ index, embedding: bagVector(text) })) } }));
	try {
		const { client } = recordingClient(server.url, { maxAttempts: 1 });
		const controller = new AbortController();
		for (let index = 0; index < 20; index += 1) await client.embed([`document ${index}`], { signal: controller.signal });
		assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'every settled call removed its abort listener');
	} finally {
		await server.close();
	}
});
