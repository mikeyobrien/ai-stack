import assert from 'node:assert/strict'
import { test } from 'node:test'

const loaded = []
globalThis.window = { __ModuleLoader__: { load(definition) { loaded.push(definition) } } }
globalThis.document = {
	createElement() { return { dataset: {}, style: {}, textContent: '', remove() {}, append() {} } },
	head: { append() {} },
	visibilityState: 'visible',
	addEventListener() {},
	removeEventListener() {},
}
await import('../client.js')
const definition = loaded[0]

function createElement(type, props, ...children) { return { type, props: props ?? {}, children } }
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
const primitives = { MarkdownText(props) { return createElement('markdown', props) }, StateDot(props) { return createElement('dot', props) } }
const client = definition.factory((name) => {
	if (name === 'react') return React
	if (name === 'deepseek-ai/dsh-client-ui-primitives') return primitives
	if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
	throw new Error(`unexpected module ${name}`)
})
const t = (key) => key
function textOf(node) {
	if (typeof node === 'string') return node
	if (node === null || node === undefined || typeof node !== 'object') return ''
	if (node.props?.text !== undefined) return String(node.props.text)
	return (node.children ?? []).map(textOf).join('')
}

test('a stalled delegation header parses as Stalled with the episode time', () => {
	const parsed = client.__internals.parseReport('[delegation deleg-1 "Research" in ai-stack stalled: no activity for 30m at 123456]\nStill running.')
	assert.deepEqual(parsed.header, {
		sessionId: 'deleg-1', title: 'Research', workspace: 'ai-stack',
		outcome: 'stalled', stalledAt: 123456,
	})
	assert.equal(parsed.body, 'Still running.')
	assert.equal(client.__internals.outcomeLabel('stalled', t), 'report.stalled')
	assert.match(client.__internals.outcomeClass('stalled'), /sa-badgeStalled/)
	assert.match(client.__internals.CSS, /\.sa-badgeStalled/)
})

test('header and hover pills use Stalled when the stalled set contains the session', () => {
	const stalled = client.__internals.DelegationTag({ sessionId: 's1', useDelegated: () => true, useStalled: () => true, t })
	assert.match(textOf(stalled), /stalled/)
	assert.match(stalled.props.className, /sa-pillStalled/)
	assert.equal(stalled.props['aria-label'], 'stalled.aria')
	const delegated = client.__internals.DelegationTag({ sessionId: 's1', useDelegated: () => true, useStalled: () => false, t })
	assert.match(textOf(delegated), /delegated/)
	assert.match(delegated.props.className, /sa-pill/)
	assert.equal(delegated.props['aria-label'], 'delegated.aria')
})

test('the leading mark labels stalled distinctly and keeps the base glyph', () => {
	const mark = client.__internals.DelegationMark({ sessionId: 's1', useDelegated: () => true, useStalled: () => true, t })
	assert.equal(mark.props['aria-label'], 'stalled.aria')
	assert.equal(mark.props.title, 'stalled')
	assert.match(mark.props.className, /sa-markStalled/)
	const delegated = client.__internals.DelegationMark({ sessionId: 's1', useDelegated: () => true, useStalled: () => false, t })
	assert.equal(delegated.props['aria-label'], 'delegated.aria')
})

test('stalled spinner CSS uses the warning accent and is 320px safe', () => {
	const css = client.__internals.delegatedSpinnerCss(['running-a', 'stalled-a'], ['stalled-a'])
	assert.match(css, /\[data-row-key="session:running-a"\] svg\[data-state="ongoing"\].*dsw-alias-link/)
	assert.match(css, /\[data-row-key="session:stalled-a"\] svg\[data-state="ongoing"\].*dsw-alias-state-warn-primary/)
	assert.ok(!css.includes('bad"id'))
	assert.match(client.__internals.CSS, /@media \(max-width:320px\)|@media \(max-width:520px\)/)
})
