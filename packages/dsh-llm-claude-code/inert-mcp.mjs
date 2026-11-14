/**
 * DSH-owned tools advertised to Claude Code through a deliberately inert MCP
 * stdio server. DSH executes every tool; this process only answers
 * `initialize` and `tools/list`, and denies `tools/call` so the CLI can never
 * run a real tool behind DSH's approval path.
 *
 * The manifest is a JSON file path in `DSH_TOOL_MANIFEST` (set via the inline
 * `--mcp-config` env block).
 *
 * Inspired by earendil-works/pi-claude-code `inert-mcp.mjs`
 * (MIT, (c) 2026 Armin Ronacher); reimplementation, not a copy.
 */
import { readFileSync } from 'node:fs';

const ENCODING = 'utf8';

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`, ENCODING);
}

function readManifest() {
	const path = process.env.DSH_TOOL_MANIFEST ?? '';
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

let buffer = '';
process.stdin.setEncoding(ENCODING);
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf('\n')) !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		let request;
		try {
			request = JSON.parse(line);
		} catch {
			continue;
		}
		handle(request);
	}
});
process.stdin.resume();

function handle(request) {
	const { id, method, params } = request;
	if (method === 'initialize') {
		write({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh', version: '0.0.0' } } });
	} else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
		// notifications expect no response
	} else if (method === 'tools/list') {
		const tools = readManifest().map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } }));
		write({ jsonrpc: '2.0', id, result: { tools } });
	} else if (method === 'tools/call') {
		write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Denied: DSH owns tool execution; this manifest is advisory only.' }] } });
	} else if (id !== undefined) {
		write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported method ${String(method)}` } });
	}
}
