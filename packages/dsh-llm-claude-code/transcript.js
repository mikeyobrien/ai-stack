/**
 * History/JSON-schema translation between DSH's canonical conversation form and
 * the Claude Code `stream-json` frame protocol (fresh process, full replay —
 * no `--resume`/`--continue`; continuity is the frames themselves).
 *
 * Frame shapes follow the documented SDK stream-json input
 * (`user` with `shouldQuery`, `assistant` replay) per the reference study of
 * earendil-works/pi-claude-code (MIT, (c) 2026 Armin Ronacher).
 *
 * @module transcript
 */

/** Prefix Claude Code sees on DSH tools (MCP server `dsh`); stripped on the way back. */
import { createHash } from 'node:crypto';

import { LlmError, contentHasImage, offloadedImageText, requestImageHandleText, requiredImageOffload } from '@deepseek-ai/dsh-llm';
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment';

const TOOL_PREFIX = 'mcp__dsh__';

export function toolWireName(name) {
	return `${TOOL_PREFIX}${name}`;
}

const ID_GRAMMAR = /^[A-Za-z0-9_-]+$/;

/**
 * Deterministic projection of a DSH tool-call id onto the Anthropic
 * `^[A-Za-z0-9_-]+$` id grammar.
 *
 * Already-valid ids pass through untouched (native live ids stay pristine and
 * stable across turns). Anything else — compound ids like `call_a|fc_b1`,
 * dots, colons — becomes `t_` plus the FULL SHA-256 digest of the raw id in
 * base64url: bounded 45 chars, grammar-safe, no growth with input length, and
 * cryptographically collision-resistant in the ordinary hash sense — NOT a
 * never-collide guarantee. The same raw id always projects identically in the
 * tool_use and its tool_result, and across turns. Percent-encoding is not an
 * option: `%` violates the grammar.
 * @param id raw DSH tool-call id.
 * @returns wire-valid id; pure function of the input.
 */
export function projectToolCallId(id) {
	if (typeof id !== 'string' || id === '') return 't_' + digestOf('');
	if (ID_GRAMMAR.test(id)) return id;
	return 't_' + digestOf(id);
}

function digestOf(text) {
	return createHash('sha256').update(text, 'utf8').digest('base64url');
}

export function toolNameFromWire(wireName) {
	return typeof wireName === 'string' && wireName.startsWith(TOOL_PREFIX) ? wireName.slice(TOOL_PREFIX.length) : wireName;
}

/**
 * Normalize a DSH tool JSON schema to what an MCP `inputSchema` accepts:
 * root object, no null-union roots, no combinator keys.
 */
export function normalizeToolSchema(schema) {
	const out = { type: 'object', properties: {}, ...(typeof schema === 'object' && schema !== null ? schema : {}) };
	if (Array.isArray(out.type)) out.type = out.type.includes('object') ? 'object' : 'object';
	else if (out.type !== 'object') out.type = 'object';
	if (out.type === 'object' && typeof out.properties !== 'object') out.properties = {};
	delete out.oneOf;
	delete out.allOf;
	delete out.anyOf;
	return out;
}

/**
 * The inert-MCP manifest: DSH tools advertised under their RAW registry names.
 * The CLI itself prepends the `mcp__dsh__` wire prefix when it composes requests
 * and reports tools; prefixing here too produced `mcp__dsh__mcp__dsh__<name>`
 * on the wire and broke every real tool call. Exactly one prefix exists, added
 * by the CLI, removed once on the response.
 */
export function toolManifest(tools = []) {
	return tools.map((tool) => ({
		name: tool.name,
		description: typeof tool.description === 'string' ? tool.description : '',
		inputSchema: normalizeToolSchema(tool.parameters),
	}));
}

/** The inline `--mcp-config` document: exactly one stdio server, no other sources. */
export function mcpConfig({ serverScript, manifestPath, nodeExecutable = process.execPath }) {
	return {
		mcpServers: {
			dsh: {
				command: nodeExecutable,
				args: [serverScript],
				env: { DSH_TOOL_MANIFEST: manifestPath },
			},
		},
	};
}

function textOf(blocks) {
	return blocks
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join('');
}

function userContent(message, images) {
	if (typeof message.content === 'string') return message.content;
	if (images === undefined) {
		// Text-only legacy path: byte-identical to the pre-multimodal behavior.
		const parts = [];
		for (const block of message.content ?? []) {
			if (block.type === 'text') parts.push(block.text);
			else if (block.type === 'image') parts.push('[image attachment rendered in the conversation]');
			else if (block.type === 'file') parts.push('[file attachment; see its handle text above]');
			else if (block.type === 'tool-call') parts.push('');
		}
		return parts.filter((part) => part !== '').join('\n') || '(empty)';
	}
	return multimodalBlocks(message.content ?? [], images, { allowImages: true, fileText: '[file attachment; see its handle text above]' });
}

/**
 * Build stream-json content blocks with native images. Each image becomes the
 * requestImageHandleText note followed by an Anthropic base64 image block —
 * ONE representation, shared by the CLI frames and (through them) the
 * canonical relay body. Offloaded images degrade to placeholder text with no
 * bytes. Images anywhere else than user/tool content are UNSUPPORTED_CONTENT.
 */
function multimodalBlocks(blocks, images, { allowImages }) {
	const content = [];
	for (const block of blocks ?? []) {
		if (block.type === 'text') {
			if (block.text) content.push({ type: 'text', text: block.text });
		} else if (block.type === 'image') {
			const access = images.resolveImageAccess(block.attachment);
			if (block.offloaded === true || images.versions === undefined) {
				content.push({ type: 'text', text: offloadedImageText(block.attachment, access) });
				continue;
			}
			const version = images.versions.get(block.attachment.attachmentId);
			if (version === undefined) {
				content.push({ type: 'text', text: offloadedImageText(block.attachment, access) });
				continue;
			}
			content.push({ type: 'text', text: requestImageHandleText(block.attachment, version, access) });
			content.push({
				type: 'image',
				source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') },
			});
		} else if (block.type === 'file') {
			content.push({ type: 'text', text: '[file attachment; see its handle text above]' });
		} else if (block.type === 'tool-call') {
			// handled by the assistant branch; nothing in user projection
		}
	}
	return content;
}

/** Collect unique non-offloaded image refs; enforce user/tool-only placement. */
export function collectImageRefs(messages) {
	if (!messages.some((message) => contentHasImage(message.content ?? []))) return [];
	const refs = new Map();
	for (const message of messages ?? []) {
		for (const block of message.content ?? []) {
			if (block.type !== 'image') continue;
			if (message.role !== 'user' && message.role !== 'tool') {
				throw new LlmError(`dsh-llm-claude-code: cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT');
			}
			if (block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment);
		}
	}
	return [...refs.values()];
}

const REPLAY_KIND = 'dsh-claude-code';
const REPLAY_VERSION = 1;

/**
 * Validate this adapter's replay envelope against the assistant content it
 * annotates. Anything else — another adapter's kind, a version bump, provider
 * mismatch, block misalignment — returns undefined and the message degrades to
 * provider-neutral history (per the installed dsh replay convention).
 */
export function readOwnReplay(message) {
	const state = message?.source?.replayState;
	if (typeof state !== 'object' || state === null) return undefined;
	const response = state.response;
	if (typeof response !== 'object' || response === null) return undefined;
	if (response.kind !== REPLAY_KIND || response.version !== REPLAY_VERSION) return undefined;
	if (response.provider !== message.source.provider) return undefined;
	if (!Array.isArray(state.blocks) || state.blocks.length !== (message.content?.length ?? 0)) return undefined;
	for (const [index, block] of (message.content ?? []).entries()) {
		const replay = state.blocks[index];
		if (typeof replay !== 'object' || replay === null) return undefined;
		if (replay.type !== undefined && replay.type !== block.type) return undefined;
	}
	return state;
}

function assistantContent(message) {
	const replay = readOwnReplay(message);
	const content = [];
	for (const [index, block] of (message.content ?? []).entries()) {
		const replayBlock = replay?.blocks[index];
		if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
		else if (block.type === 'reasoning') {
			if (replayBlock?.redactedData) {
				// Native redacted thinking: replay the opaque blob untouched.
				content.push({ type: 'redacted_thinking', data: replayBlock.redactedData });
			} else if (block.text && typeof replayBlock?.thinkingSignature === 'string' && replayBlock.thinkingSignature !== '') {
				// Signed native thinking: signature restored from replay metadata.
				content.push({ type: 'thinking', thinking: block.text, signature: replayBlock.thinkingSignature });
			}
			// Unsigned/foreign reasoning is OMITTED: fabricating a signature or
			// sending an empty one breaks native thinking continuations.
		} else if (block.type === 'tool-call') {
			let input = {};
			try {
				input = JSON.parse(block.arguments || '{}');
			} catch {
				input = {};
			}
			content.push({ type: 'tool_use', id: projectToolCallId(block.id), name: toolWireName(block.name), input });
		}
	}
	return content;
}

/**
 * Flatten canonical history into stream-json frames.
 * @param messages DSH `Message[]`; the leading `system` message is returned
 *   separately (it becomes `--system-prompt`).
 * @returns `{ system, frames }` — every frame carries a fresh uuid; all but the
 *   final frame are `shouldQuery:false`, and consecutive user frames merge.
 */
export function historyToFrames(messages, images) {
	if (images !== undefined) {
		// With images in play, enforce placement before building anything.
		for (const message of messages ?? []) {
			if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content ?? [])) {
				throw new LlmError(`dsh-llm-claude-code: cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT');
			}
		}
	}
	let system = '';
	const frames = [];
	const pushUser = (content) => {
		const last = frames.at(-1);
		if (last?.type === 'user') {
			last.message.content.push(...(Array.isArray(content) ? content : [{ type: 'text', text: content }]));
			return;
		}
		frames.push({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: Array.isArray(content) ? content : [{ type: 'text', text: content }] } });
	};

	for (const message of messages) {
		if (message.role === 'system') {
			system = textOf(message.content ?? []);
		} else if (message.role === 'user') {
			pushUser(userContent(message, images));
		} else if (message.role === 'developer') {
			// Developer instructions stay text-only: collectImageRefs refuses
			// images in non-user/tool history, so never project them here.
			pushUser(`[developer instruction]\n${userContent(message, undefined)}`);
		} else if (message.role === 'assistant') {
			frames.push({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: assistantContent(message) } });
		} else if (message.role === 'tool') {
			const hasImages = images !== undefined && contentHasImage(message.content ?? []);
			const resultContent = hasImages
				? multimodalBlocks(message.content ?? [], images, {})
				: textOf(message.content ?? []) || '(empty result)';
			pushUser([
				{
					type: 'tool_result',
					tool_use_id: projectToolCallId(message.toolCallId),
					content: resultContent,
					...(message.isError ? { is_error: true } : {}),
				},
			]);
		}
	}

	// The final frame is the one the turn responds to; everything earlier is replay.
	for (const [index, frame] of frames.entries()) {
		frame.shouldQuery = frame.type === 'user' && index === frames.length - 1;
	}
	return { system, frames };
}

/**
 * Canonical Anthropic Messages request body sections rebuilt from the same
 * frames the CLI receives, so the relayed upstream request carries DSH's
 * history verbatim — no CLI-injected reminders, transformed user text, or
 * drifted tool results. The conversation tip carries one stable ephemeral
 * cache breakpoint.
 *
 * @param frames frames from {@link historyToFrames} (user/assistant).
 * @param system the leading system text.
 * @returns `{ system, messages }` for the relay's body rewrite.
 */
export function canonicalRequestPayload(frames, system) {
	const messages = [];
	for (const frame of frames) {
		if (frame.type === 'user') {
			messages.push({ role: 'user', content: frame.message.content });
		} else if (frame.type === 'assistant') {
			messages.push({
				role: 'assistant',
				content: frame.message.content.map((block) => {
					if (block.type === 'tool_use') {
						let input = {};
						try {
							input = typeof block.input === 'string' ? JSON.parse(block.input || '{}') : block.input ?? {};
						} catch {
							input = {};
						}
						return { type: 'tool_use', id: block.id, name: block.name, input };
					}
					return block;
				}),
			});
		}
	}
	if (messages.length === 0) throw new Error('canonical history is empty; cannot build the upstream request');
	const last = messages.at(-1);
	const lastBlock = Array.isArray(last.content) ? last.content.at(-1) : undefined;
	if (lastBlock && typeof lastBlock === 'object') lastBlock.cache_control = { type: 'ephemeral' };
	return { system, messages };
}
