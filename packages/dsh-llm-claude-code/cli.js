/**
 * Claude Code CLI process boundary: binary invocation, auth status, child
 * environment, and process-tree teardown.
 *
 * The official CLI owns authentication; this module never reads credential
 * stores. It gates on `claude auth status --json` output only.
 *
 * Env rules: `ANTHROPIC_API_KEY` is stripped from the CHILD environment only
 * (the parent's env is untouched) so billing cannot silently switch to
 * metered API keys; explicit `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`
 * overrides in the parent environment are refused with a clear error instead
 * of being overridden, because they change auth/billing routing.
 *
 * @module cli
 */
import { spawn } from 'node:child_process';

/**
 * Build the child env for one turn.
 * @param base process env (never mutated).
 * @param options.relayUrl loopback relay URL for `ANTHROPIC_BASE_URL`.
 * @param options.configDir optional `CLAUDE_CONFIG_DIR` passthrough.
 */
export function childEnv(base, { relayUrl, configDir } = {}) {
	const env = authEnv(base, { configDir });
	for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
		if (env[name]) {
			// Name only: the value may be a credential and this message reaches
			// the UI, logs and session history.
			throw Object.assign(
				new Error(`dsh-llm-claude-code: ${name} is set in the environment; unset it for the DSH process so the Claude Code provider cannot silently reroute authentication or billing`),
				{ code: 'CONFLICTING_ENV' },
			);
		}
	}
	if (relayUrl !== undefined) env.ANTHROPIC_BASE_URL = relayUrl;
	// Keep the child quiet and deterministic: no telemetry, auto-update, or
	// nonessential traffic; the CLI owns auth and nothing else takes over.
	env.CLAUDE_CODE_ENTRYPOINT = 'dsh';
	env.DISABLE_TELEMETRY = '1';
	env.DISABLE_AUTOUPDATER = '1';
	env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
	env.DISABLE_NONESSENTIAL_TRAFFIC = '1';
	env.DO_NOT_TRACK = '1';
	return env;
}

/**
 * Environment for every CLI process, including `auth status`: the parent key
 * is stripped so the login check sees the same auth the worker will use.
 * @param base process env (never mutated).
 * @param options.configDir optional `CLAUDE_CONFIG_DIR` passthrough.
 */
export function authEnv(base, { configDir } = {}) {
	const env = { ...base };
	delete env.ANTHROPIC_API_KEY;
	if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
	return env;
}

/** Linux refuses any single argv string over 128 KiB (MAX_ARG_STRLEN). */
export const MAX_ARG_BYTES = 128 * 1024;

/** Worker argv: print mode, stream-json both ways, one turn, no native surface. */
export function workerArgs({ systemPrompt, settingsFile, mcpConfigFile, model }) {
	return [
		'-p',
		'--model', model,
		'--input-format', 'stream-json',
		'--output-format', 'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--tools', '',
		'--setting-sources', '',
		'--settings', settingsFile,
		'--strict-mcp-config',
		'--disable-slash-commands',
		'--max-turns', '1',
		'--permission-mode', 'dontAsk',
		'--no-session-persistence',
		'--mcp-config', mcpConfigFile,
		// Documented flag (2.1.316 --help); the file variant is undocumented, so argv text wins.
		'--system-prompt', systemPrompt,
	];
}

/** Discovery argv: same isolation, no model pinned, replay-only trailing frame. */
export function discoveryArgs({ settingsFile }) {
	return [
		'-p',
		'--input-format', 'stream-json',
		'--output-format', 'stream-json',
		'--verbose',
		'--tools', '',
		'--setting-sources', '',
		'--settings', settingsFile,
		'--strict-mcp-config',
		'--disable-slash-commands',
		'--max-turns', '1',
		'--permission-mode', 'dontAsk',
		'--no-session-persistence',
	];
}

/** Auth-status result fields the provider gates on. */
export function parseAuthStatus(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { loggedIn: false, error: 'unparseable auth status output' };
	}
	return {
		loggedIn: parsed?.loggedIn === true,
		authMethod: typeof parsed?.authMethod === 'string' ? parsed.authMethod : undefined,
		subscriptionType: typeof parsed?.subscriptionType === 'string' ? parsed.subscriptionType : undefined,
	};
}

/**
 * Run `<command> auth status --json` with a hard timeout.
 * @returns parsed status; throws `Error.code = 'CLI_FAILED'` on nonzero exit
 *   or timeout with the collected stderr in the message.
 */
export function authStatus(command, { argsPrefix = [], env = process.env, timeoutMs = 20_000, signal } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...argsPrefix, 'auth', 'status', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'], signal });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => finish(new Error(`dsh-llm-claude-code: auth status did not finish within ${timeoutMs}ms`)), timeoutMs);
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		let settled = false;
		const onAbort = () => finish(Object.assign(new Error('dsh-llm-claude-code: auth status aborted'), { code: 'ABORTED' }));
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			if (error !== undefined) {
				if (error.code === 'ENOENT') {
					error.message = `dsh-llm-claude-code: Claude Code executable not found at "${command}"; install the official CLI or set the plugin's command setting`;
					error.code = 'CLI_MISSING';
				} else if (!error.code) {
					error.code = 'CLI_FAILED';
				}
				if (stderr) error.message += `: ${stderr.trim().slice(0, 400)}`;
				reject(error);
			} else {
				resolve(value);
			}
			child.kill();
		};
		child.on('error', (error) => finish(error));
		child.on('close', (code) => {
			if (code !== 0) {
				finish(Object.assign(new Error(`dsh-llm-claude-code: auth status exited ${code}`), { code: 'CLI_FAILED' }));
			} else {
				finish(undefined, parseAuthStatus(stdout));
			}
		});
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** Kill a detached process group, falling back to the child itself. */
export function killTree(child, { signal = 'SIGKILL' } = {}) {
	if (child?.exitCode !== null || child?.killed) return;
	try {
		if (child.pid !== undefined && typeof child.pid === 'number') process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try { child.kill(signal); } catch { /* already gone */ }
	}
}
