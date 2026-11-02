/**
 * Principles — the person's named rules of work, packaged as a DSH plugin.
 *
 * The plugin contributes three things to every session and nothing else:
 * a user-scoped store at `$DSH_HOME/principles/*.md`, one prompt section that
 * indexes the store (name, title, trigger) and carries the precedence rule, and
 * the `principle_read` / `principle_write` tools. There is deliberately no cap:
 * the index prints its own size on every build, and the pruning rule comes from
 * that measurement rather than from a guess.
 *
 * @module @local/dsh-principles
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createPrincipleStore, principlesDir, renderIndex, resolveDshHome } from './store.js';

/** Cordis plugin name. */
export const name = 'dsh-principles';

/** Services the tools and the prompt section need. */
export const inject = ['systemPrompt', 'tools'];

/** Section name in the system prompt. */
export const SECTION_NAME = 'principles:index';

/**
 * Prompt order. External contributions may use any finite order; 650 puts the
 * person's principles after the fixed identity and plan/team policy, and before
 * the tool guidance that describes mechanics rather than judgment.
 */
export const SECTION_ORDER = 650;

/**
 * Register the store, its prompt section, and its two tools.
 *
 * Seeding runs before the section is registered, so the first prompt of a fresh
 * home already lists the bundled principles. A failed seed is logged and never
 * stops the plugin.
 * @param ctx - Cordis context carrying the `systemPrompt` and `tools` services.
 * @param config - optional `{ dir }` override for the store folder.
 */
export function apply(ctx, config = {}) {
	const dir = typeof config?.dir === 'string' && config.dir.trim() !== '' ? config.dir : principlesDir(resolveDshHome());
	const store = createPrincipleStore({ dir, log: (line) => ctx.logger?.warn?.(line) });
	store.seed();
	ctx.systemPrompt.section({
		name: SECTION_NAME,
		order: SECTION_ORDER,
		text: () => {
			try {
				return renderIndex(store.list(), (line) => ctx.logger?.info?.(line));
			} catch (error) {
				// A prompt is built for every request: an index failure is reported,
				// never allowed to fail the turn.
				ctx.logger?.warn?.(`principles: index build failed (${messageOf(error)}); contributing nothing`);
				return '';
			}
		},
	});
	ctx.tools.register(principleReadTool(store));
	ctx.tools.register(principleWriteTool(store));
}

/** Canonical output of `principle_read`. */
const READ_OUTPUT = {
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			name: { type: 'string', required: true },
			title: { type: 'string', required: true },
			description: { type: 'string', required: true },
			body: { type: 'string', required: true },
			version: { type: 'string', required: true },
			source: { type: 'string' },
			license: { type: 'string' },
		},
	},
	render: (_args, value) => {
		const lines = [`# ${value.title}`, `name: ${value.name} · version: ${value.version}`, '', `When it applies: ${value.description}`, ''];
		if (value.source !== undefined) lines.push(`Source: ${value.source}`, '');
		if (value.license !== undefined) lines.push(`License: ${value.license}`, '');
		lines.push(value.body);
		return [{ type: 'text', text: lines.join('\n') }];
	},
};

/** Canonical output of `principle_write`; the body is not echoed back. */
const WRITE_OUTPUT = {
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			action: { type: 'string', required: true, enum: ['add', 'change', 'remove'] },
			name: { type: 'string', required: true },
			title: { type: 'string' },
			description: { type: 'string' },
			version: { type: 'string' },
			removedTo: { type: 'string' },
		},
	},
	render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

/**
 * Build the read tool over a store.
 * @param store - the principle store.
 * @returns a registry-ready tool definition.
 */
function principleReadTool(store) {
	return defineTool({
		name: 'principle_read',
		description:
			"Read one of the person's principles: the full rule behind a line of the principles index. Call it when a principle's trigger fits the task, and before applying or citing it.",
		parameters: {
			name: {
				type: 'string',
				required: true,
				description: 'The principle id, its title, or loose words from either, such as "prove it works".',
			},
		},
		output: READ_OUTPUT,
		execute(args) {
			const found = store.find(args.name);
			if (found === undefined) throw new Error(store.unknown(args.name));
			return Promise.resolve({
				name: found.id,
				title: found.title,
				description: found.description,
				body: found.body,
				version: found.version,
				...(found.source === undefined ? {} : { source: found.source }),
				...(found.license === undefined ? {} : { license: found.license }),
			});
		},
	});
}

/**
 * Build the write tool over a store.
 * @param store - the principle store.
 * @returns a registry-ready tool definition.
 */
function principleWriteTool(store) {
	return defineTool({
		name: 'principle_write',
		description:
			"Add, change, or remove one of the person's principles in their own store. Use it when the person states a rule that should steer future work, or asks for an existing principle to be edited or dropped. A change or removal should carry the version `was` last read so a stale edit is refused.",
		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: ['add', 'change', 'remove'],
				description: 'add a new principle, change an existing one, or move one to .removed/.',
			},
			name: {
				type: 'string',
				required: true,
				description: 'The principle id, title, or loose words. For add, the name of the new principle.',
			},
			title: {
				type: 'string',
				description: 'Optional short title. On change, an empty string clears it.',
			},
			description: {
				type: 'string',
				description: 'The trigger: when the principle applies. Required for add. At most 600 characters.',
			},
			body: {
				type: 'string',
				description: 'The rule itself, in Markdown. Required for add. At most 16 KB.',
			},
			was: {
				type: 'string',
				description: 'The version the last principle_read returned. A stale version refuses the write instead of overwriting a newer edit.',
			},
		},
		output: WRITE_OUTPUT,
		execute(args) {
			if (args.action === 'add') {
				const added = store.add({ name: args.name, title: args.title, description: args.description, body: args.body });
				return Promise.resolve(summary('add', added));
			}
			if (args.action === 'change') {
				const changed = store.change({
					name: args.name,
					was: args.was,
					...(args.title === undefined ? {} : { title: args.title }),
					...(args.description === undefined ? {} : { description: args.description }),
					...(args.body === undefined ? {} : { body: args.body }),
				});
				return Promise.resolve(summary('change', changed));
			}
			if (args.action === 'remove') {
				const removed = store.remove({ name: args.name, was: args.was });
				return Promise.resolve({ action: 'remove', name: removed.id, removedTo: removed.removedTo });
			}
			throw new Error(`Unknown action ${JSON.stringify(args.action)}; use add, change, or remove.`);
		},
	});
}

/**
 * The model-facing confirmation for add and change: what was written, without
 * echoing a body that may be 16 KB.
 * @param action - the write that happened.
 * @param principle - the principle as stored after the write.
 * @returns the canonical output value.
 */
function summary(action, principle) {
	return {
		action,
		name: principle.id,
		title: principle.title,
		description: principle.description,
		version: principle.version,
	};
}

/** A thrown value's message, safe to log. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
