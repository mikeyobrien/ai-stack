/**
 * Telegram voice-note transcription through the local Parakeet STT.
 *
 * The bot downloads the file, posts it as OpenAI-compatible multipart to the
 * configured local endpoint, then hands the transcript to the owner prompt
 * path. That path is the normal gate/ingress path, so a voice note behaves like
 * typed text (source kind `user`) and no upstream semantics change.
 *
 * @module @local/dsh-mov-agent/voice
 */

export const MAX_VOICE_BYTES = 20 * 1024 * 1024
const AUDIO_DOCUMENT = /^audio\//i

/** A voice/audio upload descriptor, or null for a non-audio message. */
export function voiceAttachment(message) {
	const voice = message?.voice
	if (voice !== undefined && typeof voice.file_id === 'string') {
		return { fileId: voice.file_id, fileSize: voice.file_size, mimeType: voice.mime_type ?? 'audio/ogg', name: 'voice.ogg' }
	}
	const audio = message?.audio
	if (audio !== undefined && typeof audio.file_id === 'string') {
		return { fileId: audio.file_id, fileSize: audio.file_size, mimeType: audio.mime_type ?? 'audio/mpeg', name: audio.file_name ?? 'audio.mp3' }
	}
	const document = message?.document
	if (document !== undefined && typeof document.file_id === 'string' && AUDIO_DOCUMENT.test(String(document.mime_type ?? ''))) {
		return { fileId: document.file_id, fileSize: document.file_size, mimeType: document.mime_type, name: document.file_name ?? 'audio' }
	}
	return null
}

/** Bound and sanitize one error for a Telegram reply. */
export function voiceErrorText(error) {
	const message = String(error?.message ?? error ?? 'unknown error')
	return message.replace(/\b\d{5,}:[A-Za-z0-9_-]{15,}\b/g, '[redacted]').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]').slice(0, 300)
}

/**
 * Transcribe one downloaded Telegram audio attachment.
 * @param {object} options - dependencies.
 * @param {object} options.bridge - composed bridge (api getFile/downloadFile).
 * @param {object} options.attachment - voiceAttachment result.
 * @param {Record<string, any>} options.stt - {url, model, timeoutMs}.
 * @param {typeof fetch} [options.fetch] - injectable transport.
 * @param {Record<string, any>} [options.logger] - logger.
 * @returns {Promise<string>} transcript text.
 */
export async function transcribeVoice({ bridge, attachment, stt, fetch = globalThis.fetch, logger = console }) {
	if (!stt || stt.enabled !== true) throw new Error('voice transcription is disabled')
	if (typeof bridge?.api?.getFile !== 'function' || typeof bridge?.api?.downloadFile !== 'function') throw new Error('Telegram file API is unavailable')
	const timeoutMs = Number.isFinite(stt.timeoutMs) && stt.timeoutMs > 0 ? stt.timeoutMs : 15000
	const signal = AbortSignal.timeout(timeoutMs)
	const file = await bridge.api.getFile(attachment.fileId, { signal })
	const size = Number.isSafeInteger(attachment.fileSize) ? attachment.fileSize : file?.file_size
	if (Number.isSafeInteger(size) && size > MAX_VOICE_BYTES) throw new Error('voice file is larger than 20 MB')
	const downloaded = await bridge.api.downloadFile(file.file_path, { signal })
	const form = new FormData()
	form.append('file', new Blob([downloaded.bytes], { type: attachment.mimeType }), attachment.name)
	form.append('model', stt.model)
	form.append('response_format', 'json')
	let response
	try {
		response = await fetch(stt.url, { method: 'POST', body: form, signal })
	} catch (error) {
		logger?.warn?.(`[sidebar-agent] voice-error path=voice-error ${voiceErrorText(error)}`)
		throw new Error(`STT request failed: ${voiceErrorText(error)}`)
	}
	if (!response.ok) {
		logger?.warn?.(`[sidebar-agent] voice-error path=voice-error STT ${response.status}`)
		throw new Error(`STT answered ${response.status}`)
	}
	let payload
	try { payload = await response.json() } catch { throw new Error('STT returned malformed JSON') }
	const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
	if (text === '') {
		logger?.warn?.('[sidebar-agent] voice-error path=voice-error STT returned empty text')
		throw new Error('STT returned empty text')
	}
	logger?.info?.('[sidebar-agent] voice path=voice')
	return text
}

/**
 * Handle one Telegram voice/audio message; returns null when not applicable.
 * @param {object} options - dependencies.
 * @param {object} options.message - Telegram message.
 * @param {object} options.bridge - composed bridge.
 * @param {object} options.ownerController - owner prompt controller.
 * @param {Record<string, any>} options.stt - STT config.
 * @param {Record<string, any>} [options.logger] - logger.
 * @param {any} [options.fetch] - injectable transport.
 * @returns {Promise<Record<string, any> | null>} handled result or null.
 */
export async function handleVoiceUpdate({ message, sessionId, bridge, ownerController, stt, logger = console, fetch = globalThis.fetch }) {
	const attachment = voiceAttachment(message)
	if (attachment === null) {
		if (stt?.enabled === true && (message.document !== undefined || message.audio !== undefined)) {
			const chatId = message.chat?.id
			const threadId = message.message_thread_id ?? 0
			await bridge.api.sendMessage({ chatId, threadId, text: 'I can transcribe voice notes and audio files, but not that attachment type.' })
			logger?.warn?.('[sidebar-agent] voice-error path=voice-error unsupported attachment')
			return { handled: true, reason: 'voice-unsupported' }
		}
		return null
	}
	const chatId = message.chat?.id
	const threadId = message.message_thread_id ?? 0
	if (Number.isSafeInteger(attachment.fileSize) && attachment.fileSize > MAX_VOICE_BYTES) {
		await bridge.api.sendMessage({ chatId, threadId, text: 'That voice note is larger than 20 MB; please send a shorter one.' })
		logger?.warn?.('[sidebar-agent] voice-error path=voice-error file >20MB')
		return { handled: true, reason: 'voice-too-large' }
	}
	let text
	try {
		text = await transcribeVoice({ bridge, attachment, stt, fetch, logger })
	} catch (error) {
		try {
			await bridge.api.sendMessage({
				chatId, threadId,
				text: `I could not transcribe that voice note (${voiceErrorText(error)}). Please try again or send it as text.`,
			})
		} catch (sendError) {
			logger?.warn?.(`[sidebar-agent] voice-error reply failed: ${voiceErrorText(sendError)}`)
		}
		logger?.warn?.(`[sidebar-agent] voice-error path=voice-error ${voiceErrorText(error)}`)
		return { handled: true, reason: 'voice-error' }
	}
	const requestId = Number.isSafeInteger(message.message_id) ? `tg-voice:${chatId}:${threadId}:${message.message_id}` : undefined
	const marked = `🎤 ${text}`
	const result = await ownerController.prompt({
		...(requestId === undefined ? {} : { requestId }),
		sessionId,
		content: [{ type: 'text', text: marked }],
	})
	return { handled: true, prompted: true, text: marked, result }
}
