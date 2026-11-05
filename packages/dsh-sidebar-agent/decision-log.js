/**
 * Append-only, batched, rotated decision log for the ingress gate.
 *
 * Records are bounded field data only; message text is never accepted here.
 * @module @local/dsh-sidebar-agent/decision-log
 */

import { mkdir, open, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const MAX_BUFFER_BYTES = 32 * 1024

/**
 * Create one decision log.
 * @param {object} options - log options.
 * @param {string} options.path - ndjson path.
 * @param {number} [options.maxBytes] - rotate before this size (default 5 MB).
 * @param {number} [options.flushMs] - batch window (default 100 ms).
 * @param {Record<string, any>} [options.logger] - warnings only.
 * @returns {Record<string, any>} append/flush/close handle.
 */
export function createDecisionLog({ path, maxBytes = DEFAULT_MAX_BYTES, flushMs = 100, logger = console } = {}) {
	let buffer = []
	let timer = null
	let tail = Promise.resolve()
	let closed = false

	const schedule = () => {
		if (timer !== null || closed) return
		timer = setTimeout(() => { timer = null; void flush() }, flushMs)
		timer.unref?.()
	}

	async function writeBatch(batch) {
		if (batch === '') return
		await mkdir(dirname(path), { recursive: true })
		let size = 0
		try {
			size = (await stat(path)).size
		} catch {
			size = 0
		}
		if (size > 0 && size + Buffer.byteLength(batch) > maxBytes) {
			try {
				await rename(path, `${path}.1`)
			} catch (error) {
				if (error?.code !== 'ENOENT') throw error
			}
			size = 0
		}
		const handle = await open(path, 'a')
		try {
			await handle.write(batch)
			await handle.sync()
		} finally {
			await handle.close()
		}
	}

	async function flush() {
		if (timer !== null) {
			clearTimeout(timer)
			timer = null
		}
		const batch = buffer.join('')
		buffer = []
		if (batch !== '') {
			tail = tail.then(() => writeBatch(batch)).catch((error) => {
				logger?.warn?.(`[sidebar-agent] decision log write failed: ${error?.message ?? error}`)
			})
		}
		return tail
	}

	return {
		/**
		 * Append one record; never throws into the ingress path.
		 * @param {Record<string, any>} record - bounded decision record.
		 */
		append(record) {
			if (closed) return
			const line = `${JSON.stringify(record)}\n`
			buffer.push(line)
			if (buffer.reduce((sum, value) => sum + Buffer.byteLength(value), 0) >= MAX_BUFFER_BYTES) void flush()
			else schedule()
		},
		flush,
		async close() {
			closed = true
			await flush()
		},
	}
}
