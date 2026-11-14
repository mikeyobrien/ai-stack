/**
 * Scriptable fake `claude` CLI for behavior tests. `FAKE_CLAUDE_MODE` selects
 * the scenario; `FAKE_CLAUDE_RECORD` collects the stream-json frames stdin.
 * The `stream`/`toolturn` modes perform one real POST through the relay to the
 * stub upstream (env `ANTHROPIC_BASE_URL`), exercising capture for real.
 * No network beyond localhost; no credentials.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE ?? '';
const record = process.env.FAKE_CLAUDE_RECORD;

if (process.argv[2] === 'auth') {
	const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN !== '0';
	// Like the real CLI: an exported API key wins over the stored login.
	const authMethod = process.env.ANTHROPIC_API_KEY ? 'api_key' : process.env.FAKE_CLAUDE_AUTH_METHOD ?? 'claude.ai';
	process.stdout.write(`${JSON.stringify({ loggedIn, authMethod, subscriptionType: 'max' })}\n`);
	process.exit(0);
}

const outRecord = process.env.FAKE_CLAUDE_RECORD_OUT;
const emit = (event) => {
	const line = `${JSON.stringify(event)}\n`;
	process.stdout.write(line);
	if (outRecord) appendFileSync(outRecord, line);
};
const sseBody = [
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
	...(mode === 'toolturn'
		? [
				'event: content_block_start',
				'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tc1","name":"mcp__dsh__echo"}}',
				'',
				'event: content_block_delta',
				'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}',
				'',
				'event: content_block_stop',
				'data: {"type":"content_block_stop","index":1}',
			]
		: []),
	'event: message_delta',
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
	'',
	'event: message_stop',
	'data: {"type":"message_stop"}',
	'',
].join('\n');

if (mode === 'hang') {
	emit({ type: 'system', subtype: 'init', session_id: 'fake' });
	process.stdin.resume();
	process.on('SIGTERM', () => process.exit(0));
	setInterval(() => {}, 1000);
} else if (mode === 'early-exit') {
	// A CLI that fails before any request: bad model alias, expired login.
	process.stderr.write('Error: invalid model name "claude-nope"\n');
	process.exit(1);
} else if (mode === 'ratelimited') {
	process.env.FAKE_CLAUDE_RATE_LIMIT = '1';
	await normalTurn();
} else {
	await normalTurn();
}

async function normalTurn() {
	const mode2 = process.env.FAKE_CLAUDE_MODE;
	const record = process.env.FAKE_CLAUDE_RECORD;
	if (record) writeFileSync(record, '');
	process.stdin.resume();
	process.stdin.setEncoding('utf8');
	let buffer = '';
	const lines = [];
	process.stdin.on('data', (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim()) {
				lines.push(line);
				if (record) appendFileSync(record, `${line}\n`);
			}
		}
	});
	process.stdin.on('end', async () => {
		emit({ type: 'system', subtype: 'init', session_id: 'fake', tools: ['mcp__dsh__echo'] });
		try {
			const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
				method: 'POST',
				headers: { authorization: 'Bearer test-token', 'anthropic-version': '2023-06-01', 'user-agent': 'claude-cli/9.9.9 (external, sdk-cli)' },
				body: JSON.stringify({ model: 'claude-test', messages: [] }),
			});
			if (process.env.FAKE_CLAUDE_RECORD_HEADERS) {
				writeFileSync(process.env.FAKE_CLAUDE_RECORD_HEADERS, JSON.stringify(Object.fromEntries(response.headers)));
			}
			await response.text(); // drain the SSE the relay forwards
		} catch {
			emit({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1 });
			process.exit(1);
		}
		const content = [{ type: 'text', text: 'hello' }];
		if (mode === 'toolturn') content.push({ type: 'tool_use', id: 'tc1', name: 'mcp__dsh__echo', input: { x: 1 } });
		emit({ type: 'assistant', message: { role: 'assistant', content } });
		const event = {
			type: 'result',
			subtype: mode2 === 'toolturn' ? 'error_max_turns' : 'success',
			is_error: mode2 === 'toolturn', // documented: error_max_turns + tool_use still succeeds
			num_turns: 1,
			usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
			user_message_uuids: ['u1'],
		};
		if (process.env.FAKE_CLAUDE_RATE_LIMIT === '1') {
			event.rate_limit_event = { rate_limit_info: { status: 'rejected', errorCode: 'credits_required', overageEnabled: true } };
		}
		if (mode === 'overage') {
			// The CLI's top-level event when a request was charged to usage credits.
			emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', isUsingOverage: true, overageStatus: 'allowed' } });
		}
		emit(event);
		process.exit(0);
	});
}
