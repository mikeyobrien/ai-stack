/**
 * Model-request concurrency limiting — queue requests a provider cannot serve
 * all at once instead of failing them.
 *
 * A provider with a small concurrency ceiling (a gateway with four generation
 * slots, for example) rejects the fifth simultaneous request. Nothing above it
 * can see that ceiling: subagent capacity counts *children*, not requests, and
 * every Session shares the same endpoint, so two chats plus three subagents is
 * already five requests to one backend.
 *
 * The `llm/stream` waterfall is the one place every model request passes
 * through — loop-built requests, one-shot titles, compaction summaries, and
 * session-query calls alike. Limiting there makes the ceiling a property of the
 * provider rather than a number guessed in three different places: a request
 * waits for a slot, and the slot returns when the stream ends, throws, or is
 * aborted. Requests to unconfigured providers pass through untouched, with no
 * wrapper and no delay.
 *
 * @module @local/dsh-llm-concurrency
 */

/** Cordis plugin name. */
export const name = 'llm-concurrency';

/**
 * A FIFO in-flight limiter for one provider.
 *
 * `acquire` resolves to an idempotent release. Waiting is abortable: an aborted
 * waiter leaves the queue and rejects with the signal's reason, so a cancelled
 * turn cannot hold a queue position. A slot is handed directly from the
 * releasing request to the next waiter, so the limit is never briefly exceeded
 * by a resolved-but-not-yet-resumed waiter.
 */
export class InFlightLimiter {
	/** Maximum simultaneous acquisitions. */
	#maxInFlight;
	/** Slots currently held. */
	#active = 0;
	/** Highest simultaneous acquisitions observed, for verification. */
	#peak = 0;
	/** Waiting acquisitions in arrival order. */
	#waiters = [];

	/**
	 * @param maxInFlight - maximum simultaneous requests; a positive integer.
	 */
	constructor(maxInFlight) {
		if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
			throw new TypeError(`llm-concurrency: maxInFlight must be a positive integer, got ${JSON.stringify(maxInFlight)}`);
		}
		this.#maxInFlight = maxInFlight;
	}

	/** Maximum simultaneous requests. */
	get maxInFlight() {
		return this.#maxInFlight;
	}

	/** Requests currently holding a slot. */
	get active() {
		return this.#active;
	}

	/** Requests queued ahead of admission. */
	get waiting() {
		return this.#waiters.length;
	}

	/** Highest simultaneous request count seen so far. */
	get peak() {
		return this.#peak;
	}

	/**
	 * Wait for a slot and take it.
	 * @param signal - cancellation for the wait; aborting rejects with its reason.
	 * @returns an idempotent slot release.
	 */
	async acquire(signal) {
		if (signal?.aborted === true) throw abortReason(signal);
		if (this.#active < this.#maxInFlight) {
			this.#active += 1;
		} else {
			await this.#waitForSlot(signal);
		}
		this.#peak = Math.max(this.#peak, this.#active);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#handOver();
		};
	}

	/**
	 * Queue until a release hands this waiter a slot.
	 * @param signal - optional cancellation for the wait.
	 * @returns a promise resolved by {@link InFlightLimiter.#handOver}.
	 */
	#waitForSlot(signal) {
		return new Promise((resolve, reject) => {
			/** @type {{ resolve: () => void, signal?: AbortSignal, onAbort?: () => void }} */
			const waiter = { resolve };
			if (signal !== undefined) {
				waiter.signal = signal;
				waiter.onAbort = () => {
					// A waiter the release already picked up is no longer in the
					// queue; rejecting it would strand the slot it was handed.
					if (this.#forget(waiter)) reject(abortReason(signal));
				};
				signal.addEventListener('abort', waiter.onAbort, { once: true });
			}
			this.#waiters.push(waiter);
		});
	}

	/**
	 * Remove one still-queued waiter.
	 * @param waiter - the queued entry.
	 * @returns whether it was still queued.
	 */
	#forget(waiter) {
		const index = this.#waiters.indexOf(waiter);
		if (index < 0) return false;
		this.#waiters.splice(index, 1);
		this.#detach(waiter);
		return true;
	}

	/**
	 * Drop a waiter's abort listener.
	 * @param waiter - the queued entry.
	 */
	#detach(waiter) {
		if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
			waiter.signal.removeEventListener('abort', waiter.onAbort);
		}
	}

	/**
	 * Release one slot, handing it to the next waiter when one is queued.
	 */
	#handOver() {
		this.#active -= 1;
		const waiter = this.#waiters.shift();
		if (waiter === undefined) return;
		this.#detach(waiter);
		this.#active += 1;
		this.#peak = Math.max(this.#peak, this.#active);
		waiter.resolve();
	}
}

/**
 * The value an aborted admission rejects with.
 * @param signal - the aborted signal.
 * @returns the signal's reason, or a fresh AbortError when it has none.
 */
function abortReason(signal) {
	if (signal.reason !== undefined) return signal.reason;
	return new DOMException('the model request was aborted while waiting for a concurrency slot', 'AbortError');
}

/**
 * Write one diagnostic line for the operator.
 *
 * `ctx.logger` is the harness's structured logger, but no console exporter is
 * installed for plugin info lines in a booted app, so a line written there is
 * collected and never shown. stderr is the channel the harness itself uses for
 * boot diagnostics and the one visible in the service journal.
 * @param line - the message, without the plugin prefix.
 */
function note(line) {
	process.stderr.write(`[llm-concurrency] ${line}\n`);
}

/**
 * Wrap one downstream request so its stream runs inside a slot.
 * @param limiter - the provider's limiter.
 * @param options - the request; `signal` cancels both the wait and the stream.
 * @param next - the downstream waterfall step returning the chunk stream.
 * @returns the wrapped chunk stream.
 */
function limitedStream(limiter, options, next) {
	return (async function* limited() {
		const willWait = limiter.active >= limiter.maxInFlight;
		const release = await limiter.acquire(options.signal);
		try {
			if (willWait) {
				note(`provider "${options.provider}" admitted a queued request (${limiter.active} in flight, ${limiter.waiting} still waiting, peak ${limiter.peak})`);
			}
			for await (const chunk of next()) yield chunk;
		} finally {
			release();
		}
	})();
}

/**
 * Validate and index the configured rules.
 * @param config - plugin configuration.
 * @returns provider name to rule, in declaration order.
 */
function resolveRules(config) {
	if (config === undefined || config === null) return new Map();
	if (typeof config !== 'object' || Array.isArray(config)) {
		throw new TypeError('llm-concurrency: config must be an object with a `rules` array');
	}
	for (const key of Object.keys(config)) {
		if (key !== 'rules') throw new Error(`llm-concurrency: unknown config key "${key}"`);
	}
	const declared = config.rules ?? [];
	if (!Array.isArray(declared)) {
		throw new TypeError('llm-concurrency: `rules` must be an array');
	}
	const rules = new Map();
	for (const [index, rule] of declared.entries()) {
		const at = `rules[${index}]`;
		if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
			throw new TypeError(`llm-concurrency: ${at} must be an object`);
		}
		for (const key of Object.keys(rule)) {
			if (key !== 'provider' && key !== 'maxInFlight' && key !== 'models') {
				throw new Error(`llm-concurrency: unknown key "${key}" in ${at}`);
			}
		}
		if (typeof rule.provider !== 'string' || rule.provider.trim() === '') {
			throw new TypeError(`llm-concurrency: ${at}.provider must be a non-empty string`);
		}
		if (rules.has(rule.provider)) {
			throw new Error(`llm-concurrency: provider "${rule.provider}" is configured more than once`);
		}
		if (!Number.isInteger(rule.maxInFlight) || rule.maxInFlight < 1) {
			throw new TypeError(`llm-concurrency: ${at}.maxInFlight must be a positive integer`);
		}
		let models;
		if (rule.models !== undefined) {
			if (!Array.isArray(rule.models) || rule.models.some((model) => typeof model !== 'string' || model.trim() === '')) {
				throw new TypeError(`llm-concurrency: ${at}.models must be an array of non-empty model ids`);
			}
			if (rule.models.length > 0) models = new Set(rule.models);
		}
		rules.set(rule.provider, {
			limiter: new InFlightLimiter(rule.maxInFlight),
			...models === undefined ? {} : { models },
		});
	}
	return rules;
}

/**
 * Cap simultaneous model requests per provider, queueing beyond the cap.
 * @param ctx - Cordis context owning the `llm/stream` listener.
 * @param config - `{ rules: [{ provider, maxInFlight, models? }] }`.
 */
export function apply(ctx, config = {}) {
	const rules = resolveRules(config);
	for (const [provider, rule] of rules) {
		note(`provider "${provider}" limited to ${rule.limiter.maxInFlight} simultaneous requests`);
	}
	ctx.on('llm/stream', (options, next) => {
		if (options === null || typeof options !== 'object') return next();
		const rule = rules.get(options.provider);
		if (rule === undefined) return next();
		if (rule.models !== undefined && !rule.models.has(options.model)) return next();
		return limitedStream(rule.limiter, options, next);
	});
}
