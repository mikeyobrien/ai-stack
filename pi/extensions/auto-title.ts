/**
 * Async session titling.
 *
 * Names the session after the first agent run finishes, from the request and the
 * answer, instead of leaving `/resume` to show the opening message. In the terminal the
 * naming call is fire-and-forget: the settle handler returns immediately, the model runs
 * in the background, and the name lands a moment later. Headless (`pi -p`, RPC) it is
 * awaited instead, because that process exits as soon as handlers return. A name set by
 * `/name`, `--name`, or a previous run is never overwritten.
 *
 * Environment:
 *   PI_AUTOTITLE_MODEL   provider/modelId to title with (default: the session's model)
 *   PI_AUTOTITLE=off     disable
 *   PI_AUTOTITLE_DEBUG   trace decisions; =1 logs to /tmp/pi-autotitle.log, otherwise the path given
 *
 * `/autotitle` shows state, `/autotitle on|off`, `/autotitle model <provider/id>`.
 */

import { appendFileSync } from "node:fs";

import type { AssistantMessage, ExtensionAPI, ExtensionContext, Message } from "@earendil-works/pi-coding-agent";

const MAX_TITLE_CHARS = 60;
const MAX_PROMPT_CHARS = 1_500;
const MAX_ANSWER_CHARS = 800;
const MAX_TITLE_TOKENS = 400;
// Servers that ignore reasoning=off can spend the whole budget on thinking and answer with
// nothing, so a second attempt gets room to finish. Measured here: ~70-140 thinking tokens.
const RETRY_TITLE_TOKENS = 1_000;
const CALL_TIMEOUT_MS = 20_000;
// With no UI, Pi can exit the moment a settle handler returns, so the call is awaited there.
// The cap is roomy because a headless run has nothing else to do, and a shared server can
// queue this behind real work: measured here at 5s timing out and 3-8s succeeding.
const HEADLESS_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You name sessions. Reply with only the name: three to six words that say what the work is, in the language of the request. Lowercase, no quotes, no trailing punctuation, no emoji. Describe the task, not the tool. If the request is a one-word greeting with no task, reply with: untitled`;

// PI_AUTOTITLE_DEBUG traces decisions to a file: a terminal UI repaints over stderr, so a
// name that never arrives would otherwise be undiagnosable from the pane.
const debugPath = process.env.PI_AUTOTITLE_DEBUG
	? (process.env.PI_AUTOTITLE_DEBUG === "1" ? "/tmp/pi-autotitle.log" : process.env.PI_AUTOTITLE_DEBUG)
	: undefined;
const log = (message: string) => {
	if (!debugPath) return;
	try {
		appendFileSync(debugPath, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never break a session.
	}
};

function textOf(message: Message | undefined): string {
	const content = message?.content;
	if (content === undefined || content === null) return "";
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => (block && typeof block === "object" && block.type === "text" ? [block.text as string] : []))
		.join("\n")
		.trim();
}

function firstUserText(messages: readonly Message[]): string {
	return messages.map((message) => (message.role === "user" ? textOf(message) : "")).find(Boolean) ?? "";
}

function lastAssistantText(messages: readonly Message[]): string {
	return messages.map((message) => (message.role === "assistant" ? textOf(message) : "")).filter(Boolean).at(-1) ?? "";
}

/**
 * What the model said, made safe to store. The first line wins, quotes and trailing
 * punctuation go, an over-long answer is cut at a word, and an empty answer or a
 * literal "untitled" is refused so a greeting never becomes the session's name.
 */
export function sanitizeTitle(raw: string): string | undefined {
	const firstLine = raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
	const stripped = firstLine
		.replace(/^["'`«“]+|["'`»”]+$/g, "")
		.replace(/[.!?:;]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!stripped || stripped.toLowerCase() === "untitled") return undefined;
	if (stripped.length <= MAX_TITLE_CHARS) return stripped;
	// A rambling answer still names better cut at a word than not at all.
	const cut = stripped.slice(0, MAX_TITLE_CHARS);
	return (cut.slice(0, cut.lastIndexOf(" ")) || cut).trim();
}

/** Assistant text out of a model response, "" when it produced none. */
function responseText(response: AssistantMessage | undefined): string {
	return (response?.content ?? [])
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** One small completion, text only. Streaming because `reasoning` is a provider-neutral option. */
async function askForName(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
	request: string,
	maxTokens: number,
	signal: AbortSignal,
): Promise<string> {
	const stream = ctx.modelRegistry.streamSimple(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: request }], timestamp: Date.now() }],
		},
		{ maxTokens, reasoning: "off", signal, cacheRetention: "none" },
	);
	for await (const _event of stream) {
		// Drained for its result; the events would only be partial text.
	}
	return responseText(await stream.result());
}

/**
 * Ask once, and once more with room if thinking swallowed the answer. `reasoning: "off"`
 * is honored by some providers and ignored by others, so the budget is what decides.
 */
async function askForTitle(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
	request: string,
	signal: AbortSignal,
): Promise<string> {
	const first = await askForName(ctx, model, request, MAX_TITLE_TOKENS, signal);
	if (signal.aborted || first.trim()) return first;
	log("first answer held no text, retrying with a larger budget");
	return askForName(ctx, model, request, RETRY_TITLE_TOKENS, signal);
}

export default function (pi: ExtensionAPI) {
	let modelSpec = process.env.PI_AUTOTITLE_MODEL?.trim() ?? "";
	let enabled = process.env.PI_AUTOTITLE?.trim().toLowerCase() !== "off";
	let turn: readonly Message[] | undefined;	// the first run's messages, kept for titling
	let attempted = false;					// one attempt per session: a stall is not retried
	let running = false;

	/** The model to title with: the pinned one when it resolves, else the session's own. */
	function titleModel(ctx: ExtensionContext) {
		if (modelSpec) {
			const [provider, ...rest] = modelSpec.split("/");
			const id = rest.join("/");
			const found = id ? ctx.modelRegistry.find(provider, id) : undefined;
			if (!found) {
				if (ctx.hasUI) ctx.ui.notify(`Autotitle: ${modelSpec} not found, using the session's model`, "warning");
				return ctx.model ?? undefined;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
				if (ctx.hasUI) ctx.ui.notify(`Autotitle: no auth for ${modelSpec}, using the session's model`, "warning");
				return ctx.model ?? undefined;
			}
			return found;
		}
		return ctx.model ?? undefined;
	}

	/**
	 * Ask for a name and store it when it arrives. The returned promise is only
	 * awaited when there is no UI to hold the process open; a failed call is silent.
	 */
	function titleInBackground(ctx: ExtensionContext, messages: readonly Message[]): Promise<void> | undefined {
		const prompt = firstUserText(messages);
		if (!prompt) return undefined;
		const model = titleModel(ctx);
		if (!model) return undefined;
		attempted = true;
		running = true;
		log(`asking ${model.provider}/${model.id}`);

		const timeoutMs = ctx.hasUI ? CALL_TIMEOUT_MS : HEADLESS_TIMEOUT_MS;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		const startedAt = Date.now();
		const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
		const request = `Request:\n${prompt.slice(0, MAX_PROMPT_CHARS)}\n\nFirst answer:\n${lastAssistantText(messages).slice(0, MAX_ANSWER_CHARS)}`;
		return askForTitle(ctx, model, request, controller.signal)
			.then((raw) => {
				if (controller.signal.aborted) return log(`call timed out after ${elapsed()}`);
				const title = sanitizeTitle(raw);
				// Someone may have named the session while this call was in flight.
				if (!title || pi.getSessionName()) return log(`no title from ${JSON.stringify(raw.slice(0, 60))}`);
				pi.setSessionName(title);
				if (ctx.hasUI) ctx.ui.notify(`Session named: ${title}`, "info");
				log(`named: ${title} in ${elapsed()}`);
			})
			.catch((error) => {
				// A failed title is not worth interrupting work over.
				log(`call failed: ${String(error).slice(0, 120)}`);
			})
			.finally(() => {
				clearTimeout(timeout);
				running = false;
			});
	}

	pi.on("agent_end", async (event) => {
		if (turn || attempted || !enabled) return;
		const messages = (event as { messages?: readonly Message[] }).messages ?? [];
		if (!firstUserText(messages)) return;
		turn = messages;
		log(`first run captured: ${messages.length} messages`);
	});

	// The run is final here, and Pi is idle, so the naming call costs nothing.
	pi.on("agent_settled", async (event, ctx) => {
		if (turn === undefined || attempted || !enabled) {
			if (enabled && turn === undefined) log("settled with no first run captured");
			return;
		}
		if ((event as { aborted?: boolean }).aborted && !lastAssistantText(turn)) return log("run aborted with no answer");
		if (pi.getSessionName()) {
			attempted = true;
			return log("already named, leaving it");
		}
		const work = titleInBackground(ctx, turn);
		if (!ctx.hasUI) await work;	// a headless host exits as soon as handlers return
	});

	pi.on("session_start", async () => {
		turn = undefined;
		attempted = false;
		if (pi.getSessionName()) attempted = true;	// `pi --name`, or a session resumed with a name
	});

	// A manual name outranks anything this extension would suggest.
	pi.on("session_info_changed", async () => {
		if (pi.getSessionName()) attempted = true;
	});

	pi.registerCommand("autotitle", {
		description: "Session titling: status, `on|off`, or `model <provider/id>`",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				ctx.ui.notify(`Autotitle ${enabled ? "on" : "off"}`, "info");
				return;
			}
			if (arg.startsWith("model")) {
				const spec = arg.slice(5).trim();
				if (!spec || !spec.includes("/")) {
					ctx.ui.notify("Usage: /autotitle model <provider/id>", "warning");
					return;
				}
				modelSpec = spec;
				attempted = false;
				ctx.ui.notify(`Autotitle model: ${spec}`, "info");
				return;
			}
			const model = titleModel(ctx);
			ctx.ui.notify(
				`Autotitle ${enabled ? "on" : "off"} · ${model ? `${model.provider}/${model.id}` : "no model"} · ` +
					`named: ${pi.getSessionName() ?? (running ? "naming\u2026" : "no")}`,
				"info",
			);
		},
	});
}
