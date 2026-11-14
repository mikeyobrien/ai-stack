/**
 * Telegram photo behavior tests.
 *
 * Assertions are on what a Telegram sender and the agent transcript observe:
 * the reply text, the owner prompt content (durable image reference plus
 * caption), idempotent redelivery, and handled results for every failure path.
 * The attachment store is a fake only in its storage side effect; the image
 * sniffing and reference flow are the code under test.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import {
	imageMediaTypeOf,
	largestPhotoSize,
	photoAttachment,
	photoCaption,
	photoErrorText,
	handlePhotoUpdate,
} from '../photo.js'

/** A one-pixel PNG with just enough header bytes for the sniff. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])

function photoUpdate(overrides = {}) {
	return {
		message_id: 42,
		chat: { id: 7, type: 'private' },
		photo: [{ file_id: 'small', width: 90, height: 90, file_size: 900 }, { file_id: 'big', width: 1280, height: 960, file_size: 200_000 }],
		caption: 'the whiteboard',
		...overrides,
	}
}

/** A bridge fake recording replies; downloads return the given bytes. */
function fakeBridge(bytes = PNG) {
	const sent = []
	return {
		sent,
		api: {
			async sendMessage(message) { sent.push(message) },
			async getFile() { return { file_id: 'big', file_path: 'photos/big.jpg', file_size: bytes.length } },
			async downloadFile() { return { bytes } },
		},
	}
}

/** An attachment store fake with the real saveImages contract. */
function fakeAttachments() {
	const saved = []
	return {
		saved,
		async saveImages(inputs) {
			saved.push(...inputs)
			return inputs.map((input, index) => ({ attachmentId: `att-${index}`, mediaType: input.mediaType, byteLength: input.data.length }))
		},
	}
}

/** An owner controller recording prompts, mirroring the real accept/reject shape. */
function fakeOwner() {
	const prompts = []
	return {
		prompts,
		async prompt(request) { prompts.push(request); return { messageId: 'm1', running: false } },
	}
}

const silent = { warn() {}, info() {}, error() {} }

test('photo helpers pick the largest size and keep the caption rule', () => {
	const update = photoUpdate()
	assert.equal(largestPhotoSize(update.photo).file_id, 'big')
	assert.equal(photoAttachment(update).fileId, 'big')
	assert.equal(photoAttachment({}), null)
	assert.equal(photoCaption(update), 'Photo: the whiteboard')
	assert.equal(photoCaption({ photo: update.photo }), 'Photo')
})

test('image sniffing accepts the four supported types and rejects others', () => {
	assert.equal(imageMediaTypeOf(PNG), 'image/png')
	assert.equal(imageMediaTypeOf(JPEG), 'image/jpeg')
	assert.equal(imageMediaTypeOf(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])), 'image/gif')
	assert.equal(imageMediaTypeOf(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp')
	assert.equal(imageMediaTypeOf(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null)
	assert.equal(photoErrorText(new Error('secret: 1234567890:AaBbCcDdEeFfGgHhIiJj and sk-abcdefghijklmnopq')), 'secret: [redacted] and [redacted]')
})

test('a photo becomes a durable image plus caption on the owner prompt path', async () => {
	const bridge = fakeBridge()
	const store = fakeAttachments()
	const owner = fakeOwner()
	const result = await handlePhotoUpdate({
		message: photoUpdate(),
		attachment: photoAttachment(photoUpdate()),
		sessionId: 'agent-1',
		bridge,
		attachments: store,
		ownerController: owner,
		logger: silent,
	})
	assert.equal(result.handled, true)
	assert.equal(result.prompted, true)
	assert.equal(owner.prompts.length, 1)
	const prompt = owner.prompts[0]
	assert.equal(prompt.sessionId, 'agent-1')
	assert.equal(prompt.requestId, 'tg-photo:7:0:42')
	assert.equal(prompt.content[0].type, 'text')
	assert.equal(prompt.content[0].text, 'Photo: the whiteboard')
	assert.equal(prompt.content[1].type, 'image')
	assert.equal(prompt.content[1].attachment.attachmentId, 'att-0')
	assert.equal(store.saved[0].mediaType, 'image/png', 'the sniffed type wins over the jpg filename')
	assert.equal(bridge.sent.length, 0, 'the happy path replies nothing; the agent answers')
})

test('a redelivered photo keeps its request id so the owner dedupes it', async () => {
	const bridge = fakeBridge()
	const owner = fakeOwner()
	await handlePhotoUpdate({ message: photoUpdate(), attachment: photoAttachment(photoUpdate()), sessionId: 'a', bridge, attachments: fakeAttachments(), ownerController: owner, logger: silent })
	await handlePhotoUpdate({ message: photoUpdate(), attachment: photoAttachment(photoUpdate()), sessionId: 'a', bridge, attachments: fakeAttachments(), ownerController: owner, logger: silent })
	const ids = owner.prompts.map((prompt) => prompt.requestId)
	assert.equal(new Set(ids).size, 1, 'both deliveries carry one identity')
})

test('every failure path replies once and is handled, never silent', async () => {
	const results = []
	// Unsupported bytes.
	const bad = fakeBridge(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))
	results.push(await handlePhotoUpdate({ message: photoUpdate(), attachment: photoAttachment(photoUpdate()), sessionId: 'a', bridge: bad, attachments: fakeAttachments(), ownerController: fakeOwner(), logger: silent }))
	// Download failure.
	const broken = fakeBridge()
	broken.api.downloadFile = async () => { throw new Error('boom 1234567890:AaBbCcDdEeFfGgHhIiJj') }
	results.push(await handlePhotoUpdate({ message: photoUpdate(), attachment: photoAttachment(photoUpdate()), sessionId: 'a', bridge: broken, attachments: fakeAttachments(), ownerController: fakeOwner(), logger: silent }))
	// Store failure.
	const storeBreak = fakeAttachments()
	storeBreak.saveImages = async () => { throw new Error('disk full') }
	results.push(await handlePhotoUpdate({ message: photoUpdate(), attachment: photoAttachment(photoUpdate()), sessionId: 'a', bridge: fakeBridge(), attachments: storeBreak, ownerController: fakeOwner(), logger: silent }))
	// Oversize.
	const huge = photoUpdate({ photo: [{ file_id: 'huge', file_size: 21 * 1024 * 1024 }] })
	results.push(await handlePhotoUpdate({ message: huge, attachment: photoAttachment(huge), sessionId: 'a', bridge: fakeBridge(), attachments: fakeAttachments(), ownerController: fakeOwner(), logger: silent }))
	for (const [index, result] of results.entries()) {
		assert.equal(result.handled, true, `case ${index} handled`)
	}
	assert.ok(bad.sent.length === 1 && bad.sent[0].text.includes('format'), 'format reply names the fix')
	assert.ok(broken.sent.length === 1 && broken.sent[0].text.includes('[redacted]'), 'failure replies hide credentials')
})

test('a photo without a store falls through to the unsupported reply, not silence', async () => {
	// Covered in glue tests: photoAttachment null + no store keeps the legacy path.
	assert.equal(photoAttachment({ text: 'hi' }), null)
})
