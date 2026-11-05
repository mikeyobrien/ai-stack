/**
 * Pushover delivery for @local/dsh-notifier.
 *
 * One form POST to the message endpoint, with a bounded retry for the failures
 * Pushover's API documents as retryable: connection errors and 5xx responses.
 * Rejections (4xx, or HTTP 200 with `status !== 1`) are final — a bad token or
 * an exhausted monthly quota does not improve on a second attempt — and the
 * retry waits at least five seconds, the minimum Pushover asks for.
 *
 * @module @local/dsh-notifier/pushover
 */

/** The message endpoint documented at https://pushover.net/api. */
export const API_URL = 'https://api.pushover.net/1/messages.json';

/** Waits before each retry; the first is Pushover's five-second minimum. */
const RETRY_DELAYS = [5000, 10_000];

/** A delivery failure, with Pushover's answer when there was one. */
export class PushoverError extends Error {
	/**
	 * @param message - the failure, without credentials or message body.
	 * @param details - `retryable` marks a transient transport or server failure.
	 */
	constructor(message, details = {}) {
		super(message);
		this.name = 'PushoverError';
		this.retryable = details.retryable === true;
		if (details.status !== undefined) this.status = details.status;
	}
}

/**
 * Send one Pushover message, retrying transient failures.
 * @param request - `{ token, user, title, message, priority, sound, device, timestamp }`.
 * @param options - `fetchImpl`, `sleep`, and `log` seams, for tests; `log`
 *   receives the attempt count and the Pushover request id when one was
 *   accepted, for the operator to trace a delivery without exposing the
 *   credential fields.
 * @returns `{ request }` with Pushover's request id when accepted.
 */
export async function sendPushover(request, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
	const log = options.log ?? (() => undefined);
	let failure;
	for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
		if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
		try {
			const result = await post(fetchImpl, request);
			try {
				log({ attempt: attempt + 1, request: result.request });
			} catch {
				// Diagnostics are observational; a failing log callback
				// must not turn an accepted send into a reported failure.
			}
			return result;
		} catch (error) {
			if (!(error instanceof PushoverError) || !error.retryable) throw error;
			failure = error;
		}
	}
	throw failure;
}

/**
 * POST one message and interpret Pushover's answer.
 * @param fetchImpl - the fetch implementation to use.
 * @param request - the message fields.
 * @returns `{ request }` when Pushover accepted the message.
 */
async function post(fetchImpl, request) {
	const body = new URLSearchParams({
		token: request.token,
		user: request.user,
		message: request.message,
		title: request.title,
		priority: String(request.priority ?? 0),
	});
	if (request.sound) body.set('sound', request.sound);
	if (request.device) body.set('device', request.device);
	if (request.url) body.set('url', request.url);
	if (request.urlTitle) body.set('url_title', request.urlTitle);
	if (request.timestamp !== undefined) body.set('timestamp', String(request.timestamp));

	let response;
	try {
		response = await fetchImpl(API_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		});
	} catch (error) {
		throw new PushoverError(`network error: ${messageOf(error)}`, { retryable: true });
	}

	const text = await response.text().catch(() => '');
	if (response.status >= 500) {
		throw new PushoverError(`Pushover returned HTTP ${response.status}`, { retryable: true, status: response.status });
	}

	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		payload = undefined;
	}
	if (response.status === 200 && payload?.status === 1) return { request: typeof payload.request === 'string' ? payload.request : '' };

	const reason = Array.isArray(payload?.errors) && payload.errors.length > 0
		? payload.errors.join('; ')
		: text.trim() === '' ? 'no response body' : text.trim();
	throw new PushoverError(`Pushover rejected the message (HTTP ${response.status}): ${reason}`, { status: response.status });
}

/**
 * Render an unknown thrown value as a one-line message.
 * @param error - the thrown value.
 * @returns its message.
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
