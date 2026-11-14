/**
 * Behavior tests for `@local/dsh-tool-discovery`.
 *
 * Everything under test is real: a real `@deepseek-ai/cordis` `Context`, a real
 * `ToolRuntime` (schemas, scoped lookup, restriction, native dispatch,
 * `presentationMeta` projection), real `dsh-scope` scopes minted per agent, and
 * the real `SessionProjectionRegistry`. Only the prompt assembler and the agent
 * registry are thin stand-ins, because they are harness plumbing these
 * assertions are not about.
 *
 * Cold-replay fixtures are built from the `meta` of a REAL native
 * `tool_search` execution, so replay is tested against what the runtime
 * actually commits, not against invented event fields.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { apply } from '../index.js';

const PREFIX = 'mcp__rea__';
const CATALOG = [
	{ name: `${PREFIX}decompile`, description: 'Decompile a binary or APK' },
	{ name: `${PREFIX}memory`, description: 'Inspect target process memory' },
	{ name: `${PREFIX}strings`, description: 'Extract printable strings' },
	{ name: `${PREFIX}symbols`, description: 'List symbol table entries' },
];
const CORE = [
	{ name: 'read', description: 'Read a file' },
	{ name: 'bash', description: 'Run a shell command' },
];

let counter = 0;

/** A real Context with a real ToolRuntime, projection registry, and agent registry. */
function harness() {
	const ctx = new Context();
	const wireProviders = [];
	ctx.reflect.provide('systemPrompt', {
		tools: (provider) => {
			wireProviders.push(provider);
			return () => {};
		},
		section: () => () => {},
	});
	const tools = new ToolRuntime(ctx);
	new SessionProjectionRegistry(ctx);
	const live = [];
	ctx.reflect.provide('agents', { list: () => live, get: (id) => live.find((a) => a.id === id) });
	return {
		ctx,
		tools,
		live,
		/** The exact wire tool list the model would receive for one agent's scope. */
		wire: (agent) => wireProviders.flatMap((p) => p({ scope: scopeOf(agent.ctx) })?.schemas ?? []),
	};
}

/** Register tools on the host registry. */
function register(tools, list) {
	const disposers = [];
	for (const t of list) {
		disposers.push(
			tools.register({
				name: t.name,
				description: t.description,
				parameters: { target: { type: 'string' } },
				output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: '' }] },
				execute: async () => ({ ok: t.name }),
			}),
		);
	}
	return () => {
		for (const dispose of disposers) dispose();
	};
}

/** Create a real scoped agent whose session serves `events`. */
function agent(h, events = []) {
	const { ctx: agentCtx } = createScope(h.ctx, Symbol(`scope-${counter++}`));
	// A real log always has at least one committed event; `seq` is the last one,
	// so a fixture with no leading event would report the invalid seq -1.
	const numbered = [{ type: 'turn/start', data: {} }, ...events].map((event, seq) => ({ ...event, seq }));
	const session = {
		id: `s${counter}`,
		header: {},
		inheritedEventCount: 0,
		events: () => numbered,
		snapshotEvents: () => numbered,
		get seq() {
			return numbered.length - 1;
		},
		eventAt: (seq) => numbered[seq],
	};
	const a = { id: `a${counter}`, ctx: agentCtx, session };
	h.live.push(a);
	return a;
}

/** Create an agent from a recorded log and let the plugin initialize it. */
function resume(h, log) {
	const a = agent(h, log);
	h.ctx.emit('agent/created', { agent: a });
	return a;
}

/** Native dispatch through the real runtime. */
function nativeCall(tools, name, args, agentRef, signal = new AbortController().signal) {
	return tools.execute({ callId: `call-${counter++}`, name, arguments: args, agent: agentRef, signal });
}

/** Register catalog + core, then load the plugin. */
function setup(cfg = {}) {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX, ...cfg });
	return { h, a };
}

/** Search through the plugin tool as the agent. */
async function search(h, a, args) {
	const tool = h.tools.get('tool_search', scopeOf(a.ctx));
	return tool.execute(args, { agent: a, signal: new AbortController().signal });
}

/**
 * Build a session log from the meta of a REAL native `tool_search` execution.
 * This is the exact shape the agent loop commits.
 */
async function logFromRealCall(h, a, args) {
	const outcome = await nativeCall(h.tools, 'tool_search', args, a);
	const callId = `replay-${counter++}`;
	return [
		{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: callId, name: 'tool_search', arguments: JSON.stringify(args) }] } } },
		{
			type: 'tool/result',
			data: {
				...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
				message: { toolCallId: callId, content: outcome.content ?? [], isError: outcome.isError === true },
			},
		},
	];
}

test('a fresh agent wire carries core tools but no MCP catalog', () => {
	const { h, a } = setup();
	const names = h.wire(a).map((s) => s.name);
	assert.ok(names.includes('read') && names.includes('bash'), 'core tools stay visible');
	assert.ok(names.includes('tool_search'), 'the search tool is visible');
	assert.equal(names.filter((n) => n.startsWith(PREFIX)).length, 0, 'no catalog tool reaches the wire');
});

test('select activates an original tool that is then natively callable', async () => {
	const { h, a } = setup();
	const result = await search(h, a, { query: 'decompile', select: [`${PREFIX}decompile`] });
	assert.deepEqual(result.active, [`${PREFIX}decompile`]);
	assert.equal(result.schemas[`${PREFIX}decompile`].parameters.target.type, 'string', 'the real parameter schema is returned');

	const names = h.wire(a).map((s) => s.name);
	assert.ok(names.includes(`${PREFIX}decompile`), 'activated tool is on the wire');
	assert.ok(!names.includes(`${PREFIX}memory`), 'unselected tools stay hidden');

	const outcome = await nativeCall(h.tools, `${PREFIX}decompile`, { target: 'x' }, a);
	assert.ok(!outcome.isError, `native call must succeed: ${JSON.stringify(outcome).slice(0, 120)}`);
});

test('a sibling agent stays lean after another agent activates', async () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	const b = agent(h);
	apply(h.ctx, { prefix: PREFIX });

	await search(h, a, { query: 'memory', select: [`${PREFIX}memory`] });
	assert.ok(h.wire(a).some((s) => s.name === `${PREFIX}memory`), 'agent A activated');
	assert.ok(!h.wire(b).some((s) => s.name === `${PREFIX}memory`), 'agent B remains lean');
});

test('select REPLACES the active set instead of accumulating', async () => {
	const { h, a } = setup();
	await search(h, a, { query: 'decompile', select: [`${PREFIX}decompile`] });
	assert.ok(h.wire(a).some((s) => s.name === `${PREFIX}decompile`));

	const second = await search(h, a, { query: 'memory', select: [`${PREFIX}memory`] });
	assert.deepEqual(second.active, [`${PREFIX}memory`]);
	assert.ok(!h.wire(a).some((s) => s.name === `${PREFIX}decompile`), 'the previous tool is released');
	assert.ok(h.wire(a).some((s) => s.name === `${PREFIX}memory`), 'the new tool is active');
});

test('repeated disjoint searches cannot grow the wire without bound', async () => {
	const { h, a } = setup({ maxActive: 2 });
	for (const t of CATALOG) await search(h, a, { query: t.name, select: [t.name] });
	const prefixCount = h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length;
	assert.ok(prefixCount <= 1, `at most the last selection is active (${prefixCount})`);
});

test('an over-budget selection is rejected atomically and never becomes active', async () => {
	const h = harness();
	const dense = Array.from({ length: 6 }, (_, i) => ({ name: `${PREFIX}dense${i}`, description: 'z'.repeat(600) }));
	register(h.tools, [...CORE, ...dense]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX, maxSchemaBytes: 1024 });

	const result = await search(h, a, { query: 'dense', select: dense.map((d) => d.name) });
	assert.ok(result.error, 'the oversize set is refused');
	assert.deepEqual(result.active, [], 'nothing became active');
	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'the wire is untouched');
	assert.equal(Object.keys(result.schemas).length, 0, 'no schema is returned either');
});

test('an unknown or foreign-denied selection is refused with no state change', async () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	a.ctx.tools.restrict({ deny: [`${PREFIX}strings`] });
	apply(h.ctx, { prefix: PREFIX });

	const unknown = await search(h, a, { query: 'x', select: ['not_a_tool'] });
	assert.ok(unknown.error);
	assert.deepEqual(unknown.active, []);

	const foreign = await search(h, a, { query: 'strings', select: [`${PREFIX}strings`] });
	assert.ok(foreign.error, 'a foreign-denied tool cannot be activated');
	assert.deepEqual(foreign.active, []);
	assert.ok(!h.wire(a).some((s) => s.name === `${PREFIX}strings`), 'foreign deny still holds');
	assert.equal(Object.keys(foreign.schemas).length, 0, 'and its schema is not disclosed');
	assert.ok(!foreign.candidates.some((c) => c.name === `${PREFIX}strings`), 'and it is not listed as a candidate');
});

test('a foreign restriction on a core tool stays in force and is never disclosed', async () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	a.ctx.tools.restrict({ deny: ['bash'] });
	apply(h.ctx, { prefix: PREFIX });

	const result = await search(h, a, { query: 'bash' });
	assert.ok(!result.candidates.some((c) => c.name === 'bash'), 'a foreign-denied tool is not listed');
	assert.ok(!h.wire(a).some((s) => s.name === 'bash'), 'and stays off the wire');
});

test('search results bound candidate description text', async () => {
	const h = harness();
	register(h.tools, [...CORE, { name: `${PREFIX}verbose`, description: 'w'.repeat(5000) }]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX, maxCandidateChars: 64 });

	const result = await search(h, a, { query: 'verbose' });
	const entry = result.candidates.find((c) => c.name === `${PREFIX}verbose`);
	assert.ok(entry.description.length <= 64, `descriptions are bounded (${entry.description.length})`);
});

test('a search without a selection changes nothing', async () => {
	const { h, a } = setup();
	await search(h, a, { query: 'decompile', select: [`${PREFIX}decompile`] });
	const before = h.wire(a).map((s) => s.name).join(',');
	const result = await search(h, a, { query: 'memory' });
	assert.deepEqual(result.active, [`${PREFIX}decompile`], 'the active set is reported');
	assert.equal(h.wire(a).map((s) => s.name).join(','), before, 'the wire is unchanged');
});

test('cold replay restores the committed set from real native result meta', async () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX });
	const log = await logFromRealCall(h, a, { query: 'decompile', select: [`${PREFIX}decompile`] });
	const resumed = resume(h, log);

	const names = h.wire(resumed).map((s) => s.name);
	assert.ok(names.includes(`${PREFIX}decompile`), 'the resumed agent gets its committed tool');
	assert.ok(!names.includes(`${PREFIX}memory`), 'nothing else is restored');
});

test('a refused selection does not replay as active', async () => {
	const h = harness();
	const dense = Array.from({ length: 6 }, (_, i) => ({ name: `${PREFIX}dense${i}`, description: 'z'.repeat(600) }));
	register(h.tools, [...CORE, ...dense]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX, maxSchemaBytes: 1024 });

	const log = await logFromRealCall(h, a, { query: 'dense', select: dense.map((d) => d.name) });
	assert.equal(log[1].data.meta, undefined, 'a refused call publishes no selection metadata');

	const resumed = resume(h, log);
	assert.equal(h.wire(resumed).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'replay keeps the catalog hidden');
});

test('a family of disjoint refused selections can never rebuild the catalog', async () => {
	const h = harness();
	const dense = Array.from({ length: 4 }, (_, i) => ({ name: `${PREFIX}dense${i}`, description: 'z'.repeat(800) }));
	register(h.tools, [...CORE, ...dense]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX, maxSchemaBytes: 1024 });

	const first = await logFromRealCall(h, a, { query: 'dense', select: [dense[0].name, dense[1].name] });
	const second = await logFromRealCall(h, a, { query: 'dense', select: [dense[2].name, dense[3].name] });
	const resumed = resume(h, [...first, ...second]);
	assert.equal(h.wire(resumed).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'no accumulated leak');
});

test('a failed call replays as no activation', async () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX });
	const log = await logFromRealCall(h, a, { query: 'decompile', select: [`${PREFIX}decompile`] });
	log[1] = { ...log[1], data: { ...log[1].data, message: { ...log[1].data.message, isError: true } } };
	const resumed = resume(h, log);
	assert.ok(!h.wire(resumed).some((s) => s.name === `${PREFIX}decompile`), 'an errored call grants nothing');
});

test('forged or foreign metadata in a non-tool_search result is ignored', () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	apply(h.ctx, { prefix: PREFIX });
	const log = [
		{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'other-1', name: 'read', arguments: '{}' }] } } },
		{
			type: 'tool/result',
			data: {
				meta: { v: 1, kind: 'tool_search/active', active: CATALOG.map((c) => c.name) },
				message: { toolCallId: 'other-1', content: [], isError: false },
			},
		},
	];
	const resumed = resume(h, log);
	assert.equal(h.wire(resumed).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'metadata from a non-tool_search call is ignored');
});

test('the same metadata on a genuine call is honoured (control)', () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	apply(h.ctx, { prefix: PREFIX });
	const log = [
		{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'ok-1', name: 'tool_search', arguments: '{"query":"x"}' }] } } },
		{
			type: 'tool/result',
			data: {
				meta: { v: 1, kind: 'tool_search/active', active: [`${PREFIX}memory`] },
				message: { toolCallId: 'ok-1', content: [], isError: false },
			},
		},
	];
	const resumed = resume(h, log);
	const names = h.wire(resumed).map((s) => s.name);
	assert.ok(names.includes(`${PREFIX}memory`), 'a genuine call id commits the set');
	assert.ok(!names.includes(`${PREFIX}strings`), 'and only that set');
});

test('native argument validation rejects a malformed call', async () => {
	const { h, a } = setup();
	const outcome = await nativeCall(h.tools, 'tool_search', { limit: 'lots' }, a);
	assert.ok(outcome.isError === true || outcome.content?.some((c) => c.text?.includes('query')), 'malformed arguments are rejected natively');
});

test('a native guard denial applies to an activated tool', async () => {
	const { h, a } = setup();
	await search(h, a, { query: 'decompile', select: [`${PREFIX}decompile`] });
	const release = h.tools.guard(() => ({ kind: 'deny', reason: 'policy' }));
	const outcome = await nativeCall(h.tools, `${PREFIX}decompile`, { target: 'x' }, a);
	release();
	assert.ok(outcome.isError === true, 'the guard must deny the call');
});

test('cancellation is honoured on an activated tool', async () => {
	const { h, a } = setup();
	await search(h, a, { query: 'memory', select: [`${PREFIX}memory`] });
	const controller = new AbortController();
	controller.abort();
	const outcome = await nativeCall(h.tools, `${PREFIX}memory`, { target: 'x' }, a, controller.signal);
	assert.ok(outcome.isError === true, 'an aborted call does not execute');
});

test('a catalog change hides a late arrival by the next notification turn', async () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX });
	register(h.tools, [{ name: `${PREFIX}extra`, description: 'Late arrival' }]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'the new tool is hidden too');
});

test('an MCP-sized registration burst is hidden by one later turn', async () => {
	const h = harness();
	register(h.tools, [...CORE]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX });
	const burst = Array.from({ length: 207 }, (_, i) => ({ name: `${PREFIX}tool${i}`, description: `Tool ${i}` }));
	register(h.tools, burst);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'the whole burst is hidden');
});

test('a cancelled tool_search does not leave a live activation', async () => {
	const { h, a } = setup();
	const controller = new AbortController();
	controller.abort();
	// Dispatch through the runtime, which owns cancellation semantics.
	const outcome = await nativeCall(h.tools, 'tool_search', { query: 'decompile', select: [`${PREFIX}decompile`] }, a, controller.signal);
	assert.equal(outcome.isError, true, 'a cancelled search does not run');
	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'nothing was activated');
});

test('a late failure after the body ran rolls the activation back', async () => {
	const { h, a } = setup();
	// A native post-execute policy that rejects the call after the body returned.
	const release = h.ctx.on('tools/post-execute', () => {
		throw new Error('late policy failure');
	});
	const outcome = await nativeCall(h.tools, 'tool_search', { query: 'decompile', select: [`${PREFIX}decompile`] }, a);
	release();
	assert.ok(outcome.isError === true, 'the call is rejected natively');
	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'the activation was rolled back, not left live');
});

test('a failed restriction keeps the previous restriction and reports it', async () => {
	const { h, a } = setup();
	await search(h, a, { query: 'decompile', select: [`${PREFIX}decompile`] });
	const before = h.wire(a).map((s) => s.name).join(',');

	// Let the snapshot's own restore succeed (call 1), then fail the install of
	// the new set (calls 2+), which is the case that must keep the old one.
	const originalRestrict = a.ctx.tools.restrict.bind(a.ctx.tools);
	let calls = 0;
	a.ctx.tools.restrict = (...rest) => {
		calls += 1;
		if (calls >= 2) throw new Error('restrict unavailable');
		return originalRestrict(...rest);
	};
	const result = await search(h, a, { query: 'memory', select: [`${PREFIX}memory`] });
	a.ctx.tools.restrict = originalRestrict;

	assert.ok(result.error, 'the failure is reported');
	assert.match(result.error, /restrict unavailable/);
	assert.deepEqual(result.active, [`${PREFIX}decompile`], 'the previous set is reported');
	assert.equal(h.wire(a).map((s) => s.name).join(','), before, 'the previous restriction was kept — the catalog is not exposed');
});

test('agent initialization throws when the catalog cannot be hidden', () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	apply(h.ctx, { prefix: PREFIX });

	const { ctx: agentCtx } = createScope(h.ctx, Symbol('broken'));
	agentCtx.tools.restrict = () => {
		throw new Error('restrict unavailable');
	};
	const broken = {
		id: 'broken-agent',
		ctx: agentCtx,
		session: { id: 'broken', header: {}, inheritedEventCount: 0, events: () => [], snapshotEvents: () => [], seq: 0, eventAt: () => undefined },
	};
	assert.throws(() => h.ctx.emit('agent/created', { agent: broken }), /could not be hidden/);
});

test('the wire schema is materially smaller for a lean scope', () => {
	const h = harness();
	const many = Array.from({ length: 30 }, (_, i) => ({ name: `${PREFIX}dense${i}`, description: 'y'.repeat(200) }));
	register(h.tools, [...CORE, ...many]);
	const lean = agent(h);
	apply(h.ctx, { prefix: PREFIX });

	const leanBytes = Buffer.byteLength(JSON.stringify(h.wire(lean)), 'utf8');
	const fullBytes = Buffer.byteLength(JSON.stringify(h.tools.schemas()), 'utf8');
	assert.ok(fullBytes > leanBytes * 5, `wire shrinks materially (${leanBytes} vs ${fullBytes})`);
});

test('plugin teardown restores the catalog and a pending notification cannot re-hide it', async () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	// A real disposable fiber: this is plugin lifetime, not agent lifetime.
	const fiber = h.ctx.plugin({ name: 'tool-discovery', apply: (c, c2) => apply(c, c2) }, { prefix: PREFIX });
	await fiber;
	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'hidden while active');

	// Queue a catalog notification, then tear the plugin down before it runs.
	register(h.tools, [{ name: `${PREFIX}late`, description: 'Late arrival' }]);
	const disposing = fiber.dispose();
	await disposing;
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, CATALOG.length + 1, 'teardown restores the catalog');
	assert.equal(h.tools.get('tool_search'), undefined, 'the tool registration is gone');

	// A later turn must not resurrect restrictions from the queued callback.
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, CATALOG.length + 1, 'nothing re-hides after teardown');
});

test('a cold-restored set that no longer fits is dropped and search stays usable', async () => {
	// Produce the log under a generous budget, from a real native call.
	const dense = [
		{ name: `${PREFIX}bigOne`, description: 'b'.repeat(700) },
		{ name: `${PREFIX}bigTwo`, description: 'b'.repeat(700) },
	];
	const wide = harness();
	register(wide.tools, [...CORE, ...dense]);
	const wideAgent = agent(wide);
	apply(wide.ctx, { prefix: PREFIX, maxSchemaBytes: 65536 });
	const log = await logFromRealCall(wide, wideAgent, { query: 'big', select: [`${PREFIX}bigOne`, `${PREFIX}bigTwo`] });
	const committedMeta = log[1].data.meta;
	assert.deepEqual(committedMeta.active, [`${PREFIX}bigOne`, `${PREFIX}bigTwo`], 'the wide session committed both');

	// Resume under a budget those two schemas cannot meet.
	const narrow = harness();
	register(narrow.tools, [...CORE, ...dense, { name: `${PREFIX}small`, description: 'Small tool' }]);
	apply(narrow.ctx, { prefix: PREFIX, maxSchemaBytes: 1024 });
	const resumed = resume(narrow, log);

	assert.equal(narrow.wire(resumed).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'the oversized saved set is dropped, catalog stays hidden');
	const search = narrow.tools.get('tool_search', scopeOf(resumed.ctx));
	assert.ok(search, 'tool_search stays available — no permanent lockout');

	const again = await search.execute({ query: 'small', select: [`${PREFIX}small`] }, { agent: resumed, signal: new AbortController().signal });
	assert.deepEqual(again.active, [`${PREFIX}small`], 'a new bounded selection still works');
});

test('a provider re-registration that grows a schema drops the saved set', async () => {
	const h = harness();
	const releaseSmall = register(h.tools, [...CORE, { name: `${PREFIX}small`, description: 'Small tool' }]);
	const a = agent(h);
	apply(h.ctx, { prefix: PREFIX, maxSchemaBytes: 1024 });

	const search = h.tools.get('tool_search', scopeOf(a.ctx));
	const first = await search.execute({ query: 'small', select: [`${PREFIX}small`] }, { agent: a, signal: new AbortController().signal });
	assert.deepEqual(first.active, [`${PREFIX}small`]);

	// The provider re-registers the same name with a schema that no longer fits.
	const grown = { name: `${PREFIX}small`, description: 'x'.repeat(4000), parameters: { big: { type: 'string' } } };
	releaseSmall();
	h.tools.register({
		name: grown.name,
		description: grown.description,
		parameters: grown.parameters,
		output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: '' }] },
		execute: async () => ({}),
	});
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'the grown schema drops the saved set');
	const after = await search.execute({ query: 'small', select: [] }, { agent: a, signal: new AbortController().signal });
	assert.deepEqual(after.active, [], 'and it is reported as inactive');
	assert.ok(Array.isArray(after.candidates), 'search still answers');
});

test('disposal lifts only that agent restriction', () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	const a = agent(h);
	const b = agent(h);
	apply(h.ctx, { prefix: PREFIX });
	h.ctx.emit('agent/disposed', { agent: a });
	assert.equal(h.wire(a).filter((s) => s.name.startsWith(PREFIX)).length, CATALOG.length, 'disposed agent is unrestricted');
	assert.equal(h.wire(b).filter((s) => s.name.startsWith(PREFIX)).length, 0, 'the sibling stays hidden');
});

// --- review fixes, 2026-11-13 -------------------------------------------------

/** A committed genuine tool_search result that published `active`. */
const committedLog = (active, id = `ok-${counter++}`) => [
	{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id, name: 'tool_search', arguments: '{"query":"x"}' }] } } },
	{ type: 'tool/result', data: { meta: { v: 1, kind: 'tool_search/active', active }, message: { toolCallId: id, content: [], isError: false } } },
];
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a resumed selection survives an MCP catalog that registers after the session loads', async () => {
	const h = harness();
	register(h.tools, CORE);
	apply(h.ctx, { prefix: PREFIX });
	const resumed = resume(h, committedLog([`${PREFIX}decompile`]));
	register(h.tools, CATALOG);
	await tick();
	const names = h.wire(resumed).map((s) => s.name);
	assert.ok(names.includes(`${PREFIX}decompile`), 'the saved tool appears once it registers');
	assert.ok(!names.includes(`${PREFIX}memory`), 'the rest of the late catalog stays hidden');
	assert.deepEqual((await search(h, resumed, { query: 'decompile' })).active, [`${PREFIX}decompile`]);
});

test("a reused call id in another session cannot roll back this session's selection", async () => {
	const { h, a } = setup();
	const b = agent(h);
	h.ctx.emit('agent/created', { agent: b });
	h.tools.register({
		name: 'boom',
		description: 'Always fails',
		parameters: { target: { type: 'string' } },
		output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: '' }] },
		execute: async () => {
			throw new Error('boom');
		},
	});
	await tick();
	// A's selection is applied and still waiting for its own committed result.
	const tool = h.tools.get('tool_search', scopeOf(a.ctx));
	const selected = await tool.execute({ query: 'decompile', select: [`${PREFIX}decompile`] }, { agent: a, callId: 'call_0', signal: new AbortController().signal });
	assert.deepEqual(selected.active, [`${PREFIX}decompile`]);
	const failed = await h.tools.execute({ callId: 'call_0', name: 'boom', arguments: {}, agent: b, signal: new AbortController().signal });
	assert.equal(failed.isError, true);
	assert.ok(h.wire(a).some((s) => s.name === `${PREFIX}decompile`), "B's failure leaves A's tool active");
});

test('search splits the query into tokens and leaves out tools that match nothing', async () => {
	const { h, a } = setup();
	const words = await search(h, a, { query: 'Decompile APK' });
	assert.deepEqual(words.candidates.map((c) => c.name), [`${PREFIX}decompile`], 'words match across name and description');
	const snake = await search(h, a, { query: 'symbol_table' });
	assert.equal(snake.candidates[0].name, `${PREFIX}symbols`, 'snake_case queries split into tokens');
	const none = await nativeCall(h.tools, 'tool_search', { query: 'kubernetes' }, a);
	const text = (none.content ?? []).map((block) => block.text ?? '').join('\n');
	assert.match(text, /No matches\./);
	assert.doesNotMatch(text, /Matches:/);
});

test('the prefix must be non-empty and never hides tool_search itself', () => {
	const empty = harness();
	register(empty.tools, [...CORE, ...CATALOG]);
	assert.throws(() => apply(empty.ctx, { prefix: '' }));

	const broad = harness();
	register(broad.tools, [...CORE, ...CATALOG]);
	const a = agent(broad);
	apply(broad.ctx, { prefix: 'tool' });
	assert.ok(broad.wire(a).some((s) => s.name === 'tool_search'), 'tool_search stays on the wire');
});

test('config.select is the default only until the session commits its own selection', () => {
	const h = harness();
	register(h.tools, [...CORE, ...CATALOG]);
	apply(h.ctx, { prefix: PREFIX, select: [`${PREFIX}symbols`] });
	const fresh = resume(h, []);
	assert.ok(h.wire(fresh).some((s) => s.name === `${PREFIX}symbols`), 'a fresh session starts with the default');
	const resumed = resume(h, committedLog([`${PREFIX}memory`]));
	const names = h.wire(resumed).map((s) => s.name).filter((n) => n.startsWith(PREFIX));
	assert.deepEqual(names, [`${PREFIX}memory`], 'the committed selection replaces the default');
});
