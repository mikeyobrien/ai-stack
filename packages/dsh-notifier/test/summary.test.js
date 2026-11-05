import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MESSAGE_LIMIT,
	TITLE_LIMIT,
	codePointLength,
	composeGoalNotification,
	composeNotification,
	composeTaskNotification,
	formatDuration,
	formatTokens,
	messageText,
	plainText,
	truncate,
} from '../summary.js';

/** A finished turn with every field populated. */
const TURN = {
	label: 'ai-stack',
	reason: { kind: 'completed' },
	durationMs: 4 * 60_000 + 32_000,
	ask: 'Add dark mode to the settings page.',
	closing: 'Dark mode is implemented in Settings; tokens follow the system theme. Build and typecheck pass.',
	toolCalls: 18,
	toolErrors: 2,
	tokens: 42_100,
};

test('a completed turn names the project and the time it took', () => {
	const { title } = composeNotification(TURN);
	assert.equal(title, '✅ ai-stack · 4m 32s');
});

test('the body carries the request, the closing summary, and the work', () => {
	const { message } = composeNotification(TURN);
	assert.deepEqual(message.split('\n\n'), [
		'Goal: Add dark mode to the settings page.',
		TURN.closing,
		'18 tool calls · 2 failed · 42.1k tokens',
	]);
});

test('a failed turn says so in the title and leads with the failure', () => {
	const { title, message } = composeNotification({
		...TURN,
		reason: { kind: 'error', error: { code: 'PROVIDER_DOWN', message: 'the provider returned HTTP 503' } },
	});
	assert.equal(title, '⚠️ ai-stack failed · 4m 32s');
	assert.equal(message.split('\n\n')[0], 'Error: the provider returned HTTP 503');
});

test('a failed turn without an error message still names the failure', () => {
	const { message } = composeNotification({ ...TURN, reason: { kind: 'error' } });
	assert.equal(message.split('\n\n')[0], 'Error: the turn failed.');
});

test('other turn-end kinds are named rather than shown as "completed"', () => {
	assert.match(composeNotification({ ...TURN, reason: { kind: 'blocked' } }).title, /blocked/);
	assert.match(composeNotification({ ...TURN, reason: { kind: 'max-tokens' } }).title, /out of tokens/);
	assert.match(composeNotification({ ...TURN, reason: { kind: 'aborted', reason: { kind: 'user' } } }).title, /stopped/);
});

test('an unknown turn-end kind keeps its own name instead of failing', () => {
	const { title } = composeNotification({ ...TURN, reason: { kind: 'quarantined' } });
	assert.match(title, /quarantined/);
});

test('the body omits sections a turn did not produce', () => {
	const { message } = composeNotification({
		label: 'session',
		reason: { kind: 'completed' },
		durationMs: 90_000,
		ask: '',
		closing: '',
		toolCalls: 0,
		toolErrors: 0,
		tokens: 0,
	});
	assert.equal(message, '');
});

test('a long closing summary is cut to fit without losing the goal or the facts', () => {
	const closing = Array.from({ length: 400 }, (_, index) => `sentence ${index} about the work`).join('. ');
	const { message } = composeNotification({ ...TURN, closing });
	assert.ok(codePointLength(message) <= MESSAGE_LIMIT, `message was ${codePointLength(message)} code points`);
	assert.match(message, /^Goal: Add dark mode/);
	assert.match(message, /42\.1k tokens$/);
	assert.match(message, /…/);
});

test('truncation counts code points, never half an emoji', () => {
	const closing = '🐳'.repeat(3000);
	const { message } = composeNotification({ ...TURN, closing });
	assert.ok(codePointLength(message) <= MESSAGE_LIMIT);
	assert.equal(Array.from(message).join(''), message);
	assert.ok(Array.from(message).includes('🐳'));
	// A UTF-16 slice would leave a lone surrogate here; the last character must
	// be the ellipsis or an intact code point.
	assert.ok(message.endsWith('…') || message.endsWith('tokens'));
});

test('the title stays within Pushover\'s limit', () => {
	const { title } = composeNotification({ ...TURN, reason: { kind: 'x'.repeat(400) } });
	assert.ok(codePointLength(title) <= TITLE_LIMIT, `title was ${codePointLength(title)} code points`);
});

test('durations read naturally at every scale', () => {
	assert.equal(formatDuration(0), '0s');
	assert.equal(formatDuration(42_000), '42s');
	assert.equal(formatDuration(120_000), '2m');
	assert.equal(formatDuration(272_000), '4m 32s');
	assert.equal(formatDuration(2 * 3_600_000 + 5 * 60_000), '2h 5m');
	assert.equal(formatDuration(3_600_000), '1h');
});

test('token counts stay compact', () => {
	assert.equal(formatTokens(0), '0');
	assert.equal(formatTokens(850), '850');
	assert.equal(formatTokens(1500), '1.5k');
	assert.equal(formatTokens(42_100), '42.1k');
	assert.equal(formatTokens(250_000), '250k');
});

test('message text ignores reasoning and tool blocks', () => {
	const text = messageText({
		content: [
			{ type: 'reasoning', text: 'secret thinking' },
			{ type: 'text', text: 'first' },
			{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
			{ type: 'text', text: 'second' },
		],
	});
	assert.equal(text, 'first\nsecond');
});

test('truncate never exceeds its limit and marks the cut', () => {
	assert.equal(truncate('short', 10), 'short');
	assert.equal(truncate('abcdefghij', 5), 'abcd…');
	assert.ok(codePointLength(truncate('🐳'.repeat(50), 10)) <= 10);
});

test('a single finished task names it and the list progress', () => {
	const { title, message } = composeTaskNotification({
		label: 'ai-stack',
		done: ['Build the parser tests.'],
		completed: 3,
		total: 7,
	});
	assert.equal(title, '☑️ ai-stack · task 3/7');
	assert.equal(message, 'Done: Build the parser tests.\n\n3 of 7 complete.');
});

test('several tasks finishing in one write share one notification', () => {
	const { message } = composeTaskNotification({
		label: 'ai-stack',
		done: ['Build the parser tests.', 'Wire the CLI.'],
		completed: 2,
		total: 5,
	});
	assert.match(message, /^Done:\n• Build the parser tests\.\n• Wire the CLI\./);
	assert.match(message, /2 of 5 complete\.$/);
});

test('a large batch of finished tasks is capped', () => {
	const done = Array.from({ length: 7 }, (_, index) => `Task ${index + 1}`);
	const { message } = composeTaskNotification({ label: 'ai-stack', done, completed: 7, total: 7 });
	assert.match(message, /• \+3 more/);
	assert.ok(codePointLength(message) <= MESSAGE_LIMIT);
});

test('task text is bounded and the message stays within Pushover limits', () => {
	const { message } = composeTaskNotification({ label: 'ai-stack', done: ['x'.repeat(1000)], completed: 1, total: 1 });
	assert.ok(codePointLength(message) <= MESSAGE_LIMIT);
});

test('a completed goal names the objective, rounds, and time', () => {
	const { title, message } = composeGoalNotification({
		label: 'ai-stack',
		operation: 'complete',
		objective: 'Ship the parser rewrite.',
		rounds: 3,
		durationMs: 10 * 60_000,
	});
	assert.equal(title, '🎯 ai-stack · goal complete');
	assert.deepEqual(message.split('\n\n'), ['Objective: Ship the parser rewrite.', '3 rounds · 10m']);
});

test('a blocked goal carries the reason', () => {
	const { title, message } = composeGoalNotification({
		label: 'ai-stack',
		operation: 'block',
		objective: 'Ship it.',
		blockedReason: 'the provider stayed unavailable',
		rounds: 1,
		durationMs: 90_000,
	});
	assert.equal(title, '🎯 ai-stack · goal blocked');
	assert.match(message, /Blocked: the provider stayed unavailable/);
	assert.match(message, /1 round · 1m 30s/);
});

test('a goal without rounds or timing still sends its objective', () => {
	const { message } = composeGoalNotification({ label: 'ai-stack', operation: 'complete', objective: 'Do it.' });
	assert.equal(message, 'Objective: Do it.');
});

test('markdown is flattened into plain text for a push body', () => {
	assert.equal(
		plainText('## Done\n\n**Bold** and `code` and [the link](https://example.test).\n\n- one\n- two'),
		'Done\n\nBold and code and the link.\n\n• one\n• two',
	);
});

test('a fenced block keeps its code without the fence', () => {
	assert.equal(plainText('```sh\nnpm test\n```'), 'npm test');
});

test('table rows become dot-separated lines', () => {
	assert.equal(plainText('| Name | Value |\n| --- | --- |\n| a | b |'), 'Name · Value\n\na · b');
});

test('underscores inside words survive the emphasis pass', () => {
	assert.equal(plainText('use snake_case_name here'), 'use snake_case_name here');
});

test('composed turn bodies carry no markdown syntax', () => {
	const { message } = composeNotification({ ...TURN, closing: '## Outcome\n\n**Build** passes with `npm test`.' });
	assert.equal(message.includes('**'), false);
	assert.equal(message.includes('`'), false);
	assert.match(message, /Outcome\n\nBuild passes with npm test\./);
});
