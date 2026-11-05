import test from 'node:test';
import assert from 'node:assert/strict';

import { age, formatFeed, FINISHED_WINDOW_MS } from '../feed.js';
import { feedFromList } from '../index.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const NOW = 1_700_000_000_000;

const row = (over = {}) => ({ title: 't', running: false, blank: false, updatedAt: NOW - MINUTE, ...over });

test('age buckets', () => {
	assert.equal(age(NOW - 10_000, NOW), 'now');
	assert.equal(age(NOW - 4 * MINUTE, NOW), '4m');
	assert.equal(age(NOW - 3 * HOUR + 1000, NOW), '2h');
	assert.equal(age(NOW + 5 * MINUTE, NOW), 'now');
});

test('running sessions first, then finished-unacked', () => {
	const feed = formatFeed(
		[
			row({ title: 'Live one', running: true, updatedAt: NOW - 4 * MINUTE }),
			row({ title: 'Live two', running: true, updatedAt: NOW - 1 * HOUR }),
			row({ title: 'Just finished', updatedAt: NOW - 2 * MINUTE }),
			row({ title: 'Finished before ack', updatedAt: NOW - 20 * MINUTE }),
			row({ title: 'Stale finish', updatedAt: NOW - 2 * HOUR }),
			row({ title: '   ', running: true, blank: true }),
		],
		NOW,
		/* seen */ NOW - 25 * MINUTE, // acked 25m ago: both finishes (2m, 20m) are newer
	);
	assert.equal(feed.live, 2);
	assert.equal(feed.done, 2);
	const lines = feed.text.split('\n');
	assert.equal(lines[0], 'Live one');
	assert.equal(lines[1], 'Live two');
	assert.match(lines[2], /Just finished · done 2m/); // 16-char clip
	assert.match(lines[3], /Finished before… · done 20m/); // 12-char clip
	assert.doesNotMatch(feed.text, /Stale finish/);
	assert.doesNotMatch(feed.text, /t · done/); // blank-titled row contributes nothing
	assert.equal(feed.liveText, 'Live one\nLive two');
	assert.match(feed.doneText, /Finished before… · done 20m/);
	assert.doesNotMatch(feed.liveText, /done/);
});

test('ack hides finishes; nothing left reads all quiet', () => {
	const feed = formatFeed([row({ title: 'Done thing', updatedAt: NOW - MINUTE })], NOW, NOW);
	assert.equal(feed.text, 'all quiet');
	assert.equal(feed.done, 0);
});

test('finished window bounds what counts as recent', () => {
	const edge = formatFeed([row({ title: 'Edge' })], NOW, 0);
	assert.match(edge.text, /Edge · done 1m/); // 1m old is inside the 30m window
	const old = formatFeed([row({ title: 'Old', updatedAt: NOW - FINISHED_WINDOW_MS - 1 })], NOW, 0);
	assert.equal(old.text, 'all quiet');
});

test('feedFromList mirrors the session-controller shape', () => {
	const feed = feedFromList(
		{
			items: [
				{ sessionId: 'a', running: true, projections: { values: { title: 'Root session' } }, updatedAt: NOW - 2 * MINUTE },
				{ sessionId: 'b', parentSessionId: 'a', running: true, title: 'Sub', updatedAt: NOW },
				{ sessionId: 'c', origin: 'subagent', running: true, title: 'Sub2', updatedAt: NOW },
			],
		},
		NOW,
		0,
	);
	assert.equal(feed.live, 1);
	assert.match(feed.text, /Root session/);
	assert.equal(feed.done, 0);
});

test('long titles clip with an ellipsis', () => {
	const feed = formatFeed([row({ title: 'x'.repeat(40), running: true })], NOW);
	assert.match(feed.text, /x{23}…/);
});
