/**
 * Sparks deployments — the Host half, sourced from Prometheus.
 *
 * sparkDash shows the Sparks as hosts; Prometheus is where their model serving
 * actually lands: `local-llm` (vLLM on reef, model `qwen3.8-27b`), the GPU
 * series DCGM exports for it, and the alerts those targets fire. This plugin
 * reads that Prometheus and reduces it to one row per model-serving deployment,
 * plus the alerts that name them.
 *
 * Prometheus is a ClusterIP service inside reef's k3s (`10.43.152.17:9090`), so
 * the Host reaches it through a private SSH tunnel to reef — no listener on
 * reef's network, nothing exposed to the tailnet. One operation set serves both
 * callers: the Sparks page reads the `sparks` Remote namespace, and the
 * `sparks_deployments` tool calls the same monitor, so they cannot disagree.
 *
 * @module @local/dsh-local-llm-dashboards
 */

import { execFile } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

/** Cordis plugin name. */
export const name = 'sparks';

/** Remote namespace the Client page calls. */
export const NAMESPACE = 'sparks';

/** Prototype key the Typert Gateway reads to discover Remote methods. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** Hosts on this machine's tailnet: a deployment there is local to it. */
const LOCAL_HOSTS = new Set((process.env.DSH_LOCAL_HOSTS ?? 'reef,spark-1,spark-2')
	.split(',')
	.map((host) => host.trim().split('.')[0])
	.filter(Boolean));

/** Serving hosts that are not local, when a deployment names one. */
const REMOTE_HOSTS = new Set((process.env.DSH_REMOTE_HOSTS ?? '')
	.split(',')
	.map((host) => host.trim().split('.')[0])
	.filter(Boolean));

/** Prometheus's own service address inside reef's cluster; only reachable from reef. */
export const PROMETHEUS_TARGET = '10.43.152.17:9090';

/** Deployment states, worst first, used to rank a fleet. */
const SEVERITY = ['down', 'degraded', 'busy', 'idle'];

/** A firing alert this close to now is recent; older ones are history. */
const RECENT_ALERT_MS = 10 * 60_000;

/**
 * A monitor that could not be read. Distinct from a deployment that is down:
 * the first is unknown, the second is a known-bad state.
 */
export class MonitorUnavailable extends Error {
	/**
	 * @param {string} message - what failed, in user-facing words.
	 * @param {{ cause?: unknown }} [options] - the underlying failure.
	 */
	constructor(message, options) {
		super(message, options);
		this.name = 'MonitorUnavailable';
	}
}

/**
 * One SSH `-L` tunnel to reef, opened lazily and kept open while the plugin
 * lives.
 *
 * The tunnel listens on a loopback port picked by the OS, so two Harness
 * processes never collide and nothing is exposed beyond `127.0.0.1`. The child
 * is killed on dispose; a failed start clears the cached promise so the next
 * read retries instead of reusing the failure.
 */
export class SshTunnel {
	/** SSH destination as `user@host`. */
	#destination;
	/** Remote address the tunnel forwards to. */
	#target;
	/** Local origin, once open. */
	#baseUrl;
	/** In-flight open, shared by concurrent readers. */
	#opening;
	/** The ssh child process. */
	#child;

	/**
	 * @param {string} destination - SSH destination, e.g. `mobrienv@reef`.
	 * @param {string} target - remote `host:port` the tunnel forwards to.
	 */
	constructor(destination, target = PROMETHEUS_TARGET) {
		this.#destination = destination;
		this.#target = target;
	}

	/** The local origin once the tunnel is open. */
	get baseUrl() {
		return this.#baseUrl;
	}

	/**
	 * Open the tunnel if it is not open, and return the local origin.
	 * @returns {Promise<string>} the local origin, e.g. `http://127.0.0.1:51234`.
	 */
	async open() {
		if (this.#baseUrl !== undefined && this.#child !== undefined) return this.#baseUrl;
		this.#opening ??= this.#start().catch((error) => {
			this.#opening = undefined;
			throw error;
		});
		return this.#opening;
	}

	/** Start ssh and wait until the forwarded port accepts a connection. */
	async #start() {
		const port = await freePort();
		const child = execFile('ssh', [
			'-F', '/dev/null',
			'-o', 'BatchMode=yes',
			'-o', 'ExitOnForwardFailure=yes',
			'-o', 'ServerAliveInterval=15',
			'-N',
			'-L', `127.0.0.1:${port}:${this.#target}`,
			this.#destination,
		], { timeout: 0 });
		child.on('exit', () => {
			if (this.#child !== child) return;
			this.#child = undefined;
			this.#baseUrl = undefined;
			this.#opening = undefined;
		});
		child.on('error', () => {});
		await waitForPort(port, 5000);
		this.#child = child;
		this.#baseUrl = `http://127.0.0.1:${port}`;
		return this.#baseUrl;
	}

	/** Close the tunnel, if open. */
	close() {
		const child = this.#child;
		this.#child = undefined;
		this.#baseUrl = undefined;
		this.#opening = undefined;
		child?.kill('SIGTERM');
	}
}

/** Ask the OS for a free loopback port. */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/**
 * Wait until a loopback port accepts connections, or fail.
 * @param {number} port - local port to probe.
 * @param {number} timeoutMs - how long to keep trying.
 */
async function waitForPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await portOpen(port)) return;
		if (Date.now() > deadline) throw new MonitorUnavailable(`the SSH tunnel to 127.0.0.1:${port} did not open`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Whether one loopback port accepts a connection right now. */
function portOpen(port) {
	return new Promise((resolve) => {
		const socket = createConnection({ host: '127.0.0.1', port });
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => { resolve(false); });
	});
}

/** One decimal place, for percentages and temperatures. */
function round1(value) {
	return Math.round(value * 10) / 10;
}

/**
 * Serving metric families this plugin reads.
 *
 * reef runs vLLM, which publishes `vllm:` counters; the DGX Sparks run
 * TensorFold, which publishes the same requests, tokens and cache numbers under
 * its own `tensorfold:` prefix. Reading both is what lets one page cover both
 * kinds of deployment.
 */
export const FAMILIES = ['vllm', 'tensorfold'];

/** Per-family counter names, before the family prefix. */
const SERIES = {
	running: 'num_requests_running',
	waiting: 'num_requests_waiting',
	generationTokens: 'generation_tokens_total',
	promptTokens: 'prompt_tokens_total',
	kvCache: 'kv_cache_usage_perc',
	specDraftTokens: 'spec_decode_num_draft_tokens_total',
	specAccepted: 'spec_decode_num_accepted_tokens_total',
};

/**
 * TensorFold spellings that differ from the shared names, keyed by SERIES key.
 * TensorFold's 1.1 exporter renamed its request gauges, cache gauge and
 * speculative-decoding counters (`num_requests_running` → `requests_running`,
 * `kv_cache_usage_perc` → `kv_cache_usage_ratio`, `spec_decode_*` → `mtp_*`)
 * and dropped the per-phase time sums. Every key absent here uses SERIES.
 */
const FAMILY_METRIC = {
	tensorfold: {
		running: 'requests_running',
		waiting: 'requests_waiting',
		kvCache: 'kv_cache_usage_ratio',
		specDraftTokens: 'mtp_drafted_total',
		specAccepted: 'mtp_accepted_total',
	},
};

/** Per-phase work-time series, named aside from the value counters. */
const TIME_SERIES = {
	decodeWork: 'request_decode_time_seconds_sum',
	prefillWork: 'request_prefill_time_seconds_sum',
};

/**
 * The PromQL this plugin asks Prometheus.
 *
 * Each entry answers one question the page asks. They are exported so a test
 * can run them against a live Prometheus, and a person can paste one into
 * Prometheus to check the page is telling the truth.
 */
export const QUERIES = {
	// DCGM 4 labels the host `hostname`; the older exporter in the cluster uses
	// `Hostname`. Both are grouped and read, so one exporter version does not
	// silently blank the GPU facts.
	gpuUtil: 'max by (Hostname, hostname, device, model) (DCGM_FI_DEV_GPU_UTIL)',
	gpuTemp: 'max by (Hostname, hostname, device, model) (DCGM_FI_DEV_GPU_TEMP)',
	gpuPower: 'sum by (Hostname, hostname, model) (DCGM_FI_DEV_POWER_USAGE)',
	gpuXid: 'sum by (Hostname, hostname, model) (DCGM_FI_DEV_XID_ERRORS)',
	// A GB10 throttles on its CPU/ACPI zones before the GPU, so those belong on
	// the same row as the GPU temperature.
	cpuTemp: 'max by (host) (node_thermal_zone_temp)',
	up: 'up{job=~"local-llm|sparks-serving|dcgm-exporter|open-webui"}',
	alerts: 'ALERTS{alertstate="firing"}',
};
for (const family of FAMILIES) {
	const metricOf = (key) => FAMILY_METRIC[family]?.[key] ?? TIME_SERIES[key] ?? SERIES[key];
	for (const key of Object.keys(SERIES)) {
		QUERIES[`${key}.${family}`] = `sum by (job) (${family}:${metricOf(key)})`;
	}
	// Throughput is a rate, not a total: one minute covers four scrapes, so it
	// tracks the current serving rate instead of the whole process lifetime.
	QUERIES[`decode.${family}`] = `sum by (job) (rate(${family}:${metricOf('generationTokens')}[1m]))`;
	QUERIES[`prefill.${family}`] = `sum by (job) (rate(${family}:${metricOf('promptTokens')}[1m]))`;
	// Time actually spent decoding and prefilling. Throughput is tokens over
	// those seconds, so an idle gap lowers no number: it just means no samples.
	QUERIES[`decodeWork.${family}`] = `sum by (job) (rate(${family}:${metricOf('decodeWork')}[1m]))`;
	QUERIES[`prefillWork.${family}`] = `sum by (job) (rate(${family}:${metricOf('prefillWork')}[1m]))`;
	// A cached prefix is not prefill work, so vLLM's cached share is subtracted.
	QUERIES['prefillCached.vllm'] = 'sum by (job) (rate(vllm:prompt_tokens_cached_total[1m]))';
	// `model_name` is the engine's own label (vLLM); `model` is the label the
	// scrape config adds for a target that does not name its model.
	QUERIES[`serving.${family}`] = `count by (job, model_name, model, host) (${family}:${metricOf('running')})`;
}
// TensorFold 1.1 has no per-phase time series; time after the first token is
// decode by construction, so e2e latency minus time-to-first-token stands in.
QUERIES['decodeWork.tensorfold'] = 'sum by (job) (clamp_min(rate(tensorfold:request_latency_seconds_sum[1m]) - rate(tensorfold:time_to_first_token_seconds_sum[1m]), 0))';

/** One hour of trends, with the same units and work-time rates as the cards. */
export const HISTORY_QUERIES = {
	decode: FAMILIES.map((family) => `(${QUERIES[`decode.${family}`]} / (${QUERIES[`decodeWork.${family}`]} > 0))`).join(' or '),
	prefill: FAMILIES.map((family) => {
		// Full prompts include cached prefixes. Without their count, actual
		// prefill throughput is unknown, not full-prompt tokens / compute time.
		const cached = QUERIES[`prefillCached.${family}`];
		if (cached === undefined) return null;
		const tokens = `clamp_min((${QUERIES[`prefill.${family}`]}) - (${cached}), 0)`;
		return `((${tokens}) / (${QUERIES[`prefillWork.${family}`]} > 0))`;
	}).filter(Boolean).join(' or '),
	gpuTemp: 'max by (Hostname, hostname, model) (DCGM_FI_DEV_GPU_TEMP)',
	gpuUtil: 'max by (Hostname, hostname, model) (DCGM_FI_DEV_GPU_UTIL)',
};

/**
 * Reduce Prometheus answers to the deployment rows the page shows.
 *
 * One row per serving job across both metric families: the model name comes
 * from the series that carries it, GPU facts are attached only to the host they
 * describe, and `up` decides whether the target answers at all. A job whose
 * target is not up is `down`; a job with firing alerts naming it is `degraded`;
 * a job with requests in flight is `busy`.
 * @param {Record<string, any>} answers - query name → instant-vector payload.
 * @param {number} [now] - the instant to judge alert recency at.
 * @returns {{ deployments: Record<string, any>[], conditions: Record<string, any>[] }}
 */
export function summarizePrometheus(answers, now = Date.now()) {
	const alerts = (answers.alerts?.data?.result ?? []).map((sample) => ({
		alertname: sample.metric.alertname,
		severity: sample.metric.severity ?? 'warning',
		job: sample.metric.job ?? null,
		instance: sample.metric.instance ?? null,
		pod: sample.metric.pod ?? null,
		state: sample.metric.alertstate ?? 'firing',
		ts: Number(sample.value?.[0]) * 1000,
	}));
	const upByJob = new Map();
	for (const sample of answers.up?.data?.result ?? []) {
		const job = sample.metric.job;
		const value = Number(sample.value?.[1]);
		upByJob.set(job, (upByJob.get(job) ?? true) && value === 1);
	}
	/** Sum one counter across every family, per job. */
	const byJob = (key) => {
		const map = new Map();
		for (const family of FAMILIES) {
			for (const sample of answers[`${key}.${family}`]?.data?.result ?? []) {
				const job = sample.metric.job;
				const value = Number(sample.value?.[1]);
				if (job === undefined || !Number.isFinite(value)) continue;
				map.set(job, (map.get(job) ?? 0) + value);
			}
		}
		return map;
	};
	const running = byJob('running');
	const waiting = byJob('waiting');
	const generationTokens = byJob('generationTokens');
	const promptTokens = byJob('promptTokens');
	const kvCache = byJob('kvCache');
	const draftTokens = byJob('specDraftTokens');
	const accepted = byJob('specAccepted');
	const decodeRate = byJob('decode');
	const prefillRate = byJob('prefill');
	const prefillCached = byJob('prefillCached');
	const decodeWork = byJob('decodeWork');
	const prefillWork = byJob('prefillWork');

	/** The host a DCGM or node sample describes, under either label spelling. */
	const hostOf = (metric) => metric.Hostname ?? metric.hostname ?? metric.host ?? null;
	/** Sum one series per label value (power, Xid, thermal zones). */
	const sumBy = (query, label) => {
		const map = new Map();
		for (const sample of answers[query]?.data?.result ?? []) {
			const key = sample.metric[label];
			const value = Number(sample.value?.[1]);
			if (key === undefined || !Number.isFinite(value)) continue;
			map.set(key, (map.get(key) ?? 0) + value);
		}
		return map;
	};
	const powerByHost = new Map([...sumBy('gpuPower', 'Hostname'), ...sumBy('gpuPower', 'hostname')]);
	const xidByHost = new Map([...sumBy('gpuXid', 'Hostname'), ...sumBy('gpuXid', 'hostname')]);
	/** The hottest sample per label value: temperatures add up to nothing. */
	const maxBy = (query, label) => {
		const map = new Map();
		for (const sample of answers[query]?.data?.result ?? []) {
			const key = sample.metric[label];
			const value = Number(sample.value?.[1]);
			if (key === undefined || !Number.isFinite(value)) continue;
			map.set(key, Math.max(map.get(key) ?? -Infinity, value));
		}
		return map;
	};
	const temperatureByHost = maxBy('gpuTemp', 'hostname');
	for (const [host, value] of maxBy('gpuTemp', 'Hostname')) {
		temperatureByHost.set(host, Math.max(temperatureByHost.get(host) ?? -Infinity, value));
	}
	// One row per GPU, then two views over them: by host (for a deployment that
	// names its host) and by model (for one model served across several hosts,
// as a TP pair).
	const usageSamples = answers.gpuUtil?.data?.result ?? [];
	const gpuByHost = new Map();
	for (const sample of usageSamples) {
		const host = hostOf(sample.metric);
		const usage = Number(sample.value?.[1]);
		if (host === null || !Number.isFinite(usage)) continue;
		const entry = gpuByHost.get(host) ?? { host, model: sample.metric.model ?? null, job: sample.metric.job ?? null, devices: 0, usage: null, temperature: null, power: powerByHost.get(host) ?? null, xid: xidByHost.get(host) ?? 0 };
		entry.devices += 1;
		entry.usage = entry.usage === null ? usage : Math.max(entry.usage, usage);
		const temperature = temperatureByHost.get(host);
		if (entry.temperature === null && temperature !== undefined) entry.temperature = temperature;
		gpuByHost.set(host, entry);
	}
	const gpuByModel = new Map();
	for (const entry of gpuByHost.values()) {
		if (entry.model === null) continue;
		const combined = gpuByModel.get(entry.model) ?? { host: entry.host, model: entry.model, job: entry.job, devices: 0, usage: null, temperature: null, power: null, xid: 0 };
		combined.devices += entry.devices;
		combined.usage = combined.usage === null ? entry.usage : Math.max(combined.usage, entry.usage ?? 0);
		combined.temperature = combined.temperature === null ? entry.temperature : Math.max(combined.temperature, entry.temperature ?? 0);
		combined.power = (combined.power ?? 0) + (entry.power ?? 0);
		combined.xid += entry.xid;
		gpuByModel.set(entry.model, combined);
	}
	const cpuTempByHost = sumBy('cpuTemp', 'host');
	/**
	 * Pick the GPU facts for one deployment: the model's own GPUs first (a TP
	 * pair), then the host it names, then the one monitored host no other
	 * deployment claims (the cluster's own vLLM exporter).
	 */
	const claimedHosts = new Set();
	const gpuFor = (info) => {
		if (info.model !== null) {
			const byModel = gpuByModel.get(info.model);
			if (byModel !== undefined) {
				claimedHosts.add(byModel.host);
				return byModel;
			}
		}
		if (info.host !== null) {
			claimedHosts.add(info.host);
			return gpuByHost.get(info.host) ?? null;
		}
		// Nothing names this deployment's GPUs. The exporter running inside the
		// cluster is the one that belongs to it; otherwise only an unambiguous
		// single candidate is safe to claim.
		const unclaimed = [...gpuByHost.values()].filter((entry) => !claimedHosts.has(entry.host));
		const local = unclaimed.find((entry) => entry.job === 'dcgm-exporter');
		if (local !== undefined) return local;
		return unclaimed.length === 1 ? unclaimed[0] : null;
	};

	/** job → { model, backend, host } discovered from each family's series. */
	const found = new Map();
	// The serving series carries the host each engine runs on, so a deployment
	// is local exactly when that host is a machine on this tailnet rather than
	// a serving cluster. A host the plugin has no opinion about stays untagged
	// instead of being guessed either way.
	const hostTag = (host) => {
		if (host === null) return null;
		const label = host.split('.')[0];
		if (LOCAL_HOSTS.has(label)) return 'local';
		if (REMOTE_HOSTS.has(label)) return 'remote';
		return null;
	};
	for (const family of FAMILIES) {
		for (const sample of answers[`serving.${family}`]?.data?.result ?? []) {
			const job = sample.metric.job;
			if (job === undefined) continue;
			found.set(job, {
				model: sample.metric.model_name ?? sample.metric.model ?? null,
				backend: family,
				host: sample.metric.host ?? null,
			});
		}
	}
	const deployments = [...found.entries()].map(([job, info]) => {
		const gpu = gpuFor(info);
		const jobAlerts = alerts.filter((alert) => alert.job === job && now - alert.ts <= RECENT_ALERT_MS);
		const answering = upByJob.get(job) ?? true;
		const requestsRunning = running.get(job) ?? 0;
		const requestsWaiting = waiting.get(job) ?? 0;
		let state = 'idle';
		let reason = null;
		if (!answering) {
			state = 'down';
			reason = 'target not answering';
		} else if (jobAlerts.length > 0) {
			state = 'degraded';
			reason = jobAlerts[0].alertname;
		} else if (requestsRunning > 0 || requestsWaiting > 0 || (decodeWork.get(job) ?? 0) > 0) {
			// Decoding in the last window counts as serving too: a row that shows a
			// decode rate cannot also read Idle.
			state = 'busy';
			reason = info.model;
		} else if ((gpu?.xid ?? 0) > 0) {
			state = 'degraded';
			reason = `${gpu.xid} Xid`;
		}
		const drafted = draftTokens.get(job) ?? 0;
		// Throughput is tokens over the seconds actually spent working, so time an
		// idle engine spent waiting never dilutes the number. No work in the
		// window means no rate to report, not zero tokens per second.
		const decodeSeconds = decodeWork.get(job) ?? 0;
		const prefillSeconds = prefillWork.get(job) ?? 0;
		const prefillTokens = prefillRate.has(job) && prefillCached.has(job)
			? Math.max(prefillRate.get(job) - prefillCached.get(job), 0) : null;
		const perSecond = (tokens, seconds) => (seconds > 0 ? Math.round((tokens / seconds) * 10) / 10 : null);
		return {
			id: job,
			name: info.model ?? job,
			kind: 'serving',
			role: info.backend,
			// `local` for a model served on a machine here, `remote` for one
			// served in a cluster; null when the host is unknown.
			tag: hostTag(info.host ?? gpu?.host ?? null),
			online: answering,
			state,
			reason,
			instance: null,
			uptimeSeconds: null,
			gpu: {
				usagePercent: gpu?.usage ?? null,
				temperatureC: gpu?.temperature ?? null,
				powerW: gpu?.power === null || gpu?.power === undefined ? null : round1(gpu.power),
				devices: gpu?.devices ?? 0,
				host: info.host ?? gpu?.host ?? null,
			},
			cpu: {
				temperatureC: cpuTempByHost.get(info.host ?? gpu?.host ?? '') ?? null,
			},
			memory: { usedMB: null, totalMB: null, percent: kvCache.has(job) ? Math.round(kvCache.get(job) * 1000) / 10 : null, oomRisk: null },
			storage: null,
			serving: {
				port: null,
				backend: info.backend,
				modelId: info.model,
				available: answering,
				requestsRunning,
				requestsWaiting,
				generationTps: null,
				specAcceptance: drafted > 0 ? accepted.get(job) / drafted : null,
				// Tokens per second of decoding/prefilling, so idle time in the
				// window lowers nothing. Prefill also requires a known cache count.
				decodeTps: perSecond(decodeRate.get(job) ?? 0, decodeSeconds),
				prefillTps: prefillTokens === null ? null : perSecond(prefillTokens, prefillSeconds),
				contextLength: null,
				promptTokens: promptTokens.get(job) ?? null,
				completionTokens: generationTokens.get(job) ?? null,
				posture: null,
			},
			alerts: jobAlerts.map((alert) => alert.alertname),
		};
	});
	const conditions = alerts
		.filter((alert) => alert.job !== null && found.has(alert.job) && now - alert.ts <= RECENT_ALERT_MS)
		.map((alert) => ({
			id: `${alert.alertname}:${alert.job}`,
			ts: alert.ts,
			type: alert.alertname,
			severity: alert.severity,
			sparkId: alert.job,
			sparkName: found.get(alert.job).model ?? alert.job,
			message: `${alert.alertname} · ${alert.job}`,
		}));
	return { deployments, conditions };
}

/**
 * Pull one deployment's trend lines out of the history matrices.
 *
 * Values are normalised to what the row shows: decode and prefill in tokens per
 * second, GPU temperature in °C, GPU utilisation in percent.
 * @param {Record<string, any>} deployment - one summarized deployment.
 * @param {Record<string, any>} history - history query name → matrix payload.
 * @returns {Record<string, { t: number, v: number }[]>} one series per trend.
 */
export function seriesFor(deployment, history) {
	const pick = (name, match) => {
		const points = new Map();
		for (const series of (history[name]?.data?.result ?? []).filter(match)) {
			for (const [seconds, raw] of series.values ?? []) {
				const t = Math.round(Number(seconds) * 1000);
				const v = Number(raw);
				if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
				points.set(t, Math.max(points.get(t) ?? -Infinity, Math.round(v * 100) / 100));
			}
		}
		return [...points].sort(([a], [b]) => a - b).map(([t, v]) => ({ t, v }));
	};
	const byJob = (metric) => (sample) => sample.metric.job === metric;
	const host = deployment.gpu?.host;
	const byHost = (sample) => sample.metric.model === deployment.name
		|| (sample.metric.Hostname ?? sample.metric.hostname) === host;
	const out = {
		decode: pick('decode', byJob(deployment.id)),
		prefill: pick('prefill', byJob(deployment.id)),
	};
	if (host !== null && host !== undefined) {
		out.gpuTemp = pick('gpuTemp', byHost);
		out.gpuUtil = pick('gpuUtil', byHost);
	}
	return out;
}

/**
 * Rank a fleet: the worst state present, so a badge shows a problem rather
 * than an average that hides one.
 * @param {Record<string, any>[]} deployments - summarized deployments.
 * @returns {string} one of the {@link SEVERITY} states.
 */
export function fleetState(deployments) {
	const states = new Set(deployments.map((deployment) => deployment.state));
	return SEVERITY.find((state) => states.has(state)) ?? 'idle';
}

/** Format tokens as a short count: 1.2M, 461.2B. */
export function formatTokens(value) {
	if (!Number.isFinite(value) || value <= 0) return '0';
	const units = ['', 'K', 'M', 'B', 'T'];
	let unit = 0;
	let scaled = value;
	while (scaled >= 1000 && unit < units.length - 1) {
		scaled /= 1000;
		unit += 1;
	}
	return `${scaled >= 100 ? Math.round(scaled) : round1(scaled)}${units[unit]}`;
}

/**
 * Read-only view of the model-serving fleet through Prometheus.
 *
 * Every read is one instant query, cached for a short window so a page render
 * and a tool call do not each hit Prometheus; the scrape interval is 15 s, so a
 * 5 s cache loses nothing an observer can see.
 */
export class PrometheusMonitor {
	/** Resolves the local origin for the current tunnel, opening it if needed. */
	#origin;
	/** Cached reads keyed by query name, each `{ at, value }`. */
	#cache = new Map();
	/** fetch implementation, injectable for tests. */
	#fetch;

	/**
	 * @param {string | (() => Promise<string>)} origin - Prometheus origin, or a resolver that opens one.
	 * @param {{ fetch?: typeof fetch }} [options] - transport override for tests.
	 */
	constructor(origin, options = {}) {
		this.#origin = typeof origin === 'function' ? origin : async () => String(origin).replace(/\/+$/, '');
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	/**
	 * One cached instant query. A failure is not cached: the next reader retries.
	 * @param {string} name - key into {@link QUERIES}.
	 * @param {AbortSignal} [signal] - caller cancellation.
	 * @returns {Promise<any>} the decoded payload.
	 */
	async query(name, signal) {
		const cached = this.#cache.get(name);
		if (cached !== undefined && Date.now() - cached.at < 5000) return cached.value;
		const promql = QUERIES[name];
		if (promql === undefined) throw new Error(`sparks: unknown query ${JSON.stringify(name)}`);
		const origin = await this.#origin();
		const url = `${origin}/api/v1/query?query=${encodeURIComponent(promql)}`;
		let response;
		try {
			response = await this.#fetch(url, { headers: { accept: 'application/json' }, signal: signal === undefined ? undefined : signal });
		} catch (error) {
			if (signal?.aborted === true) throw error;
			throw new MonitorUnavailable(`Prometheus is not reachable at ${origin}`, { cause: error });
		}
		if (!response.ok) throw new MonitorUnavailable(`Prometheus answered ${response.status} for ${name}`);
		const payload = await response.json();
		if (payload?.status !== 'success') throw new MonitorUnavailable(`Prometheus rejected the ${name} query`);
		this.#cache.set(name, { at: Date.now(), value: payload });
		return payload;
	}

	/**
	 * One range query over the last hour, for a sparkline.
	 * @param {string} name - key into {@link HISTORY_QUERIES}.
	 * @param {AbortSignal} [signal] - caller cancellation.
	 * @returns {Promise<any>} the decoded matrix payload.
	 */
	async range(name, signal) {
		const key = `history.${name}`;
		const cached = this.#cache.get(key);
		if (cached !== undefined && Date.now() - cached.at < 5000) return cached.value;
		const promql = HISTORY_QUERIES[name];
		if (promql === undefined) throw new Error(`sparks: unknown history query ${JSON.stringify(name)}`);
		const origin = await this.#origin();
		const url = `${origin}/api/v1/query_range?query=${encodeURIComponent(promql)}&start=${Math.floor(Date.now() / 1000) - 3600}&end=${Math.floor(Date.now() / 1000)}&step=30`;
		let response;
		try {
			response = await this.#fetch(url, { headers: { accept: 'application/json' }, signal });
		} catch (error) {
			if (signal?.aborted === true) throw error;
			throw new MonitorUnavailable(`Prometheus is not reachable at ${origin}`, { cause: error });
		}
		if (!response.ok) throw new MonitorUnavailable(`Prometheus answered ${response.status} for ${name} history`);
		const payload = await response.json();
		if (payload?.status !== 'success') throw new MonitorUnavailable(`Prometheus rejected the ${name} history query`);
		this.#cache.set(key, { at: Date.now(), value: payload });
		return payload;
	}

	/**
	 * Everything the page shows in one call, so one render is one round trip.
	 * A failing side read degrades to empty rather than failing the page.
	 * @param {AbortSignal} [signal] - caller cancellation.
	 * @returns {Promise<Record<string, any>>} the fleet overview.
	 */
	async overview(signal) {
		const answers = {};
		/** First failure, kept so an unreachable Prometheus is not shown as an empty fleet. */
		let failure;
		await Promise.all(Object.keys(QUERIES).map(async (name) => {
			try {
				answers[name] = await this.query(name, signal);
			} catch (error) {
				if (signal?.aborted === true) throw error;
				answers[name] = null;
				if (name.startsWith('serving.')) failure ??= error;
			}
		}));
		// An absent metric family answers 200 with no series, so only a transport
		// or protocol failure lands here; every discovery query failing means the
		// monitor itself is unusable rather than empty.
		if (failure !== undefined && !Object.keys(QUERIES).some((name) => name.startsWith('serving.') && answers[name] !== null)) {
			throw failure;
		}
		const { deployments, conditions } = summarizePrometheus(answers);
		// Trends are optional: a failed history read leaves a row without a
		// sparkline rather than failing the page.
		const history = {};
		await Promise.all(Object.keys(HISTORY_QUERIES).map(async (name) => {
			try {
				history[name] = await this.range(name, signal);
			} catch (error) {
				if (signal?.aborted === true) throw error;
				history[name] = null;
			}
		}));
		for (const deployment of deployments) {
			deployment.series = seriesFor(deployment, history);
		}
		return {
			deployments,
			conditions,
			fleetState: fleetState(deployments),
			fetchedAt: Date.now(),
		};
	}
}

/**
 * The model-facing tool. It returns a compact JSON summary — not the raw
 * Prometheus payload — because the agent asks which deployment needs attention,
 * not for every interface counter.
 * @param {PrometheusMonitor} monitor - the shared monitor instance.
 * @returns {Record<string, any>} a tool definition for `ctx.tools.register`.
 */
export function sparksTool(monitor) {
	return {
		name: 'local_models',
		description: 'Check the local model-serving deployments from Prometheus: per-model state, requests in flight, GPU and CPU temperature, tokens served, speculative-decoding acceptance, and the alerts that name them. Read-only.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				deployment: { type: 'string', description: 'One deployment id (a serving job such as local-llm or sparks-serving). Omit for every deployment.' },
			},
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
		},
		async execute(args = {}, exec = {}) {
			const overview = await monitor.overview(exec.signal);
			const deployments = args.deployment === undefined
				? overview.deployments
				: overview.deployments.filter((deployment) => deployment.id === args.deployment);
			if (args.deployment !== undefined && deployments.length === 0) {
				throw new Error(`local_models: no deployment ${JSON.stringify(args.deployment)}; known deployments: ${overview.deployments.map((deployment) => deployment.id).join(', ')}`);
			}
			return {
				fleetState: overview.fleetState,
				fetchedAt: overview.fetchedAt,
				deployments,
				conditions: overview.conditions.map((condition) => `${condition.sparkName}: ${condition.message}`),
			};
		},
	};
}

/**
 * Mount the monitor, the `sparks` Remote namespace and the agent tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the bundle's Host context.
 * @param {{ baseUrl?: string, ssh?: string, target?: string, tool?: boolean }} [config] - bundle row configuration.
 */
export function apply(ctx, config = {}) {
	const tunnel = config.baseUrl === undefined
		? new SshTunnel(config.ssh ?? 'mobrienv@reef', config.target ?? PROMETHEUS_TARGET)
		: undefined;
	const origin = tunnel === undefined ? config.baseUrl : () => tunnel.open();
	const monitor = new PrometheusMonitor(origin, config.fetch === undefined ? {} : { fetch: config.fetch });
	// Mounted as a Cordis Service, not provided as a value: only a Service reaches
	// the Typert Gateway, which is what turns it into the `sparks` Remote
	// namespace the browser can inject.
	ctx.plugin(sparksService(monitor));
	if (tunnel !== undefined) ctx.effect(() => () => tunnel.close(), 'sparks: prometheus tunnel');
	// `tools` is optional for this plugin: the page needs no registry. Declaring
	// it through `ctx.inject` still activates the tool wherever one exists,
	// instead of dropping it silently the way a bare `ctx.get('tools')` would.
	if (config.tool !== false) {
		ctx.inject(['tools'], (scoped) => {
			scoped.effect(() => scoped.tools.register(sparksTool(monitor)), 'sparks: deployments tool');
		});
	}
}

/**
 * The `sparks` Remote namespace the page reads, built around one monitor.
 *
 * It extends `TypertRemoteService` so Cordis registers it as a Service and the
 * Typert Gateway discovers the endpoint: a plain value registered with
 * `ctx.provide()` carries no service definition, so no Remote namespace and no
 * `remote.sparks` for the Client to inject. The method marker is written by
 * hand because this bundle ships plain JavaScript.
 * @param {PrometheusMonitor} monitor - the monitor this namespace reads.
 * @returns {typeof import('@deepseek-ai/dsh-typert-protocol').TypertRemoteService} the service class to mount.
 */
export function sparksService(monitor) {
	const Klass = class SparksService extends TypertRemoteService {
		/**
		 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
		 */
		constructor(ctx) {
			super(ctx, NAMESPACE);
			this.ctx = ctx;
			this.monitor = monitor;
		}

		/**
		 * Fleet overview for the Sparks page.
		 * @param {AbortSignal} signal - caller cancellation.
		 * @returns {Promise<Record<string, any>>} deployments and conditions.
		 */
		overview(signal) {
			return this.monitor.overview(signal);
		}
	};

	Object.defineProperty(Klass.prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([Object.freeze({ method: 'overview', invocation: Object.freeze({ kind: 'direct' }) })]),
		}),
	});
	return Klass;
}
