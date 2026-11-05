import assert from 'node:assert/strict'
import { test } from 'node:test'

const loaded = []
globalThis.window = {
	__ModuleLoader__: {
		load(definition) {
			loaded.push(definition)
		},
	},
}
globalThis.document = {
	createElement() {
		return { dataset: {}, style: {}, textContent: '', remove() {}, append() {} }
	},
	head: { append() {} },
	visibilityState: 'visible',
	addEventListener() {},
	removeEventListener() {},
}

await import('../client.js')

const definition = loaded[0]
assert.equal(definition.id, '@local/dsh-sidebar-agent')

function createElement(type, props, ...children) {
	return { type, props: props ?? {}, children }
}
const React = {
	createElement,
	useState(initial) { return [initial, () => {}] },
	useEffect() {},
	useLayoutEffect() {},
	useReducer() { return [0, () => {}] },
	useMemo(factory) { return factory() },
	useRef() { return { current: null } },
	useCallback(callback) { return callback },
	Fragment: 'Fragment',
}
const primitives = {
	MarkdownText(props) { return createElement('markdown', props) },
	StateDot(props) { return createElement('dot', props) },
}
const client = definition.factory((name) => {
	if (name === 'react') return React
	if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
	throw new Error(`unexpected module ${name}`)
})

const t = (key, values) => {
	if (values === undefined) return key
	let out = key
	for (const [name, value] of Object.entries(values)) out = out.split(`{${name}}`).join(String(value))
	return out
}

function textOf(node) {
	if (typeof node === 'string') return node
	if (node === null || node === undefined || typeof node !== 'object') return ''
	if (node.props?.text !== undefined) return String(node.props.text)
	return (node.children ?? []).map(textOf).join('')
}

function findByType(node, type) {
	if (node === null || typeof node !== 'object') return null
	if (node.type === type) return node
	for (const child of node.children ?? []) {
		const found = findByType(child, type)
		if (found !== null) return found
	}
	return null
}

test('the client registers a sidebar entry and the chat page', () => {
	const registrations = []
	const disposers = []
	const ctx = {
		locale: {
			register: () => () => {},
			bind: () => (key) => key,
			getSnapshot: () => ({}),
			subscribe: () => () => {},
		},
		slots: {
			inject(_name, callback) {
				callback()
				return () => {}
			},
			register(options) {
				registrations.push(options)
				return () => {}
			},
		},
		remote: { $mount: () => Promise.resolve() },
		inject(_deps, callback) {
			callback({ remote: { agent: {
				status: async () => ({ ok: true, value: { ready: true, messages: [] } }),
				chat: async () => ({ ok: true, value: { messageId: 'm1' } }),
				stop: async () => ({ ok: true, value: { stopped: true } }),
				settings: async () => ({ ok: true, value: {} }),
				saveSettings: async () => ({ ok: true, value: {} }),
			} } })
			return { dispose() {} }
		},
		effect(callback) {
			const dispose = callback()
			if (typeof dispose === 'function') disposers.push(dispose)
			return dispose
		},
	}
	assert.equal(typeof client.apply, 'function')
	client.apply(ctx)
	assert.deepEqual(
		registrations.map((entry) => ({ name: entry.name, id: entry.id, key: entry.key })),
		[
			{ name: 'main', id: undefined, key: 'agent' },
			{ name: 'sidebar.panellist', id: 'agent', key: undefined },
			{ name: 'conversation.session.header.actions', id: 'delegated-tag', key: undefined },
			{ name: 'sidebar.session.row.hover', id: 'delegated-hover', key: undefined },
			{ name: 'sidebar.session.row.leading', id: 'delegated-mark', key: undefined },
		],
	)
	for (const dispose of disposers.reverse()) dispose()
})

test('consecutive execution calls become one ordered disclosure', () => {
	const messages = [
		{ id: 'u1', role: 'user', text: 'go' },
		{ id: 't1', role: 'tool', name: 'bash', summary: 'echo one' },
		{ id: 't2', role: 'tool', name: 'read', summary: 'a.js' },
		{ id: 't3', role: 'tool', name: 'grep', summary: 'needle' },
		{ id: 'a1', role: 'assistant', text: 'done' },
		{ id: 't4', role: 'tool', name: 'bash', summary: 'echo two' },
	]
	const items = client.__internals.buildItems(messages)
	assert.deepEqual(items.map((item) => item.kind), ['message', 'tools', 'message', 'tools'])
	assert.deepEqual(items[1].tools.map((tool) => tool.id), ['t1', 't2', 't3'])
	assert.deepEqual(items[3].tools.map((tool) => tool.id), ['t4'])
	assert.equal(items[1].id, 'tools:t1')
})

test('reports are attributed and kept out of the user-bubble role', () => {
	const parsed = client.__internals.parseReport('[delegation session-1 "Fix the bug" in ai-stack ended: done]\n## Result\n\nAll good.')
	assert.deepEqual(parsed.header, { sessionId: 'session-1', title: 'Fix the bug', workspace: 'ai-stack', outcome: 'done' })
	const timed = client.__internals.parseReport('[delegation session-2 "Timed" in ai-stack ended: done at 1234]\nBody.')
	assert.deepEqual(timed.header, { sessionId: 'session-2', title: 'Timed', workspace: 'ai-stack', outcome: 'done', endedAt: 1234 })
	assert.equal(parsed.body, '## Result\n\nAll good.')
	assert.equal(client.__internals.parseReport('plain text').header, null)
	assert.equal(client.__internals.parseReport('plain text').body, 'plain text')

	const report = client.__internals.MessageRow({
		message: { role: 'user', source: 'delegation', text: '[delegation session-1 "Fix the bug" in ai-stack ended: done]\nAll good.' },
		t, labels: {},
	})
	assert.equal(report.type, client.__internals.DelegationReport)

	const user = client.__internals.MessageRow({ message: { role: 'user', source: 'user', text: 'hi' }, t, labels: {} })
	assert.equal(user.type, 'div')
	assert.match(user.props.className, /sa-userRow/)

	const assistant = client.__internals.MessageRow({ message: { role: 'assistant', text: '# Heading' }, t, labels: {} })
	assert.equal(textOf(assistant).includes('# Heading'), true)
})

test('unknown tool names are humanized and raw JSON summaries stay out', () => {
	const phrase = client.__internals.toolPhrase('mcp__playwright-mcp__browser_navigate', '{"url":"https://example.com"}')
	assert.equal(phrase, 'Browser navigate')
	assert.ok(!phrase.includes('{'))
	assert.equal(client.__internals.toolPhrase('bash', "printf 'hello'"), "Ran printf 'hello'")
	assert.equal(client.__internals.toolPhrase('bash', '{"command":"rm -rf /"}'), 'Ran a command')
	assert.ok(!client.__internals.toolPhrase('mcp__x__y_tool', '{"a":1}').includes('{'))
})

test('the delegated running accent is scoped to valid delegated session rows', () => {
	const css = client.__internals.delegatedSpinnerCss(['session-a', 'session-b', 'bad"id', ''])
	assert.match(css, /\[data-row-key="session:session-a"\] svg\[data-state="ongoing"\]/)
	assert.match(css, /\[data-row-key="session:session-b"\]/)
	assert.ok(!css.includes('bad"id'))
	assert.ok(!css.includes('session:""'))
	assert.match(css, /--dsw-alias-link/)
})

test('the composer keyboard contract sends, respects IME, and keeps stop reachable', () => {
	let sends = 0
	let stops = 0
	const noop = () => {}
	const element = client.__internals.Composer({
		t, draft: 'hello', setDraft: noop, files: [], attach: noop, removeFile: noop,
		send: () => { sends += 1 }, stop: () => { stops += 1 }, running: true, sending: false, sendError: null,
		selection: { provider: 'p', model: 'm' }, catalogData: null, catalogError: null,
		menuOpen: false, menuMode: 'model', openMenu: noop, closeMenu: noop, chooseModel: noop, chooseEffort: noop,
		inputRef: { current: { style: {}, scrollHeight: 0 } }, fileInputRef: { current: null },
		menuRef: { current: null }, modelButtonRef: { current: null }, effortButtonRef: { current: null },
	})
	const textarea = findByType(element, 'textarea')
	assert.ok(textarea !== null)
	const press = (overrides) => {
		let prevented = false
		textarea.props.onKeyDown({
			key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false },
			preventDefault: () => { prevented = true }, ...overrides,
		})
		return prevented
	}
	assert.equal(press(), true)
	assert.equal(sends, 1)
	assert.equal(press({ shiftKey: true }), false)
	assert.equal(sends, 1, 'Shift+Enter inserts a newline instead of sending')
	textarea.props.onCompositionStart()
	assert.equal(press(), false)
	assert.equal(sends, 1, 'Enter during composition must not send')
	textarea.props.onCompositionEnd()
	assert.equal(press({ keyCode: 229 }), false)
	assert.equal(sends, 1, 'the IME keyCode is not a send and is not prevented')
	assert.equal(press(), true)
	assert.equal(sends, 2, 'Enter after composition ends sends')
	textarea.props.onKeyDown({ key: 'Escape', shiftKey: false, keyCode: 27, nativeEvent: { isComposing: false }, preventDefault: noop })
	assert.equal(stops, 1, 'Escape stops a running turn')
})

test('model and effort labels use the catalog and fall back', () => {
	const catalog = { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M',
		reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] }
	assert.equal(client.__internals.modelLabel(catalog, { provider: 'p', model: 'm' }), 'M')
	assert.equal(client.__internals.modelLabel(null, { provider: 'p', model: 'm' }), 'p/m')
	assert.equal(client.__internals.effortLabel(catalog, { provider: 'p', model: 'm' }, t), 'effort.default')
	assert.equal(client.__internals.effortLabel(catalog, { provider: 'p', model: 'm', reasoningEffort: 'high' }, t), 'High')
})

function findByProp(node, key, value) {
	if (node === null || typeof node !== 'object') return null
	if (node.props?.[key] === value) return node
	for (const child of node.children ?? []) {
		const found = findByProp(child, key, value)
		if (found !== null) return found
	}
	return null
}

test('the Agent page exposes settings and Telegram status as a right-side panel', () => {
	const data = {
		ready: true,
		revision: 4,
		ns: 'include:sidebar-agent',
		values: { title: 'Agent', cwd: '/srv/agent', model: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
		agent: { sessionId: 'agent-1', running: false },
		telegram: { state: 'off', enabled: false, binding: { kind: 'none' } },
	}
	const form = { title: 'Agent', cwd: '/srv/agent', provider: 'p', model: 'm', effort: 'high' }
	const panel = client.__internals.SettingsPanel({
		t, data, status: 'ready', error: null, saving: false, saveError: null, saved: false, form,
		onChange: () => {}, onSave: () => {}, onClose: () => {}, catalog: null,
	})
	assert.equal(panel.type, 'aside')
	assert.equal(findByProp(panel, 'id', 'sa-settings-title')?.props.value, 'Agent')
	assert.equal(findByProp(panel, 'id', 'sa-settings-cwd')?.props.value, '/srv/agent')
	const text = textOf(panel)
	assert.match(text, /settings.open/)
	assert.match(text, /settings.telegram/)
	assert.match(text, /settings.telegram.target/)
	assert.match(text, /settings.agent/)
	assert.match(text, /settings.telegram.off/)
	assert.ok(!/token/i.test(text))
	const saving = client.__internals.SettingsPanel({
		t, data, status: 'ready', error: null, saving: true, saveError: 'Fixture failure', saved: false, form,
		onChange: () => {}, onSave: () => {}, onClose: () => {}, catalog: null,
	})
	assert.match(textOf(saving), /Fixture failure/)
	assert.equal(findByProp(saving, 'id', 'sa-settings-save')?.props.disabled, true)
	const loading = client.__internals.SettingsPanel({
		t, data: null, status: 'loading', error: null, saving: false, saveError: null, saved: false, form: null,
		onChange: () => {}, onSave: () => {}, onClose: () => {}, catalog: null,
	})
	assert.match(textOf(loading), /settings.loading/)
})
