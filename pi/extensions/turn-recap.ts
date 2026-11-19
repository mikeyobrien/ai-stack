/**
 * Quoted turn recap, extracted from pi-claude-code 1.8.0 (MIT, © 2026 minuque and
 * 111222333huantong) without the rest of that package — notably its `write` override,
 * which conflicted with pi-tidy-tools.
 *
 * After an agent run with at least two tool calls, appends a display-only session entry:
 *   │ Ran 4 commands, read 4 files, 1 failed · 31.9s · 47.2 tok/s · TTFT 2.7s · done 11/19 9:08 AM
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "agent-summary"; // same type as pi-claude-code, so old entries still render

type RecapData = {
	commands: number;
	reads: number;
	edits: number;
	others: number;
	failed: number;
	durationMs: number;
	endedAt?: number;
	outputTokens?: number;
	ttftMs?: number;
};

type Theme = {
	fg(color: string, text: string): string;
	italic(text: string): string;
	getFgAnsi(color: string): string;
};

const plural = (n: number) => (n === 1 ? "" : "s");

function parts(d: RecapData): { text: string; failed: boolean }[] {
	const out: string[] = [];
	if (d.commands) out.push(`ran ${d.commands} command${plural(d.commands)}`);
	if (d.reads) out.push(`read ${d.reads} file${plural(d.reads)}`);
	if (d.edits) out.push(`edited ${d.edits} file${plural(d.edits)}`);
	if (d.others) out.push(`${d.others} other tool${plural(d.others)}`);
	if (d.failed) out.push(`${d.failed} failed`);
	return out.map((text, i) => ({
		text: i === 0 && /^[a-z]/.test(text) ? text[0].toUpperCase() + text.slice(1) : text,
		failed: text.endsWith("failed"),
	}));
}

function seconds(ms: number): string {
	const total = ms / 1000;
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = (total - h * 3600 - m * 60).toFixed(1);
	return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

function clock(ms: number): string {
	const d = new Date(ms);
	const hour = d.getHours() % 12 || 12;
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${d.getMonth() + 1}/${d.getDate()} ${hour}:${min} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

function tail(d: RecapData): string {
	const tokens = d.outputTokens ?? 0;
	const rate = tokens > 0 && d.durationMs >= 1000 ? tokens / (d.durationMs / 1000) : 0;
	const segs = [rate >= 0.05 ? `${seconds(d.durationMs)} · ${rate.toFixed(1)} tok/s` : seconds(d.durationMs)];
	if (d.ttftMs && d.ttftMs > 0) {
		segs.push(`TTFT ${d.ttftMs < 1000 ? `${Math.round(d.ttftMs)}ms` : `${(d.ttftMs / 1000).toFixed(1)}s`}`);
	}
	if (d.endedAt && d.endedAt > 0) segs.push(`done ${clock(d.endedAt)}`);
	return segs.join(" · ");
}

function prefixOf(style: (t: string) => string): string {
	const styled = style("\u0000");
	const i = styled.indexOf("\u0000");
	return i >= 0 ? styled.slice(0, i) : "";
}

class RecapLine {
	private readonly body: string;
	private readonly border: string;

	constructor(d: RecapData, theme: Theme) {
		this.border = theme.fg("mdQuoteBorder", "│");
		const quote = (t: string) => theme.italic(theme.fg("mdQuote", t));
		const counts = parts(d)
			.map(({ text, failed }) => {
				const ansi = theme.getFgAnsi(failed ? "error" : "success");
				return ansi ? text.replace(/(\d+)/, `${ansi}$1\x1b[0m`) : text;
			})
			.join(", ");
		const prefix = prefixOf(quote);
		const text = `${counts} · ${tail(d)}`;
		this.body = quote(prefix ? text.replace(/\x1b\[0m/g, `\x1b[0m${prefix}`) : text);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return wrapTextWithAnsi(this.body, Math.max(1, width - 4)).map((l) => ` ${this.border} ${l}`);
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const d = entry.data as RecapData;
		if (!d || parts(d).length === 0) return undefined;
		return new RecapLine(d, theme as unknown as Theme);
	});

	let startedAt = 0;
	let firstTokenAt = 0;
	let tools = 0;
	let commands = 0;
	let others = 0;
	let failed = 0;
	let outputTokens = 0;
	let reads = new Set<string>();
	let edits = new Set<string>();

	pi.on("before_agent_start", async () => {
		startedAt = Date.now();
		firstTokenAt = 0;
		tools = commands = others = failed = outputTokens = 0;
		reads = new Set();
		edits = new Set();
	});

	pi.on("message_update", async (event) => {
		const type = (event as any)?.assistantMessageEvent?.type;
		if (!firstTokenAt && (type === "text_start" || type === "thinking_start" || type === "toolcall_start")) {
			firstTokenAt = Date.now();
		}
	});

	pi.on("tool_execution_start", async (event) => {
		tools++;
		const name = event.toolName.split(".").pop() ?? event.toolName;
		const args = event.args as Record<string, unknown> | undefined;
		const path = args?.path ?? args?.file_path;
		const file = typeof path === "string" && path ? path : undefined;
		if (name === "bash" || name === "powershell") commands++;
		else if (name === "read") file && reads.add(file);
		else if (name === "edit" || name === "write") file && edits.add(file);
		else others++;
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.isError) failed++;
	});

	pi.on("agent_end", async (event) => {
		for (const m of ((event as any)?.messages ?? []) as any[]) {
			const out = Number(m?.role === "assistant" ? m.usage?.output : 0);
			if (Number.isFinite(out) && out > 0) outputTokens += Math.round(out);
		}
	});

	pi.on("agent_settled", async () => {
		if (tools < 2 || !startedAt) return;
		const now = Date.now();
		const data: RecapData = {
			commands,
			reads: reads.size,
			edits: edits.size,
			others,
			failed,
			durationMs: now - startedAt,
			endedAt: now,
			outputTokens,
		};
		if (firstTokenAt > startedAt) data.ttftMs = firstTokenAt - startedAt;
		pi.appendEntry(ENTRY_TYPE, data);
	});
}
