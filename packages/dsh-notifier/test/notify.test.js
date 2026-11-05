import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveSettings } from '../index.js';

/** Fixed epoch for synthetic events. */
const START = 1_700_000_000_000;

/** Five minutes: comfortably past the default threshold. */
const LONG = 5 * 60_000;

/** Route the plugin's delivery through a recording fetch. */
async function withFetch(fetchImpl, run) {
	const original = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

/** An accepted Pushover answer. */
function accepted(request = 'req-1') {
	return { ok: true, status: 200, async text() { return JSON.stringify({ status: 1, request }); } };
}

/** Collect `[dsh-notifier]` diagnostics instead of printing them. */
function captureStderr() {
	const original = process.stderr.write;
	const lines = [];
	process.stderr.write = (chunk) => {
		lines.push(String(chunk));
		return true;
	};
	return { lines, restore() { process.stderr.write = original; } };
}

let stderr;
beforeEach(() => {
	stderr = captureStderr();
});
afterEach(() => {
	stderr.restore();
});

/** A Cordis context stand-in with the `credentials` service the plugin injects. */
function fakeContext(credentials = { PUSHOVER_TOKEN: 'app-token', PUSHOVER_USER: 'user-key' }, services = {}) {
	const handlers = new Map();
	return {
		on(type, handler) {
			handlers.set(type, handler);
		},
		get(name) {
			return services[name];
		},
		credentials: {
			async resolve(ref) {
				const value = credentials[ref];
				return value === undefined ? undefined : { value, source: 'test' };
			},
		},
		emit(session, events) {
			for (const event of events) handlers.get('session/event')(session, event);
		},
	};
}

/** A session stand-in with the header fields the plugin reads. */
function fakeSession({ id = 'root', cwd = '/home/me/ai-stack', origin } = {}) {
	return { id, header: { cwd, ...(origin === undefined ? {} : { origin }) } };
}

/** One complete turn in committed-event order. */
function turnEvents({
	turn = 1,
	durationMs = LONG,
	reason = { kind: 'completed' },
	ask = 'Refactor the parser.',
	source = { kind: 'user' },
	closing = 'Work is done.',
} = {}) {
	return [
		{ type: 'turn/start', time: START, data: { turn } },
		{ type: 'user/message', time: START + 100, data: { role: 'user', id: 'u1', source, content: [{ type: 'text', text: ask }] } },
		{ type: 'tool/call', time: START + 1000, data: { turn, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
		{ type: 'tool/result', time: START + 2000, data: { turn, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } } },
		{ type: 'tool/result', time: START + 3000, data: { turn, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'boom' }] }, error: { name: 'ToolError', code: 'E_FAIL' } } },
		{ type: 'assistant/message', time: START + durationMs - 1000, data: { turn, step: 2, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: closing }] }, usage: { inputTokens: 1000, outputTokens: 500 } } },
		{ type: 'turn/end', time: START + durationMs, data: { turn, reason } },
	];
}

/** Wait until `predicate` holds, so assertions read settled state. */
async function settle(predicate, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Wait long enough for a delivery that should not happen. */
function quiet(milliseconds = 150) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('a long turn is pushed with its generated summary', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push({ url, body: new URLSearchParams(init.body) });
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents());
		await settle(() => calls.length === 1);
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://api.pushover.net/1/messages.json');
	assert.equal(calls[0].body.get('token'), 'app-token');
	assert.equal(calls[0].body.get('user'), 'user-key');
	assert.equal(calls[0].body.get('title'), '✅ ai-stack · 5m');
	assert.match(calls[0].body.get('message'), /^Goal: Refactor the parser\./);
	assert.match(calls[0].body.get('message'), /Work is done\./);
	assert.match(calls[0].body.get('message'), /1 tool call · 1 failed · 1\.5k tokens$/);
	assert.equal(calls[0].body.get('timestamp'), String(Math.floor((START + LONG) / 1000)));
});

test('an automatic goal round shows the goal objective, not the round prompt', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [
			goalChange({
				operation: 'create',
				goal: { id: 'goal-1', revision: 1, objective: 'Ship the parser rewrite.', phase: 'active' },
			}),
			{
				type: 'turn/start',
				time: START,
				data: { turn: 1 },
			},
			{
				type: 'user/message',
				time: START + 100,
				data: {
					role: 'user',
					id: 'u2',
					source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 },
					content: [{ type: 'text', text: '<goal_round>\nObjective: "Ship the parser rewrite."\nRound: 1/256\n\nContinue working toward the objective.\n</goal_round>' }],
				},
			},
			{ type: 'assistant/message', time: START + LONG - 1000, data: { turn: 1, step: 2, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'Round one landed.' }] }, usage: { inputTokens: 100, outputTokens: 50 } } },
			{ type: 'turn/end', time: START + LONG, data: { turn: 1, reason: { kind: 'completed' } } },
		]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.match(calls[0].get('message'), /^Goal: Ship the parser rewrite\.\s*$/m);
	assert.doesNotMatch(calls[0].get('message'), /<goal_round>|Round: 1/);
});

test('a goal round without a goal snapshot gets no goal line', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [
			{ type: 'turn/start', time: START, data: { turn: 1 } },
			{
				type: 'user/message',
				time: START + 100,
				data: {
					role: 'user',
					id: 'u3',
					source: { kind: 'goal', goalId: 'goal-2', revision: 1, round: 1 },
					content: [{ type: 'text', text: '<goal_round>\nObjective: "Something nobody recorded."\n</goal_round>' }],
				},
			},
			{ type: 'assistant/message', time: START + LONG - 1000, data: { turn: 1, step: 2, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'Working on it.' }] } } },
			{ type: 'turn/end', time: START + LONG, data: { turn: 1, reason: { kind: 'completed' } } },
		]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.doesNotMatch(calls[0].get('message'), /Goal:|<goal_round>|Round:/);
});

test('notices and relays are never read as a human request', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [
			{ type: 'turn/start', time: START, data: { turn: 1 } },
			{
				type: 'user/message',
				time: START + 100,
				data: { role: 'user', id: 'u4', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'Background job finished: the build.' }] },
			},
			{ type: 'assistant/message', time: START + LONG - 1000, data: { turn: 1, step: 2, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'Done.' }] } } },
			{ type: 'turn/end', time: START + LONG, data: { turn: 1, reason: { kind: 'completed' } } },
		]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.doesNotMatch(calls[0].get('message'), /Goal:|Background job finished/);
});

test('two genuine human turns in one session stay two pushes', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [
			{ type: 'turn/start', time: START, data: { turn: 1 } },
			{ type: 'user/message', time: START + 100, data: { role: 'user', id: 'u5', source: { kind: 'user' }, content: [{ type: 'text', text: 'First request.' }] } },
			{ type: 'assistant/message', time: START + LONG - 1000, data: { turn: 1, step: 2, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'One done.' }] } } },
			{ type: 'turn/end', time: START + LONG, data: { turn: 1, reason: { kind: 'completed' } } },
			{ type: 'turn/start', time: START + LONG + 1000, data: { turn: 2 } },
			{ type: 'user/message', time: START + LONG + 1100, data: { role: 'user', id: 'u6', source: { kind: 'user' }, content: [{ type: 'text', text: 'Second request.' }] } },
			{ type: 'assistant/message', time: START + 2 * LONG, data: { turn: 2, step: 2, message: { role: 'assistant', id: 'a2', content: [{ type: 'text', text: 'Two done.' }] } } },
			{ type: 'turn/end', time: START + 2 * LONG, data: { turn: 2, reason: { kind: 'completed' } } },
		]);
		await settle(() => calls.length === 2);
	});
	assert.equal(calls.length, 2);
	assert.match(calls[0].get('message'), /Goal: First request\./);
	assert.match(calls[1].get('message'), /Goal: Second request\./);
});

test('a repeated goal snapshot with no terminal mutation stays silent', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [
			goalChange({
				operation: 'create',
				goal: { id: 'goal-1', revision: 2, objective: 'Ship the parser rewrite.', phase: 'active' },
			}),
			goalChange({
				operation: 'edit',
				goal: { id: 'goal-1', revision: 2, objective: 'Ship the parser rewrite.', phase: 'active' },
			}),
		]);
		await quiet();
	});
	assert.equal(calls.length, 0);
});

test('a cleared goal leaves no stale objective on an automatic turn', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [goalChange({
			operation: 'create',
			goal: { id: 'goal-1', revision: 1, objective: 'Ship the parser rewrite.', phase: 'active' },
		})]);
		ctx.emit(fakeSession(), [{
			type: 'goal/change',
			time: START + 1,
			data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal-1', revision: 1 }, clearedAt: START + 1 },
		}]);
		ctx.emit(fakeSession(), [
			{ type: 'turn/start', time: START + 2, data: { turn: 1 } },
			{ type: 'user/message', time: START + 3, data: { role: 'user', id: 'u7', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'Background job finished: build.' }] } },
			{ type: 'assistant/message', time: START + LONG - 1000, data: { turn: 1, step: 2, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'Job done.' }] } } },
			{ type: 'turn/end', time: START + LONG, data: { turn: 1, reason: { kind: 'completed' } } },
		]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.doesNotMatch(calls[0].get('message'), /Goal:|<goal_round>/);
});

test('a terminal goal leaves no stale objective for a later automatic turn', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [goalChange({
			operation: 'create',
			goal: { id: 'goal-1', revision: 1, objective: 'Ship the parser rewrite.', phase: 'active' },
		})]);
		ctx.emit(fakeSession(), [goalChange({
			operation: 'complete',
			goal: { id: 'goal-1', revision: 2, objective: 'Ship the parser rewrite.', phase: 'complete' },
		})]);
		await quiet();
		ctx.emit(fakeSession(), [
			{ type: 'turn/start', time: START + LONG, data: { turn: 2 } },
			{ type: 'user/message', time: START + LONG + 1, data: { role: 'user', id: 'u8', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'Build finished.' }] } },
			{ type: 'assistant/message', time: START + 2 * LONG - 1000, data: { turn: 2, step: 2, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'Done.' }] } } },
			{ type: 'turn/end', time: START + 2 * LONG, data: { turn: 2, reason: { kind: 'completed' } } },
		]);
		await settle(() => calls.length === 2);
	});
	assert.equal(calls.length, 2);
	assert.doesNotMatch(calls[1].get('message'), /Goal:|Ship the parser/);
});

test('a <goal_complete> notice is never read as a human request', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [
			{ type: 'turn/start', time: START, data: { turn: 1 } },
			{
				type: 'user/message',
				time: START + 100,
				data: {
					role: 'user',
					id: 'u9',
					source: { kind: 'tool-goal', form: 'notice' },
					content: [{ type: 'text', text: '<goal_complete>\nObjective: "Ship the parser rewrite."\nThe goal is marked complete. No further action needed.\n</goal_complete>' }],
				},
			},
			{ type: 'assistant/message', time: START + LONG - 1000, data: { turn: 1, step: 2, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'Goal complete.' }] } } },
			{ type: 'turn/end', time: START + LONG, data: { turn: 1, reason: { kind: 'completed' } } },
		]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.doesNotMatch(calls[0].get('message'), /Goal:|<goal_round>|<goal_complete>/);
});

test('a push records its attempt count and Pushover request id on delivery', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted('req-7');
	}, async () => {
		ctx.emit(fakeSession(), turnEvents());
		await settle(() => calls.length === 1);
	});
	assert.match(stderr.lines.join(''), /accepted after 1 attempt\(s\), Pushover request req-7/);
	assert.match(stderr.lines.join(''), /sent "✅ ai-stack · 5m"/);
});

test('a turn shorter than the threshold stays silent', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents({ durationMs: 30_000 }));
		await quiet();
	});
	assert.equal(calls.length, 0);
});

test('a turn that reaches the threshold exactly is pushed', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, { minDurationSeconds: 120 });
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents({ durationMs: 120_000 }));
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
});

test('a failed turn is pushed as failed, with the reason', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents({ reason: { kind: 'error', error: { code: 'X', message: 'the provider returned HTTP 503' } } }));
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].get('title'), '⚠️ ai-stack failed · 5m');
	assert.match(calls[0].get('message'), /^Error: the provider returned HTTP 503/);
});

test('a forked turn end is not a completion and stays silent', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents({ reason: { kind: 'forked' } }));
		await quiet();
	});
	assert.equal(calls.length, 0);
});

test('a turn the plugin did not see start has no duration and stays silent', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		const [event] = turnEvents().slice(-1);
		ctx.emit(fakeSession(), [event]);
		await quiet();
	});
	assert.equal(calls.length, 0);
});

test('subagent sessions are silent unless asked for', async () => {
	const calls = [];
	const child = fakeSession({ id: 'child', origin: 'subagent' });
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		const quietContext = fakeContext();
		apply(quietContext, {});
		quietContext.emit(child, turnEvents());
		await quiet();
		assert.equal(calls.length, 0);

		const loudContext = fakeContext();
		apply(loudContext, { includeSubagents: true });
		loudContext.emit(child, turnEvents());
		await settle(() => calls.length === 1);
		assert.equal(calls.length, 1);
	});
});

test('unset Pushover credentials skip the push and say which reference is missing', async () => {
	const calls = [];
	const ctx = fakeContext({});
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents());
		await quiet();
	});
	assert.equal(calls.length, 0);
	assert.match(stderr.lines.join(''), /PUSHOVER_TOKEN and PUSHOVER_USER not configured/);
});

test('a rejected delivery is reported and does not block the next push', async () => {
	const calls = [];
	const ctx = fakeContext();
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return calls.length === 1
			? { ok: false, status: 400, async text() { return JSON.stringify({ status: 0, errors: ['application token is invalid'] }); } }
			: accepted('req-2');
	}, async () => {
		apply(ctx, {});
		ctx.emit(fakeSession({ id: 'first' }), turnEvents());
		await settle(() => calls.length === 1);
		ctx.emit(fakeSession({ id: 'second' }), turnEvents());
		await settle(() => calls.length === 2);
	});
	assert.equal(calls.length, 2);
	assert.match(stderr.lines.join(''), /delivery failed for ai-stack: Pushover rejected the message/);
});

test('configured sound and device reach the push', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, { sound: 'clack', device: 'phone' });
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents());
		await settle(() => calls.length === 1);
	});
	assert.equal(calls[0].get('sound'), 'clack');
	assert.equal(calls[0].get('device'), 'phone');
});

test('an invalid config fails activation with a usable message', () => {
	assert.throws(() => resolveSettings({ priority: 2 }), /priority 2/);
	assert.throws(() => resolveSettings({ minDurationSeconds: -1 }), /non-negative/);
	assert.throws(() => resolveSettings({ tokenRef: 'not a name' }), /credential reference/);
	assert.throws(() => resolveSettings({ minDuration: 60 }), /unknown config key "minDuration"/);
});

/** One whole-list task snapshot, as `todo_write` appends it. */
function todoWrite(todos, time = START) {
	return { type: 'todo/write', time, data: { todos } };
}

/** One durable goal mutation, as the goal service appends it. */
function goalChange(overrides = {}) {
	const operation = overrides.operation ?? 'complete';
	const goal = overrides.goal ?? {
		id: 'goal-1',
		revision: 2,
		objective: 'Ship the parser rewrite.',
		phase: 'complete',
		maxGoalRounds: 256,
	};
	const createdAt = overrides.createdAt ?? START - 10 * 60_000;
	const updatedAt = overrides.updatedAt ?? START;
	return {
		type: 'goal/change',
		time: updatedAt,
		data: {
			kind: 'goal/change',
			version: 1,
			operation,
			goal,
			roundsStarted: overrides.roundsStarted ?? 3,
			createdAt,
			updatedAt,
		},
	};
}

/** The first snapshot is the baseline; only later transitions announce. */
const PENDING_TWO = [
	{ content: 'Build the parser tests.', status: 'pending' },
	{ content: 'Wire the CLI.', status: 'pending' },
];

test('a completed task is pushed with its list progress', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [todoWrite([{ content: 'Build the parser tests.', status: 'in_progress' }, PENDING_TWO[1]])]);
		await quiet();
		assert.equal(calls.length, 0);

		ctx.emit(fakeSession(), [todoWrite([{ content: 'Build the parser tests.', status: 'completed' }, PENDING_TWO[1]])]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].get('title'), '☑️ ai-stack · task 1/2');
	assert.match(calls[0].get('message'), /Done: Build the parser tests\./);
	assert.match(calls[0].get('message'), /1 of 2 complete\.$/);
});

test('a task already completed when the plugin first sees the list is not announced', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [todoWrite([{ content: 'Build the parser tests.', status: 'completed' }, PENDING_TWO[1]])]);
		await quiet();
	});
	assert.equal(calls.length, 0);
});

test('a rewrite that completes nothing stays silent, and a completion is announced once', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [todoWrite(PENDING_TWO)]);
		ctx.emit(fakeSession(), [todoWrite([{ content: 'Build the parser tests.', status: 'in_progress' }, PENDING_TWO[1]])]);
		await quiet();
		assert.equal(calls.length, 0);

		ctx.emit(fakeSession(), [todoWrite([{ content: 'Build the parser tests.', status: 'completed' }, PENDING_TWO[1]])]);
		await settle(() => calls.length === 1);

		ctx.emit(fakeSession(), [todoWrite([{ content: 'Build the parser tests.', status: 'completed' }, PENDING_TWO[1]])]);
		await quiet();
	});
	assert.equal(calls.length, 1);
});

test('several completions in one write are one push', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	const items = [
		{ content: 'Build the parser tests.', status: 'in_progress' },
		{ content: 'Wire the CLI.', status: 'in_progress' },
		{ content: 'Update the docs.', status: 'pending' },
	];
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [todoWrite(items)]);
		ctx.emit(fakeSession(), [todoWrite(items.map((item) => ({ ...item, status: item.content === 'Update the docs.' ? 'pending' : 'completed' })))]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].get('title'), '☑️ ai-stack · task 2/3');
	assert.match(calls[0].get('message'), /• Build the parser tests\./);
	assert.match(calls[0].get('message'), /• Wire the CLI\./);
	assert.match(calls[0].get('message'), /2 of 3 complete\.$/);
});

test('task pushes follow the subagent filter', async () => {
	const calls = [];
	const child = fakeSession({ id: 'child', origin: 'subagent' });
	const completed = [{ content: 'Build the parser tests.', status: 'completed' }];
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		const quietContext = fakeContext();
		apply(quietContext, {});
		quietContext.emit(child, [todoWrite([{ content: 'Build the parser tests.', status: 'in_progress' }])]);
		quietContext.emit(child, [todoWrite(completed)]);
		await quiet();
		assert.equal(calls.length, 0);

		const loudContext = fakeContext();
		apply(loudContext, { includeSubagents: true });
		loudContext.emit(child, [todoWrite([{ content: 'Build the parser tests.', status: 'in_progress' }])]);
		loudContext.emit(child, [todoWrite(completed)]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
});

test('notifyTasks false suppresses task pushes', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, { notifyTasks: false });
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [todoWrite([{ content: 'Build the parser tests.', status: 'in_progress' }])]);
		ctx.emit(fakeSession(), [todoWrite([{ content: 'Build the parser tests.', status: 'completed' }])]);
		await quiet();
	});
	assert.equal(calls.length, 0);
});

test('a completed goal is pushed with its objective, rounds, and duration', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [goalChange()]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].get('title'), '🎯 ai-stack · goal complete');
	assert.match(calls[0].get('message'), /^Objective: Ship the parser rewrite\./);
	assert.match(calls[0].get('message'), /3 rounds · 10m$/);
});

test('a blocked goal is pushed with the reason', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [goalChange({
			operation: 'block',
			goal: {
				id: 'goal-1',
				revision: 2,
				objective: 'Ship the parser rewrite.',
				phase: 'blocked',
				blockedReason: { code: 'provider-unavailable', message: 'the provider stayed unavailable' },
				maxGoalRounds: 256,
			},
			roundsStarted: 1,
			createdAt: START - 90_000,
		})]);
		await settle(() => calls.length === 1);
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].get('title'), '🎯 ai-stack · goal blocked');
	assert.match(calls[0].get('message'), /Blocked: the provider stayed unavailable/);
	assert.match(calls[0].get('message'), /1 round · 1m 30s$/);
});

test('non-terminal goal changes stay silent', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		for (const operation of ['create', 'edit', 'pause', 'resume']) ctx.emit(fakeSession(), [goalChange({ operation })]);
		ctx.emit(fakeSession(), [{
			type: 'goal/change',
			time: START,
			data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal-1', revision: 3 }, clearedAt: START },
		}]);
		await quiet();
	});
	assert.equal(calls.length, 0);
});

test('notifyGoals false suppresses goal pushes', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, { notifyGoals: false });
	await withFetch(async (url, init) => {
		calls.push(init);
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), [goalChange()]);
		await quiet();
	});
	assert.equal(calls.length, 0);
});

test('a push links to the GUI when the host serves one', async () => {
	const calls = [];
	const ctx = fakeContext(undefined, { webApp: { getAdvertisedUrl: () => 'https://example.test/' } });
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents());
		await settle(() => calls.length === 1);
	});
	assert.equal(calls[0].get('url'), 'https://example.test/?session=root');
	assert.equal(calls[0].get('url_title'), 'Open session');
});

test('a host without a web app sends no link', async () => {
	const calls = [];
	const ctx = fakeContext();
	apply(ctx, {});
	await withFetch(async (url, init) => {
		calls.push(new URLSearchParams(init.body));
		return accepted();
	}, async () => {
		ctx.emit(fakeSession(), turnEvents());
		await settle(() => calls.length === 1);
	});
	assert.equal(calls[0].has('url'), false);
	assert.equal(calls[0].has('url_title'), false);
});
