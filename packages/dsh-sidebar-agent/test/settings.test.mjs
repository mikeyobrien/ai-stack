import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, __internals } from '../index.js'
import { DEFAULT_TELEGRAM_TOKEN_REF } from '../telegram-host.js'

const {
	configValue,
	settingsOf,
	effectiveSettings,
	validateSettingsPatch,
	saveSettings,
	settingsNamespace,
	telegramStatusOf,
} = __internals

const NS = 'include:sidebar-agent'
const AGENT_SESSION = 'agent-session-1'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function modelInfo(provider, model) {
	if (provider === 'p' && model === 'm') {
		return { provider: 'p', id: 'm', name: 'Model M', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }
	}
	if (provider === 'p' && model === 'm2') {
		return { provider: 'p', id: 'm2', name: 'Model M2', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }
	}
	if (provider === 'p' && model === 'm3') {
		return { provider: 'p', id: 'm3', name: 'Model M3', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
	}
	if (provider === 'p' && model === 'plain') {
		return { provider: 'p', id: 'plain', name: 'Plain' }
	}
	throw new Error(`unknown model ${provider}/${model}`)
}

function callsBag() {
	return { rename: [], setCwd: [], setModel: [], mutate: [], modelSelections: [] }
}

function fakeRuntime(overrides = {}) {
	const calls = callsBag()
	const agent = {
		session: {
			id: AGENT_SESSION,
			append(type, data) {
				if (type === 'model/selection') calls.modelSelections.push({ type, data })
			},
		},
		status: 'idle',
		options: { provider: 'p', model: 'm' },
		steer(message) { calls.steer = message },
		followup(message) { calls.followup = message },
		cancel(request) { calls.cancel = request },
	}
	const runtime = {
		ready: true,
		error: null,
		title: 'Live Agent',
		cwd: '/stale/row/cwd',
		sessionId: AGENT_SESSION,
		agent,
		selectionRef: { current: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
		model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
		delegations: new Map(),
		telegram: null,
		config: {},
		calls,
		...overrides,
	}
	return runtime
}

function fakeSettings({ descriptor, conflict = false } = {}) {
	const service = {
		describe() {
			if (descriptor === false) return []
			return [descriptor ?? {
				ns: NS,
				autoGenerate: false,
				revision: 3,
				applies: 'live',
				schema: { type: 'object', properties: { title: { type: 'string' } } },
				value: { title: 'Row title', cwd: '/row/cwd', provider: 'row', model: 'row-model' },
			}]
		},
		async mutate(ns, ops, revision) {
			service.mutations.push({ ns, ops, revision })
			if (conflict) throw Object.assign(new Error('settings namespace changed since it was read'), { code: 'SETTINGS_CONFLICT' })
		},
		mutations: [],
	}
	return service
}

function fakeContext({ settings = fakeSettings(), cwd = '/live/dir', editor = undefined, service = settings } = {}) {
	const calls = callsBag()
	const ctx = {
		fiber: { entry: { options: { id: NS } } },
		calls,
		get(name) {
			if (name === 'settings') return service
			if (name === 'configEditor') return editor
			return undefined
		},
		sessionTitle: {
			async rename(session, title) {
				calls.rename.push({ session, title })
			},
		},
		workingDirectory: {
			get() {
				return cwd
			},
			async set(agent, path) {
				calls.setCwd.push({ agent, path })
				cwd = path
				return path
			},
		},
		fs: {
			async resolve(path) {
				return { path }
			},
			async stat(target) {
				if (target?.path === '/missing') return undefined
				if (target?.path === '/a-file') return { type: 'file' }
				return { type: 'directory' }
			},
		},
		llm: {
			async resolveModelInfo(provider, model) {
				return modelInfo(provider, model)
			},
		},
		logger: silent,
	}
	return ctx
}

test('the plugin exports a discoverable Config schema with live editable fields', () => {
	assert.notEqual(Config, undefined)
	const resolved = Config['~standard'].validate({})
	assert.equal(resolved.issues, undefined)
	const config = resolved.value
	assert.equal(config.title.get(), 'Agent')
	assert.equal(config.telegram.enabled, false, 'telegram is off by default')
	assert.deepEqual([...config.telegram.allowedChatIds], [])
	assert.equal(typeof config.cwd?.get, 'function')
	assert.equal(typeof config.provider?.get, 'function')
	assert.equal(typeof config.model?.get, 'function')
	assert.equal(typeof config.reasoningEffort?.get, 'function')
	// Ordinary fields stay ordinary: they are validated but never live-editable.
	assert.equal(typeof config.dataDir?.get, 'undefined')
	assert.equal(typeof config.telegram?.enabled?.get, 'undefined')

	const explicit = Config['~standard'].validate({
		title: 'Sidecar',
		cwd: '/srv/agent',
		dataDir: '/srv/agent-data',
		telegram: { enabled: false, allowedChatIds: [42], tokenRef: 'A_TOKEN' },
	}).value
	assert.equal(explicit.title.get(), 'Sidecar')
	assert.equal(explicit.cwd.get(), '/srv/agent')
	assert.equal(explicit.dataDir, '/srv/agent-data')
	assert.equal(explicit.telegram.tokenRef, 'A_TOKEN')
	assert.deepEqual([...explicit.telegram.allowedChatIds], [42])
})

test('settingsOf reads both plain config and resolved volatile references', () => {
	const plain = settingsOf({})
	assert.equal(plain.title, 'Agent')
	assert.equal(plain.cwd.endsWith('/workspace'), true)
	assert.equal(configValue(plain.provider), undefined)

	const resolved = Config['~standard'].validate({ title: 'Sidecar', cwd: '/srv/agent', dataDir: '/srv/data' }).value
	const settings = settingsOf(resolved)
	assert.equal(settings.title, 'Sidecar')
	assert.equal(settings.cwd, '/srv/agent')
	assert.equal(settings.dataDir, '/srv/data')
	assert.equal(configValue('plain'), 'plain')
	assert.equal(configValue({ get: () => 'ref' }), 'ref')
})

test('the staged activation config validates and keeps the legacy Telegram state home', () => {
	const resolved = Config['~standard'].validate({
		telegram: { enabled: true, allowedChatIds: [5822509701] },
	})
	assert.equal(resolved.issues, undefined)
	const settings = settingsOf(resolved.value)
	assert.equal(settings.telegram.enabled, true)
	assert.deepEqual([...settings.telegram.allowedChatIds], [5822509701])
	assert.equal(settings.telegram.tokenRef, DEFAULT_TELEGRAM_TOKEN_REF)
	assert.equal(settings.telegram.dshHome, undefined, 'the bridge state stays at $DSH_HOME/telegram-session-bridge')
	assert.equal(settings.telegram.poll, true)
})

test('effective settings report the live Agent values, not stale profile defaults', () => {
	const runtime = fakeRuntime()
	const settings = fakeSettings({
		descriptor: {
			ns: NS,
			autoGenerate: false,
			revision: 7,
			applies: 'live',
			schema: { type: 'object', properties: {} },
			value: { title: 'Row title', cwd: '/row/cwd', provider: 'row-provider', model: 'row-model' },
		},
	})
	const ctx = fakeContext({ settings, cwd: '/live/dir' })
	const read = effectiveSettings(ctx, runtime)
	assert.equal(read.ready, true)
	assert.equal(read.revision, 7)
	assert.equal(read.ns, NS)
	assert.equal(read.values.title, 'Live Agent')
	assert.equal(read.values.cwd, '/live/dir')
	assert.deepEqual(read.values.model, { provider: 'p', model: 'm', reasoningEffort: 'high' })
	assert.deepEqual(read.agent, { sessionId: AGENT_SESSION, running: false })
	assert.deepEqual(read.telegram, { state: 'off', enabled: false, binding: { kind: 'none' }, candidates: [] })
	const serialized = JSON.stringify(read)
	assert.ok(!serialized.includes('dataDir'))
	assert.ok(!serialized.includes('/row/cwd'))
	assert.ok(!serialized.includes('token'))
})

test('saving the title renames the live Agent and leaves model/effort untouched', async () => {
	const settings = fakeSettings()
	const ctx = fakeContext({ settings })
	const runtime = fakeRuntime()
	const read = await saveSettings(ctx, runtime, { title: '  Sidecar  ', expectedRevision: 3 })
	assert.deepEqual(settings.mutations, [{ ns: NS, ops: [{ op: 'set', path: ['title'], value: 'Sidecar' }], revision: 3 }])
	assert.equal(runtime.title, 'Sidecar')
	assert.deepEqual(ctx.calls.rename, [{ session: runtime.agent.session, title: 'Sidecar' }])
	assert.equal(ctx.calls.setCwd.length, 0, 'a title edit does not touch the directory')
	assert.deepEqual(runtime.selectionRef.current, { provider: 'p', model: 'm', reasoningEffort: 'high' })
	assert.deepEqual(read.values.model, { provider: 'p', model: 'm', reasoningEffort: 'high' })
	assert.equal(runtime.calls.modelSelections.length, 0, 'a title save writes no model/selection event')
})

test('saving the directory changes the live working directory', async () => {
	const settings = fakeSettings()
	const ctx = fakeContext({ settings })
	const runtime = fakeRuntime()
	const read = await saveSettings(ctx, runtime, { cwd: '/srv/new-agent', expectedRevision: 3 })
	assert.deepEqual(settings.mutations[0].ops, [{ op: 'set', path: ['cwd'], value: '/srv/new-agent' }])
	assert.equal(ctx.calls.setCwd.length, 1)
	assert.equal(ctx.calls.setCwd[0].path, '/srv/new-agent')
	assert.equal(runtime.cwd, '/srv/new-agent')
	assert.equal(read.values.cwd, '/srv/new-agent')
})

test('a model change validates and applies through the existing selection owner', async () => {
	const settings = fakeSettings()
	const ctx = fakeContext({ settings })
	const runtime = fakeRuntime()
	const read = await saveSettings(ctx, runtime, { provider: 'p', model: 'm3', expectedRevision: 3 })
	assert.deepEqual(settings.mutations[0].ops, [
		{ op: 'set', path: ['provider'], value: 'p' },
		{ op: 'set', path: ['model'], value: 'm3' },
		{ op: 'set', path: ['reasoningEffort'], value: 'high' },
	], 'the current effort is preserved when the new model offers it')
	assert.deepEqual(runtime.selectionRef.current, { provider: 'p', model: 'm3', reasoningEffort: 'high' })
	assert.deepEqual(runtime.calls.modelSelections.at(-1).data, { provider: 'p', model: 'm3', reasoningEffort: 'high' })
	assert.equal(read.values.model.model, 'm3')

	const second = fakeSettings()
	const ctx2 = fakeContext({ settings: second })
	const runtime2 = fakeRuntime()
	await saveSettings(ctx2, runtime2, { provider: 'p', model: 'm2', expectedRevision: 3 })
	assert.deepEqual(runtime2.selectionRef.current, { provider: 'p', model: 'm2' }, 'an unoffered effort is cleared to Default')
	assert.deepEqual(runtime2.calls.modelSelections.at(-1).data, { provider: 'p', model: 'm2' })
	assert.deepEqual(second.mutations[0].ops, [
		{ op: 'set', path: ['provider'], value: 'p' },
		{ op: 'set', path: ['model'], value: 'm2' },
		{ op: 'unset', path: ['reasoningEffort'] },
	])
})

test('changing only thinking keeps the current model and can reset to default', async () => {
	const settings = fakeSettings()
	const ctx = fakeContext({ settings })
	const runtime = fakeRuntime()
	await saveSettings(ctx, runtime, { reasoningEffort: 'low', expectedRevision: 3 })
	assert.deepEqual(runtime.selectionRef.current, { provider: 'p', model: 'm', reasoningEffort: 'low' })
	assert.deepEqual(settings.mutations[0].ops, [{ op: 'set', path: ['reasoningEffort'], value: 'low' }])

	const reset = fakeSettings()
	const ctx2 = fakeContext({ settings: reset })
	const runtime2 = fakeRuntime()
	await saveSettings(ctx2, runtime2, { reasoningEffort: null, expectedRevision: 3 })
	assert.deepEqual(runtime2.selectionRef.current, { provider: 'p', model: 'm' })
	assert.deepEqual(runtime2.calls.modelSelections.at(-1).data, { provider: 'p', model: 'm' }, 'Default clears the durable effort')
	assert.deepEqual(reset.mutations[0].ops, [{ op: 'unset', path: ['reasoningEffort'] }])
})

test('invalid edits reject before anything is persisted or applied', async () => {
	const cases = [
		[{ title: '' }, /title/i],
		[{ title: '   ' }, /title/i],
		[{ title: 'x'.repeat(200) }, /title/i],
		[{ cwd: 'relative/path' }, /absolute|cwd|directory/i],
		[{ cwd: '/missing' }, /directory/i],
		[{ cwd: '/a-file' }, /directory/i],
		[{ provider: 'p' }, /provider and model/i],
		[{ provider: 'p', model: 'unknown' }, /unknown model/i],
		[{ reasoningEffort: 'xhigh' }, /does not offer|thinking|effort/i],
		[{ dataDir: '/srv/elsewhere' }, /not editable|dataDir/i],
		[{ telegram: { enabled: true } }, /not editable|telegram/i],
		[{ tokenRef: 'A_TOKEN' }, /not editable|tokenRef/i],
		[{ allowedChatIds: [1] }, /not editable|allowedChatIds/i],
	]
	for (const [patch, message] of cases) {
		const settings = fakeSettings()
		const ctx = fakeContext({ settings })
		const runtime = fakeRuntime()
		await assert.rejects(
			validateSettingsPatch(ctx, runtime, patch),
			(error) => message.test(String(error?.message)),
			`${JSON.stringify(patch)} should be rejected`,
		)
		await assert.rejects(saveSettings(ctx, runtime, { ...patch, expectedRevision: 3 }), (error) => message.test(String(error?.message)))
		assert.equal(settings.mutations.length, 0, 'invalid input must not reach the settings service')
		assert.equal(ctx.calls.rename.length, 0)
		assert.equal(ctx.calls.setCwd.length, 0)
		assert.deepEqual(runtime.selectionRef.current, { provider: 'p', model: 'm', reasoningEffort: 'high' })
	}
})

test('a stale settings revision is refused without applying live changes', async () => {
	const settings = fakeSettings({ conflict: true })
	const ctx = fakeContext({ settings })
	const runtime = fakeRuntime()
	await assert.rejects(saveSettings(ctx, runtime, { title: 'Sidecar', expectedRevision: 1 }), (error) => error?.code === 'SETTINGS_CONFLICT')
	assert.equal(runtime.title, 'Live Agent')
	assert.equal(ctx.calls.rename.length, 0)
})

test('saving without the settings service fails closed; reading still works', async () => {
	const ctx = fakeContext({ settings: null, service: null })
	const runtime = fakeRuntime()
	const read = effectiveSettings(ctx, runtime)
	assert.equal(read.values.title, 'Live Agent')
	assert.equal(read.revision, null)
	await assert.rejects(saveSettings(ctx, runtime, { title: 'Sidecar', expectedRevision: null }), /settings service is unavailable/i)
	assert.equal(runtime.title, 'Live Agent')
})

test('a no-op save does not write config', async () => {
	const settings = fakeSettings()
	const ctx = fakeContext({ settings })
	const runtime = fakeRuntime()
	const read = await saveSettings(ctx, runtime, { expectedRevision: 3 })
	assert.equal(settings.mutations.length, 0)
	assert.equal(read.values.title, 'Live Agent')
	assert.deepEqual(runtime.selectionRef.current, { provider: 'p', model: 'm', reasoningEffort: 'high' })
	assert.equal(runtime.calls.modelSelections.length, 0, 'a no-op save writes nothing')
})

test('the settings namespace falls back to the config editor entry', () => {
	const fiber = {}
	const ctx = fakeContext({ editor: { entries: () => [{ fiber, options: { id: 'include:from-editor' } }] } })
	assert.equal(settingsNamespace({ ...ctx, fiber }), 'include:from-editor')
})

test('telegram status is off and carries no credential material', () => {
	const runtime = fakeRuntime()
	assert.deepEqual(telegramStatusOf(runtime), { state: 'off', enabled: false, binding: { kind: 'none' }, candidates: [] })
	const configured = fakeRuntime({
		telegram: {
			status: () => ({ state: 'off', enabled: false, binding: { kind: 'none' } }),
		},
	})
	assert.deepEqual(telegramStatusOf(configured), { state: 'off', enabled: false, binding: { kind: 'none' }, candidates: [] })
})

test('telegram status passes through only safe DM adoption candidates', () => {
	const runtime = fakeRuntime({
		telegram: {
			status: () => ({
				state: 'ready', enabled: true, binding: { kind: 'none' },
				candidates: [
					{ key: 'dm:777:42:42', chatId: 42 },
					{ key: 'dm:777:43:43', chatId: '43' },
					{ key: 9, chatId: 9 },
					{ key: 'dm:777:44:44', chatId: 44, token: 'must-not-pass' },
				],
			}),
		},
	})
	assert.deepEqual(telegramStatusOf(runtime), {
		state: 'ready', enabled: true, binding: { kind: 'none' },
		candidates: [{ key: 'dm:777:42:42', chatId: 42 }, { key: 'dm:777:44:44', chatId: 44 }],
	})
})
