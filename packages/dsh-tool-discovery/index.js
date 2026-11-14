/**
 * Tool Discovery — keep a large MCP catalog out of a fresh session's wire.
 *
 * A globally loaded MCP server registers many tools, and all of them ride on
 * every model request until something narrows the per-agent surface. This
 * plugin hides a configured name prefix from each agent's own scope and exposes
 * one small `tool_search` tool that finds those hidden tools and activates the
 * ones the model explicitly selects, so the original tool becomes natively
 * callable without the rest ever reaching the wire.
 *
 * Selection contract: `select` REPLACES the session's active set. Callers pass
 * every tool they need together; the whole set must be at most `maxActive`
 * tools and at most `maxSchemaBytes` of schema, or the request is rejected with
 * no state change. Hiding, activation, and replay all derive from that one set,
 * so repeated searches cannot grow the wire without bound.
 *
 * Native mechanisms only:
 *   - Hide: `agent.ctx.tools.restrict({ deny })` on the agent's own scoped
 *     context. A scope's own restriction removes inherited tools only, so
 *     foreign restrictions stay in force and presentation, lookup, and
 *     execution stay aligned.
 *   - Find: `tool_search` synchronously lifts ONLY its own restriction, reads
 *     `ctx.tools.schemas(scope)` with the caller's scope, then restores its own
 *     restriction before any await.
 *   - Activate: recompute the agent's deny list without the selected names. The
 *     original ToolDefinition keeps its identity, validation, guards,
 *     concurrency class, cancellation, and side effects.
 *   - Durable: a host-only `ctx.sessionProjections` unit folds the versioned
 *     metadata a successful `tool_search` publishes through
 *     `output.presentationMeta`, which the agent loop commits as
 *     `tool/result.data.meta`. Replay therefore restores the committed active
 *     set itself — never the names a model merely asked for.
 *
 * @module @local/dsh-tool-discovery
 */

import { z } from 'zod';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { scopeOf } from '@deepseek-ai/dsh-scope';

/** Cordis plugin name. */
export const name = 'tool-discovery';

/** Services this plugin needs. */
export const inject = ['tools', 'agents', 'sessionProjections'];

/** Config, editable in `cordis.patch.yml`. */
export const Config = z.object({
	prefix: z.string().min(1).default('mcp__rea__'),
	select: z.array(z.string()).default([]),
	maxResults: z.number().int().min(1).max(50).default(8),
	maxActive: z.number().int().min(1).max(50).default(8),
	maxSchemaBytes: z.number().int().min(1024).max(524288).default(16384),
	maxCandidateChars: z.number().int().min(32).max(2000).default(200),
});

/** Name of the one tool this plugin registers. */
const SEARCH_TOOL = 'tool_search';

/** Host-only projection key owned by this plugin. */
const PROJECTION_KEY = 'tool-discovery/activation';

/** Version tag of the metadata payload this plugin publishes and replays. */
const META_KIND = 'tool_search/active';
const META_VERSION = 1;

/**
 * Fold canonical session events into the committed active set.
 *
 * A call is recorded from its `assistant/message` tool-call block; the
 * `tool/result` for that same id commits only what the successful value
 * published through `presentationMeta`, which is the authoritative set the
 * plugin actually applied. Requested names in the call arguments are never
 * trusted, so a rejected, oversized, unknown, failed, or cancelled call cannot
 * change the selection — live or after replay.
 */
const activationProjection = {
	key: PROJECTION_KEY,
	stateVersion: 2,
	stateSchema: z
		.object({
			v: z.literal(2),
			/** tool-call ids of genuine `tool_search` calls awaiting their result */
			pending: z.array(z.string()),
			/** the committed active set */
			active: z.array(z.string()),
		})
		.strict(),
	init: () => ({ v: 2, pending: [], active: [] }),
	apply: (state, event) => {
		if (event.type === 'assistant/message') {
			const content = event.data?.message?.content;
			if (!Array.isArray(content)) return state;
			let pending;
			for (const block of content) {
				if (block?.type !== 'tool-call' || block?.name !== SEARCH_TOOL) continue;
				if (typeof block.id !== 'string' || state.pending.includes(block.id)) continue;
				pending ??= [...state.pending];
				pending.push(block.id);
			}
			return pending === undefined ? state : { ...state, pending };
		}
		if (event.type === 'tool/result') {
			const callId = event.data?.message?.toolCallId;
			if (typeof callId !== 'string' || !state.pending.includes(callId)) return state;
			const rest = state.pending.filter((id) => id !== callId);
			if (event.data?.message?.isError === true) return { ...state, pending: rest };
			const meta = event.data?.meta;
			if (meta?.v !== META_VERSION || meta?.kind !== META_KIND || !Array.isArray(meta.active)) {
				return { ...state, pending: rest };
			}
			const active = meta.active.filter((n) => typeof n === 'string');
			return { ...state, pending: rest, active };
		}
		return state;
	},
};

/** @param error - thrown value @returns a short message */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Split a query into lowercase tokens on whitespace and the separators tool
 * names use, so "decompile function" finds `decompile_function`.
 * @param query - raw query text.
 * @returns the tokens; empty for a blank query.
 */
function tokensOf(query) {
	return String(query ?? '').toLowerCase().split(/[\s_\-.:/]+/u).filter((token) => token !== '');
}

/**
 * Score a candidate: each token found in the name counts 2, in the description
 * only 1, and matching every token adds a bonus. A blank query lists every
 * tool; a candidate that matches no token scores 0 and is left out.
 * @param name - tool name.
 * @param description - tool description.
 * @param tokens - query tokens from {@link tokensOf}.
 * @returns a positive score, or 0 for no match.
 */
function scoreQuery(name, description, tokens) {
	if (tokens.length === 0) return 1;
	const lowerName = name.toLowerCase();
	const lowerDescription = description.toLowerCase();
	let score = 0;
	let matched = 0;
	for (const token of tokens) {
		if (lowerName.includes(token)) score += 2;
		else if (lowerDescription.includes(token)) score += 1;
		else continue;
		matched += 1;
	}
	if (matched === 0) return 0;
	return matched === tokens.length ? score + tokens.length : score;
}

/**
 * Build the `tool_search` tool definition.
 * @param cfg - validated Config.
 * @param run - `(args, exec) => result` performs the search.
 * @returns the tool definition.
 */
function buildSearchTool(cfg, run) {
	return defineTool({
		name: SEARCH_TOOL,
		description:
			'Search tools hidden from this session (a large MCP catalog is hidden by default to keep the tool list small). Returns matching names; pass every tool you need in `select` to activate that set, replacing any previously activated set. The whole set must fit the session tool budget, so select the tools needed for one task together.',
		// A property map, not a JSON Schema object: the authoring dialect takes
		// each parameter's own value schema here.
		parameters: {
			query: { type: 'string', required: true, description: 'Name or description fragment to search for.' },
			limit: { type: 'integer', description: `Maximum matches to return (max ${cfg.maxResults}).` },
			select: {
				type: 'array',
				items: { type: 'string' },
				description: `The complete set of tools to activate, replacing the current set (at most ${cfg.maxActive} tools; all must fit the schema budget). Omit it, or pass an empty list, to search without changing the active set.`,
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					active: {
						type: 'array',
						items: { type: 'string' },
						description: 'The complete active set after this call; unchanged when `error` is set.',
					},
					activated: {
						type: 'array',
						items: { type: 'string' },
						description: 'Names newly callable from the next step.',
					},
					candidates: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: { name: { type: 'string' }, description: { type: 'string' } },
						},
						description: 'Matches, including already-active ones.',
					},
					schemas: {
						type: 'object',
						additionalProperties: true,
						description: 'Full parameter schemas of the active set, by name.',
					},
					error: { type: 'string', description: 'Why the request could not be fulfilled.' },
				},
			},
			render: (_args, value) => {
				const lines = [];
				if (value.error) lines.push(value.error);
				if (value.activated?.length) lines.push(`Active now: ${value.active.join(', ')} — callable from your next step.`);
				if (value.candidates?.length) {
					const marks = new Set(value.active ?? []);
					lines.push('Matches:');
					for (const c of value.candidates) lines.push(`  - ${c.name}${marks.has(c.name) ? ' (active)' : ''}: ${c.description}`);
				} else if (!value.error) {
					lines.push('No matches.');
				}
				return [{ type: 'text', text: lines.join('\n') }];
			},
			// The only durable record of the selection. Emitted only when this
			// call committed a new set, and it carries that set itself.
			presentationMeta: (_args, value) =>
				value.error === undefined ? { v: META_VERSION, kind: META_KIND, active: value.active } : undefined,
		},
		async execute(args, exec) {
			return run(args, exec);
		},
	});
}

/**
 * Whether a tool belongs to the hidden catalog. `tool_search` itself is never
 * hidden, whatever the prefix, or nothing could ever be activated.
 * @param cfg - validated Config.
 * @param name - tool name.
 * @returns true when the tool is hidden until selected.
 */
function hideable(cfg, name) {
	return name !== SEARCH_TOOL && name.startsWith(cfg.prefix);
}

/** @param permitted - caller-permitted catalog @param names - tool names @returns schemas by name */
function schemasOf(permitted, names) {
	const out = {};
	for (const name of names) {
		const entry = permitted.get(name);
		if (entry === undefined) continue;
		out[name] = { name, description: entry.description, parameters: entry.parameters };
	}
	return out;
}

/** @param text - a description @param max - character budget @returns a shortened description */
function shorten(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Rank the permitted prefix tools and apply an atomic replacement selection.
 * @param cfg - validated Config.
 * @param readActive - `(session) => string[]` committed active set.
 * @param applyActive - `(agent, names) => string` applies a set, returning an error message or ''.
 * @param snapshot - `(agent) => Map<string,{description,parameters}>` caller-permitted catalog.
 * @param failureOf - `(agent) => string|undefined` an enforcement failure.
 * @param args - `{ query, limit?, select? }`.
 * @param exec - tool execution context; `exec.agent` is the caller.
 * @returns the canonical result object.
 */
function runSearch(cfg, readActive, applyActive, snapshot, failureOf, args, exec) {
	const agent = exec.agent;
	if (agent === undefined) return { active: [], activated: [], candidates: [], schemas: {}, error: 'This tool needs a calling agent.' };

	const failure = failureOf(agent);
	if (failure !== undefined) {
		return { active: readActive(agent), activated: [], candidates: [], schemas: {}, error: `Tool discovery is not enforced for this session (${failure}).` };
	}

	const permitted = snapshot(agent);
	const permittedNames = [...permitted.keys()].filter((n) => hideable(cfg, n));
	const active = readActive(agent).filter((n) => permitted.has(n) && hideable(cfg, n));

	// The same budget check that governs restore and re-registration, measured
	// on the schemas this caller is actually permitted to receive.
	const sizes = new Map();
	for (const [name, entry] of permitted) sizes.set(name, Buffer.byteLength(JSON.stringify({ name, description: entry.description, parameters: entry.parameters }), 'utf8'));

	const tokens = tokensOf(args?.query);
	const limit = Math.max(1, Math.min(cfg.maxResults, Number(args?.limit) || cfg.maxResults));
	const scored = [];
	for (const name of permittedNames) {
		const score = scoreQuery(name, permitted.get(name).description, tokens);
		if (score > 0) scored.push({ name, score });
	}
	scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	const candidates = scored.slice(0, limit).map(({ name }) => ({
		name,
		description: shorten(permitted.get(name).description, cfg.maxCandidateChars),
	}));

	const requested = Array.isArray(args?.select) ? args.select.filter((n) => typeof n === 'string') : [];
	if (requested.length === 0) {
		// A search without a selection changes nothing.
		return { active, activated: [], candidates, schemas: schemasOf(permitted, active) };
	}

	// `select` replaces the set. Reject atomically before touching any state.
	const wanted = [...new Set(requested)];
	const invalid = wanted.filter((n) => !permittedNames.includes(n));
	if (invalid.length > 0) {
		return { active, activated: [], candidates, schemas: {}, error: `Cannot activate ${invalid.join(', ')}: not a usable tool in this session. Search first, then select from the matches.` };
	}
	const bound = validateActive(cfg, wanted, sizes);
	if (bound !== '') return { active, activated: [], candidates, schemas: {}, error: `Nothing changed: ${bound}` };

	// Enforce first; only a successful restriction change counts as activation.
	const applied = applyActive(agent, wanted, exec.callId);
	if (applied !== '') return { active, activated: [], candidates, schemas: {}, error: `Nothing changed: ${applied}` };

	const previous = new Set(active);
	return {
		active: wanted,
		activated: wanted.filter((n) => !previous.has(n)),
		candidates,
		schemas: schemasOf(permitted, wanted),
	};
}

/**
 * The whole global catalog as one snapshot: tool name → its wire schema size in
 * bytes. One read serves an entire enforcement pass, so a burst of hundreds of
 * registrations costs one clone, not one per tool per agent.
 * @param ctx - host context.
 * @returns a Map of tool name to schema byte size.
 */
function catalogSnapshot(ctx) {
	const out = new Map();
	for (const schema of ctx.tools.schemas()) {
		out.set(schema.name, Buffer.byteLength(JSON.stringify({ name: schema.name, description: schema.description ?? '', parameters: schema.parameters ?? {} }), 'utf8'));
	}
	return out;
}

/**
 * The one budget check shared by a new selection, a restored selection, and a
 * re-registered provider. Every path that can change an active set goes through
 * it, so a saved set cannot outgrow the limits without a new search.
 * @param cfg - validated Config.
 * @param names - the complete candidate set.
 * @param sizes - tool name → schema byte size, as currently registered.
 * @returns an actionable reason, or the empty string when the set is valid.
 */
function validateActive(cfg, names, sizes) {
	const missing = names.find((name) => !sizes.has(name));
	if (missing !== undefined) return `${missing} is no longer available to this session.`;
	return budgetOf(cfg, names, sizes);
}

/**
 * The budget half of {@link validateActive}, over tools that are registered.
 * @param cfg - validated Config.
 * @param names - registered tool names.
 * @param sizes - tool name → schema byte size.
 * @returns an actionable reason, or the empty string when the set fits.
 */
function budgetOf(cfg, names, sizes) {
	if (names.length > cfg.maxActive) return `that is ${names.length} tools; at most ${cfg.maxActive} may be active at once.`;
	let bytes = 0;
	for (const name of names) bytes += sizes.get(name) ?? 0;
	if (bytes > cfg.maxSchemaBytes) return `the set needs ${bytes} schema bytes; the budget is ${cfg.maxSchemaBytes}. Select fewer or narrower tools.`;
	return '';
}

/**
 * The plugin entry point.
 * @param ctx - Cordis host context.
 * @param config - row config, validated against `Config`.
 */
export function apply(ctx, config = {}) {
	const cfg = Config.parse(config);
	const initial = cfg.select.filter((n) => typeof n === 'string');

	/** agent → the single restriction record this plugin owns for that agent */
	const owned = new Map();
	/** agent → the applied active set for this live agent */
	const activeSets = new Map();
	/**
	 * agent → callId → the activation that call applied, pending its committed
	 * outcome. Keyed per agent: providers reuse call ids such as `call_0` across
	 * sessions, so a bare call id could roll back another session's selection.
	 */
	const inFlight = new Map();
	/** agent → last enforcement failure */
	const failures = new Map();
	/** true while this plugin is applying restrictions, to break `tools/change` re-entry */
	let installing = false;
	/** true once this plugin is disposed: no queued callback may act afterwards */
	let disposed = false;
	/** composition signature of the global catalog at the last enforcement */
	let lastCatalog = '';
	/** agent → the reason its saved set was dropped, to log a change once */
	const dropped = new Map();

	/** One catalog snapshot per enforcement pass; a burst reads it once. */
	const readCatalog = () => catalogSnapshot(ctx);
	// The signature covers each tool's schema size too: a provider can
	// re-register the same names with larger schemas, which changes the budget
	// even though the name set is identical.
	const signatureOf = (snapshot) =>
		[...snapshot.entries()]
			.filter(([n]) => hideable(cfg, n))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([n, bytes]) => `${n}:${bytes}`)
			.join('\n');

	/**
	 * The committed active set as the session log records it. `config.select`
	 * is only the default for a session that has not selected tools yet; a
	 * committed selection replaces it, live and after resume alike.
	 */
	const committed = (session) => {
		if (session === undefined || ctx.sessionProjections === undefined) return [...initial];
		const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
		const active = (state?.active ?? []).filter((n) => typeof n === 'string');
		return active.length > 0 ? active : [...initial];
	};

	/**
	 * The active set for a live agent. The log is authoritative on resume; a
	 * live agent also carries the set this plugin just applied, so a selection
	 * is effective for the rest of the session even before its tool result is
	 * committed.
	 */
	const readActive = (agent) => {
		const live = activeSets.get(agent);
		if (live !== undefined) return live;
		const names = committed(agent?.session);
		activeSets.set(agent, names);
		return names;
	};

	/**
	 * The active set as this pass may actually apply it. Tools that have not
	 * registered yet are kept, not dropped: an MCP server often registers its
	 * catalog shortly after a session loads, and the next catalog pass makes
	 * them visible. Only a set whose registered tools break the budget is
	 * dropped to empty: the catalog stays hidden and `tool_search` remains
	 * available for a new, bounded selection.
	 * @param agent - the agent being enforced.
	 * @param sizes - the current catalog sizes.
	 * @returns the applicable names.
	 */
	const resolveActive = (agent, sizes) => {
		const names = readActive(agent);
		const reason = budgetOf(cfg, names.filter((n) => sizes.has(n)), sizes);
		if (reason === '') {
			if (dropped.delete(agent)) ctx.logger.info(`tool-discovery: the saved selection for ${agent.id} fits the budget again`);
			return names;
		}
		if (dropped.get(agent) !== reason) {
			dropped.set(agent, reason);
			ctx.logger.warn(`tool-discovery: dropping the saved selection for ${agent.id} (${reason}); the catalog stays hidden and tool_search can select a new set`);
		}
		// Keep live state consistent with what is actually enforced, so the tool
		// reports the real (empty) set and a later selection replaces it cleanly.
		activeSets.set(agent, []);
		return [];
	};

	/** Install one restriction record for an agent. */
	const install = (agent, deny) => ({ deny, dispose: agent.ctx.tools.restrict({ deny }) });

	/**
	 * The caller-permitted catalog: lift only this plugin's own restriction,
	 * read with the caller's scope, then restore it. Every step is synchronous,
	 * so no await observes the lifted window and foreign filters stay in force.
	 */
	const snapshot = (agent) => {
		const scope = agent?.ctx === undefined ? undefined : scopeOf(agent.ctx);
		const mine = owned.get(agent);
		if (mine !== undefined) {
			owned.delete(agent);
			mine.dispose();
		}
		let entries;
		try {
			entries = ctx.tools.schemas(scope);
		} finally {
			if (mine !== undefined) {
				try {
					owned.set(agent, install(agent, mine.deny));
				} catch (error) {
					// Never continue silently with the catalog exposed: fail the call
					// and force the next catalog pass to re-install the restriction.
					failures.set(agent, messageOf(error));
					ctx.logger.error(`tool-discovery: could not restore the restriction for ${agent.id}: ${messageOf(error)}`);
					lastCatalog = '';
					scheduleEnforce();
					throw error;
				}
			}
		}
		const out = new Map();
		for (const schema of entries) out.set(schema.name, { description: schema.description ?? '', parameters: schema.parameters ?? {} });
		return out;
	};

	/**
	 * Apply a set for one agent. The new restriction is installed BEFORE the old
	 * one is dropped, so a failure keeps the previous safe restriction instead of
	 * exposing the catalog.
	 * @param agent - the agent to enforce.
	 * @param activated - the complete set to leave visible.
	 * @returns an error message, or the empty string.
	 */
	const enforce = (agent, activated, snapshot) => {
		if (agent?.ctx === undefined) return 'the agent has no scoped context';
		const sizes = snapshot ?? readCatalog();
		const keep = new Set(activated);
		const deny = [...sizes.keys()].filter((n) => hideable(cfg, n) && !keep.has(n));
		const previous = owned.get(agent);

		if (deny.length === 0) {
			owned.delete(agent);
			if (previous !== undefined) previous.dispose();
			failures.delete(agent);
			return '';
		}

		let next;
		try {
			next = install(agent, deny);
		} catch (error) {
			// A name may have vanished between the global read and the call; the
			// retry narrows to what the registry knows now. Anything else is real
			// and keeps the previous restriction in place.
			// Rare: the catalog shifted between the pass snapshot and the call.
			const known = readCatalog();
			const retry = deny.filter((n) => known.has(n));
			if (retry.length > 0 && retry.length < deny.length) {
				try {
					next = install(agent, retry);
				} catch (retryError) {
					return failed(agent, messageOf(retryError));
				}
			} else {
				return failed(agent, messageOf(error));
			}
		}

		// Only now is the old restriction dropped: the catalog was never exposed.
		owned.set(agent, next);
		if (previous !== undefined) previous.dispose();
		failures.delete(agent);
		return '';
	};

	/** Record and report an enforcement failure. @param agent - the agent @param message - the cause @returns the actionable error */
	const failed = (agent, message) => {
		failures.set(agent, message);
		ctx.logger.error(`tool-discovery: cannot hide the ${cfg.prefix} catalog for ${agent.id}: ${message}`);
		return `the ${cfg.prefix} catalog could not be hidden (${message}); the previous restriction was kept`;
	};

	/**
	 * Re-enforce every live agent after a real catalog change.
	 *
	 * `tools/change` also fires for our own `restrict` calls and carries no
	 * payload, so re-entry is broken by comparing the composition that actually
	 * matters: the set of global tool names. A restriction never changes it.
	 */
	const enforceAll = () => {
		if (installing) return;
		installing = true;
		try {
			// One deep-cloned catalog read serves every agent in this pass.
			const snapshot = readCatalog();
			lastCatalog = signatureOf(snapshot);
			for (const agent of ctx.agents.list()) {
				const error = enforce(agent, resolveActive(agent, snapshot), snapshot);
				if (error !== '') ctx.logger.error(`tool-discovery: ${error}`);
			}
		} finally {
			installing = false;
		}
	};

	/**
	 * Coalesce `tools/change` bursts into one pass per turn of the event loop.
	 * An MCP server can register hundreds of tools in one burst; enforcing per
	 * registration would re-clone the catalog per agent per tool. The change is
	 * still applied before the next agent step.
	 */
	let scheduled = false;
	const scheduleEnforce = () => {
		if (disposed || scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			// A teardown may land between scheduling and this turn; never touch
			// restrictions after the plugin's own registrations are gone.
			if (disposed) return;
			if (installing) {
				scheduleEnforce();
				return;
			}
			const snapshot = readCatalog();
			if (signatureOf(snapshot) === lastCatalog) return;
			enforceAll();
		});
	};

	/** Apply a new active set for one agent. @param agent - the caller @param names - the complete set @returns an error message, or '' */
	const applyActive = (agent, names, callId) => {
		installing = true;
		const previous = readActive(agent);
		try {
			const snapshot = readCatalog();
			const invalid = validateActive(cfg, names, snapshot);
			if (invalid !== '') return `Nothing changed: ${invalid}`;
			const error = enforce(agent, names, snapshot);
			if (error === '') {
				activeSets.set(agent, names);
				dropped.delete(agent);
				if (callId !== undefined) {
					let calls = inFlight.get(agent);
					if (calls === undefined) inFlight.set(agent, (calls = new Map()));
					calls.set(String(callId), { names, previous });
				}
			}
			return error;
		} finally {
			installing = false;
		}
	};

	/**
	 * The native `tools/result` is the final frozen outcome of a call. An
	 * activation applied by a call whose committed result is an error (a
	 * cancellation or a late failure after the body returned) is rolled back, so
	 * live state always matches what the log will replay.
	 */
	ctx.on('tools/result', (exec, result) => {
		const calls = inFlight.get(exec.agent);
		const key = String(exec.callId);
		const pending = calls?.get(key);
		if (pending === undefined) return;
		calls.delete(key);
		if (calls.size === 0) inFlight.delete(exec.agent);
		if (result.isError !== true) return;
		installing = true;
		try {
			const error = enforce(exec.agent, pending.previous, readCatalog());
			if (error === '') activeSets.set(exec.agent, pending.previous);
			else ctx.logger.error(`tool-discovery: could not roll back a rejected activation: ${error}`);
		} finally {
			installing = false;
		}
	});

	const disposeTool = ctx.tools.register(buildSearchTool(cfg, (args, exec) => runSearch(cfg, readActive, applyActive, snapshot, (agent) => failures.get(agent), args, exec)));
	ctx.effect(() => () => {
		// Set this before anything else: a queued catalog notification must not
		// re-install restrictions after our registrations are gone.
		disposed = true;
		scheduled = false;
		try {
			disposeTool();
		} catch {
			/* already disposed */
		}
		for (const entry of owned.values()) entry.dispose();
		owned.clear();
		activeSets.clear();
		dropped.clear();
	});

	ctx.sessionProjections.register(activationProjection);

	// Hide the catalog for every agent already live. A load that cannot hide it
	// fails rather than leaving the catalog visible.
	const initialCatalog = readCatalog();
	lastCatalog = signatureOf(initialCatalog);
	for (const agent of ctx.agents.list()) {
		const error = enforce(agent, resolveActive(agent, initialCatalog), initialCatalog);
		if (error !== '') throw new Error(`tool-discovery: ${error}`);
	}

	ctx.on('agent/created', ({ agent }) => {
		if (disposed) return;
		// Serial and synchronous: the catalog is hidden before the first prompt.
		const snapshot = readCatalog();
		const error = enforce(agent, resolveActive(agent, snapshot), snapshot);
		if (error !== '') throw new Error(`tool-discovery: ${error}`);
	});

	// The global catalog changed: recompute every agent's deny list. Our own
	// `restrict` calls also emit this, so compare the composition first.
	ctx.on('tools/change', () => {
		if (disposed || installing) return;
		scheduleEnforce();
	});

	ctx.on('agent/disposed', ({ agent }) => {
		if (disposed) return;
		const entry = owned.get(agent);
		owned.delete(agent);
		activeSets.delete(agent);
		failures.delete(agent);
		dropped.delete(agent);
		inFlight.delete(agent);
		if (entry !== undefined) entry.dispose();
	});
}
