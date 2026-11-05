/**
 * KWGT feed — one headerless GET that serves DSH state to phone widgets.
 *
 * The phone polls `https://<tailnet>/kwgt/feed.json` through the auth-proxy,
 * which signs the request with the profile's browser-session secret, so the
 * Kustom `$wg()` formula needs no headers, tokens, or cookies (Kustom's web
 * get supports none of those reliably). The payload is flat JSON with a
 * preformatted `text` block for dumb rendering plus discrete fields for
 * conditional formatting, and an epoch `stamp` so the widget can show its own
 * staleness — One UI doze silences polls for minutes to hours and there is
 * no way to detect that from inside the widget.
 *
 * Content policy: running agents, plus sessions finished since the last
 * `GET /kwgt/ack` — the widget is a what-needs-attention surface.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatFeed, SUMMARY_TTL_MS } from './feed.js';

/** Routes owned by this plugin. */
export const FEED_PATH = '/kwgt/feed.json';
export const ACK_PATH = '/kwgt/ack';

/** Persistent acknowledgement stamp: the epoch ms of the last ack. */
export const seenFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'kwgt-seen.json');

const readSeen = () => {
	try {
		return Number(JSON.parse(readFileSync(seenFile(), 'utf8')).seen) || 0;
	} catch {
		return 0;
	}
};

export const name = 'dsh-kwgt-feed';

/** Host services this plugin cannot run without. */
export const inject = ['webServer', 'connection', 'sessionController'];

/**
 * Long-running, top-level sessions only — subagents and blank prompts are
 * noise on a glanceable widget.
 */
function visibleSessions(items) {
	const rows = [];
	for (const item of items ?? []) {
		if (item?.parentSessionId !== undefined) continue;
		if (item?.origin === 'subagent') continue;
		rows.push({
			title: typeof item?.projections?.values?.title === 'string' ? item.projections.values.title : '',
			running: item?.running === true,
			blank: item?.blank === true,
			updatedAt: Number(item?.updatedAt) || 0,
		});
	}
	return rows;
}

/** The feed payload, from a session-controller list response. */
export function feedFromList(list, now = Date.now(), seen = readSeen()) {
	return formatFeed(visibleSessions(list?.items), now, seen);
}

export async function apply(ctx) {
	let cache = { at: 0, payload: null };

	const respond = (response, code, body, type = 'application/json; charset=utf-8') => {
		response.writeHead(code, {
			'content-type': type,
			'cache-control': 'no-cache',
			'content-length': String(Buffer.byteLength(body)),
		});
		response.end(body);
	};

	async function payload() {
		const now = Date.now();
		if (cache.payload !== null && now - cache.at < SUMMARY_TTL_MS) return cache.payload;
		const list = await ctx.sessionController.list({}, AbortSignal.timeout(8_000));
		const payload = feedFromList(list, now);
		cache = { at: now, payload };
		return payload;
	}

	const routes = [
		{
			path: FEED_PATH,
			handler: async (request, response) => {
				let body;
				try {
					body = JSON.stringify(await payload());
				} catch (error) {
					ctx.logger?.warn?.(error, 'kwgt-feed: session list failed');
					respond(response, 503, 'kwgt-feed: session list unavailable', 'text/plain; charset=utf-8');
					return;
				}
				respond(response, 200, body);
			},
		},
		{
			// Idempotent acknowledgement: everything finished before now stops
			// being "recent" once this is called.
			path: ACK_PATH,
			handler: async (request, response) => {
				const seen = Date.now();
				writeFileSync(seenFile(), `${JSON.stringify({ seen })}\n`);
				cache.at = 0; // next feed poll re-renders with the new stamp
				respond(response, 200, JSON.stringify({ ok: true, seen }));
			},
		},
	];

	for (const route of routes) {
		const dispose = ctx.webServer.register({
			kind: 'exact',
			path: route.path,
			handler: async (request, response) => {
				if (!ctx.connection.authorizeIndex(request, response)) return;
				await route.handler(request, response);
			},
		});
		ctx.effect(() => dispose, `kwgt-feed: ${route.path}`);
	}

	ctx.logger?.info?.(`kwgt-feed: serving ${FEED_PATH} and ${ACK_PATH}`);
}
