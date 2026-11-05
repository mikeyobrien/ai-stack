/**
 * The link contract shared by the Host tool and the Client handler.
 *
 * A link is one URL with the session in the query — `?session=<id>` — because
 * that form survives any proxy, pasting into chat, and the GUI's lack of a
 * router. The `dsh-session:` reference is the short form for notes and
 * messages; a bare reference is only clickable where the scheme is registered,
 * while the URL always is.
 *
 * @module @local/dsh-session-links/links
 */

/** Prefix of the short session reference. */
export const REFERENCE_PREFIX = 'dsh-session:';

/** Query parameter that carries the session id. */
export const SESSION_PARAM = 'session';

/**
 * Normalize a GUI base URL.
 * @param baseUrl - the advertised GUI URL.
 * @returns the URL without trailing slashes.
 */
export function guiBase(baseUrl) {
	return String(baseUrl).trim().replace(/\/+$/, '');
}

/**
 * Build the URL that opens one session in the GUI.
 * @param baseUrl - the advertised GUI URL.
 * @param sessionId - the session to open.
 * @returns the shareable URL.
 */
export function sessionUrl(baseUrl, sessionId) {
	return `${guiBase(baseUrl)}/?${SESSION_PARAM}=${encodeURIComponent(sessionId)}`;
}

/**
 * The short reference for one session.
 * @param sessionId - the session to reference.
 * @returns `dsh-session:<id>`.
 */
export function sessionReference(sessionId) {
	return `${REFERENCE_PREFIX}${sessionId}`;
}
