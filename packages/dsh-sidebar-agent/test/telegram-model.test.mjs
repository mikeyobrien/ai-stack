import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { __internals } from '../index.js'
import { createTelegramHost } from '../telegram-host.js'
import { FakeBotApi } from '../../dsh-telegram-session-bridge/test/helpers/fake-bot-api.js'
import { createBridge } from '../../dsh-telegram-session-bridge/src/bridge.js'
import { dmKey } from '../../dsh-telegram-session-bridge/src/state.js'

const { createOwnerModelControl, chatStatus } = __internals
const AGENT = 'agent-model-1'
const DM = dmKey({ botId: 777, chatId: 42, senderId: 42 })
const silent = { debug() {}, info() {}, warn() {}, error() {} }

function modelCatalog() {
	const models = [
		{ id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
		{ id: 'm2', name: 'Model Two', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
		{ id: 'm3', name: 'Model Three', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } },
		{ id: 'plain', name: 'Plain Model' },
	]
	return {
		models,
		llm: {
			listProviders() { return [{ id: 'p', name: 'Provider P' }] },
			async listModels() { return models.map(({ id, name }) => ({ id, name })) },
			async resolveModelInfo(provider, model) {
				const found = models.find((entry) => entry.id === model)
				if (provider !== 'p' || found === undefined) throw new Error(`unknown model ${provider}/${model}`)
				return { provider, id: found.id, name: found.name, reasoning: found.reasoning }
			},
		},
	}
}

async function harness(t, { current = { provider: 'p', model: 'm1', reasoningEffort: 'high' }, allowedChatIds = [42] } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-agent-model-'))
	const fake = await new FakeBotApi({ token: '777:model-token' }).start()
	const catalog = modelCatalog()
	const events = []
	const session = {
		id: AGENT,
		surface: { nodes: [] },
		append(type, data) { events.push({ type, data }) },
		snapshotEvents() { return events },
		requestHeader() { return undefined },
	}
	const calls = { steer: 0, followup: 0, cancel: 0, prompt: 0, create: 0 }
	const agent = {
		session,
		status: 'idle',
		options: { provider: 'p', model: 'm1' },
		steer() { calls.steer += 1 },
		followup() { calls.followup += 1 },
		cancel() { calls.cancel += 1 },
	}
	const runtime = {
		ready: true, title: 'Agent', sessionId: AGENT, agent,
		selectionRef: { current }, model: current, delegations: new Map(),
		streamText: null, catalogCache: null, telegram: null, settingsNs: 'sidebar-agent',
	}
	const ctx = {
		events,
		llm: catalog.llm,
		sessionQuery: {
			async observeSession() {
				return { events: [...events], projections: { values: {} }, [Symbol.dispose]() {} }
			},
		},
	}
	const forward = {
		async prompt() { calls.prompt += 1; throw new Error('ordinary session controller must not be used for /model') },
		async cancel() { throw new Error('ordinary cancel must not be used for /model') },
		async list() { return { items: [] } },
		async create() { calls.create += 1; return { sessionId: 'ordinary-new' } },
		async inspect() { return { events: [] } },
	}
	const modelControl = createOwnerModelControl(ctx, runtime)
	const glue = createTelegramHost({
		runtime,
		modelControl,
		config: { enabled: true, tokenRef: 'T', allowedChatIds, dshHome: root, poll: false, baseUrl: fake.baseUrl },
		env: { T: '777:model-token' },
		forward: () => forward,
		importBridge: async () => ({ createBridge }),
		install: () => () => {},
		logger: silent,
		clock: () => 1_700_000_000_000,
	})
	t.after(async () => {
		await glue.stop().catch(() => {})
		await fake.stop().catch(() => {})
		await rm(root, { recursive: true, force: true })
	})
	await glue.start()
	await glue.bridge.store.setDm({ key: DM, sessionId: AGENT, mode: 'created' })
	await glue.bridge.registerCommands()
	return { root, fake, ctx, runtime, events, calls, forward, glue, modelControl }
}

function dmUpdate(text, id = 1) {
	return { update_id: id, message: { message_id: 100 + id, chat: { id: 42, type: 'private' }, from: { id: 42 }, text } }
}

function callback(glue, data, { chatId = 42, senderId = 42, threadId = 0, messageId = 1, id = 'cb' } = {}) {
	return glue.handleUpdate({
		update_id: 900,
		callback_query: {
			id,
			from: { id: senderId },
			message: { message_id: messageId, chat: { id: chatId, type: 'private' }, message_thread_id: threadId },
			data,
		},
	})
}

function pickerButton(fake, label, messageIndex = -1) {
	const message = fake.messages.at(messageIndex)
	const buttons = (message?.reply_markup?.inline_keyboard ?? []).flat()
	return buttons.find((button) => new RegExp(label).test(button.text)) ?? buttons[0]
}

test('/model reports the actual model, offers the catalog, and a callback switches the same owner selection', async (t) => {
	const h = await harness(t)
	const result = await h.glue.handleUpdate(dmUpdate('/model'))
	assert.equal(result.handled, true)
	assert.equal(result.command, '/model')
	assert.equal(typeof result.messageId, 'number')
	const message = h.fake.messages.at(-1)
	assert.match(message.text, /Model:/)
	assert.match(message.text, /p\/m1/)
	const buttons = message.reply_markup.inline_keyboard.flat()
	assert.equal(buttons.length, 4)
	assert.equal(h.glue.status().model.registered, true)
	assert.equal(h.glue.bridge.modelDiscovery.registered, true)
	assert.equal(h.glue.bridge.modelDiscovery.chats[0].confirmed, true)
	assert.equal(h.fake.commandsByScope['chat:42'].find((entry) => entry.command === 'model').description, "Choose this Agent's model")
	for (const button of buttons) assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64, button.callback_data)
	const selected = pickerButton(h.fake, 'Model Two')
	const applied = await callback(h.glue, selected.callback_data, { messageId: result.messageId })
	assert.equal(applied.accepted, true)
	assert.deepEqual(h.runtime.selectionRef.current, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.deepEqual(chatStatus(h.runtime).model, { provider: 'p', model: 'm2', reasoningEffort: 'high' })
	assert.equal(h.events.filter((event) => event.type === 'model/selection').length, 1)
	assert.equal(h.calls.cancel, 0)
	assert.equal(h.calls.prompt, 0)
	assert.equal(h.calls.steer + h.calls.followup, 0, '/model is control, never a prompt')
})

test('/model p/plain uses the canonical form and clears unsupported effort', async (t) => {
	const h = await harness(t)
	const result = await h.glue.handleUpdate(dmUpdate('/model p/plain'))
	assert.equal(result.handled, true)
	assert.deepEqual(h.runtime.selectionRef.current, { provider: 'p', model: 'plain' })
	assert.match(h.fake.messages.at(-1).text, /Plain Model|p\/plain/)
	const unknown = await h.glue.handleUpdate(dmUpdate('/model p/missing', 2))
	assert.match(h.fake.messages.at(-1).text, /Unknown model|unknown/i)
	assert.deepEqual(h.runtime.selectionRef.current, { provider: 'p', model: 'plain' })
	assert.equal(unknown.handled, true)
})

test('the picker supplies an explicit supported default when the current effort is not offered', async (t) => {
	const h = await harness(t)
	const result = await h.glue.handleUpdate(dmUpdate('/model'))
	const selected = pickerButton(h.fake, 'Model Three')
	const applied = await callback(h.glue, selected.callback_data, { messageId: result.messageId })
	assert.equal(applied.accepted, true)
	assert.deepEqual(h.runtime.selectionRef.current, { provider: 'p', model: 'm3', reasoningEffort: 'medium' })
	const canonical = await h.glue.handleUpdate(dmUpdate('/model p/m3', 2))
	assert.deepEqual(h.runtime.selectionRef.current, { provider: 'p', model: 'm3', reasoningEffort: 'medium' })
	assert.equal(canonical.command, '/model')
})

test('a setter failure is actionable and preserves the good selection', async (t) => {
	const h = await harness(t)
	const append = h.runtime.agent.session.append
	h.runtime.agent.session.append = () => { throw new Error('durable append failed') }
	const result = await h.glue.handleUpdate(dmUpdate('/model p/m2'))
	assert.match(h.fake.messages.at(-1).text, /durable append failed/)
	assert.deepEqual(h.runtime.selectionRef.current, { provider: 'p', model: 'm1', reasoningEffort: 'high' })
	assert.equal(result.handled, true)
	h.runtime.agent.session.append = append
})

test('a replayed callback applies once and later presses are stale', async (t) => {
	const h = await harness(t)
	const result = await h.glue.handleUpdate(dmUpdate('/model'))
	const selected = pickerButton(h.fake, 'Model Two')
	const first = await callback(h.glue, selected.callback_data, { messageId: result.messageId, id: 'cb-1' })
	assert.equal(first.accepted, true)
	const count = h.events.filter((event) => event.type === 'model/selection').length
	const second = await callback(h.glue, selected.callback_data, { messageId: result.messageId, id: 'cb-2' })
	assert.equal(second.accepted, false)
	assert.equal(h.events.filter((event) => event.type === 'model/selection').length, count)
	assert.equal(h.runtime.selectionRef.current.model, 'm2')
	assert.ok(h.fake.callbackAnswers.some((answer) => /no longer active/i.test(answer.text)))
})

test('forged, cross-chat, cross-sender, cross-thread and stale callbacks cannot change the selection', async (t) => {
	const h = await harness(t)
	assert.equal((await callback(h.glue, 'm:forged:0')).accepted, false)
	assert.equal(h.events.length, 0)

	const first = await h.glue.handleUpdate(dmUpdate('/model'))
	const data = pickerButton(h.fake, 'Model Two').callback_data
	const crossChat = await callback(h.glue, data, { chatId: 43, senderId: 43, messageId: first.messageId, id: 'cb-cross-chat' })
	assert.equal(crossChat.accepted, false)
	const crossSender = await callback(h.glue, data, { chatId: 42, senderId: 43, messageId: first.messageId, id: 'cb-cross-sender' })
	assert.equal(crossSender.accepted, false)
	const crossThread = await callback(h.glue, data, { chatId: 42, senderId: 42, threadId: 1, messageId: first.messageId, id: 'cb-cross-thread' })
	assert.equal(crossThread.accepted, false)
	assert.equal(h.events.length, 0)

	await h.glue.bridge.store.unbindDm(DM)
	const unbound = await callback(h.glue, data, { messageId: first.messageId, id: 'cb-unbound' })
	assert.equal(unbound.accepted, false)
	assert.equal(h.events.length, 0)
	assert.deepEqual(h.runtime.selectionRef.current, { provider: 'p', model: 'm1', reasoningEffort: 'high' })
})

test('a normal-session binding and an unauthorized chat do not expose model control', async (t) => {
	const h = await harness(t)
	await h.glue.bridge.store.bind({ chatId: 42, threadId: 5, sessionId: 'ordinary-session' })
	const normal = await h.glue.handleUpdate({
		update_id: 50,
		message: { message_id: 50, chat: { id: 42, type: 'supergroup' }, message_thread_id: 5, from: { id: 42 }, text: '/model' },
	})
	assert.equal(normal.handled, true)
	assert.match(h.fake.messages.at(-1).text, /only available|sidebar Agent/i)
	assert.equal(h.events.length, 0)

	const before = h.fake.messages.length
	const unauthorized = await h.glue.handleUpdate({
		update_id: 51,
		message: { message_id: 51, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/model' },
	})
	assert.equal(unauthorized.handled, false)
	assert.equal(h.fake.messages.length, before)
})

test('a busy Agent accepts a model switch without cancelling or prompting, and /help exposes /model', async (t) => {
	const h = await harness(t)
	h.runtime.agent.status = 'running'
	await h.glue.handleUpdate(dmUpdate('/help'))
	assert.match(h.fake.messages.at(-1).text, /\/model/)
	const result = await h.glue.handleUpdate(dmUpdate('/model', 2))
	const selected = pickerButton(h.fake, 'Model Two')
	const applied = await callback(h.glue, selected.callback_data, { messageId: result.messageId })
	assert.equal(applied.accepted, true)
	assert.equal(h.runtime.selectionRef.current.model, 'm2')
	assert.equal(h.calls.cancel, 0)
	assert.equal(h.calls.prompt, 0)
	assert.equal(h.calls.steer + h.calls.followup, 0)
})


test('the production poller dispatches /model and its callback through the patched handler', async (t) => {
	const h = await harness(t)
	const messageUpdate = (updateId, text) => ({
		update_id: updateId,
		message: { message_id: 100 + updateId, chat: { id: 42, type: 'private' }, from: { id: 42 }, text },
	})
	const callbackUpdate = (updateId, data, messageId, callbackId) => ({
		update_id: updateId,
		callback_query: {
			id: callbackId,
			from: { id: 42 },
			message: { message_id: messageId, chat: { id: 42, type: 'private' }, message_thread_id: 0 },
			data,
		},
	})

	h.fake.pushUpdate(messageUpdate(1, '/model'))
	await h.glue.bridge.pollOnce()
	const picker = h.fake.messages.at(-1)
	assert.ok(picker, 'the production poller must deliver the picker')
	assert.match(picker.text, /Model:/)
	const buttons = picker.reply_markup.inline_keyboard.flat()
	const pickerMessageId = h.fake.messageId
	const selected = buttons.find((button) => /Model Two/.test(button.text))
	assert.ok(selected)

	h.fake.pushUpdate(callbackUpdate(2, selected.callback_data, pickerMessageId, 'cb-poll-1'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.runtime.selectionRef.current.model, 'm2')
	assert.equal(h.events.filter((event) => event.type === 'model/selection').length, 1)
	assert.ok(h.fake.callbackAnswers.some((answer) => answer.text === 'Model set'))

	// A fresh Telegram press reaches the handler but the one-shot token is stale.
	h.fake.pushUpdate(callbackUpdate(3, selected.callback_data, pickerMessageId, 'cb-poll-2'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.events.filter((event) => event.type === 'model/selection').length, 1)

	// A transport replay is acked by the durable dedupe ledger before dispatch.
	h.fake.pushUpdate(callbackUpdate(2, selected.callback_data, pickerMessageId, 'cb-poll-1'))
	await h.glue.bridge.pollOnce()
	assert.equal(h.events.filter((event) => event.type === 'model/selection').length, 1)
})


test('command registration preserves custom commands and a web-app menu while adding model', async (t) => {
	const h = await harness(t)
	h.fake.commandsByScope.all_private_chats = [
		{ command: 'custom', description: 'Keep this custom command' },
		{ command: 'model', description: 'Old model description' },
		{ command: 'help', description: 'Show help' },
	]
	h.fake.commandsByScope['chat:42'] = []
	h.fake.menuButtons.set(42, { type: 'web_app', web_app: { url: 'https://example.invalid/app' } })
	const discovery = await h.glue.bridge.registerCommands()
	assert.equal(discovery.registered, true)
	const commands = h.fake.commandsByScope['chat:42']
	assert.deepEqual(commands.map((entry) => entry.command), ['custom', 'model', 'help'])
	assert.equal(commands[0].description, 'Keep this custom command')
	assert.equal(commands[1].description, "Choose this Agent's model")
	assert.deepEqual(h.fake.menuButtons.get(42), { type: 'web_app', web_app: { url: 'https://example.invalid/app' } })
	const status = h.glue.status().model
	assert.equal(status.registered, true)
	assert.equal(status.chats[0].scope, 'chat:42')
	assert.equal(status.chats[0].confirmed, true)
	assert.equal(status.chats[0].modelCommand.description, "Choose this Agent's model")
	assert.deepEqual(h.fake.commandsByScope['all_private_chats'].map((entry) => entry.command), ['custom', 'model', 'help'])
})

test('registration failure or a missing readback is reported, never a false success', async (t) => {
	const h = await harness(t)
	h.fake.failSetCommands = true
	const failed = await h.glue.bridge.registerCommands()
	assert.equal(failed.registered, false)
	assert.ok(failed.chats[0].error)
	assert.equal(h.glue.status().model.registered, false)
	h.fake.failSetCommands = false
	h.fake.commandsByScope['chat:42'] = []
	h.fake.dropCommands = true
	const dropped = await h.glue.bridge.registerCommands()
	assert.equal(dropped.registered, false)
	assert.equal(dropped.chats[0].error, 'readback-missing')
	assert.equal(h.glue.status().model.registered, false)
})
