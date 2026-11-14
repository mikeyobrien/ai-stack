/**
 * Telegram photo handling for the owner agent.
 *
 * A photo update downloads the largest size, verifies it is a supported raster
 * image, stores it through the same durable attachment service the chat panel
 * uses, and hands the reference to the owner prompt path with an optional
 * caption. That path is the normal gate/ingress path, so a photo behaves like
 * an image attached in the panel (source kind `user`) and no upstream semantics
 * change.
 *
 * @module @local/dsh-sidebar-agent/photo
 */

/** The largest photo size entry Telegram marks or the final array member. */
export function largestPhotoSize(photo) {
	if (!Array.isArray(photo) || photo.length === 0) return null
	const last = photo[photo.length - 1]
	if (last === undefined || typeof last?.file_id !== 'string') return null
	return last
}

/** A photo descriptor for the message, or null when the message has no photo. */
export function photoAttachment(message) {
	const size = largestPhotoSize(message?.photo)
	if (size === null) return null
	return {
		fileId: size.file_id,
		fileSize: Number.isSafeInteger(size.file_size) ? size.file_size : undefined,
		width: size.width,
		height: size.height,
		name: 'photo.jpg',
	}
}

/** Caption text prefixed to the image, or the default line when none was sent. */
export function photoCaption(message) {
	const caption = typeof message?.caption === 'string' ? message.caption.trim() : ''
	return caption === '' ? 'Photo' : `Photo: ${caption}`
}

/** Bound and sanitize one error for a Telegram reply. */
export function photoErrorText(error) {
	const message = String(error?.message ?? error ?? 'unknown error')
	return message
		.replace(/\b\d{5,}:[A-Za-z0-9_-]{15,}\b/g, '[redacted]')
		.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
		.slice(0, 300)
}

/** Sniff the encoded image type from leading bytes; null when unsupported. */
export function imageMediaTypeOf(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
		&& bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
	return null
}

/** Telegram photo updates never exceed this raw download size. */
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024

/**
 * Download and store one photo, then submit it to the owner prompt path.
 * Every failure path replies once and returns a handled result; nothing
 * vanishes silently and no duplicate update is applied twice (requestId).
 * @param {object} options - dependencies.
 * @param {object} options.message - the Telegram message carrying `photo`.
 * @param {object} options.attachment - photoAttachment result.
 * @param {string} options.sessionId - the owner agent's session id.
 * @param {object} options.bridge - composed bridge (api getFile/downloadFile).
 * @param {object} options.attachments - host attachment store (saveImages).
 * @param {object} options.ownerController - owner prompt controller.
 * @param {Record<string, any>} [options.logger] - logger.
 * @returns {Promise<object>} handled result.
 */
export async function handlePhotoUpdate({ message, attachment, sessionId, bridge, attachments, ownerController, logger = console }) {
	const chatId = message?.chat?.id
	const threadId = message?.message_thread_id ?? 0
	const reply = (text) => bridge.api.sendMessage({ chatId, threadId, text })
	try {
		if (Number.isSafeInteger(attachment.fileSize) && attachment.fileSize > MAX_PHOTO_BYTES) {
			await reply('That photo is larger than 20 MB; please send a smaller one.')
			return { handled: true, reason: 'photo-too-large' }
		}
		const file = await bridge.api.getFile(attachment.fileId)
		const downloaded = await bridge.api.downloadFile(file.file_path)
		const bytes = downloaded?.bytes instanceof Uint8Array ? downloaded.bytes : new Uint8Array()
		const mediaType = imageMediaTypeOf(bytes)
		if (mediaType === null) {
			await reply('I could not read that image format; please send a PNG, JPEG, WebP or GIF photo.')
			return { handled: true, reason: 'photo-unsupported-format' }
		}
		if (bytes.length > MAX_PHOTO_BYTES) {
			await reply('That photo is larger than 20 MB; please send a smaller one.')
			return { handled: true, reason: 'photo-too-large' }
		}
		const [reference] = await attachments.saveImages([{ data: bytes, mediaType, name: attachment.name }])
		const caption = photoCaption(message)
		const requestId = Number.isSafeInteger(message?.message_id) ? `tg-photo:${chatId}:${threadId}:${message.message_id}` : undefined
		const result = await ownerController.prompt({
			...(requestId === undefined ? {} : { requestId }),
			sessionId,
			content: [{ type: 'text', text: caption }, { type: 'image', attachment: reference }],
		})
		return { handled: true, prompted: true, attachment: reference, result }
	} catch (error) {
		const detail = photoErrorText(error)
		try {
			await reply(`I could not process that photo (${detail}). Please try again or describe it in text.`)
		} catch (replyError) {
			logger?.warn?.(`[sidebar-agent] photo-error reply failed: ${photoErrorText(replyError)}`)
		}
		logger?.warn?.(`[sidebar-agent] photo-error path=photo-error ${detail}`)
		return { handled: true, reason: 'photo-error', error: detail }
	}
}
