import test from 'node:test';
import assert from 'node:assert/strict';
import { API_URL, PushoverError, sendPushover } from '../pushover.js';

const REQUEST = {
	token: 'a'.repeat(30),
	user: 'b'.repeat(30),
	title: '✅ ai-stack · 5m',
	message: 'Goal: refactor the parser.\n\nWork is done.',
	priority: 0,
};

/** A fetch response stand-in. */
function response(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return typeof body === 'string' ? body : JSON.stringify(body);
		},
	};
}

/** A fetch that replays responses (or thrown errors) in order, then repeats the last. */
function recorder(...script) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		const step = script.length > 1 ? script.shift() : script[0];
		if (step instanceof Error) throw step;
		return step;
	};
	return { calls, fetchImpl };
}

/** Record retry waits instead of sleeping. */
function sleeps() {
	const waits = [];
	return { waits, sleep: async (milliseconds) => { waits.push(milliseconds); } };
}

test('an accepted message posts the documented fields and returns the request id', async () => {
	const { calls, fetchImpl } = recorder(response(200, { status: 1, request: 'req-9' }));
	const { waits, sleep } = sleeps();
	const result = await sendPushover(REQUEST, { fetchImpl, sleep });

	assert.deepEqual(result, { request: 'req-9' });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, API_URL);
	assert.equal(calls[0].init.method, 'POST');
	assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
	const body = new URLSearchParams(calls[0].init.body);
	assert.equal(body.get('token'), REQUEST.token);
	assert.equal(body.get('user'), REQUEST.user);
	assert.equal(body.get('title'), REQUEST.title);
	assert.equal(body.get('message'), REQUEST.message);
	assert.equal(body.get('priority'), '0');
	assert.equal(waits.length, 0);
});

test('optional fields are omitted when unset', async () => {
	const { calls, fetchImpl } = recorder(response(200, { status: 1 }));
	await sendPushover(REQUEST, { fetchImpl, sleep: async () => {} });
	const body = new URLSearchParams(calls[0].init.body);
	assert.equal(body.has('sound'), false);
	assert.equal(body.has('device'), false);
	assert.equal(body.has('timestamp'), false);
});

test('a 4xx rejection is final and surfaces the API errors', async () => {
	const { calls, fetchImpl } = recorder(response(400, { status: 0, errors: ['application token is invalid'] }));
	const { waits, sleep } = sleeps();
	await assert.rejects(sendPushover(REQUEST, { fetchImpl, sleep }), (error) => {
		assert.ok(error instanceof PushoverError);
		assert.match(error.message, /HTTP 400/);
		assert.match(error.message, /application token is invalid/);
		return true;
	});
	assert.equal(calls.length, 1);
	assert.equal(waits.length, 0);
});

test('HTTP 200 with status 0 is a rejection, not a success', async () => {
	const { calls, fetchImpl } = recorder(response(200, { status: 0, errors: ['user key is invalid'] }));
	const { waits, sleep } = sleeps();
	await assert.rejects(sendPushover(REQUEST, { fetchImpl, sleep }), /user key is invalid/);
	assert.equal(calls.length, 1);
	assert.equal(waits.length, 0);
});

test('monthly quota exhaustion (429) is not retried', async () => {
	const { calls, fetchImpl } = recorder(response(429, { status: 0, errors: ['monthly limit exceeded'] }));
	const { waits, sleep } = sleeps();
	await assert.rejects(sendPushover(REQUEST, { fetchImpl, sleep }), /monthly limit exceeded/);
	assert.equal(calls.length, 1);
	assert.equal(waits.length, 0);
});

test('a transient server failure is retried after Pushover\'s minimum wait', async () => {
	const { calls, fetchImpl } = recorder(response(503, 'service unavailable'), response(200, { status: 1, request: 'req-2' }));
	const { waits, sleep } = sleeps();
	const result = await sendPushover(REQUEST, { fetchImpl, sleep });
	assert.deepEqual(result, { request: 'req-2' });
	assert.equal(calls.length, 2);
	assert.deepEqual(waits, [5000]);
});

test('an accepted send logs the attempt count and Pushover request id', async () => {
	const { fetchImpl } = recorder(response(200, { status: 1, request: 'req-9' }));
	const entries = [];
	await sendPushover(REQUEST, {
		fetchImpl,
		sleep: async () => {},
		log: (entry) => { entries.push(entry); },
	});
	assert.deepEqual(entries, [{ attempt: 1, request: 'req-9' }]);
});

test('the log seam sees the final attempt after a retry', async () => {
	const { fetchImpl } = recorder(response(503, 'service unavailable'), response(200, { status: 1, request: 'req-2' }));
	const entries = [];
	await sendPushover(REQUEST, {
		fetchImpl,
		sleep: async () => {},
		log: (entry) => { entries.push(entry); },
	});
	assert.deepEqual(entries, [{ attempt: 2, request: 'req-2' }]);
});

test('a rejected send logs nothing and does not change the failure', async () => {
	const { fetchImpl } = recorder(response(400, { status: 0, errors: ['application token is invalid'] }));
	const entries = [];
	await assert.rejects(
		sendPushover(REQUEST, {
			fetchImpl,
			sleep: async () => {},
			log: (entry) => { entries.push(entry); },
		}),
		/PushoverError/,
	);
	assert.deepEqual(entries, []);
});

test('a throwing log callback does not change the accepted outcome', async () => {
	const { fetchImpl } = recorder(response(200, { status: 1, request: 'req-1' }));
	const result = await sendPushover(REQUEST, {
		fetchImpl,
		sleep: async () => {},
		log: () => { throw new Error('diagnostic sink unavailable'); },
	});
	assert.deepEqual(result, { request: 'req-1' });
});

test('a connection failure is retried too', async () => {
	const { calls, fetchImpl } = recorder(new Error('ECONNRESET'), response(200, { status: 1 }));
	const { waits, sleep } = sleeps();
	await sendPushover(REQUEST, { fetchImpl, sleep });
	assert.equal(calls.length, 2);
	assert.deepEqual(waits, [5000]);
});

test('retries are bounded and the last failure is reported', async () => {
	const { calls, fetchImpl } = recorder(response(500, 'boom'));
	const { waits, sleep } = sleeps();
	await assert.rejects(sendPushover(REQUEST, { fetchImpl, sleep }), /HTTP 500/);
	assert.equal(calls.length, 3);
	assert.deepEqual(waits, [5000, 10_000]);
});

test('a link and its label are posted when configured', async () => {
	const { calls, fetchImpl } = recorder(response(200, { status: 1 }));
	await sendPushover({ ...REQUEST, url: 'https://example.test/', urlTitle: 'Open DSH' }, { fetchImpl, sleep: async () => {} });
	const body = new URLSearchParams(calls[0].init.body);
	assert.equal(body.get('url'), 'https://example.test/');
	assert.equal(body.get('url_title'), 'Open DSH');
});
