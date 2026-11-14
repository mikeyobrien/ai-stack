/**
 * Native Claude Code provider plugin.
 *
 * The official `claude` CLI is transport and authentication only; DSH keeps
 * the agent loop, tools, approvals, history, and compaction. See README.md
 * for scope, limits, and the upstream reference attribution.
 *
 * @module @local/dsh-llm-claude-code
 */
import z from '@deepseek-ai/schemastery';

import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { ClaudeCodeAdapter } from './adapter.js';

export const name = 'llm-claude-code';

/** Inject the LLM registry; the adapter registers route `claude-code`. */
export const inject = ['llm'];

const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

/**
 * Runtime schema. `command` must be a resolved path or unambiguous name; a
 * version-manager shim (e.g. mise's `~/.local/bin/claude`) may mutate global
 * tool state, so prefer the versioned binary. `requestTimeoutMs` is the longest
 * silence (no SSE event or CLI output) a turn may have before it fails.
 */
export const Config = z.object({
	command: z.string().default('claude'),
	configDir: z.string(),
	requestTimeoutMs: z.number().min(1000).max(MAX_TIMER_MS).default(180_000),
	statusTimeoutMs: z.number().min(1000).max(MAX_TIMER_MS).default(20_000),
	allowUsageCredits: z.boolean().default(false),
});

/**
 * Register the `claude-code` provider route.
 * @param ctx Cordis plugin context with `llm` injected.
 * @param config resolved {@link Config}.
 */
export function apply(ctx, config) {
	const adapter = new ClaudeCodeAdapter({
		command: config.command,
		configDir: config.configDir,
		requestTimeoutMs: config.requestTimeoutMs,
		statusTimeoutMs: config.statusTimeoutMs,
		allowUsageCredits: config.allowUsageCredits,
		resolveAttachments: () => ctx.get('attachments'),
		resolveImageAccess: (ref) => {
			const fs = ctx.get('fs');
			if (fs === undefined) return undefined;
			return resolveImageAttachmentAccess(ctx.get('attachments'), (hostPath) => fs.processPathFromHostPath(hostPath), ref);
		},
		logger: (level, message, ...values) => ctx.logger[level]?.(message, ...values),
	});
	const registration = ctx.llm.registerAdapter(['claude-code'], adapter);
	ctx.on('loader/volatile-update', () => {
		// Route set is static; re-assert so a settings reload never leaves the
		// route registered to a stale adapter generation.
		try {
			registration.replace(['claude-code']);
		} catch (error) {
			ctx.logger.warn?.('dsh-llm-claude-code: volatile re-registration skipped', error);
		}
	});
	ctx.on('dispose', () => {
		try {
			registration();
		} catch { /* already disposed with the fiber */ }
	});
}

export { ClaudeCodeAdapter };
