/**
 * Token Metrics — the Host half.
 *
 * Rolls up the token usage of every model call from the moment the plugin is
 * activated. It listens to the live `session/event` append feed, reads the
 * `usage` field (`TokenUsage`) of each settled `assistant/message`, and keeps
 * one row per model name. Nothing is backfilled: a fork or resume seed never
 * publishes on that feed, so an inherited copy cannot arrive at all. Rows are
 * persisted to a small per-profile state file so a restart continues instead of
 * starting over, and two profiles cannot clobber each other's numbers.
 *
 * The `tokenMetrics` Remote namespace is the only Client entry point; a model
 * name, a few token counts, the call count, and the activation time cross the
 * boundary, never a transcript.
 *
 * @module @local/dsh-token-metrics
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import { createRollup, fromState } from './tokens.js';

/** Cordis plugin name. */
export const name = 'token-metrics';

/** Remote namespace the Client panel calls. */
export const NAMESPACE = 'tokenMetrics';

/** Prototype key the Typert Gateway reads to discover Remote methods. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** How long a burst of appended events is coalesced before the state hits disk. */
export const SAVE_DEBOUNCE_MS = 1_000;

/** The DSH home directory this Host runs with. */
export function dshHome() {
	return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

/**
 * The profile this Host serves, taken from the launch arguments it was given.
 * Counting is scoped to that profile so two profiles cannot share one counter.
 * @param [argv] - the Host's argument list.
 * @returns the profile name, or undefined when the Host was launched without one.
 */
export function activeProfile(argv = process.argv) {
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--profile' && typeof argv[index + 1] === 'string' && argv[index + 1] !== '') return argv[index + 1];
		if (typeof argument === 'string' && argument.startsWith('--profile=')) {
			const value = argument.slice('--profile='.length);
			if (value !== '') return value;
		}
	}
	return undefined;
}

/** A filesystem-safe file stem for one profile name. */
function profileStem(profile) {
	const stem = profile.replace(/[^A-Za-z0-9._-]/g, '_');
	return stem === '' || stem === '.' || stem === '..' ? 'profile' : stem;
}

/**
 * The state file's path: one small JSON document under the DSH home, named for
 * the profile that produced the counts. A row may point it elsewhere, which
 * tests use to stay out of the real store.
 * @param [config] - the bundle row's configuration.
 * @param [options] - the launch arguments to scope by (tests pass their own).
 * @returns the absolute state path.
 */
export function stateFilePath(config = {}, options = {}) {
	if (typeof config.stateFile === 'string' && config.stateFile !== '') return config.stateFile;
	const file = activeProfile(options.argv ?? process.argv);
	const name = file === undefined ? 'state.json' : `state-${profileStem(file)}.json`;
	return join(dshHome(), 'token-metrics', name);
}

/**
 * Read the persisted rows. A missing or malformed file starts fresh: the
 * panel then says counting began now, which is true.
 * @param file - the state path.
 * @returns the restored rollup options.
 */
export function readState(file) {
	try {
		return fromState(JSON.parse(readFileSync(file, 'utf8')));
	} catch {
		return {};
	}
}

/**
 * Persist the rows atomically. A failed write leaves the live rows intact and
 * only costs durability, so activation is never blocked by it.
 * @param file - the state path.
 * @param rollup - the live rows.
 * @returns true when the state reached disk.
 */
export function writeState(file, rollup) {
	try {
		mkdirSync(dirname(file), { recursive: true });
		const temporary = `${file}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(rollup.toState())}\n`, 'utf8');
		renameSync(temporary, file);
		return true;
	} catch {
		return false;
	}
}

/**
 * The `tokenMetrics` Remote namespace the panel reads.
 *
 * It extends `TypertRemoteService` so Cordis registers it as a Service and the
 * Typert Gateway exposes the endpoint; the method marker is written by hand
 * because this bundle ships plain JavaScript.
 * @param snapshot - returns the current rows and activation time.
 * @returns {typeof import('@deepseek-ai/dsh-typert-protocol').TypertRemoteService} the service class to mount.
 */
export function tokenMetricsService(snapshot) {
	const Klass = class TokenMetricsService extends TypertRemoteService {
		/**
		 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
		 */
		constructor(ctx) {
			super(ctx, NAMESPACE);
			this.ctx = ctx;
		}

		/**
		 * The rows rolled up since activation. Reading never changes a row.
		 * @returns {object} activation time, profile-wide totals, and per-model rows.
		 */
		overview() {
			return snapshot();
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

/**
 * Mount the rollup: restore its state, listen to the append feed, persist what
 * it sees, and expose the Remote namespace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the bundle's Host context.
 * @param {{ stateFile?: string }} [config] - bundle row configuration.
 */
export function apply(ctx, config = {}) {
	const file = stateFilePath(config);
	const restored = readState(file);
	const rollup = createRollup(restored);
	// The first activation is the counting start; make that durable immediately.
	if (restored.activatedAt === undefined) writeState(file, rollup);
	let timer;
	const save = () => {
		timer = undefined;
		writeState(file, rollup);
	};
	const schedule = () => {
		if (timer === undefined) timer = setTimeout(save, SAVE_DEBOUNCE_MS);
	};
	ctx.effect(() => ctx.on('session/event', (session, event) => {
		if (rollup.observe(session.id, event)) schedule();
	}), 'token-metrics: session feed');
	ctx.effect(() => ctx.on('session/disposed', (session) => rollup.forget(session.id)), 'token-metrics: session close');
	ctx.effect(() => () => {
		if (timer !== undefined) clearTimeout(timer);
		writeState(file, rollup);
	}, 'token-metrics: state');
	ctx.plugin(tokenMetricsService(() => rollup.snapshot()));
}
