/**
 * Machine-readable tail for Agent chat messages.
 *
 * The rendered text remains the source of truth. The final line is
 * `<!--meta:{...json...}-->`; the Client parses it for structured cards and
 * falls back to the plain text when it is absent or malformed.
 *
 * @module @local/dsh-sidebar-agent/machine-meta
 */

/** Prefix/suffix of the final marker line. */
export const META_PREFIX = '<!--meta:'
export const META_SUFFIX = '-->'

/**
 * Encode metadata without allowing the JSON to terminate the HTML comment.
 * `<` and `>` become JSON unicode escapes, which JSON.parse restores.
 * @param {Record<string, unknown>} meta - card metadata.
 * @returns {string} final marker line, including the leading newline.
 */
export function machineMetaLine(meta) {
	const json = JSON.stringify(meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
	return `\n${META_PREFIX}${json}${META_SUFFIX}`
}

/**
 * Append the machine tail to human-readable text.
 * @param {string} text - source-of-truth text.
 * @param {Record<string, unknown>} meta - card metadata.
 * @returns {string} text with the final meta line.
 */
export function withMachineMeta(text, meta) {
	return `${text}${machineMetaLine(meta)}`
}
