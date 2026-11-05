/**
 * Deterministic automated deployment/verification callback.
 *
 * Workers supply fields; this module owns the bounded key-value rendering so a
 * callback never becomes run-on prose. The owner Remote sends the rendered text
 * into this same Agent through the existing chat channel.
 *
 * @module @local/dsh-sidebar-agent/deployment-callback
 */

import { withMachineMeta } from './machine-meta.js'

/** Maximum rendered callback lines, including the automated marker. */
export const MAX_CALLBACK_LINES = 8

/** Last line that identifies the message as an automated callback. */
export const CALLBACK_MARKER = 'Automated: deployment callback'

const MAX_WHAT = 80
const MAX_VALUE = 200
const STATES = new Set(['LIVE', 'HOLDING', 'BLOCKED'])
const MINIMAL = Object.freeze([
	'Deployment callback: BLOCKED',
	'Holding: malformed callback fields',
	CALLBACK_MARKER,
].join('\n'))

/** Redact credential-shaped text before it can enter a callback. */
function redact(value) {
	return value
		.replace(/\b\d{5,}:[A-Za-z0-9_-]{15,}\b/g, '[redacted]')
		.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
}

/** Flatten one value to a single bounded line. */
function oneLine(value, max) {
	if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ''
	const text = redact(String(value)).replace(/\s+/g, ' ').trim()
	if (text === '') return ''
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function valueOf(fields, key) {
	return oneLine(fields?.[key], MAX_VALUE)
}

/**
 * Render the fixed callback template. Malformed required fields fail closed to
 * a minimal safe form; optional empty fields are omitted.
 * @param {unknown} input - fields supplied by the worker.
 * @returns {string} the callback text, at most eight lines.
 */
export function formatDeploymentCallback(input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return MINIMAL
	const what = oneLine(input.what, MAX_WHAT)
	const state = typeof input.state === 'string' ? input.state.trim().toUpperCase() : ''
	if (what === '' || !STATES.has(state)) return MINIMAL
	const lines = [`${what}: ${state}`]
	const changed = valueOf(input, 'changed')
	if (changed !== '') lines.push(`Changed: ${changed}`)
	const verified = valueOf(input, 'verified')
	if (verified !== '') lines.push(`Verified: ${verified}`)
	const stateLine = valueOf(input, 'stateLine') || valueOf(input, 'stateIdentity') || valueOf(input, 'identity')
	if (stateLine !== '') lines.push(`State: ${stateLine}`)
	const live = valueOf(input, 'live')
	const holding = valueOf(input, 'holding')
	const statusValue = state === 'LIVE' ? live : (holding || live)
	if (statusValue !== '') lines.push(`${state === 'LIVE' ? 'Live' : 'Holding'}: ${statusValue}`)
	const gaps = valueOf(input, 'gaps')
	if (gaps !== '') lines.push(`Gaps: ${gaps}`)
	lines.push(CALLBACK_MARKER)
	const meta = {
		kind: 'deployment',
		title: what,
		state,
	}
	if (changed !== '') meta.changed = changed
	if (verified !== '') meta.verified = verified
	if (stateLine !== '') meta.stateLine = stateLine
	if (live !== '') meta.live = live
	if (holding !== '') meta.holding = holding
	if (gaps !== '') meta.gaps = gaps
	if (typeof input.session === 'string' && input.session.trim() !== '') meta.session = oneLine(input.session, 120)
	if (typeof input.reason === 'string' && input.reason.trim() !== '') meta.reason = oneLine(input.reason, 80)
	if (Number.isFinite(input.durationMs)) meta.durationMs = input.durationMs
	return withMachineMeta(lines.slice(0, MAX_CALLBACK_LINES).join('\n'), meta)
}
