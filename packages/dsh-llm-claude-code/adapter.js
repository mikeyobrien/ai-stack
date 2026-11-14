/**
 * Native Claude Code adapter for the DSH `LlmAdapter` seam.
 *
 * Division of labor (mirrors earendil-works/pi-claude-code, MIT (c) 2026
 * Armin Ronacher, ideas only): the official `claude -p` process is transport
 * and authentication only — a fresh process per call replays the canonical
 * history as stream-json frames, DSH tools are advertised through an inert
 * local MCP server, and a loopback relay captures the raw Anthropic response
 * (tool_use, thinking, usage, stop reason) that `--max-turns 1` handling
 * would otherwise reshape. DSH keeps the agent loop, tools, approvals,
 * history, and compaction.
 *
 * Streaming is incremental: text/reasoning/tool deltas are relayed from the
 * live SSE as each event arrives; the terminal `finish` (and any success
 * classification) waits for the complete native `message_stop` plus the CLI
 * result frame. An incomplete upstream stream is a classified provider
 * error, never a successful truncated finish.
 *
 * @module adapter
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
	CONTEXT_WINDOW_EXCEEDED_CODE, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ProviderRequestId,
	contentHasImage, isContextWindowExceededError, isQuotaExceededError, requiredImageOffload,
} from '@deepseek-ai/dsh-llm';
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment';

import { MAX_ARG_BYTES, authEnv, authStatus, childEnv, discoveryArgs, killTree, workerArgs } from './cli.js';
import { SseResponseBuilder, TurnRelay, usageFromAnthropic } from './relay.js';
import { collectImageRefs as collectImageRefsFrom, canonicalRequestPayload, historyToFrames, mcpConfig, toolManifest } from './transcript.js';
import { FALLBACK_MODELS } from './catalog.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)));
const MCP_SCRIPT = join(PACKAGE_ROOT, 'inert-mcp.mjs');
const AUTH_CACHE_TTL_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const TOOL_PREFIX = 'mcp__dsh__';
// Per-image request target (parity with the shipped adapter policy) and the
// adapter transport bound on accumulated base64 per request. These are adapter
// transport facts, NOT model-capacity claims; the catalog carries modality
// only. Image-heavy requests beyond the bound take the documented DSH offload
// path (IMAGE_OFFLOAD_REQUIRED) instead of silent dropping.
const IMAGE_MAX_PIXELS = 4_194_304;
const IMAGE_MAX_BYTES = 1_048_576;
const IMAGE_REQUEST_BUDGET_BYTES = 8 * 1_048_576;

/** Grace after the CLI exits before an untouched relay is closed out. */
const CHILD_EXIT_GRACE_MS = 500;

/** Terminal, classified turn failure. */
function turnError(code, message, extra = {}) {
	return new LlmError(`dsh-llm-claude-code: ${message}`, code, extra);
}

// Anthropic's wording when it moves a request off plan limits onto usage
// credits (same patterns pi-claude-code recognizes).
const USAGE_CREDITS_REJECTION = /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/iu;
// Anthropic context-overflow wording the shared classifier does not cover,
// e.g. "prompt is too long: 213462 tokens > 200000 maximum".
const ANTHROPIC_CONTEXT_OVERFLOW = /prompt is too long|too many input tokens/iu;

function retryAfterMs(value) {
	if (value === undefined || value === null) return undefined;
	const delay = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

/**
 * Classify an Anthropic error (HTTP status before streaming, or an in-band SSE
 * `error` event) onto the shared DSH codes, so llm-retry and context recovery
 * route on it.
 * @param options.status HTTP status, when the error preceded streaming.
 * @param options.error parsed `{type, message}` error object, if any.
 * @param options.body raw response body, used when it is not JSON.
 * @param options.retryAfter `retry-after` header value.
 * @param options.requestId upstream request id.
 */
export function upstreamError({ status, error, body, retryAfter, requestId } = {}) {
	let parsed = error;
	if (parsed === undefined && typeof body === 'string' && body !== '') {
		try {
			parsed = JSON.parse(body)?.error;
		} catch {
			parsed = { message: body.slice(0, 300) };
		}
	}
	const type = typeof parsed?.type === 'string' ? parsed.type : '';
	const message = typeof parsed?.message === 'string' && parsed.message !== ''
		? parsed.message
		: `Anthropic request failed (${status ?? 'stream error'})`;
	const detail = `${type} ${message}`;
	let code;
	if (USAGE_CREDITS_REJECTION.test(message)) code = 'BILLING';
	else if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') code = 'AUTH';
	else if (status === 402 || isQuotaExceededError(detail)) code = 'QUOTA';
	else if (status === 429 || type === 'rate_limit_error') code = 'RATE_LIMIT';
	else if (ANTHROPIC_CONTEXT_OVERFLOW.test(message) || isContextWindowExceededError(detail)) code = CONTEXT_WINDOW_EXCEEDED_CODE;
	else if (status === 400 || status === 413 || type === 'invalid_request_error' || type === 'request_too_large') code = 'INVALID_REQUEST';
	else if ((status !== undefined && status >= 500) || type === 'api_error' || type === 'overloaded_error') code = 'SERVER';
	else code = status === undefined ? 'SERVER' : `HTTP_${status}`;
	const delay = retryAfterMs(retryAfter);
	return turnError(code, `${type ? `${type}: ` : ''}${message}`, {
		...(status === undefined ? {} : { status }),
		...(requestId ? { requestId: ProviderRequestId(requestId) } : {}),
		...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
	});
}

/** Map the captured response onto the DSH finish vocabulary. */
function finishFor({ stopReason, hasToolUse }) {
	if (hasToolUse) return { kind: 'tool-calls' };
	if (stopReason === 'max_tokens') return { kind: 'max-tokens' };
	return { kind: 'stop' };
}

/** Documented request fields the CLI argv cannot carry; applied at the relay. */
function requestOverlayOf(options) {
	const overlay = {};
	if (options.temperature !== undefined) overlay.temperature = options.temperature;
	if (options.maxTokens !== undefined) overlay.max_tokens = options.maxTokens;
	if (Array.isArray(options.stop) && options.stop.length > 0) overlay.stop_sequences = [...options.stop];
	return overlay;
}

function stripPrefix(name) {
	return typeof name === 'string' && name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function argsOrEmpty(json) {
	return typeof json === 'string' && json !== '' ? json : '{}';
}

function validJsonObject(text) {
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

export class ClaudeCodeAdapter extends LlmAdapter {
	/**
	 * @param options.command resolved CLI executable (no PATH shim reliance).
	 * @param options.commandArgs extra argv before the generated flags (tests).
	 * @param options.configDir optional `CLAUDE_CONFIG_DIR` for the child only.
	 * @param options.requestTimeoutMs longest silence (no SSE event or CLI
	 *   output) one turn may have before it fails with TIMEOUT.
	 * @param options.statusTimeoutMs ceiling for `auth status`.
	 * @param options.allowUsageCredits when true, usage-credit billing events
	 *   are allowed through instead of failing the turn.
	 * @param options.env base environment snapshot (never mutated).
	 * @param options.upstream relay upstream override (tests).
	 * @param options.logger `(level, message, ...values)` sink.
	 */
	constructor({
		command,
		commandArgs = [],
		configDir,
		requestTimeoutMs = 180_000,
		statusTimeoutMs = 20_000,
		allowUsageCredits = false,
env = process.env,
		upstream,
		resolveAttachments,
		resolveImageAccess,
		imageMaxPixels = IMAGE_MAX_PIXELS,
		imageMaxBytes = IMAGE_MAX_BYTES,
		imageRequestBudgetBytes = IMAGE_REQUEST_BUDGET_BYTES,
		logger = () => {},
	} = {}) {
		super();
		this.command = command;
		this.commandArgs = commandArgs;
		this.configDir = configDir;
		this.requestTimeoutMs = requestTimeoutMs;
		this.statusTimeoutMs = statusTimeoutMs;
		this.allowUsageCredits = allowUsageCredits === true;
		this.env = env;
		this.upstream = upstream;
		this.resolveAttachments = resolveAttachments;
		this.resolveImageAccess = resolveImageAccess;
		this.imageMaxPixels = imageMaxPixels;
		this.imageMaxBytes = imageMaxBytes;
		this.imageRequestBudgetBytes = imageRequestBudgetBytes;
		this.logger = logger;
		this.authCache = null;
		this.modelsCache = null;
	}

	providerInfo() {
		return { id: 'claude-code', name: 'Claude Code (official CLI)' };
	}

	async #ensureAuth(signal) {
		if (this.authCache && Date.now() - this.authCache.at < AUTH_CACHE_TTL_MS) return this.authCache.value;
		let status;
		try {
			// Same environment the worker gets: an exported ANTHROPIC_API_KEY would
			// otherwise make the CLI report api_key auth the worker never uses.
			status = await authStatus(this.command, {
				argsPrefix: this.commandArgs,
				env: authEnv(this.env, { configDir: this.configDir }),
				timeoutMs: this.statusTimeoutMs,
				signal,
			});
		} catch (error) {
			if (error.code === 'CLI_MISSING' || error.code === 'CLI_FAILED') throw error;
			throw turnError('AUTH', `auth status failed: ${error.message}`, { cause: error });
		}
		if (!status.loggedIn) {
			throw turnError('AUTH', 'the Claude Code CLI is not logged in; run `claude auth login` (the official CLI owns credentials; this plugin never reads them)');
		}
		if (status.authMethod !== 'claude.ai') {
			// A stored API-key login would silently spend metered credits once the
			// env key is stripped; subscription auth is the only accepted mode and
			// the plan name is the CLI's business, never matched here.
			throw turnError('AUTH', `CLI auth method is ${JSON.stringify(status.authMethod ?? 'unknown')}, not "claude.ai"; re-authenticate with \`claude auth login\` (subscription) or remove the stored API-key login — this provider refuses to spend metered API credits`);
		}
		this.authCache = { at: Date.now(), value: status };
		return status;
	}

	async listModels() {
		try {
			const status = await this.#ensureAuth();
			if (!status.loggedIn) return [];
		} catch {
			return [];
		}
		try {
			return await this.#discoverModels();
		} catch (error) {
			this.logger?.('warn', `dsh-llm-claude-code: model discovery failed, serving labeled fallback catalog: ${error.message}`);
			return FALLBACK_MODELS.map((model) => ({ provider: 'claude-code', inputModalities: ['text', 'image'], ...model }));
		}
	}

	/**
	 * `control_request{initialize}` over stream-json; the CLI answers with the
	 * account's real model catalog (proven on 2.1.316). Replay-only user frame,
	 * `shouldQuery:false` — no generation, no token cost.
	 */
	#discoverModels() {
		if (this.modelsCache && Date.now() - this.modelsCache.at < AUTH_CACHE_TTL_MS) return Promise.resolve(this.modelsCache.value);
		return new Promise((resolve, reject) => {
			const child = spawn(this.command, [...this.commandArgs, ...discoveryArgs({ settingsFile: '{}' })], {
				env: childEnv(this.env, { configDir: this.configDir }),
				stdio: ['pipe', 'pipe', 'pipe'],
				detached: true,
			});
			let stdout = '';
			let stderr = '';
			let settled = false;
			const finish = (error, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				killTree(child);
				if (error !== undefined) reject(error);
				else resolve(value);
			};
			const timer = setTimeout(() => finish(turnError('DISCOVERY_TIMEOUT', `model discovery exceeded ${DISCOVERY_TIMEOUT_MS}ms`)), DISCOVERY_TIMEOUT_MS);
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk) => { stderr += chunk; });
			child.stdout.on('data', (chunk) => { stdout += chunk; });
			child.on('error', (error) => finish(error.code === 'ENOENT' ? Object.assign(error, { code: 'CLI_MISSING' }) : error));
			child.on('close', (code) => {
				if (settled) return;
				if (code !== 0) {
					finish(turnError('CLI_FAILED', `discovery run exited ${code}: ${stderr.trim().slice(0, 200)}`));
					return;
				}
				const models = modelsFromTranscript(stdout);
				if (models === null) finish(turnError('TURN_INCOMPLETE', 'discovery produced no control_response models'));
				else {
					this.modelsCache = { at: Date.now(), value: models };
					finish(undefined, models);
				}
			});
			const frames = [
				`${JSON.stringify({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'initialize' } })}\n`,
				`${JSON.stringify({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'text', text: 'list models' }] }, shouldQuery: false })}\n`,
			];
			child.stdin.on('error', () => {});
			child.stdin.end(frames.join(''));
		});
	}

	async resolveModel(_provider, model) {
		try {
			const models = await this.#discoverModels();
			const hit = models.find((entry) => entry.id === model);
			if (hit) return hit;
		} catch (error) {
			this.logger?.('warn', `dsh-llm-claude-code: catalog lookup for ${model} failed: ${error.message}`);
		}
		return { provider: 'claude-code', id: model, name: `${model} (Claude Code CLI)`, inputModalities: ['text', 'image'] };
	}

	/**
	 * Resolve every non-offloaded image reference once per request: shared
	 * versions keyed by attachment id, plus the host access resolver for
	 * handle/placeholder text. Throws UNSUPPORTED_CONTENT for images in
	 * non-user/tool history and IMAGE_OFFLOAD_REQUIRED when the accumulated
	 * base64 bound is exceeded (DSH then offloads oldest and retries).
	 * @returns undefined for text-only requests (legacy byte-identical path).
	 */
	async #prepareImages(messages, signal) {
		if (!messages.some((message) => contentHasImage(message.content ?? []))) return undefined;
		const attachments = this.resolveAttachments?.();
		if (attachments === undefined) {
			throw new LlmError('dsh-llm-claude-code: request carries images but no attachments service is mounted', 'INVALID_REQUEST');
		}
		const refs = collectImageRefsFrom(messages);
		const versions = new Map();
		await Promise.all(refs.map(async (ref) => {
			const target = {
				...requestImageDimensions(ref.width, ref.height, this.imageMaxPixels),
				maxBytes: this.imageMaxBytes,
			};
			versions.set(ref.attachmentId, await attachments.readImageRequest(ref, target, signal));
		}));
		// The route gate runs on the ENCODED sizes, per the shipped convention.
		const offloadImages = requiredImageOffload(
			messages,
			{ representation: 'base64', maxBytes: this.imageRequestBudgetBytes },
			(block) => versions.get(block.attachment.attachmentId)?.bytes ?? 0,
		);
		if (offloadImages > 0) {
			throw new LlmError(
				`dsh-llm-claude-code: request images exceed the ${this.imageRequestBudgetBytes}-byte base64 bound; ${offloadImages} more oldest occurrence(s) must be offloaded`,
				IMAGE_OFFLOAD_REQUIRED_CODE,
				{ offloadImages },
			);
		}
		return {
			versions,
			resolveImageAccess: (ref) => this.resolveImageAccess?.(ref),
		};
	}

	/**
	 * One model call = one fresh CLI process + exactly one relayed upstream
	 * response. Yields DSH chunks as they arrive; usage always precedes `finish`.
	 */
	async *stream(options) {
		let status;
		try {
			status = await this.#ensureAuth(options.signal);
		} catch (error) {
			if (options.signal?.aborted) {
				yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted during preflight', code: 'ABORTED' } } };
				return;
			}
			throw error;
		}
		const images = await this.#prepareImages(options.messages ?? [], options.signal);
		const { system, frames } = historyToFrames(options.messages ?? [], images);
		if (frames.length === 0) {
			throw turnError('EMPTY_HISTORY', 'request carried no messages');
		}
		const systemBytes = Buffer.byteLength(system || '', 'utf8');
		if (systemBytes >= MAX_ARG_BYTES) {
			// The CLI takes the system prompt as one argv string; past this the
			// spawn fails with a raw E2BIG.
			throw turnError('INVALID_REQUEST', `system prompt is ${systemBytes} bytes; the Claude Code CLI accepts under ${MAX_ARG_BYTES} bytes as one argument`);
		}

		const session = new TurnSession(this, options, system, frames);
		try {
			yield* session.run();
		} finally {
			await session.dispose();
		}
	}
}

/** Extract `control_response ... models[]` rows from a discovery transcript. */
export function modelsFromTranscript(stdout) {
	for (const line of stdout.split('\n')) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const rows = event?.response?.models ?? event?.response?.response?.models;
		if (event?.type === 'control_response' && Array.isArray(rows)) {
			return rows.map((row) => ({
				provider: 'claude-code',
				id: String(row.value ?? row.resolvedModel ?? ''),
				name: String(row.displayName ?? row.value ?? 'unknown'),
				description: typeof row.description === 'string' ? row.description : undefined,
				inputModalities: ['text', 'image'],
			})).filter((model) => model.id !== '');
		}
	}
	return null;
}

/** One `claude -p` invocation: child + relay + live classified emission. */
class TurnSession {
	#adapter;
	#options;
	#system;
	#frames;
	#child;
	#relay;
	#dir;
	#timers = [];
	#stderr = '';
	#nativeError;
	#result;
	#rateLimitEvents = [];
	#aborted = false;
	#abortReason;
	#exitInfo;
	#stdoutClosed;
	#idleTimer;
	#onAbort;
	/** Live SSE mirror for final validation; fed alongside the delta relay. */
	#builder = new SseResponseBuilder();
	#toolJsonProblem;

	constructor(adapter, options, system, frames) {
		this.#adapter = adapter;
		this.#options = options;
		this.#system = system;
		this.#frames = frames;
	}

	async *run() {
		const options = this.#options;
		const signal = options.signal;
		if (signal?.aborted) {
			yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted before start', code: 'ABORTED' } } };
			return;
		}

		this.#dir = await mkdtemp(join(tmpdir(), 'dsh-claude-'));
		const settingsPath = join(this.#dir, 'settings.json');
		const manifestPath = join(this.#dir, 'tools.json');
		const mcpPath = join(this.#dir, 'mcp.json');
		await writeFile(settingsPath, JSON.stringify({}), 'utf8');
		await writeFile(manifestPath, JSON.stringify(toolManifest(options.tools ?? [])), 'utf8');
		await writeFile(mcpPath, JSON.stringify(mcpConfig({ serverScript: MCP_SCRIPT, manifestPath })), 'utf8');

		// Rebuild the upstream body from the canonical frames: the CLI's own
		// user-content projection (reminders, merged turns) never reaches the
		// model; DSH history does, with one stable tip cache breakpoint.
		let canonical;
		try {
			canonical = canonicalRequestPayload(this.#frames, this.#system || 'You are a helpful assistant.');
		} catch (error) {
			throw turnError('EMPTY_HISTORY', `canonical request rebuild failed: ${error.message}`);
		}
		this.#relay = new TurnRelay({
			upstream: this.#adapter.upstream,
			requestOverlay: requestOverlayOf(options),
			// Messages are rebuilt canonically; the system array is the CLI's
			// documented layout, which already carries --system-prompt plus the
			// subscription billing-header block the API routes on.
			transformBody: () => ({ messages: canonical.messages }),
			logger: this.#adapter.logger,
		});
		const relayUrl = await this.#relay.start();
		let env;
		try {
			env = childEnv(this.#adapter.env, { relayUrl, configDir: this.#adapter.configDir });
		} catch (error) {
			this.#relay.close();
			throw error.code === 'CONFLICTING_ENV' ? new LlmError(error.message, 'CONFLICTING_ENV') : error;
		}

		const child = spawn(this.#adapter.command, [...this.#adapter.commandArgs, ...workerArgs({
			systemPrompt: this.#system || 'You are a helpful assistant.',
			settingsFile: settingsPath,
			mcpConfigFile: mcpPath,
			model: options.model,
		})], { env, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
		this.#child = child;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => { this.#stderr += chunk; });
		this.#pumpStdout(child);

		child.stdin.on('error', () => { /* EPIPE when the child dies early; classified via exit/relay */ });
		child.stdin.end(this.#frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''));

		if (signal) {
			this.#onAbort = () => this.#abort('aborted');
			signal.addEventListener('abort', this.#onAbort, { once: true });
		}
		this.#touch();
		// A CLI that exits before or while the relay serves (bad model alias,
		// expired login, crash) ends the turn now instead of at the timeout.
		void this.#stdoutClosed.then(() => {
			if (this.#relay.settled) return;
			const timer = setTimeout(() => this.#relay.close(), CHILD_EXIT_GRACE_MS);
			this.#timers.push(timer);
		});

		// Live phase: emit deltas as the relay observes each SSE event.
		let sawMessageStop = false;
		for await (const event of this.#relay.events()) {
			this.#touch();
			const chunk = this.#liveChunk(event);
			if (chunk !== undefined) yield chunk;
			if ((event.event ?? '') === 'message_stop') {
				sawMessageStop = true;
				break;
			}
		}

		// Drain the child completely (its result lands after the relay reply),
		// then take the capture for classification.
		await this.#stdoutClosed;
		const capture = await Promise.race([
			this.#relay.capture,
			new Promise((resolve) => {
				const timer = setTimeout(() => resolve({ kind: 'relay-closed' }), 1000);
				this.#timers.push(timer);
			}),
		]);

		if (this.#aborted && this.#abortReason === 'timeout') {
			// A stall is a retryable provider failure, not a user abort.
			throw turnError('TIMEOUT', `no response progress for ${this.#adapter.requestTimeoutMs}ms`);
		}
		if (this.#aborted) {
			yield { type: 'finish', reason: { kind: 'aborted', failure: { message: `turn ${this.#abortReason ?? 'aborted'}`, code: 'ABORTED' } } };
			return;
		}
		// Classification gates the finish: billing, completeness, result, usage.
		this.#classifyOrThrow(capture, { sawMessageStop });
		const response = capture.response;
		const blocks = (response?.blocks ?? []).filter(Boolean);
		const hasToolUse = blocks.some((block) => block?.type === 'tool_use');
		yield { type: 'usage', usage: response.usage ?? usageFromAnthropic(this.#result?.usage) };
		yield {
			type: 'finish',
			reason: finishFor({ stopReason: response?.stopReason, hasToolUse }),
			// Native fidelity for the next turn: signed/redacted thinking survives
			// here, one entry per emitted block, per the installed replay convention.
			replayState: {
				response: {
					kind: 'dsh-claude-code',
					version: 1,
					provider: 'claude-code',
					model: options.model,
					stopReason: response?.stopReason ?? null,
					resultUuids: this.#result?.user_message_uuids ?? null,
				},
				blocks: blocks.map((block) => {
					if (block.type === 'thinking') {
						return {
							type: 'reasoning',
							...(block.signature ? { thinkingSignature: block.signature } : {}),
						};
					}
					if (block.type === 'redacted_thinking') {
						return { type: 'reasoning', redactedData: block.redactedData };
					}
					if (block.type === 'tool_use') return { type: 'tool-call' };
					return { type: 'text' };
				}),
			},
		};
	}

	async dispose() {
		for (const timer of this.#timers.splice(0)) clearTimeout(timer);
		clearTimeout(this.#idleTimer);
		if (this.#onAbort) this.#options.signal?.removeEventListener('abort', this.#onAbort);
		if (this.#child && this.#child.exitCode === null && !this.#child.killed) killTree(this.#child);
		this.#relay?.close();
		if (this.#dir) await rm(this.#dir, { recursive: true, force: true }).catch(() => {});
	}

	/** Re-arm the idle bound: any SSE event or CLI output counts as progress. */
	#touch() {
		if (this.#aborted) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => this.#abort('timeout'), this.#adapter.requestTimeoutMs);
	}

	#abort(reason) {
		if (this.#aborted) return;
		this.#aborted = true;
		this.#abortReason = reason;
		if (this.#child && this.#child.exitCode === null) killTree(this.#child);
		this.#relay?.close();
	}

	#pumpStdout(child) {
		this.#stdoutClosed = new Promise((resolve) => {
			let buffer = '';
			child.stdout.on('data', (chunk) => {
				this.#touch();
				buffer += chunk;
				let newline;
				while ((newline = buffer.indexOf('\n')) !== -1) {
					this.#onStdoutLine(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
				}
			});
			child.on('close', (code, signalName) => {
				this.#exitInfo = { code, signal: signalName };
				resolve();
			});
			child.on('error', (error) => {
				this.#exitInfo = { error: String(error) };
				resolve();
			});
		});
	}

	#onStdoutLine(line) {
		if (!line.trim()) return;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === 'assistant' && event.error) {
			this.#nativeError = typeof event.error === 'string' ? event.error : event.error?.message ?? 'assistant error';
		}
		if (event.type === 'result') {
			this.#result = event;
			const rateLimit = event.rate_limit_events ?? (event.rate_limit_event ? [event.rate_limit_event] : undefined);
			if (Array.isArray(rateLimit)) this.#rateLimitEvents.push(...rateLimit);
		}
		if (event.type === 'rate_limit_event') this.#rateLimitEvents.push(event);
	}

	/** What the CLI said about its own failure: stderr, result text, or exit. */
	#cliDetail() {
		const result = typeof this.#result?.result === 'string' ? this.#result.result : '';
		return (this.#stderr.trim() || this.#nativeError || result.trim() || `exit ${JSON.stringify(this.#exitInfo ?? null)}`).slice(0, 400);
	}

	/**
	 * Post-terminal classification. Anything thrown here surfaces after any
	 * already-emitted deltas as a classified provider failure — never as a
	 * successful finish.
	 */
	#classifyOrThrow(capture, { sawMessageStop }) {
		this.#checkBilling();
		if (this.#toolJsonProblem !== undefined) {
			throw turnError('TURN_INCOMPLETE', this.#toolJsonProblem);
		}
		// Upstream refused before streaming: classify by status and body so
		// retry (RATE_LIMIT/SERVER) and context recovery route correctly.
		if (capture?.kind === 'upstream-error') throw upstreamError(capture);
		// In-band SSE error event (e.g. overloaded_error mid-stream).
		const inBand = capture?.response?.error ?? this.#builder.result.error;
		if (!sawMessageStop && inBand !== undefined) throw upstreamError({ error: inBand, requestId: capture?.requestId });
		if (capture?.kind === 'transport-error' || capture?.kind === 'stream-broken') {
			throw turnError('TRANSPORT', `upstream connection failed (${capture.kind}): ${String(capture.error ?? '').slice(0, 300)}`, capture.status === undefined ? {} : { status: capture.status });
		}
		if (this.#relay.requestCount === 0) {
			// The CLI never reached the relay: a CLI problem (bad model alias,
			// expired login, changed flags), surfaced with its own words.
			throw turnError('CLI_FAILED', `the Claude Code CLI exited before making a request: ${this.#cliDetail()}`);
		}
		if (!sawMessageStop || !capture || capture.kind === 'relay-closed' || capture.kind === 'relay-error') {
			const captureDetail = capture?.kind === 'relay-error' ? ` ${String(capture.error ?? '').slice(0, 200)}` : '';
			throw turnError('TURN_INCOMPLETE', `incomplete model response (capture ${String(capture?.kind ?? 'none')}, message_stop ${sawMessageStop})${captureDetail}: ${this.#cliDetail()}`);
		}
		if (capture.kind !== 'ok') {
			const detail = capture.error ?? capture.body ?? capture.kind;
			throw turnError('UPSTREAM', `relay turn failed (${capture.kind}): ${typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail)?.slice(0, 300)}`, capture.status === undefined ? {} : { status: capture.status });
		}
		const result = this.#result;
		const blocks = (capture.response?.blocks ?? []).filter(Boolean);
		if (result?.is_error === true && this.#nativeError && blocks.length === 0) {
			throw turnError('UPSTREAM', `CLI reported an assistant error: ${this.#nativeError}`);
		}
		if (blocks.length === 0) {
			throw turnError('TURN_INCOMPLETE', `response completed without content blocks (result subtype ${String(result?.subtype ?? 'none')})`);
		}
		const usage = capture.response?.usage ?? usageFromAnthropic(result?.usage);
		if (!usage || typeof usage.outputTokens !== 'number') {
			throw turnError('TURN_INCOMPLETE', 'response completed without token usage');
		}
	}

	#checkBilling() {
		for (const event of this.#rateLimitEvents) {
			const info = event.rate_limit_info ?? event;
			// isUsingOverage is the CLI's signal that this request was charged to
			// usage credits (the check pi-claude-code relies on). The response is
			// already paid for; stopping keeps the loop from issuing more.
			const charged = info?.isUsingOverage === true || info?.status === 'rejected' || info?.errorCode === 'credits_required';
			if (!charged) continue;
			if (!this.#adapter.allowUsageCredits) {
				throw turnError('BILLING', `subscription limits reached (rate_limit_event ${JSON.stringify(info).slice(0, 200)}); set allowUsageCredits to permit usage-credit billing`);
			}
			this.#adapter.logger?.('info', 'dsh-llm-claude-code: proceeding on usage credits per allowUsageCredits');
		}
	}

	/** Translate one live relay SSE event into at most one DSH chunk. */
	#liveChunk({ event: name, data }) {
		let parsed;
		try {
			parsed = JSON.parse(data);
		} catch {
			return undefined;
		}
		// Keep the validation mirror in lockstep with what is emitted.
		this.#builder.apply(name, data);
		const type = name ?? parsed.type;
		const index = parsed.index;
		if (type === 'content_block_start') {
			const block = parsed.content_block ?? {};
			const blockType = block.type === 'tool_use' ? 'tool-call' : block.type === 'thinking' || block.type === 'redacted_thinking' ? 'reasoning' : 'text';
			return { type: 'block-start', index, blockType };
		}
		if (type === 'content_block_delta') {
			const d = parsed.delta ?? {};
			if (d.type === 'text_delta') return { type: 'text-delta', index, text: d.text ?? '' };
			if (d.type === 'thinking_delta') return { type: 'reasoning-delta', index, text: d.thinking ?? '' };
			if (d.type === 'input_json_delta') {
				const started = this.#builder.result.blocks[index];
				return { type: 'tool-call-delta', index, id: started?.id, name: stripPrefix(started?.name), argumentsDelta: d.partial_json ?? '' };
			}
			return undefined;
		}
		if (type === 'content_block_stop') {
			const block = this.#builder.result.blocks[index];
			if (!block) return undefined;
			if (block.type === 'tool_use') {
				const args = block.json ?? '';
				// Empty arguments are a real no-argument call; anything else must parse.
				if (args !== '' && !validJsonObject(args)) {
					this.#toolJsonProblem = `tool_use block ${index} has malformed arguments`;
				}
				return { type: 'block-end', index, block: { type: 'tool-call', id: block.id, name: stripPrefix(block.name), arguments: argsOrEmpty(args) } };
			}
			if (block.type === 'thinking') return { type: 'block-end', index, block: { type: 'reasoning', text: block.thinking ?? '' } };
			// Redacted thinking has no readable text; it is an empty reasoning block
			// so it lines up with its `reasoning` replay entry and replays natively.
			if (block.type === 'redacted_thinking') return { type: 'block-end', index, block: { type: 'reasoning', text: '' } };
			return { type: 'block-end', index, block: { type: 'text', text: block.text ?? '' } };
		}
		return undefined;
	}
}
