/**
 * dsh-notifier — a Pushover push when a long agent turn finishes.
 *
 * "Long" means the turn outlasted `minDurationSeconds`. The summary is
 * generated from the session log at the moment the turn closes: the request
 * that opened it, the model's closing words, the work performed, and the time
 * the turn took. Nothing waits for a model, and nothing here can delay or fail
 * the turn: the push is fire-and-forget and delivery failures are reported to
 * stderr.
 *
 * Secrets never live in config. The token and user key are credential
 * references resolved once per send, so the credential store, the launch
 * environment, a project `.env`, and `$DSH_HOME/.env` all work, and a key saved
 * after boot is used by the next notification without a restart.
 *
 * @module @local/dsh-notifier
 */

import { condense, composeGoalNotification, composeNotification, composeTaskNotification, formatDuration, messageText, truncate } from './summary.js';
import { sendPushover } from './pushover.js';

/**
 * A `user/message` is a human request only when the harness recorded it as
 * kind `user`: the goal-round driver marks its continuation prompts `goal`,
 * injected context and relays declare their own kinds, and the model's own
 * words never arrive as user messages.
 * @param data - the `user/message` payload.
 * @returns true when a human opened this turn.
 */
function isHumanMessage(data) {
	return data?.source?.kind === 'user';
}

/**
 * The objective an automatic goal round is pursuing, from a `goal/change`
 * snapshot the plugin has already seen in this session — the goal-round
 * prompt in the log is a wrapper, not the objective.
 * @param data - the `goal/change` payload.
 * @returns the objective string, or `undefined` when the snapshot carries none.
 */
function goalObjective(data) {
	const goal = data?.goal;
	if (goal === null || typeof goal !== 'object') return undefined;
	const objective = goal.objective;
	return typeof objective === 'string' && objective.trim() !== '' ? objective.trim() : undefined;
}

/** Cordis plugin name. */
export const name = 'dsh-notifier';

/** The token and user key come from the credential service. */
export const inject = ['credentials'];

/** Defaults for the row's `config`. */
const DEFAULTS = {
	minDurationSeconds: 120,
	includeSubagents: false,
	notifyTasks: true,
	notifyGoals: true,
	priority: 0,
	sound: undefined,
	device: undefined,
	tokenRef: 'PUSHOVER_TOKEN',
	userRef: 'PUSHOVER_USER',
};

/** Longest request excerpt shown as the goal line. */
const ASK_LIMIT = 200;

/** Longest project label in the title. */
const LABEL_LIMIT = 48;

/** Credential references name environment-variable keys. */
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Track turns and push a summary when a long one ends.
 * @param ctx - Cordis context carrying the `credentials` service.
 * @param config - row configuration; see README.
 */
export function apply(ctx, config = {}) {
	const settings = resolveSettings(config);
	const turns = new Map();
	const todos = new Map();
	const goals = new Map();
	const enqueue = serialQueue();

	note(
		`pushing Pushover for turns longer than ${formatDuration(settings.minDurationSeconds * 1000)}`
		+ `${settings.includeSubagents ? ', subagents included' : ''}`,
	);

	ctx.on('session/event', (session, event) => {
		if (event === null || typeof event !== 'object') return;
		const data = event.data ?? {};
		const turn = turns.get(session.id);
		switch (event.type) {
			case 'turn/start':
				turns.set(session.id, {
					number: data.turn,
					startedAt: event.time,
					ask: '',
					objective: goals.get(session.id),
					closing: '',
					toolCalls: 0,
					toolErrors: 0,
					tokens: 0,
				});
				return;
			case 'user/message':
				// The ask is the human's own words only: a goal-round
				// continuation, an injected notice, or a relay message is not a
				// request, and the goal line stays the real objective (or absent
				// when the plugin has not seen a goal snapshot yet).
				if (turn !== undefined && isHumanMessage(data)) turn.ask = condense(messageText(data), ASK_LIMIT);
				return;
			case 'assistant/message': {
				if (turn === undefined || data.interrupted === true) return;
				const text = messageText(data.message);
				if (text !== '') turn.closing = text;
				turn.tokens += totalTokens(data.usage);
				return;
			}
			case 'tool/call':
				if (turn !== undefined) turn.toolCalls += 1;
				return;
			case 'tool/result':
				if (turn !== undefined && data.error !== undefined) turn.toolErrors += 1;
				return;
			case 'todo/write':
				recordTasks(session, data, event.time);
				return;
			case 'goal/change':
				recordGoal(session, data, event.time);
				return;
			case 'turn/end':
				turns.delete(session.id);
				if (turn === undefined || turn.number !== data.turn) return;
				consider(session, { ...turn, endedAt: event.time, reason: data.reason });
				return;
			default:
				return;
		}
	});

	/**
	 * Decide whether a finished turn is worth a push, then queue it.
	 * @param session - the session whose turn ended.
	 * @param turn - the tracked turn, with `endedAt` and `reason`.
	 */
	function consider(session, turn) {
		const kind = typeof turn.reason === 'string' ? turn.reason : turn.reason?.kind ?? 'completed';
		// A fork is not a completion: the session continues in the child.
		if (kind === 'forked') return;
		if (!settings.includeSubagents && session.header?.origin === 'subagent') return;
		const durationMs = turn.endedAt - turn.startedAt;
		if (!(durationMs >= settings.minDurationSeconds * 1000)) return;
		enqueue(() => deliver(session, { ...turn, durationMs })).catch((error) => {
			note(`delivery failed for ${labelOf(session)}: ${messageOf(error)}`);
		});
	}

	/**
	 * Announce the items one task-list snapshot just moved to `completed`.
	 *
	 * The list is a whole-list replacement, so a completion is a transition:
	 * the same content in the previous snapshot was not `completed` yet. The
	 * first snapshot after activation is the baseline, with nothing to compare.
	 * @param session - the session that owns the list.
	 * @param data - the `todo/write` payload.
	 * @param time - the event time, used as the push timestamp.
	 */
	function recordTasks(session, data, time) {
		const items = Array.isArray(data.todos)
			? data.todos.filter((item) => item !== null && typeof item === 'object' && typeof item.content === 'string')
			: [];
		const previous = todos.get(session.id);
		todos.set(session.id, items.map((item) => ({ content: item.content, status: item.status })));
		if (previous === undefined || !settings.notifyTasks) return;
		if (!settings.includeSubagents && session.header?.origin === 'subagent') return;
		const before = new Map(previous.map((item) => [item.content, item.status]));
		const done = items
			.filter((item) => item.status === 'completed' && before.has(item.content) && before.get(item.content) !== 'completed')
			.map((item) => item.content);
		if (done.length === 0) return;
		enqueue(() => deliverTask(session, done, items, time)).catch((error) => {
			note(`delivery failed for ${labelOf(session)}: ${messageOf(error)}`);
		});
	}

	/**
	 * Announce a goal that just reached `complete` or `blocked`.
	 * @param session - the session that owns the goal.
	 * @param change - the `goal/change` payload.
	 * @param time - the event time, used as the push timestamp.
	 */
	function recordGoal(session, change, time) {
		// A clear or terminal phase leaves the session with no active
		// objective; a snapshot with an objective records it for turns after.
		// An already-open turn captured its objective at turn/start and is
		// unaffected by later snapshots.
		if (change.operation === 'clear' || change.goal?.phase === 'complete' || change.goal?.phase === 'blocked') {
			goals.delete(session.id);
		} else {
			const objective = goalObjective(change);
			if (objective !== undefined) goals.set(session.id, objective);
		}
		if (change.operation !== 'complete' && change.operation !== 'block') return;
		if (!settings.notifyGoals) return;
		if (!settings.includeSubagents && session.header?.origin === 'subagent') return;
		const goal = change.goal;
		if (goal === null || typeof goal !== 'object') return;
		const durationMs = Number.isFinite(change.createdAt) && Number.isFinite(change.updatedAt)
			? change.updatedAt - change.createdAt
			: undefined;
		enqueue(() => deliverGoal(session, {
			operation: change.operation,
			objective: goal.objective,
			blockedReason: goal.blockedReason?.message,
			rounds: change.roundsStarted,
			durationMs,
		}, time)).catch((error) => {
			note(`delivery failed for ${labelOf(session)}: ${messageOf(error)}`);
		});
	}

	/**
	 * Compose a finished turn and send it.
	 * @param session - the session whose turn ended.
	 * @param turn - the finished turn, with its `ask` and `objective`.
	 */
	async function deliver(session, turn) {
		const composed = composeNotification({
			label: labelOf(session),
			reason: turn.reason,
			durationMs: turn.durationMs,
			// A human request wins; an automatic goal round shows the real
			// objective from a goal snapshot; otherwise no goal line at all.
			ask: turn.ask !== '' ? turn.ask : turn.objective,
			closing: turn.closing,
			toolCalls: turn.toolCalls,
			toolErrors: turn.toolErrors,
			tokens: turn.tokens,
		});
		await send(composed, Math.floor(turn.endedAt / 1000), session);
	}

	/**
	 * Compose the task completions and send them.
	 * @param session - the session that owns the list.
	 * @param done - the item contents that just completed.
	 * @param items - the whole list after the write.
	 * @param time - the event time.
	 */
	async function deliverTask(session, done, items, time) {
		const composed = composeTaskNotification({
			label: labelOf(session),
			done,
			completed: items.filter((item) => item.status === 'completed').length,
			total: items.length,
		});
		await send(composed, Math.floor(time / 1000), session);
	}

	/**
	 * Compose the finished goal and send it.
	 * @param session - the session that owns the goal.
	 * @param goal - the terminal goal facts.
	 * @param time - the event time.
	 */
	async function deliverGoal(session, goal, time) {
		const composed = composeGoalNotification({ label: labelOf(session), ...goal });
		await send(composed, Math.floor(time / 1000), session);
	}

	/**
	 * Resolve credentials and deliver one composed notification.
	 * @param composed - `{ title, message }`.
	 * @param timestamp - Pushover's event time, in seconds.
	 * @param session - the session the notification is about.
	 */
	async function send(composed, timestamp, session) {
		const [token, user] = await Promise.all([
			ctx.credentials.resolve(settings.tokenRef),
			ctx.credentials.resolve(settings.userRef),
		]);
		const missing = [token === undefined ? settings.tokenRef : '', user === undefined ? settings.userRef : ''].filter(Boolean);
		if (missing.length > 0) {
			note(`skipped "${composed.title}": ${missing.join(' and ')} not configured`);
			return;
		}
		const url = appUrl(session);
		await sendPushover({
			token: token.value,
			user: user.value,
			title: composed.title,
			message: composed.message,
			priority: settings.priority,
			sound: settings.sound,
			device: settings.device,
			url,
			urlTitle: url === undefined ? undefined : 'Open session',
			timestamp,
		}, {
			log: ({ attempt, request }) => {
				note(`accepted after ${attempt} attempt(s)${request === '' ? '' : `, Pushover request ${request}`}`);
			},
		});
		note(`sent "${composed.title}"`);
	}

	/**
	 * The GUI's advertised URL, when this host serves one. The GUI keeps no
	 * per-session route, so the link opens the app rather than one session.
	 * @returns the URL, or `undefined` for a host without a web app.
	 */
	function appUrl(session) {
		const url = ctx.get('webApp')?.getAdvertisedUrl?.();
		if (typeof url !== 'string' || url.trim() === '') return undefined;
		const base = url.trim().replace(/\/+$/, '');
		const id = session?.id;
		return typeof id === 'string' && id !== '' ? `${base}/?session=${encodeURIComponent(id)}` : `${base}/`;
	}
}

/**
 * Validate the row's config and apply defaults.
 * @param config - the row's `config`.
 * @returns the resolved settings.
 */
export function resolveSettings(config) {
	if (config === null || typeof config !== 'object' || Array.isArray(config)) {
		throw new TypeError('dsh-notifier: config must be an object');
	}
	for (const key of Object.keys(config)) {
		if (!(key in DEFAULTS)) throw new Error(`dsh-notifier: unknown config key "${key}"`);
	}

	const minDurationSeconds = config.minDurationSeconds ?? DEFAULTS.minDurationSeconds;
	if (typeof minDurationSeconds !== 'number' || !Number.isFinite(minDurationSeconds) || minDurationSeconds < 0) {
		throw new TypeError('dsh-notifier: minDurationSeconds must be a non-negative number');
	}
	const includeSubagents = config.includeSubagents ?? DEFAULTS.includeSubagents;
	const notifyTasks = config.notifyTasks ?? DEFAULTS.notifyTasks;
	const notifyGoals = config.notifyGoals ?? DEFAULTS.notifyGoals;
	for (const [key, value] of [['includeSubagents', includeSubagents], ['notifyTasks', notifyTasks], ['notifyGoals', notifyGoals]]) {
		if (typeof value !== 'boolean') throw new TypeError(`dsh-notifier: ${key} must be true or false`);
	}
	const priority = config.priority ?? DEFAULTS.priority;
	if (!Number.isInteger(priority) || priority < -2 || priority > 2) {
		throw new TypeError('dsh-notifier: priority must be an integer from -2 to 2');
	}
	if (priority === 2) {
		throw new Error('dsh-notifier: priority 2 repeats until acknowledged, which a completion notice should never do');
	}
	for (const key of ['sound', 'device']) {
		const value = config[key] ?? DEFAULTS[key];
		if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
			throw new TypeError(`dsh-notifier: ${key} must be a non-empty string when set`);
		}
	}

	const tokenRef = config.tokenRef ?? DEFAULTS.tokenRef;
	const userRef = config.userRef ?? DEFAULTS.userRef;
	for (const [key, ref] of [['tokenRef', tokenRef], ['userRef', userRef]]) {
		if (typeof ref !== 'string' || !CREDENTIAL_NAME.test(ref)) {
			throw new TypeError(`dsh-notifier: ${key} must be a credential reference name, got ${JSON.stringify(ref)}`);
		}
	}

	return {
		minDurationSeconds,
		includeSubagents,
		notifyTasks,
		notifyGoals,
		priority,
		sound: config.sound ?? DEFAULTS.sound,
		device: config.device ?? DEFAULTS.device,
		tokenRef,
		userRef,
	};
}

/**
 * A promise chain that runs one delivery at a time, so a burst of finishing
 * subagents cannot exceed Pushover's two-connection limit and a failed delivery
 * never blocks the next one.
 * @returns a function that queues a task and returns its promise.
 */
function serialQueue() {
	let tail = Promise.resolve();
	return (task) => {
		const run = tail.then(task, task);
		tail = run.then(() => undefined, () => undefined);
		return run;
	};
}

/**
 * The project label: the session directory's last path segment.
 * @param session - the session.
 * @returns a short label for the title.
 */
function labelOf(session) {
	const cwd = session.header?.cwd;
	if (typeof cwd !== 'string' || cwd.trim() === '') return 'session';
	const parts = cwd.trim().split(/[\\/]+/).filter(Boolean);
	return parts.length === 0 ? 'session' : truncate(parts[parts.length - 1], LABEL_LIMIT);
}

/**
 * Sum a turn's token usage.
 * @param usage - one assistant message's `usage`.
 * @returns the token count, or 0 when absent.
 */
function totalTokens(usage) {
	if (usage === null || typeof usage !== 'object') return 0;
	const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	return Number.isFinite(total) ? total : 0;
}

/**
 * Write one diagnostic line for the operator. `ctx.logger` lines have no
 * console exporter in a booted app, so stderr — the channel the harness itself
 * uses for boot diagnostics — is where these reach the service journal.
 * @param line - the message, without the plugin prefix.
 */
function note(line) {
	process.stderr.write(`[dsh-notifier] ${line}\n`);
}

/**
 * Render an unknown thrown value as a one-line message.
 * @param error - the thrown value.
 * @returns its message.
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
