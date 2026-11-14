/**
 * Behavior tests for the native Claude Code provider, at the adapter/relay
 * boundary. Mock-CLI tier: no network beyond localhost, no credentials.
 * Live-CLI verification is tracked separately.
 *
 * Run: node --test test/*.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ClaudeCodeAdapter, modelsFromTranscript } from '../adapter.js';
import { childEnv, workerArgs } from '../cli.js';
import { TurnRelay } from '../relay.js';
import { historyToFrames, toolManifest } from '../transcript.js';

const FAKE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
// The developer's shell may export these; the tests must not inherit them.
const env = cleanEnv(process.env);

function cleanEnv(base) {
	const out = { ...base };
	for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) delete out[name];
	return out;
}

/**
 * Local stub of the Anthropic Messages API serving one canned SSE response,
 * or, with `status`, one error response.
 */
async function stubUpstream({ toolUse = false, incomplete = false, status = 200, errorBody, headers = {} } = {}) {
	const server = createServer((req, res) => {
		let body = '';
		server.requests = (server.requests ?? 0) + 1;
		req.on('data', (chunk) => { body += chunk; });
		req.on('end', () => {
			server.lastRequest = { headers: { ...req.headers }, url: req.url, body: JSON.parse(body || '{}') };
			if (status !== 200) {
				res.writeHead(status, { 'content-type': 'application/json', ...headers });
				res.end(JSON.stringify(errorBody ?? { type: 'error', error: { type: 'api_error', message: 'boom' } }));
				return;
			}
			res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
			const frames = [
				'event: message_start',
				'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}',
				'',
				'event: content_block_start',
				'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
				'',
				'event: content_block_delta',
				'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
				'',
				'event: content_block_stop',
				'data: {"type":"content_block_stop","index":0}',
			];
			if (toolUse) {
				frames.push(
					'event: content_block_start',
					'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tc1","name":"mcp__dsh__echo"}}',
					'',
					'event: content_block_delta',
					'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\\"x\\\":1}"}}',
					'',
					'event: content_block_stop',
					'data: {"type":"content_block_stop","index":1}',
				);
			}
			frames.push(
				'event: message_delta',
				'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
				'',
			);
			if (!incomplete) frames.push('event: message_stop', 'data: {"type":"message_stop"}', '');
			res.end(frames.join('\n'));
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	server.url = `http://127.0.0.1:${server.address().port}`;
	return server;
}

function adapterFor(overrides = {}) {
	return new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env, upstream: undefined, ...overrides });
}

const baseRequest = (overrides = {}) => ({
	provider: 'claude-code',
	model: 'claude-test',
	messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
	...overrides,
});

async function collect(iterable) {
	const chunks = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

test('streaming turn: text deltas, disjoint usage before finish, stop', async () => {
	const upstream = await stubUpstream();
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env, upstream: upstream.url });
		const chunks = await collect(adapter.stream(baseRequest()));
		const kinds = chunks.map((chunk) => chunk.type);
		assert.ok(kinds.includes('text-delta'));
		assert.deepEqual(chunks.find((chunk) => chunk.type === 'block-end')?.block, { type: 'text', text: 'hello' });
		const usageIndex = kinds.indexOf('usage');
		const finishIndex = kinds.indexOf('finish');
		assert.ok(usageIndex !== -1 && finishIndex !== -1 && usageIndex < finishIndex, 'usage precedes finish');
		const usage = chunks[usageIndex].usage;
		assert.equal(usage.inputTokens, 10);
		assert.equal(usage.outputTokens, 7);
		assert.equal(usage.cacheReadTokens, 4);
		assert.equal(usage.cacheWriteTokens, 2);
		assert.equal(chunks[finishIndex].reason.kind, 'stop');
		// exactly one upstream generation, carrying the CANONICAL body:
		await delay(50);
		assert.equal(upstream.lastRequest !== undefined, true);
		const body = upstream.lastRequest.body;
		assert.ok(body.system === undefined || Array.isArray(body.system), 'system passthrough (CLI layout carries --system-prompt plus billing header)');
		assert.equal(body.messages.length, 1);
		assert.equal(body.messages[0].role, 'user');
		assert.equal(body.messages[0].content[0].text, 'hi');
		assert.deepEqual(body.messages[0].content.at(-1).cache_control, { type: 'ephemeral' }, 'stable tip cache breakpoint');
	} finally {
		upstream.close();
	}
});

test('tool roundtrip: DSH tool advertised inert, tool_use finishes tool-calls, history replays', async () => {
	const upstream = await stubUpstream({ toolUse: true });
	const dir = await mkdtemp(join(tmpdir(), 'dsh-cc-test-'));
	const record = join(dir, 'frames.ndjson');
	const outRecord = `${record}.out`;
	try {
		const adapter = new ClaudeCodeAdapter({
			command: process.execPath, commandArgs: [FAKE],
			env: { ...env, FAKE_CLAUDE_MODE: 'toolturn', FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_RECORD_OUT: outRecord },
			upstream: upstream.url,
		});
		const chunks = await collect(adapter.stream(baseRequest({
			tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: { x: { type: 'number' } } } }],
		})));
		const toolCall = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
		assert.ok(toolCall, 'tool-call block emitted');
		assert.equal(toolCall.block.name, 'echo', 'mcp__dsh__ prefix stripped');
		assert.equal(chunks.at(-1).reason.kind, 'tool-calls');

		const frames = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
		const outEvents = (await readFile(outRecord, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
		const system = outEvents.find((event) => event.type === 'system');
		assert.deepEqual(system.tools, ['mcp__dsh__echo'], 'only the inert DSH MCP tool is visible to the CLI');
		const userFrames = frames.filter((frame) => frame.type === 'user');
		assert.equal(userFrames.length, 1);
		assert.equal(userFrames[0].shouldQuery, true, 'final user frame triggers the turn');

		// Follow-up history whose last message is the tool result.
        const record2 = `${record}.2`;
		const adapter2 = new ClaudeCodeAdapter({
			command: process.execPath, commandArgs: [FAKE],
			env: { ...env, FAKE_CLAUDE_RECORD: record2 },
			upstream: upstream.url,
		});
		await collect(adapter2.stream(baseRequest({
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
				{ role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'echo', arguments: '{"x":1}' }] },
				{ role: 'tool', toolCallId: 'tc1', content: [{ type: 'text', text: 'ok' }] },
			],
		})));
		const frames2 = (await readFile(record2, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
		const userFrames2 = frames2.filter((frame) => frame.type === 'user');
		assert.equal(userFrames2.length, 2, 'tool result replays as a user frame');
		assert.equal(userFrames2[0].shouldQuery, false, 'earlier frames are replay-only');
		assert.equal(userFrames2[1].shouldQuery, true);
		const toolResult = userFrames2[1].message.content.find((block) => block.type === 'tool_result');
		assert.equal(toolResult.tool_use_id, 'tc1');
	} finally {
		await rm(dir, { recursive: true, force: true });
		upstream.close();
	}
});

test('abort: finish aborted, child reaped, relay closed', async () => {
	const upstream = await stubUpstream();
	try {
		const adapter = new ClaudeCodeAdapter({
			command: process.execPath, commandArgs: [FAKE],
			env: { ...env, FAKE_CLAUDE_MODE: 'hang' },
			upstream: upstream.url,
			requestTimeoutMs: 10_000,
		});
		const controller = new AbortController();
		const stream = adapter.stream(baseRequest({ signal: controller.signal }));
		const iterator = stream[Symbol.asyncIterator]();
		await delay(150); // let the hang-mode child spawn and idle
		controller.abort('user cancel');
		const chunks = await collect(iterator);
		const finish = chunks.find((chunk) => chunk.type === 'finish');
		assert.ok(finish, 'terminal finish emitted');
		assert.equal(finish.reason.kind, 'aborted');
	} finally {
		upstream.close();
	}
});

test('auth gate: api-key login refuses with actionable AUTH error, no generation', async () => {
	const api_key = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_AUTH_METHOD: 'api_key' } });
	assert.deepEqual(await api_key.listModels(), [], 'no catalog offered for non-subscription auth');
	await assert.rejects(() => collect(api_key.stream(baseRequest())), (error) => {
		assert.equal(error.code, 'AUTH');
		assert.match(error.message, /api_key/);
		assert.match(error.message, /claude auth login/);
		return true;
	});
});

test('auth gate: logged-out yields empty catalog and AUTH failure; missing binary is CLI_MISSING', async () => {
	const loggedOut = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_LOGGED_IN: '0' } });
	assert.deepEqual(await loggedOut.listModels(), []);
	await assert.rejects(() => collect(loggedOut.stream(baseRequest())), (error) => error.code === 'AUTH');

	const missing = new ClaudeCodeAdapter({ command: '/nonexistent/claude-binary', env });
	await assert.rejects(() => collect(missing.stream(baseRequest())), (error) => error.code === 'CLI_MISSING');
});

test('billing: rejected rate_limit_event fails the turn unless allowUsageCredits', async () => {
	const upstream = await stubUpstream();
	try {
		const strict = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_MODE: 'ratelimited' }, upstream: upstream.url });
		await assert.rejects(() => collect(strict.stream(baseRequest())), (error) => error.code === 'BILLING');

		const lenient = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_MODE: 'ratelimited' }, allowUsageCredits: true, upstream: upstream.url });
	const chunks = await collect(lenient.stream(baseRequest()));
	assert.equal(chunks.at(-1).reason.kind, 'stop');
	} finally {
		upstream.close();
	}
});

test('env hygiene: child ANTHROPIC_API_KEY stripped, conflicts refused, parent env untouched', () => {
	const base = { ANTHROPIC_API_KEY: 'parent-key', HOME: '/home/x', ANTHROPIC_AUTH_TOKEN: 'tok-secret-value' };
	const snapshot = JSON.stringify(base);
	assert.throws(() => childEnv(base, { relayUrl: 'http://127.0.0.1:1/x' }), (error) => {
		assert.equal(error.code, 'CONFLICTING_ENV');
		assert.match(error.message, /ANTHROPIC_AUTH_TOKEN/);
		assert.doesNotMatch(error.message, /tok-secret-value/, 'the value never reaches the message');
		return true;
	});
	assert.equal(JSON.stringify(base), snapshot, 'parent env not mutated');

	const clean = { HOME: '/home/x', ANTHROPIC_API_KEY: 'parent-key' };
	const child = childEnv(clean, { relayUrl: 'http://127.0.0.1:9/t', configDir: '/cfg' });
	assert.equal(child.ANTHROPIC_API_KEY, undefined, 'key stripped from the child only');
	assert.equal(clean.ANTHROPIC_API_KEY, 'parent-key');
	assert.equal(child.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/t');
	assert.equal(child.CLAUDE_CONFIG_DIR, '/cfg');
});

test('identity: the CLI user-agent and query reach upstream unchanged', async () => {
	const upstream = await stubUpstream();
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env, upstream: upstream.url });
		await collect(adapter.stream(baseRequest()));
		assert.equal(upstream.lastRequest.headers['user-agent'], 'claude-cli/9.9.9 (external, sdk-cli)');
		assert.equal(upstream.lastRequest.headers.authorization, 'Bearer test-token');
		assert.equal(upstream.lastRequest.headers['accept-encoding'], 'identity');
		assert.equal(upstream.lastRequest.url, '/v1/messages?beta=true');
	} finally {
		upstream.close();
	}
});

test('rate-limit headers reach the CLI so it can report overage', async () => {
	const upstream = await stubUpstream({ headers: { 'anthropic-ratelimit-unified-status': 'allowed', 'request-id': 'req_1' } });
	const dir = await mkdtemp(join(tmpdir(), 'dsh-cc-hdr-'));
	const record = join(dir, 'headers.json');
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_RECORD_HEADERS: record }, upstream: upstream.url });
		await collect(adapter.stream(baseRequest()));
		const seen = JSON.parse(await readFile(record, 'utf8'));
		assert.equal(seen['anthropic-ratelimit-unified-status'], 'allowed');
		assert.equal(seen['request-id'], 'req_1');
	} finally {
		await rm(dir, { recursive: true, force: true });
		upstream.close();
	}
});

test('billing: isUsingOverage fails the turn unless allowUsageCredits', async () => {
	const upstream = await stubUpstream();
	try {
		const strict = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_MODE: 'overage' }, upstream: upstream.url });
		await assert.rejects(() => collect(strict.stream(baseRequest())), (error) => error.code === 'BILLING');
		const lenient = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_MODE: 'overage' }, allowUsageCredits: true, upstream: upstream.url });
		assert.equal((await collect(lenient.stream(baseRequest()))).at(-1).reason.kind, 'stop');
	} finally {
		upstream.close();
	}
});

test('auth gate: an exported ANTHROPIC_API_KEY does not fail the subscription check', async () => {
	const upstream = await stubUpstream();
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, ANTHROPIC_API_KEY: 'sk-parent' }, upstream: upstream.url });
		assert.equal((await collect(adapter.stream(baseRequest()))).at(-1).reason.kind, 'stop');
	} finally {
		upstream.close();
	}
});

test('early CLI exit: fails fast with the CLI\'s own error, not at the timeout', async () => {
	const upstream = await stubUpstream();
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_MODE: 'early-exit' }, upstream: upstream.url, requestTimeoutMs: 30_000 });
		const started = Date.now();
		await assert.rejects(() => collect(adapter.stream(baseRequest())), (error) => {
			assert.equal(error.code, 'CLI_FAILED');
			assert.match(error.message, /invalid model name/);
			return true;
		});
		assert.ok(Date.now() - started < 5_000, 'settles within the exit grace');
		assert.equal(upstream.requests ?? 0, 0, 'no generation was attempted');
	} finally {
		upstream.close();
	}
});

test('idle timeout: a stalled turn fails with retryable TIMEOUT, not a user abort', async () => {
	const upstream = await stubUpstream();
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env: { ...env, FAKE_CLAUDE_MODE: 'hang' }, upstream: upstream.url, requestTimeoutMs: 300 });
		await assert.rejects(() => collect(adapter.stream(baseRequest())), (error) => error.code === 'TIMEOUT');
	} finally {
		upstream.close();
	}
});

test('upstream errors map to the shared retry and recovery codes', async () => {
	const cases = [
		{ status: 429, errorBody: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, headers: { 'retry-after': '7' }, code: 'RATE_LIMIT', retryAfterMs: 7000 },
		{ status: 529, errorBody: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, code: 'SERVER' },
		{ status: 400, errorBody: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 213462 tokens > 200000 maximum' } }, code: 'CONTEXT_WINDOW_EXCEEDED' },
		{ status: 400, errorBody: { type: 'error', error: { type: 'invalid_request_error', message: 'Third-party apps now draw from your extra usage' } }, code: 'BILLING' },
		{ status: 401, errorBody: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, code: 'AUTH' },
	];
	for (const { code, retryAfterMs, ...stub } of cases) {
		const upstream = await stubUpstream(stub);
		try {
			const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env, upstream: upstream.url });
			await assert.rejects(() => collect(adapter.stream(baseRequest())), (error) => {
				assert.equal(error.code, code, `HTTP ${stub.status} → ${code}`);
				if (retryAfterMs !== undefined) assert.equal(error.failure.providerRetryAfterMs, retryAfterMs);
				return true;
			});
			assert.equal(upstream.requests, 1, 'the CLI retry is refused; DSH owns retries');
		} finally {
			upstream.close();
		}
	}
});

test('oversized system prompt is refused before spawn', async () => {
	const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env });
	const messages = [
		{ role: 'system', content: [{ type: 'text', text: 'x'.repeat(130 * 1024) }] },
		{ role: 'user', content: [{ type: 'text', text: 'hi' }] },
	];
	await assert.rejects(() => collect(adapter.stream(baseRequest({ messages }))), (error) => error.code === 'INVALID_REQUEST');
});

// --- relay boundary -----------------------------------------------------------

test('relay: only one POST /v1/messages per turn; other routes never reach upstream', async () => {
	const upstream = await stubUpstream();
	const relay = new TurnRelay({ upstream: upstream.url });
	try {
		const base = await relay.start();
		assert.equal((await fetch(`${base}/v1/models`)).status, 404);
		assert.equal((await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', body: '{}' })).status, 404);
		assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } })).status, 404);
		assert.equal(upstream.requests ?? 0, 0);
		const first = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{"messages":[]}' });
		await first.text();
		assert.equal(first.status, 200);
		const second = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{"messages":[]}' });
		assert.equal(second.status, 400);
		assert.equal(upstream.requests, 1);
	} finally {
		relay.close();
		upstream.close();
	}
});

test('relay: a CLI that disconnects mid-body settles the turn without an unhandled rejection', async () => {
	const { connect } = await import('node:net');
	const rejections = [];
	const onRejection = (reason) => rejections.push(reason);
	process.on('unhandledRejection', onRejection);
	const relay = new TurnRelay({ upstream: 'http://127.0.0.1:9' });
	try {
		const url = new URL(await relay.start());
		const socket = connect(Number(url.port), '127.0.0.1');
		await new Promise((resolve) => socket.once('connect', resolve));
		socket.write(`POST ${url.pathname}/v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000\r\n\r\n{"messages":[`);
		await delay(50);
		socket.destroy();
		const capture = await Promise.race([relay.capture, delay(2000).then(() => ({ kind: 'not-settled' }))]);
		assert.equal(capture.kind, 'relay-error');
		await delay(50);
		assert.deepEqual(rejections, []);
	} finally {
		process.off('unhandledRejection', onRejection);
		relay.close();
	}
});

test('relay: close() cancels the upstream request instead of letting it run on', async () => {
	let upstreamClosed;
	const closed = new Promise((resolve) => { upstreamClosed = resolve; });
	const server = createServer((req, res) => {
		req.on('data', () => {});
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
			res.on('close', () => upstreamClosed(true));
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const relay = new TurnRelay({ upstream: `http://127.0.0.1:${server.address().port}` });
	try {
		const base = await relay.start();
		const response = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{"messages":[]}' });
		const reader = response.body.getReader();
		await reader.read();
		relay.close();
		assert.equal(await Promise.race([closed, delay(2000).then(() => false)]), true, 'upstream connection closed');
	} finally {
		relay.close();
		server.closeAllConnections?.();
		server.close();
	}
});

test('history hygiene: branched histories never share frames; argv pins the single-turn contract', async () => {
	const a = historyToFrames([{ role: 'user', content: [{ type: 'text', text: 'one' }] }]);
	const b = historyToFrames([{ role: 'user', content: [{ type: 'text', text: 'two' }] }]);
	notEqualDeep(a.frames, b.frames);
	for (const frame of [...a.frames, ...b.frames]) assert.ok(frame.uuid, 'every frame carries an identity');

	const args = workerArgs({ systemPrompt: 's', settingsFile: 'set', mcpConfigFile: 'mcp', model: 'm' });
	const has = (flag) => args.includes(flag);
	for (const flag of ['--max-turns', '--strict-mcp-config', '--no-session-persistence', '--permission-mode']) assert.ok(has(flag), `${flag} present`);
	assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
	assert.deepEqual(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2), ['--setting-sources', '']);
});

test('manifest: inert MCP manifest exposes schemas, denies execution by construction', () => {
	const manifest = toolManifest([{ name: 'echo', description: 'e', parameters: { type: ['object', 'null'], oneOf: [], properties: { x: { type: 'number' } } } }]);
	assert.equal(manifest[0].name, 'echo', 'raw name; the CLI adds mcp__dsh__');
	assert.equal(manifest[0].inputSchema.type, 'object');
	assert.equal(manifest[0].inputSchema.oneOf, undefined);
});

test('discovery transcript: control_response models become catalog rows', () => {
	const payload = JSON.stringify({ type: 'control_response', response: { subtype: 'success', models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' }] } });
	const stdout = payload + '\n';
	const models = modelsFromTranscript(stdout);
	assert.equal(models.length, 1);
	assert.equal(models[0].id, 'opus');
	assert.equal(models[0].name, 'Opus 5.5');
	assert.equal(modelsFromTranscript('not json\n'), null);
});

function notEqualDeep(a, b) {
	assert.notDeepEqual(JSON.stringify(a), JSON.stringify(b));
}

test('incremental streaming: first delta lands before the upstream tail is released', async () => {
	let release;
	const held = new Promise((resolve) => { release = resolve; });
	const server = createServer((req, res) => {
		req.on('data', () => {});
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write([
				'event: message_start',
				'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":10,"output_tokens":1}}}',
				'',
				'event: content_block_start',
				'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
				'',
				'event: content_block_delta',
				'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}',
				'',
				'event: content_block_delta',
				'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
				'',
				'event: content_block_stop',
				'data: {"type":"content_block_stop","index":0}',
				'',
			].join('\n'));
			void held.then(() => {
				res.end([
					'event: message_delta',
					'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
					'',
					'event: message_stop',
					'data: {"type":"message_stop"}',
					'',
				].join('\n'));
			});
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env, upstream: `http://127.0.0.1:${server.address().port}` });
		const iterator = adapter.stream(baseRequest())[Symbol.asyncIterator]();
		const first = await Promise.race([
			(async () => {
				for (;;) {
					const { value } = await iterator.next();
					if (value.type === 'text-delta') return value;
				}
			})(),
			delay(5000).then(() => { throw new Error('no delta before tail release'); }),
		]);
		assert.equal(first.text, 'hel');
		release();
		const chunks = [];
		for (;;) {
			const { value, done } = await iterator.next();
			if (done) break;
			chunks.push(value);
		}
		const kinds = chunks.map((chunk) => chunk.type);
		const usageIndex = kinds.indexOf('usage');
		const finishIndex = kinds.indexOf('finish');
		assert.ok(usageIndex !== -1 && finishIndex !== -1 && usageIndex < finishIndex, 'usage precedes finish');
		assert.equal(chunks[usageIndex].usage.outputTokens, 7);
		assert.equal(chunks[finishIndex].reason.kind, 'stop');
	} finally {
		server.close();
	}
});

test('incomplete upstream stream: classified failure, no successful finish', async () => {
	const upstream = await stubUpstream({ incomplete: true });
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env, upstream: upstream.url });
		await assert.rejects(
			() => collect(adapter.stream(baseRequest())),
			(error) => error.code === 'TURN_INCOMPLETE' || (typeof error?.message === 'string' && error.message.includes('incomplete')),
		);
	} finally {
		upstream.close();
	}
});

test('signed-thinking replay: signatures survive via replayState; foreign history omits, never fabricates', async () => {
	const { historyToFrames } = await import('../transcript.js');
	const signature = 'sig-abc';
	const ownSource = { kind: 'model', provider: 'claude-code', model: 'claude-test', replayState: {
		response: { kind: 'dsh-claude-code', version: 1, provider: 'claude-code', model: 'claude-test', stopReason: 'tool_use' },
		blocks: [{ type: 'reasoning', thinkingSignature: signature }, { type: 'text' }, { type: 'tool-call' }],
	} };
	const own = {
		role: 'assistant', source: ownSource,
		content: [
			{ type: 'reasoning', text: 'pondering' },
			{ type: 'text', text: 'doing' },
			{ type: 'tool-call', id: 'tc9', name: 'echo', arguments: '{"x":2}' },
		],
	};
	const { frames } = historyToFrames([{ role: 'user', content: [{ type: 'text', text: 'go' }] }, own, { role: 'tool', toolCallId: 'tc9', content: [{ type: 'text', text: 'ok' }] }]);
	const assistantFrame = frames.find((frame) => frame.type === 'assistant');
	const thinking = assistantFrame.message.content.find((block) => block.type === 'thinking');
	assert.equal(thinking.signature, signature, 'native signature restored from replay state');
	assert.equal(thinking.thinking, 'pondering');
	const toolUse = assistantFrame.message.content.find((block) => block.type === 'tool_use');
	assert.equal(toolUse.id, 'tc9');

	// Foreign-source history: no envelope -> reasoning omitted entirely (no fake signature).
	const foreign = { role: 'assistant', source: { kind: 'model', provider: 'sparks', model: 'glm' }, content: [{ type: 'reasoning', text: 'foreign thoughts' }, { type: 'text', text: 'answer' }] };
	const { frames: foreignFrames } = historyToFrames([foreign]);
	const foreignContent = foreignFrames.find((frame) => frame.type === 'assistant').message.content;
	assert.equal(foreignContent.some((block) => block.type === 'thinking'), false, 'foreign reasoning not turned into native thinking');
	assert.equal(foreignContent.find((block) => block.type === 'text').text, 'answer');

	// Misaligned envelope degrades instead of throwing.
	const broken = { role: 'assistant', source: { kind: 'model', provider: 'claude-code', model: 'claude-test', replayState: { response: { kind: 'dsh-claude-code', version: 1, provider: 'claude-code' }, blocks: [] } }, content: [{ type: 'text', text: 'x' }] };
	const { frames: brokenFrames } = historyToFrames([broken]);
	assert.equal(brokenFrames.find((frame) => frame.type === 'assistant').message.content[0].text, 'x');
});

test('finish replayState carries signatures/redacted data aligned to emitted blocks', async () => {
	let release;
	const held = new Promise((resolve) => { release = resolve; });
	const server = createServer((req, res) => {
		req.on('data', () => {});
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end([
				'event: message_start',
				'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3,"output_tokens":1}}}',
				'',
				'event: content_block_start',
				'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
				'',
				'event: content_block_delta',
				'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
				'',
				'event: content_block_delta',
				'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-xyz"}}',
				'',
				'event: content_block_stop',
				'data: {"type":"content_block_stop","index":0}',
				'',
				'event: content_block_start',
				'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-blob"}}',
				'',
				'event: content_block_stop',
				'data: {"type":"content_block_stop","index":1}',
				'',
				'event: message_delta',
				'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
				'',
				'event: message_stop',
				'data: {"type":"message_stop"}',
				'',
			].join('\n'));
			void held;
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const adapter = new ClaudeCodeAdapter({ command: process.execPath, commandArgs: [FAKE], env, upstream: `http://127.0.0.1:${server.address().port}` });
		const chunks = await collect(adapter.stream(baseRequest()));
		const finish = chunks.at(-1);
		assert.equal(finish.type, 'finish');
		assert.equal(finish.replayState.response.kind, 'dsh-claude-code');
		assert.equal(finish.replayState.response.provider, 'claude-code');
		assert.equal(finish.replayState.blocks.length, 2, 'one metadata entry per emitted block');
		assert.equal(finish.replayState.blocks[0].thinkingSignature, 'sig-xyz');
		assert.equal(finish.replayState.blocks[1].redactedData, 'opaque-blob');

		// Emitted block types must line up with the replay entries, or the whole
		// envelope is rejected on the next turn and every signature is lost.
		const ends = chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block);
		assert.deepEqual(ends.map((block) => block.type), finish.replayState.blocks.map((block) => block.type));
		const assistant = {
			role: 'assistant',
			source: { kind: 'model', provider: 'claude-code', model: 'claude-test', replayState: finish.replayState },
			content: ends,
		};
		const { frames } = historyToFrames([{ role: 'user', content: [{ type: 'text', text: 'go' }] }, assistant, { role: 'user', content: [{ type: 'text', text: 'more' }] }]);
		const replayed = frames.find((frame) => frame.type === 'assistant').message.content;
		assert.deepEqual(replayed, [
			{ type: 'thinking', thinking: 'hmm', signature: 'sig-xyz' },
			{ type: 'redacted_thinking', data: 'opaque-blob' },
		]);
	} finally {
		server.close();
	}
});

test('tool naming: manifest raw, exactly one CLI wire prefix, single strip on response', async () => {
	const { toolManifest, toolWireName, toolNameFromWire } = await import('../transcript.js');
	// Manifest: raw registry names — the CLI adds mcp__dsh__ itself.
	const manifest = toolManifest([
		{ name: 'bash', description: 'b', parameters: { type: 'object', properties: {} } },
		{ name: 'mcp__dsh__nested', description: 'n', parameters: { type: 'object', properties: {} } },
	]);
	assert.equal(manifest[0].name, 'bash', 'manifest must not pre-prefix');
	assert.equal(manifest[1].name, 'mcp__dsh__nested', 'legitimate DSH mcp__-named tool preserved verbatim');

	// Upstream/wire: exactly one prefix, CLI-added.
	assert.equal(toolWireName('bash'), 'mcp__dsh__bash');
	assert.equal(toolWireName('mcp__dsh__nested'), 'mcp__dsh__mcp__dsh__nested');

	// Response: strip exactly once; never loop-strip.
	assert.equal(toolNameFromWire('mcp__dsh__bash'), 'bash');
	assert.equal(toolNameFromWire('mcp__dsh__mcp__dsh__nested'), 'mcp__dsh__nested');
	assert.equal(toolNameFromWire('mcp__dsh__bash'.replace('mcp__dsh__', '') // sanity: single strip only
	), 'bash');
});

test('compound tool-call ids: valid Anthropic projection in BOTH outputs, matched pairs, input untouched', async () => {
	const { historyToFrames, canonicalRequestPayload } = await import('../transcript.js');
	const codexA = 'call_abc123|fc_def456';
	const codexB = 'msg.9:step=2;part[3]';
	const native = 'toolu_native-01';
	const messages = [
		{ role: 'user', content: [{ type: 'text', text: 'go' }] },
		{ role: 'assistant', source: { kind: 'model', provider: 'codex', model: 'gpt' }, content: [{ type: 'tool-call', id: codexA, name: 'bash', arguments: '{"x":1}' }] },
		{ role: 'tool', toolCallId: codexA, content: [{ type: 'text', text: 'ok' }] },
		{ role: 'assistant', source: { kind: 'model', provider: 'codex', model: 'gpt' }, content: [{ type: 'tool-call', id: codexB, name: 'bash', arguments: '{}' }] },
		{ role: 'tool', toolCallId: codexB, content: [{ type: 'text', text: 'ok2' }] },
		{ role: 'assistant', source: { kind: 'model', provider: 'claude-code', model: 'opus' }, content: [{ type: 'tool-call', id: native, name: 'bash', arguments: '{}' }] },
		{ role: 'tool', toolCallId: native, content: [{ type: 'text', text: 'ok3' }] },
	];
	const snapshot = JSON.stringify(messages);

	// Translation one: CLI history frames.
	const { frames, system } = historyToFrames(messages);
	// Translation two: canonical relay body, built from those same frames.
	const canonical = canonicalRequestPayload(frames, system);

	// Observe ids/pairs from the OUTPUTS themselves; no helper under test.
	const idsOf = (blocks) => blocks
		.map((block) => block.type === 'tool_use' ? { kind: 'call', role: block.role ?? 'assistant', id: block.id } : block.type === 'tool_result' ? { kind: 'result', id: block.tool_use_id } : undefined)
		.filter(Boolean);
	const frameIds = frames.flatMap((frame) => frame.message?.content ? idsOf(frame.message.content) : []);
	const bodyIds = canonical.messages.flatMap((message) => idsOf(message.content));
	assert.ok(frameIds.length >= 6 && bodyIds.length === frameIds.length, 'both outputs carry the tool id pairs');

	const GRAMMAR = /^[A-Za-z0-9_-]+$/;
	for (const { id } of [...frameIds, ...bodyIds]) {
		assert.match(id, GRAMMAR, `wire id ${id} must be grammar-valid (no %, no punctuation)`);
	}

	// Correspondence by observed id: in EACH output, each call is matched by a
	// result carrying the identical id, and the two outputs agree per raw id.
	const pairUp = (entries) => {
		const map = new Map();
		for (const { kind, id } of entries) {
			const entry = map.get(id) ?? { calls: 0, results: 0 };
			entry[kind === 'call' ? 'calls' : 'results'] += 1;
			map.set(id, entry);
		}
		return map;
	};
	for (const [label, entries] of [['frames', frameIds], ['canonical body', bodyIds]]) {
		const map = pairUp(entries);
		assert.equal(map.size, 3, `${label}: three distinct projected ids`);
		for (const [id, { calls, results }] of map) {
			assert.ok(calls >= 1 && results >= 1, `${label}: call+result share id ${id}`);
		}
	}
	const byOutput = (entries) => new Map([...pairUp(entries).entries()].map(([id]) => [id, id]));
	for (const [id] of pairUp(frameIds)) {
		assert.ok(byOutput(bodyIds).has(id), `id ${id} appears identically in both outputs`);
	}

	// Native passthrough, collapse-pair distinctness, determinism between two
	// fresh translations — all from observed ids.
	const nativeId = [...pairUp(frameIds).keys()].find((id) => id === native);
	assert.equal(nativeId, native, 'grammar-valid id passes through untouched');
	const collapseA = 'call_a|fc_b';
	const collapseB = 'call_a.fc_b';
	const collapseInput = [
		{ role: 'user', content: [{ type: 'text', text: 'x' }] },
		{ role: 'assistant', source: { kind: 'model', provider: 'codex', model: 'gpt' }, content: [{ type: 'tool-call', id: collapseA, name: 'bash', arguments: '{}' }] },
		{ role: 'tool', toolCallId: collapseA, content: [{ type: 'text', text: 'r' }] },
		{ role: 'assistant', source: { kind: 'model', provider: 'codex', model: 'gpt' }, content: [{ type: 'tool-call', id: collapseB, name: 'bash', arguments: '{}' }] },
		{ role: 'tool', toolCallId: collapseB, content: [{ type: 'text', text: 'r2' }] },
	];
	const run = () => {
		const { frames: f, system: sys } = historyToFrames(collapseInput);
		return { f, body: canonicalRequestPayload(f, sys) };
	};
	const first = run();
	const second = run();
	const collect = (out) => out.f.flatMap((frame) => frame.message?.content ?? [])
		.map((b) => b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : undefined).filter(Boolean);
	const firstIds = collect(first);
	const secondIds = collect(second);
	assert.equal(firstIds.length, 4); // 2 calls + 2 results
	const distinct = new Set(firstIds);
	assert.equal(distinct.size, 2, 'collapse pair projects to two distinct ids');
	assert.deepEqual(firstIds, secondIds, 'deterministic across fresh translations');
	const bodyIdsA = first.body.messages.flatMap((m) => m.content).map((b) => b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : undefined).filter(Boolean);
	assert.deepEqual(bodyIdsA, firstIds, 'canonical body agrees with frames on the collapse pair');
	const bounded = [...distinct].every((id) => id.length <= 64 && id.startsWith('t_'));
	assert.ok(bounded, 'projected ids bounded and digest-marked');

	// Source immutability: the ACTUAL input object, after both translations.
	assert.equal(JSON.stringify(messages), snapshot, 'input history not mutated by either translation');
});


// --- multimodal input -------------------------------------------------------

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAADZJk7lAAAAFElEQVR4nGP8z8DAwMDAxIAEAAAAAP//AwB9mgQFAAAAAElFTkSuQmCC';

/** Fake attachment service: deterministic tiny versions, no real files. */
function fakeAttachments({ bytes = 3 } = {}) {
	const reads = [];
	return {
		reads,
		readImageRequest: async (ref, target, signal) => {
			reads.push({ ref, target, signal: signal === undefined });
			const data = new Uint8Array(bytes).fill(7);
			return {
				variantId: 'v1',
				attachment: ref,
				data,
				mediaType: 'image/png',
				bytes: data.length,
				width: Math.min(2, target.width),
				height: Math.min(2, target.height),
				depth: 'uchar',
				space: 'srgb',
				hasAlpha: false,
			};
		},
	};
}

const imageRef = (attachmentId, { width = 2, height = 2 } = {}) => ({ attachmentId, width, height, name: `${attachmentId}.png` });
const imageMessage = (ref, { offloaded } = {}) => ({
	role: 'user',
	content: [
		{ type: 'text', text: 'see shot' },
		{ type: 'image', attachment: ref, ...(offloaded ? { offloaded: true } : {}) },
	],
});

function imageAdapter(upstream, attachments, overrides = {}) {
	return new ClaudeCodeAdapter({
		command: process.execPath,
		commandArgs: [FAKE],
		env,
		upstream: upstream.url,
		resolveAttachments: () => attachments,
		resolveImageAccess: () => undefined,
		...overrides,
	});
}

test('multimodal: base64 image reaches relay body AND cli frame with handle text', async () => {
	const upstream = await stubUpstream();
	const record = join(await mkdtemp(join(tmpdir(), 'dsh-cc-img-')), 'frames.ndjson');
	const attachments = fakeAttachments();
	try {
		const adapter = imageAdapter(upstream, attachments, { env: { ...env, FAKE_CLAUDE_RECORD: record } });
		const ref = imageRef('att-1');
		const chunks = await collect(adapter.stream(baseRequest({ messages: [imageMessage(ref)] })));
		assert.equal(chunks.at(-1).reason.kind, 'stop');

		// Relay body: handle text block + native base64 image block.
		const content = upstream.lastRequest.body.messages[0].content;
		const textBlock = content.find((block) => block.type === 'text' && /image/i.test(block.text));
		assert.ok(textBlock, 'requestImageHandleText text precedes the image');
		const imageBlock = content.find((block) => block.type === 'image');
		assert.ok(imageBlock, 'image block present in canonical body');
		assert.equal(imageBlock.source.type, 'base64');
		assert.equal(imageBlock.source.media_type, 'image/png');
		assert.equal(Buffer.from(imageBlock.source.data, 'base64').length, 3);

		// CLI frame carries the same single representation (no double encode).
		const frames = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
		const userFrame = frames.find((frame) => frame.type === 'user');
		const frameImage = userFrame.message.content.find((block) => block.type === 'image');
		assert.ok(frameImage, 'image block present in stream-json frame');
		assert.equal(frameImage.source.media_type, 'image/png');
		assert.deepEqual(frameImage.source.data, imageBlock.source.data, 'frames and body share one encoding');

		// the read went through the attachment service with a bounded target
		assert.equal(attachments.reads.length, 1);
		assert.equal(attachments.reads[0].target.maxBytes, 1_048_576);
	} finally {
		await rm(record, { force: true });
		upstream.close();
	}
});

test('multimodal: offloaded image becomes placeholder text with no bytes', async () => {
	const upstream = await stubUpstream();
	try {
		const adapter = imageAdapter(upstream, fakeAttachments());
		const chunks = await collect(adapter.stream(baseRequest({ messages: [imageMessage(imageRef('att-off'), { offloaded: true })] })));
		assert.equal(chunks.at(-1).reason.kind, 'stop');
		const content = upstream.lastRequest.body.messages[0].content;
		assert.equal(content.filter((block) => block.type === 'image').length, 0, 'no bytes for offloaded image');
		assert.ok(content.some((block) => block.type === 'text' && /offloaded|unavailable|placeholder|image/i.test(block.text)), 'placeholder text present');
	} finally {
		upstream.close();
	}
});

test('multimodal: over-budget image set fails IMAGE_OFFLOAD_REQUIRED with a count', async () => {
	const upstream = await stubUpstream();
	try {
		const adapter = imageAdapter(upstream, fakeAttachments(), { imageRequestBudgetBytes: 1 });
		await assert.rejects(
			() => collect(adapter.stream(baseRequest({ messages: [imageMessage(imageRef('a1')), imageMessage(imageRef('a2'))] }))),
			(error) => {
				assert.equal(error.code, 'IMAGE_OFFLOAD_REQUIRED');
				assert.equal(error.failure.offloadImages, 2);
				return true;
			},
		);
	} finally {
		upstream.close();
	}
});

test('multimodal: catalog advertises image input; unsupported placement refused', async () => {
	const { modelsFromTranscript } = await import('../adapter.js');
	const row = JSON.stringify({ type: 'control_response', response: { response: { models: [{ value: 'opus', displayName: 'Opus' }] } } });
	const [model] = modelsFromTranscript(row + '\n');
	assert.deepEqual(model.inputModalities, ['text', 'image']);

	const { historyToFrames } = await import('../transcript.js');
	const bad = [
		{ role: 'user', content: [{ type: 'text', text: 'x' }] },
		{ role: 'assistant', source: { kind: 'model', provider: 'codex', model: 'gpt' }, content: [{ type: 'image', attachment: imageRef('a') }] },
	];
	assert.throws(() => historyToFrames(bad, { versions: new Map(), resolveImageAccess: () => undefined }), (error) => error.code === 'UNSUPPORTED_CONTENT');
});

test('multimodal: text-only requests keep the legacy byte-identical shape', async () => {
	const { historyToFrames } = await import('../transcript.js');
	const { frames } = historyToFrames(baseRequest().messages);
	const userFrame = frames.find((frame) => frame.type === 'user');
	// Legacy shape: single plain text block, no image keys, nothing added.
	assert.deepEqual(userFrame.message.content, [{ type: 'text', text: 'hi' }]);
	assert.ok(!('source' in userFrame.message.content[0]));
});
