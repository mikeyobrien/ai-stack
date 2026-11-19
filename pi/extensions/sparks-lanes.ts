/**
 * Sparks and strata lane meters.
 *
 * Footer statuses showing the requests running on each self-hosted server out of
 * its lane budget, plus that server's decode throughput, e.g.
 * `sparks ██░░ 2/4 · 75t/s` and `strata █░░░ 1/4 · 55t/s`. The numbers come from
 * the servers themselves — TensorFold's /metrics and /health, PolyStrata's
 * /metrics — so they cover every client on the GPU, not just this session.
 * Polls fast while a turn is in flight, slow when idle.
 *
 * Environment:
 *   PI_SPARKS_BASE_URL / PI_STRATA_BASE_URL  override the base URL read from models.json
 *   PI_SPARKS_LANES  / PI_STRATA_LANES       lane budget shown as the denominator
 *   PI_SPARKS_PROVIDER / PI_STRATA_PROVIDER  pi provider names read from models.json (defaults: sparks, reef-strata)
 *
 * `/sparks` and `/strata` toggle their meter; `/sparks lanes <n>` changes a denominator.
 *
 * Width-aware: pi puts every extension status on ONE footer row, sorted by key, joined with a
 * single space, and clips that row with a dim `...` at the terminal width. So each meter picks a
 * full / compact / minimal form from `process.stdout.columns` at paint time, and sizes itself to
 * its share of the row, so both meters survive a narrow terminal instead of `strata` being clipped.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPARKS_PROVIDER = "sparks";
const SPARKS_LABEL = "sparks";

const STRATA_PROVIDER = "reef-strata";
const STRATA_LABEL = "strata";

const DEFAULT_LANES = 4;
const IDLE_POLL_MS = 1000;
const ACTIVE_POLL_MS = 400;
const FETCH_TIMEOUT_MS = 1200;
const CONCEAL_AFTER_FAILURES = 4;

type Tone = "dim" | "muted" | "warning" | "error";

/** How much of a meter to draw. Chosen from the terminal width, never from the poll. */
export type MeterTier = "full" | "compact" | "minimal";

/** Full form once a meter's share is roomy: with both meters, from 122 columns up. */
const FULL_TIER_MIN_BUDGET = 54;
/** Two-letter labels once a share is barely a word and a count: with both meters, to 54 columns down. */
const SHORT_LABEL_MAX_BUDGET = 20;
/** Room pi's `...` clip and other extensions' statuses need on top of our meters. */
const ROW_HEADROOM = 12;
/** Fallback share when the terminal reports no width (piped output, tests). */
const UNKNOWN_WIDTH_BUDGET = 60;

/** What a server reports about itself in one round trip. `lanes` is its own batch budget, when it has one. */
export interface Live {
	running: number;
	waiting: number;
	decode?: number;
	lanes?: number;
}

/** Parse one Prometheus gauge, ignoring its `#` comment lines and labels. */
export function gaugeValue(metrics: string, name: string): number | undefined {
	const match = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\{[^\\n]*\\})?[ \\t]+(-?[0-9.eE+]+)$`, "m").exec(metrics);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : undefined;
}

/** Server-side decode throughput, smoothed so the footer does not flicker. */
export function smoothTps(previous: number, sample: number, running: number): number {
	if (running === 0) return 0;
	if (previous === 0) return sample < 1 ? 0 : sample;
	const next = previous + 0.5 * (sample - previous);
	return next < 0.5 ? 0 : next;
}

/** Server-side decode throughput, as reported for all live streams. */
export function tpsText(decodeTokensPerSecond: number): string {
	return `${Math.round(decodeTokensPerSecond)}t/s`;
}

/** Pick the form for one meter: full, compact, or minimal, from its share of the status row. */
export function pickTier(budget: number): MeterTier {
	if (budget >= FULL_TIER_MIN_BUDGET) return "full";
	if (budget > SHORT_LABEL_MAX_BUDGET) return "compact";
	return "minimal";
}

/** Footer text for one meter. Tone picks the theme color. */
export function meterText(state: {
	label: string;
	shortLabel?: string;
	running: number;
	waiting: number;
	own: number;
	lanes: number;
	decode: number;
	stale: boolean;
	tier?: MeterTier;
}): { text: string; tone: Tone } {
	const tier = state.tier ?? "full";
	const label = tier === "minimal" ? state.shortLabel ?? state.label : state.label;
	const parts = [label];

	if (tier === "full") {
		const filled = Math.min(Math.max(state.running, 0), state.lanes);
		parts.push("█".repeat(filled) + "░".repeat(Math.max(0, state.lanes - filled)));
	}
	parts.push(`${state.running}/${state.lanes}`);
	if (tier !== "minimal" && state.decode > 0) parts.push(tier === "full" ? `· ${tpsText(state.decode)}` : tpsText(state.decode));
	if (state.waiting > 0 && tier === "full") parts.push(`+${state.waiting}q`);
	else if (state.own > 0 && state.own < state.running && tier !== "minimal") parts.push(`(${state.own})`);

	if (state.stale) return { text: tier === "full" ? `${label} ⋯ ${state.running}/${state.lanes}` : `${label} ⋯`, tone: "dim" };
	if (state.waiting > 0 || state.running > state.lanes) return { text: parts.join(" "), tone: "error" };
	if (state.running >= state.lanes) return { text: parts.join(" "), tone: "warning" };
	if (state.running > 0) return { text: parts.join(" "), tone: "muted" };
	return { text: parts.join(" "), tone: "dim" };
}

function stripTail(url: string): string {
	return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function whole(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Base URL of a provider, taken from env or models.json so nothing is hardcoded. */
async function resolveBaseUrl(provider: string, env: string | undefined): Promise<string | undefined> {
	const override = env?.trim();
	if (override) return stripTail(override);
	try {
		const raw = await readFile(path.join(homedir(), ".pi", "agent", "models.json"), "utf8");
		const parsed = JSON.parse(raw) as { providers?: Record<string, { baseUrl?: string }> };
		const configured = parsed.providers?.[provider]?.baseUrl?.trim();
		if (configured) return stripTail(configured);
	} catch {
		// unconfigured on this host
	}
	return undefined;
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	return run(controller.signal).finally(() => clearTimeout(timeout));
}

/** TensorFold on the sparks pair: lane counts from /metrics, throughput from /health. */
export async function readTensorFold(url: string): Promise<Live> {
	return withTimeout(async (signal) => {
		const metrics = fetch(`${url}/metrics`, { signal, headers: { accept: "text/plain" } });
		const health = fetch(`${url}/health`, { signal, headers: { accept: "application/json" } });
		const response = await metrics;
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = await response.text();
		const running = gaugeValue(body, "tensorfold:requests_running") ?? gaugeValue(body, "tensorfold:num_requests_running");
		if (running === undefined) throw new Error("no running gauge");
		const waiting = gaugeValue(body, "tensorfold:requests_waiting") ?? gaugeValue(body, "tensorfold:num_requests_waiting") ?? 0;

		// Throughput is optional: keep the last reading if /health is unavailable.
		let decode: number | undefined;
		try {
			const res = await health;
			if (res.ok) {
				const live = (await res.json()) as { live?: { decode_tokens_per_second?: number } };
				decode = whole(live.live?.decode_tokens_per_second);
			}
		} catch {
			// ignore, /metrics carries the authoritative lane counts
		}
		return { running, waiting, decode };
	});
}

/** PolyStrata: one /metrics call carries the batch slots, the queue, and the decode rate. */
export async function readStrata(url: string): Promise<Live> {
	return withTimeout(async (signal) => {
		const response = await fetch(`${url}/metrics`, { signal, headers: { accept: "application/json" } });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const report = (await response.json()) as {
			live?: { state?: string; running?: number; parallel?: number; waiting?: number; queued?: number; tok_s?: number };
			engine?: { batch_slots?: number };
		};
		const live = report.live ?? {};
		// A strata server without batch slots set reports its one request through `state`, not `running`.
		const busy = live.state !== undefined && live.state !== "idle" && live.state !== "unloaded" ? 1 : 0;
		const running = live.running ?? busy;
		const waiting = live.waiting ?? live.queued ?? 0;
		return { running, waiting, decode: whole(live.tok_s), lanes: whole(live.parallel) ?? whole(report.engine?.batch_slots) };
	});
}

/**
 * One server's meter: its own polling loop, its own footer status, its own count of
 * this session's requests, so a dead server only conceals its own meter.
 */
class Meter {
	readonly key: string;
	readonly label: string;
	/** Two-letter form, used only when a meter's share of the status row gets tiny. */
	readonly shortLabel: string;
	readonly provider: string;
	readonly envUrl: string;
	readonly envLanes: string;
	/** Take the denominator from the server: a strata batch is a real budget; the sparks lane cap is not its max_batch_size. */
	readonly autoLanes: boolean;
	readonly read: (url: string) => Promise<Live>;

	baseUrl: string | undefined;
	lanes: number;
	/** An env var or `/… lanes <n>` has fixed the denominator, so the server's own budget no longer moves it. */
	lanesExplicit: boolean;
	visible = true;
	running = 0;
	waiting = 0;
	decode = 0;
	own = 0;
	failures = 0;
	activeTurn = false;
	private polling = false;
	private started = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ctx: ExtensionContext | undefined;

	constructor(spec: {
		key: string;
		label: string;
		shortLabel?: string;
		provider: string;
		envUrl: string;
		envLanes: string;
		autoLanes?: boolean;
		read: (url: string) => Promise<Live>;
	}) {
		this.key = spec.key;
		this.label = spec.label;
		this.shortLabel = spec.shortLabel ?? spec.label.slice(0, 2);
		this.provider = spec.provider;
		this.envUrl = spec.envUrl;
		this.envLanes = spec.envLanes;
		this.autoLanes = spec.autoLanes ?? false;
		this.read = spec.read;
		const configured = Number.parseInt(process.env[spec.envLanes] ?? "", 10);
		this.lanes = configured || DEFAULT_LANES;
		this.lanesExplicit = configured >= 1 && configured <= 64;
	}

	/** Remember the live UI, so a command or a model change can paint without a poll. */
	focus(next: ExtensionContext): void {
		this.ctx = next;
	}

	/** Point at the provider's server, as env or models.json names it. */
	start(next: ExtensionContext): void {
		this.ctx = next;
		if (this.started) return;
		this.started = true;
		void resolveBaseUrl(this.provider, process.env[this.envUrl]).then((url) => {
			this.baseUrl = url;
			if (url) this.refresh();
			else this.paint();
		});
	}

	stop(clear: boolean): void {
		this.started = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (clear) this.ctx?.ui.setStatus(this.key, undefined);
	}

	/** True when an event names this meter's provider. */
	covers(provider: string | undefined): boolean {
		return provider === this.provider;
	}

	/** Share of the footer status row this meter gets, in columns; undefined when width is unknown. */
	budget(): number | undefined {
		const columns = process.stdout.columns;
		if (!columns) return undefined;
		const drawn = Math.max(1, meters.filter((other) => other.shown()).length);
		return Math.max(6, Math.floor((columns - ROW_HEADROOM) / drawn) - 1);
	}

	/** Whether this meter currently claims a slot on the status row. */
	shown(): boolean {
		return Boolean(this.baseUrl) && this.visible && this.failures < CONCEAL_AFTER_FAILURES;
	}

	paint(): void {
		if (!this.ctx) return;
		if (!this.shown()) {
			this.ctx.ui.setStatus(this.key, undefined);
			return;
		}
		const { text, tone } = meterText({
			label: this.label,
			shortLabel: this.shortLabel,
			running: this.running,
			waiting: this.waiting,
			own: this.own,
			lanes: this.lanes,
			decode: this.decode,
			stale: this.failures > 0,
			tier: pickTier(this.budget() ?? UNKNOWN_WIDTH_BUDGET),
		});
		this.ctx.ui.setStatus(this.key, this.ctx.ui.theme.fg(tone, text));
	}

	private reschedule(): void {
		if (!this.started || this.timer) return;
		const busy = this.activeTurn || this.own > 0;
		const backoff = this.failures > 0 ? Math.min(this.failures, 4) : 1;
		const delay = (busy ? ACTIVE_POLL_MS : IDLE_POLL_MS) * backoff;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.poll();
		}, delay);
		this.timer.unref?.();
	}

	private async poll(): Promise<void> {
		if (!this.started || this.polling || !this.baseUrl) return;
		this.polling = true;
		try {
			const live = await this.read(this.baseUrl);
			this.running = live.running;
			this.waiting = live.waiting;
			this.decode = smoothTps(this.decode, live.decode ?? this.decode, this.running);
			if (this.autoLanes && !this.lanesExplicit && live.lanes !== undefined && live.lanes > 0) this.lanes = live.lanes;
			this.failures = 0;
		} catch {
			this.failures += 1;
		} finally {
			this.polling = false;
		}
		if (!this.started) return;
		this.paint();
		this.reschedule();
	}

	/** Repaint at the current width without disturbing the polling schedule. */
	repaint(): void {
		if (!this.started) return;
		this.paint();
	}

	refresh(): void {
		if (!this.started) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		void this.poll();
	}

	/** `/sparks on|off`, or a bare toggle. Returns whether the meter is now visible. */
	toggle(arg: string): boolean {
		if (arg === "on") this.visible = true;
		else if (arg === "off") this.visible = false;
		else this.visible = !this.visible;
		this.paint();
		this.refresh();
		return this.visible;
	}

	/** `/sparks lanes <n>`, which outranks the server's own budget for good. */
	setLanes(arg: string): boolean {
		const parsed = Number.parseInt(arg.slice(5).trim(), 10);
		if (parsed >= 1 && parsed <= 64) {
			this.lanes = parsed;
			this.lanesExplicit = true;
			this.paint();
			this.refresh();
			return true;
		}
		return false;
	}
}

/** Exported so a test harness can drive the real paint path. */
export const meters: Meter[] = [
	new Meter({
		key: SPARKS_LABEL,
		label: SPARKS_LABEL,
		shortLabel: "sp",
		provider: process.env.PI_SPARKS_PROVIDER?.trim() || SPARKS_PROVIDER,
		envUrl: "PI_SPARKS_BASE_URL",
		envLanes: "PI_SPARKS_LANES",
		read: readTensorFold,
	}),
	new Meter({
		key: STRATA_LABEL,
		label: STRATA_LABEL,
		shortLabel: "st",
		provider: process.env.PI_STRATA_PROVIDER?.trim() || STRATA_PROVIDER,
		envUrl: "PI_STRATA_BASE_URL",
		envLanes: "PI_STRATA_LANES",
		autoLanes: true,
		read: readStrata,
	}),
];

// pi re-renders the footer when the terminal resizes, but it hands the existing status strings
// straight back to it and fires no extension event. Re-paint on the resize ourselves; polling is
// untouched, so a missed event still self-corrects on the next tick.
{
	let pending: ReturnType<typeof setTimeout> | undefined;
	process.stdout.on?.("resize", () => {
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = undefined;
			for (const meter of meters) meter.repaint();
		}, 50);
		pending.unref?.();
	});
}

export default function (pi: ExtensionAPI) {
	// `/sparks` and `/strata`: toggle that meter, or set its denominator.
	for (const meter of meters) {
		pi.registerCommand(meter.key, {
			description: "Lane meter: toggle, or `lanes <n>` to set the denominator",
			handler: async (args, next) => {
				meter.focus(next);
				const arg = args.trim().toLowerCase();
				if (arg.startsWith("lanes")) {
					if (!meter.setLanes(arg)) next.ui.notify(`Usage: /${meter.key} lanes <1-64>`, "warning");
				} else meter.toggle(arg);
			},
		});
	}

	pi.on("session_start", async (_event, next) => {
		for (const meter of meters) meter.start(next);
	});
	pi.on("session_shutdown", async () => {
		for (const meter of meters) meter.stop(true);
	});

	pi.on("turn_start", async () => {
		for (const meter of meters) {
			meter.activeTurn = true;
			meter.refresh();
		}
	});
	pi.on("turn_end", async () => {
		for (const meter of meters) {
			meter.own = 0;
			meter.activeTurn = false;
			meter.refresh();
		}
	});
	pi.on("agent_settled", async () => {
		for (const meter of meters) {
			meter.activeTurn = false;
			meter.refresh();
		}
	});

	// Instant 0→1 and 1→0 transitions for this session; polling covers other clients.
	pi.on("before_provider_request", async (_event, next) => {
		for (const meter of meters) {
			if (!meter.covers(next.model?.provider)) continue;
			meter.own += 1;
			meter.refresh();
		}
	});
	pi.on("message_end", async (event, next) => {
		if (event.message.role !== "assistant") return;
		for (const meter of meters) {
			if (!meter.covers(next.model?.provider)) continue;
			meter.own = Math.max(0, meter.own - 1);
			meter.refresh();
		}
	});

	pi.on("model_select", async (_event, next) => {
		for (const meter of meters) {
			meter.focus(next);
			meter.paint();
		}
	});
}
