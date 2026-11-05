import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startFixtureServer } from './fixture/server.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '../../..')
const outDir = process.env.SA_FIXTURE_OUT ?? join(repoRoot, '.playwright-mcp')
mkdirSync(outDir, { recursive: true })
const reactDir = process.env.SA_REACT_DIR ?? '/tmp/sa-fixture/node_modules'
const reactUmd = join(reactDir, 'react/umd/react.development.js')
const reactDomUmd = join(reactDir, 'react-dom/umd/react-dom.development.js')

/** Resolve Playwright from the running web profile, not the plugin workspace. */
function playwrightOf() {
	const profile = process.env.DSH_WEB_PROFILE ?? join(homedir(), '.dsh/profiles/web')
	const require = createRequire(join(profile, 'package.json'))
	return require('playwright')
}

/** Find a Chromium build already installed for the harness. */
function chromiumPath() {
	if (process.env.SA_CHROMIUM) return process.env.SA_CHROMIUM
	const cache = join(homedir(), '.cache/ms-playwright')
	if (!existsSync(cache)) return undefined
	const candidates = []
	for (const entry of readdirSync(cache)) {
		candidates.push(
			join(cache, entry, 'chrome-headless-shell-linux64/chrome-headless-shell'),
			join(cache, entry, 'chrome-linux64/chrome'),
		)
	}
	return candidates.find((candidate) => existsSync(candidate))
}

const skipReason = !existsSync(reactUmd) || !existsSync(reactDomUmd)
	? `React UMD vendor is missing; run: mkdir -p /tmp/sa-fixture && (cd /tmp/sa-fixture && npm install react@18.2.0 react-dom@18.2.0)`
	: undefined

test('isolated Agent chat fixture', { skip: skipReason, timeout: 180_000 }, async (t) => {
	const { chromium } = playwrightOf()
	const executablePath = chromiumPath()
	const server = await startFixtureServer()
	const browser = await chromium.launch({ headless: true, ...(executablePath === undefined ? {} : { executablePath }) })
	const page = await browser.newPage({ viewport: { width: 1000, height: 720 } })
	const consoleErrors = []
	page.on('pageerror', (error) => consoleErrors.push(String(error)))
	page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.goto(`http://127.0.0.1:${server.port}/`)
	await page.locator('.sa-page').waitFor({ state: 'visible' })

	const setScenario = async (name) => {
		await page.evaluate((scenario) => window.__fx.setScenario(scenario), name)
		await page.waitForTimeout(80)
	}
	const reset = async () => {
		await page.evaluate(() => window.__fx.reset())
		await page.waitForTimeout(80)
	}
	const calls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__fx.calls)))
	const textarea = () => page.locator('textarea.sa-input')

	t.after(async () => {
		await browser.close()
		await server.close()
	})

	await t.test('empty, loading, and error states stay understandable', async () => {
		await setScenario('empty')
		assert.equal(await page.locator('.sa-userBubble').count(), 0)
		assert.equal(await textarea().count(), 1)
		await setScenario('idle')
		assert.match(await page.locator('.sa-state').innerText(), /Idle/)
		await setScenario('loading')
		assert.match(await page.locator('.sa-centered').innerText(), /Starting Agent/)
		assert.equal(await textarea().count(), 0)
		await setScenario('error')
		assert.match(await page.locator('[role="alert"]').innerText(), /Fixture start failure/)
		assert.equal(await page.getByRole('button', { name: 'Retry' }).count(), 1)
		await setScenario('ready')
	})

	await t.test('Enter sends, Shift+Enter inserts a newline, IME never submits', async () => {
		await reset()
		await textarea().fill('first message')
		await textarea().press('Enter')
		await page.waitForTimeout(150)
		let current = await calls()
		assert.equal(current.chat.length, 1, 'Enter should send once')
		assert.equal(await textarea().inputValue(), '', 'a successful send clears the draft')
		assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'focus returns to the composer')

		await textarea().fill('line one')
		await textarea().press('Shift+Enter')
		await page.waitForTimeout(50)
		current = await calls()
		assert.equal(current.chat.length, 1, 'Shift+Enter must not send')
		assert.match(await textarea().inputValue(), /\n/, 'Shift+Enter inserts a newline')

		await textarea().fill('ime draft')
		await page.evaluate(() => {
			const input = document.querySelector('textarea.sa-input')
			input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
		})
		await page.waitForTimeout(80)
		current = await calls()
		assert.equal(current.chat.length, 1, 'Enter during composition must not send')
		await page.evaluate(() => {
			const input = document.querySelector('textarea.sa-input')
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
		})
		await page.waitForTimeout(80)
		current = await calls()
		assert.equal(current.chat.length, 1, 'keyCode 229 must not send')
		await page.evaluate(() => {
			const input = document.querySelector('textarea.sa-input')
			input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
		})
		await page.waitForTimeout(150)
		current = await calls()
		assert.equal(current.chat.length, 2, 'Enter after composition ends sends')
	})

	await t.test('a failed send keeps the draft and attachments; remove works', async () => {
		await reset()
		await setScenario('failed')
		const dir = await mkdtemp(join(tmpdir(), 'sidebar-agent-fixture-'))
		const file = join(dir, 'notes.txt')
		await writeFile(file, 'fixture attachment', 'utf8')
		try {
			await textarea().fill('retry me')
			await page.locator('input[type=file]').setInputFiles(file)
			await page.locator('.sa-chip').filter({ hasText: 'notes.txt' }).waitFor({ state: 'visible' })
			await page.getByRole('button', { name: 'Send' }).click()
			await page.waitForTimeout(200)
			assert.equal((await calls()).chat.length, 1)
			assert.equal(await textarea().inputValue(), 'retry me', 'failed send retains the draft')
			assert.equal(await page.locator('.sa-chip').filter({ hasText: 'notes.txt' }).count(), 1, 'failed send retains attachments')
			assert.match(await page.locator('.sa-failure[role="alert"]').innerText(), /Fixture send failed/)
			await page.getByRole('button', { name: 'Remove notes.txt' }).click()
			assert.equal(await page.locator('.sa-chip').count(), 0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	await t.test('Stop is reachable, calls stop, and keeps the draft', async () => {
		await reset()
		await setScenario('running')
		assert.equal(await page.locator('.sa-stop').count(), 1)
		assert.match(await page.locator('.sa-state').innerText(), /Running/)
		await textarea().fill('keep this draft')
		await page.locator('input[type=file]').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep') })
		await page.locator('.sa-chip').filter({ hasText: 'keep.txt' }).waitFor({ state: 'visible' })
		await page.locator('.sa-stop').click()
		await page.waitForTimeout(150)
		assert.equal((await calls()).stop, 1)
		assert.equal(await textarea().inputValue(), 'keep this draft')
		assert.equal(await page.locator('.sa-chip').filter({ hasText: 'keep.txt' }).count(), 1, 'stop retains attachments')
		await page.evaluate(() => window.__fx.setData({ running: false }))
		await page.waitForTimeout(150)
		assert.match(await page.locator('.sa-state').innerText(), /Stopped/)
	})

	await t.test('clipboard image paste reuses the attachment pipeline', async () => {
		const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2h8AAAAASUVORK5CYII='
		const GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
		const dispatchPaste = async ({ text = '', images = [] } = {}) => page.evaluate(({ text, images }) => {
			const transfer = new DataTransfer()
			for (const image of images) {
				const bytes = image.large === true
					? new Uint8Array(10 * 1024 * 1024 + 1)
					: Uint8Array.from(atob(image.base64), (character) => character.charCodeAt(0))
				transfer.items.add(new File([bytes], image.name, { type: image.type }))
			}
			if (text !== '') transfer.setData('text/plain', text)
			let event
			try {
				event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
			} catch {
				event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
			}
			if (event.clipboardData !== transfer) Object.defineProperty(event, 'clipboardData', { value: transfer })
			const target = document.querySelector('textarea.sa-input')
			target.focus()
			const dispatched = target.dispatchEvent(event)
			return { defaultPrevented: event.defaultPrevented, dispatched }
		}, { text, images })
		const imagePaste = (name = 'pasted.png', type = 'image/png') => dispatchPaste({ images: [{ name, type, base64: PNG }] })

		await reset()
		await setScenario('idle')
		await textarea().fill('keep this draft')
		const pasted = await imagePaste()
		assert.equal(pasted.defaultPrevented, true, 'an image-only paste is consumed')
		await page.locator('.sa-chip').filter({ hasText: 'pasted.png' }).waitFor({ state: 'visible' })
		assert.equal(await textarea().inputValue(), 'keep this draft', 'pasting an image keeps the draft')
		assert.equal(await page.locator('.sa-chip').filter({ hasText: 'pasted.png' }).count(), 1)
		assert.equal(await page.getByRole('button', { name: 'Send' }).isEnabled(), true)

		await textarea().fill('')
		await page.getByRole('button', { name: 'Send' }).click()
		await page.waitForTimeout(200)
		const sent = await calls()
		assert.equal(sent.chat.length, 1, 'image-only content sends')
		assert.equal(sent.chat[0].text, '')
		assert.equal(sent.chat[0].files.length, 1)
		assert.equal(sent.chat[0].files[0].mediaType, 'image/png')
		assert.ok(sent.chat[0].files[0].data.length > 0)

		await reset()
		await setScenario('idle')
		await imagePaste('remove-me.png')
		await page.locator('.sa-chip').filter({ hasText: 'remove-me.png' }).waitFor({ state: 'visible' })
		await page.getByRole('button', { name: 'Remove remove-me.png' }).click()
		assert.equal(await page.locator('.sa-chip').count(), 0)
		assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true, 'removing the only image disables an empty send')

		await reset()
		await setScenario('idle')
		const one = await dispatchPaste({ images: [
			{ name: 'duplicate.png', type: 'image/png', base64: PNG },
			{ name: 'duplicate.png', type: 'image/png', base64: PNG },
		] })
		assert.equal(one.defaultPrevented, true)
		await page.waitForTimeout(200)
		assert.equal(await page.locator('.sa-chip').filter({ hasText: 'duplicate.png' }).count(), 1, 'identical clipboard images are not double-attached')

		await reset()
		await setScenario('idle')
		await dispatchPaste({ images: [
			{ name: 'one.png', type: 'image/png', base64: PNG },
			{ name: 'two.gif', type: 'image/gif', base64: GIF },
		] })
		await page.waitForTimeout(200)
		assert.equal(await page.locator('.sa-chip').count(), 2, 'distinct clipboard images both attach')

		await reset()
		await setScenario('idle')
		await textarea().fill('existing text')
		const textOnly = await dispatchPaste({ text: 'pasted text' })
		assert.equal(textOnly.defaultPrevented, false, 'text-only paste is left to the browser')
		assert.equal(await page.locator('.sa-chip').count(), 0)
		assert.equal(await textarea().inputValue(), 'existing text')

		await reset()
		await setScenario('idle')
		await textarea().fill('keep on reject')
		const unsupported = await dispatchPaste({ images: [{ name: 'scan.tiff', type: 'image/tiff', base64: PNG }] })
		assert.equal(unsupported.defaultPrevented, true)
		assert.match(await page.locator('.sa-composer [role="alert"]').innerText(), /PNG, JPEG, WebP, or GIF/)
		assert.equal(await textarea().inputValue(), 'keep on reject')
		assert.equal(await page.locator('.sa-chip').count(), 0)

		await reset()
		await setScenario('idle')
		await textarea().fill('keep on oversize')
		await dispatchPaste({ images: [{ name: 'huge.png', type: 'image/png', large: true }] })
		assert.match(await page.locator('.sa-composer [role="alert"]').innerText(), /10 MB/)
		assert.equal(await textarea().inputValue(), 'keep on oversize')
		assert.equal(await page.locator('.sa-chip').count(), 0)

		await reset()
		await setScenario('idle')
		await page.locator('input[type=file]').setInputFiles({ name: 'existing.txt', mimeType: 'text/plain', buffer: Buffer.from('existing') })
		await page.locator('.sa-chip').filter({ hasText: 'existing.txt' }).waitFor({ state: 'visible' })
		await textarea().fill('draft with attachment')
		await imagePaste('added.png')
		await page.locator('.sa-chip').filter({ hasText: 'added.png' }).waitFor({ state: 'visible' })
		assert.equal(await page.locator('.sa-chip').count(), 2, 'pasting an image preserves an existing attachment')
		assert.equal(await textarea().inputValue(), 'draft with attachment')

		await reset()
		await setScenario('idle')
		await textarea().fill('mixed draft')
		const mixed = await dispatchPaste({ text: 'caption text', images: [{ name: 'mixed.png', type: 'image/png', base64: PNG }] })
		assert.equal(mixed.defaultPrevented, false, 'image-plus-text paste leaves the text to the browser')
		await page.locator('.sa-chip').filter({ hasText: 'mixed.png' }).waitFor({ state: 'visible' })
		assert.equal(await textarea().inputValue(), 'mixed draft')
		assert.equal(await page.locator('.sa-chip').count(), 1)
	})

	await t.test('consecutive calls are one human disclosure; reports are not user bubbles', async () => {
		await reset()
		await setScenario('running')
		assert.equal(await page.locator('.sa-activityHeader').count(), 1, 'three calls collapse into one group')
		const collapsed = await page.locator('.sa-activityHeader').innerText()
		assert.match(collapsed, /Ran npm test/)
		assert.ok(!/\{|\}|mcp__|"/.test(collapsed), 'collapsed activity exposes no raw JSON or wire id')
		await page.locator('.sa-activityHeader').click()
		await page.waitForTimeout(100)
		assert.equal(await page.locator('.sa-toolItem').count(), 3)
		assert.match(await page.locator('.sa-activityBody').innerText(), /Failed/)

		await setScenario('report')
		assert.equal(await page.locator('.sa-report').count(), 1)
		assert.equal(await page.locator('.sa-userBubble').count(), 0, 'a delegation report is not a user bubble')
		assert.match(await page.locator('.sa-report').innerText(), /Fixture delegation/)
		assert.match(await page.locator('.sa-report').innerText(), /Done/)
		await page.locator('.sa-reportHeader').click()
		await page.waitForTimeout(100)
		assert.match(await page.locator('.sa-reportBody').innerText(), /All checks passed/)
		assert.match(await page.locator('.sa-reportBody').innerText(), /session-abc/)
	})

	await t.test('reports keep actual completion order and identical-text occurrences', async () => {
		await reset()
		await setScenario('timeline')
		await page.waitForTimeout(150)
		const order = () => page.evaluate(() => [...document.querySelectorAll('.sa-column > *')].map((element) => {
			if (element.classList.contains('sa-report')) return `report:${element.querySelector('.sa-reportTitle')?.innerText ?? ''}`
			if (element.classList.contains('sa-toolItem')) return `tool:${element.querySelector('.sa-toolPhrase')?.innerText ?? ''}`
			return element.innerText.replace(/\n/g, ' ').trim()
		}))
		assert.deepEqual(await order(), [
			'First request.',
			'tool:Read a.js',
			'report:Early',
			'Second answer.',
			'report:Later',
			'report:Repeat',
			'Last answer.',
		])
		assert.equal(await page.locator('.sa-report').count(), 3, 'both occurrences from one child are kept')
		await setScenario('timeline')
		await page.waitForTimeout(150)
		assert.deepEqual(await order(), [
			'First request.',
			'tool:Read a.js',
			'report:Early',
			'Second answer.',
			'report:Later',
			'report:Repeat',
			'Last answer.',
		], 'refresh/remount keeps the completion order')
	})

	await t.test('reading earlier turns is not interrupted; Latest returns and focuses', async () => {
		await reset()
		await setScenario('long')
		await page.waitForTimeout(150)
		const before = await page.locator('.sa-scroll').evaluate((list) => ({ top: list.scrollTop, distance: list.scrollHeight - list.scrollTop - list.clientHeight }))
		assert.equal(before.distance, 0, 'the initial transcript is pinned to the latest turn')
		await page.locator('.sa-scroll').evaluate((list) => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll', { bubbles: true })) })
		await page.waitForTimeout(120)
		assert.equal(await page.locator('.sa-jump').count(), 1, 'Latest appears when reading earlier turns')
		await page.evaluate(() => {
			const data = window.__fx.store.getSnapshot().data
			window.__fx.setData({ messages: [...data.messages, { id: 'new-answer', role: 'assistant', text: 'New answer while reading.', time: (data.messages.at(-1)?.time ?? 0) + 1 }] })
		})
		await page.waitForTimeout(200)
		const after = await page.locator('.sa-scroll').evaluate((list) => list.scrollTop)
		assert.equal(after, 0, 'new content does not pull a reading user to the bottom')
		assert.equal(await page.locator('.sa-jump').count(), 1)
		await page.locator('.sa-jump').click()
		await page.waitForTimeout(300)
		const distance = await page.locator('.sa-scroll').evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight)
		assert.ok(distance <= 2, `Latest returns to the bottom (distance ${distance})`)
		assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA')
	})

	await t.test('expanding activity above the reader keeps what is on screen still', async () => {
		await reset()
		await setScenario('long')
		await page.waitForTimeout(150)
		const list = page.locator('.sa-scroll')
		const chosen = await list.evaluate((element) => {
			const box = element.getBoundingClientRect()
			const groups = [...element.querySelectorAll('.sa-activity')]
			for (let index = 0; index < groups.length; index += 1) {
				const group = groups[index]
				const next = group.nextElementSibling
				if (next === null || !next.classList.contains('sa-turn')) continue
				const groupTop = group.getBoundingClientRect().top - box.top + element.scrollTop
				element.scrollTop = Math.max(0, groupTop + group.offsetHeight + 20)
				element.dispatchEvent(new Event('scroll', { bubbles: true }))
				return { index, text: next.innerText }
			}
			return null
		})
		assert.ok(chosen !== null, 'the fixture has a group followed by a turn')
		await page.waitForTimeout(150)
		const before = await list.evaluate((element, text) => {
			const next = [...element.querySelectorAll('.sa-turn')].find((node) => node.innerText === text)
			return next === undefined ? null : next.getBoundingClientRect().top
		}, chosen.text)
		assert.ok(before !== null)
		await list.evaluate((element, index) => {
			element.querySelectorAll('.sa-activity')[index]?.querySelector('.sa-activityHeader')?.click()
		}, chosen.index)
		await page.waitForTimeout(150)
		const after = await list.evaluate((element, text) => {
			const next = [...element.querySelectorAll('.sa-turn')].find((node) => node.innerText === text)
			return next === undefined ? null : next.getBoundingClientRect().top
		}, chosen.text)
		assert.ok(after !== null)
		assert.ok(Math.abs(after - before) <= 2, `the reading anchor stays still (${before} -> ${after})`)
	})

	await t.test('long report bodies cap, scroll, and leave the transcript still', async () => {
		const run = async (width, height) => {
			await page.setViewportSize({ width, height })
			await reset()
			await setScenario('longReport')
			await page.waitForTimeout(150)
			const transcript = page.locator('.sa-scroll')
			const header = page.locator('.sa-reportHeader').first()
			await header.scrollIntoViewIfNeeded()
			await page.waitForTimeout(100)
			const before = await transcript.evaluate((el) => el.scrollTop)
			await header.click()
			await page.waitForTimeout(200)
			const body = page.locator('.sa-reportBody').first()
			const metrics = await body.evaluate((el) => ({
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				overflowY: getComputedStyle(el).overflowY,
				overscroll: getComputedStyle(el).overscrollBehaviorY,
				role: el.getAttribute('role'),
				label: el.getAttribute('aria-label'),
				tabIndex: el.tabIndex,
				headerOutside: el.previousElementSibling?.classList.contains('sa-reportHeader') === true,
			}))
			const cap = Math.min(height / 2, 448)
			assert.ok(metrics.scrollHeight > metrics.clientHeight, `${width}x${height}: long report scrolls (${metrics.scrollHeight}/${metrics.clientHeight})`)
			assert.ok(metrics.clientHeight <= cap + 2, `${width}x${height}: report body capped at ${cap} (${metrics.clientHeight})`)
			assert.equal(metrics.overflowY, 'auto')
			assert.equal(metrics.overscroll, 'contain')
			assert.equal(metrics.role, 'region')
			assert.equal(metrics.tabIndex, 0)
			assert.ok(metrics.label !== null && metrics.label.length > 0)
			assert.equal(metrics.headerOutside, true, 'title, badge, and collapse affordance stay outside the scroller')
			const afterExpand = await transcript.evaluate((el) => el.scrollTop)
			assert.ok(Math.abs(afterExpand - before) <= 2, `${width}x${height}: expand does not yank the transcript (${before} -> ${afterExpand})`)

			// Put the capped body fully in view for the reachability checks; this
			// is an explicit reader scroll, not an automatic expansion jump.
			await body.scrollIntoViewIfNeeded()
			await page.waitForTimeout(100)
			const reading = await transcript.evaluate((el) => el.scrollTop)
			await body.hover()
			const beforeWheel = reading
			for (let step = 0; step < 8; step += 1) await page.mouse.wheel(0, 3000)
			await page.waitForTimeout(300)
			let scroll = await body.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
			assert.ok(scroll.top >= scroll.max - 2, `${width}x${height}: wheel reaches the final content (${scroll.top}/${scroll.max})`)
			const afterWheel = await transcript.evaluate((el) => el.scrollTop)
			assert.ok(Math.abs(afterWheel - beforeWheel) <= 2, `${width}x${height}: wheel in the report does not move the transcript`)
			const visibleEnd = await body.evaluate((el) => {
				const last = el.lastElementChild?.getBoundingClientRect()
				const box = el.getBoundingClientRect()
				const transcriptBox = el.closest('.sa-scroll')?.getBoundingClientRect()
				return last === undefined || transcriptBox === undefined ? null : {
					lastBottom: last.bottom, bodyBottom: box.bottom, transcriptBottom: transcriptBox.bottom,
				}
			})
			assert.ok(visibleEnd !== null)
			assert.ok(visibleEnd.lastBottom <= visibleEnd.bodyBottom + 1, `${width}x${height}: final content is inside the report scroller`)
			assert.ok(visibleEnd.lastBottom <= visibleEnd.transcriptBottom + 1, `${width}x${height}: final content is inside the transcript viewport`)
			if (width === 390) await page.screenshot({ path: join(outDir, 'fixture-long-report-390.png'), scale: 'css' })

			await header.focus()
			await page.keyboard.press('Tab')
			const focused = await page.evaluate(() => {
				const element = document.activeElement
				return {
					cls: element?.className ?? '',
					outline: element === null ? 'none' : getComputedStyle(element).outlineStyle,
					width: element === null ? '0px' : getComputedStyle(element).outlineWidth,
				}
			})
			assert.match(focused.cls, /sa-reportBody/)
			assert.notEqual(focused.outline, 'none', 'the scroll region has a visible keyboard focus ring')
			const beforeKey = await transcript.evaluate((el) => el.scrollTop)
			await page.keyboard.press('Home')
			await page.waitForTimeout(100)
			await page.keyboard.press('End')
			await page.waitForTimeout(200)
			scroll = await body.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
			assert.ok(scroll.top >= scroll.max - 2, `${width}x${height}: keyboard reaches the final content (${scroll.top}/${scroll.max})`)
			const afterKey = await transcript.evaluate((el) => el.scrollTop)
			assert.ok(Math.abs(afterKey - beforeKey) <= 2, `${width}x${height}: keyboard in the report does not move the transcript`)

			// Return the transcript to the reading position before collapsing;
			// focusing a tall region can legitimately reveal it, and collapsing
			// then removes only the body the user is leaving.
			await transcript.evaluate((el, top) => { el.scrollTop = top }, before)
			await page.waitForTimeout(100)
			const beforeCollapse = await transcript.evaluate((el) => el.scrollTop)
			await header.click()
			await page.waitForTimeout(100)
			assert.equal(await page.locator('.sa-reportBody').count(), 0)
			assert.equal(await header.isVisible(), true)
			const afterCollapse = await transcript.evaluate((el) => el.scrollTop)
			assert.ok(Math.abs(afterCollapse - beforeCollapse) <= 2, `${width}x${height}: collapse does not yank the transcript (${beforeCollapse} -> ${afterCollapse})`)
			return metrics
		}
		const desktop = await run(1000, 720)
		const mobile = await run(390, 844)
		const narrow = await run(320, 720)
		assert.ok(desktop.clientHeight > 0 && mobile.clientHeight > 0 && narrow.clientHeight > 0)
	})

	await t.test('long activity bodies cap and nested tool results stay bounded', async () => {
		await page.setViewportSize({ width: 390, height: 844 })
		await reset()
		await setScenario('longActivity')
		await page.waitForTimeout(150)
		const header = page.locator('.sa-activityHeader').first()
		await header.scrollIntoViewIfNeeded()
		await header.click()
		await page.waitForTimeout(200)
		const body = page.locator('.sa-activityBody').first()
		const metrics = await body.evaluate((el) => ({
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			overflowY: getComputedStyle(el).overflowY,
			overscroll: getComputedStyle(el).overscrollBehaviorY,
			role: el.getAttribute('role'),
			tabIndex: el.tabIndex,
			headerOutside: el.previousElementSibling?.classList.contains('sa-activityHeader') === true,
		}))
		assert.ok(metrics.scrollHeight > metrics.clientHeight, `activity body scrolls (${metrics.scrollHeight}/${metrics.clientHeight})`)
		assert.ok(metrics.clientHeight <= 422 + 2, `activity body capped (${metrics.clientHeight})`)
		assert.equal(metrics.overflowY, 'auto')
		assert.equal(metrics.overscroll, 'contain')
		assert.equal(metrics.role, 'region')
		assert.equal(metrics.tabIndex, 0)
		assert.equal(metrics.headerOutside, true)

		await header.focus()
		await page.keyboard.press('Tab')
		const focused = await page.evaluate(() => ({
			cls: document.activeElement?.className ?? '',
			outline: document.activeElement === null ? 'none' : getComputedStyle(document.activeElement).outlineStyle,
		}))
		assert.match(focused.cls, /sa-activityBody/)
		assert.notEqual(focused.outline, 'none')
		await page.keyboard.press('End')
		await page.waitForTimeout(200)
		const scroll = await body.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
		assert.ok(scroll.top >= scroll.max - 2, `keyboard reaches the final activity row (${scroll.top}/${scroll.max})`)

		const chevron = body.locator('.sa-toolChevron').first()
		await chevron.scrollIntoViewIfNeeded()
		await chevron.click()
		await page.waitForTimeout(150)
		const detail = body.locator('.sa-toolDetail').first()
		const detailMetrics = await detail.evaluate((el) => ({
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			overflowY: getComputedStyle(el).overflowY,
			overscroll: getComputedStyle(el).overscrollBehaviorY,
			role: el.getAttribute('role'),
			tabIndex: el.tabIndex,
		}))
		assert.ok(detailMetrics.scrollHeight > detailMetrics.clientHeight, 'long tool result scrolls internally')
		assert.ok(detailMetrics.clientHeight <= 201, `tool result stays bounded (${detailMetrics.clientHeight})`)
		assert.equal(detailMetrics.overflowY, 'auto')
		assert.equal(detailMetrics.overscroll, 'contain')
		assert.equal(detailMetrics.role, 'region')
		assert.equal(detailMetrics.tabIndex, 0)

		await header.scrollIntoViewIfNeeded()
		await header.click()
		await page.waitForTimeout(100)
		assert.equal(await page.locator('.sa-activityBody').count(), 0)
		assert.equal(await header.isVisible(), true)
	})

	await t.test('model and thinking controls open a bounded menu and close on Escape', async () => {
		await reset()
		await setScenario('idle')
		await page.locator('.sa-model').click()
		await page.waitForTimeout(100)
		const menu = page.locator('.sa-menu')
		assert.equal(await menu.count(), 1)
		const box = await menu.boundingBox()
		const viewport = page.viewportSize()
		assert.ok(box !== null && box.x >= 0 && box.x + box.width <= viewport.width + 1, 'menu stays inside the panel width')
		assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menu')
		await page.keyboard.press('Escape')
		await page.waitForTimeout(100)
		assert.equal(await page.locator('.sa-menu').count(), 0)
		assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''), /Model:/)
		await page.locator('.sa-model').click()
		await page.waitForTimeout(100)
		await page.getByRole('menuitemradio', { name: 'Fixture Model B' }).click()
		await page.waitForTimeout(100)
		const current = await calls()
		assert.equal(current.setModel.length, 1)
		assert.deepEqual(current.setModel[0], { provider: 'fixture', model: 'model-b' })
		assert.equal(await page.locator('.sa-menu').count(), 0)
	})

	await t.test('the transcript and status are announced accessibly', async () => {
		await reset()
		await setScenario('idle')
		assert.equal(await page.locator('[role="log"]').count(), 1)
		assert.equal(await page.locator('[role="status"]').count(), 1)
		assert.equal(await textarea().getAttribute('aria-label'), 'Message')
		assert.equal(await page.getByRole('button', { name: 'Attach files' }).count(), 1)
		await page.locator('.sa-scroll').evaluate((list) => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll', { bubbles: true })) })
		await page.waitForTimeout(100)
		if (await page.locator('.sa-activityHeader').count() > 0) {
			assert.equal(await page.locator('.sa-activityHeader').first().getAttribute('aria-expanded'), 'false')
		}
	})

	await t.test('320px keeps every control and the composer on screen', async () => {
		await reset()
		await page.setViewportSize({ width: 320, height: 720 })
		await setScenario('running')
		await page.waitForTimeout(150)
		const measured = await page.locator('.sa-page').evaluate((panel) => {
			const viewport = { width: innerWidth, height: innerHeight }
			const buttons = [...panel.querySelectorAll('button')].filter((button) => button.getClientRects().length > 0)
			const outside = buttons.filter((button) => {
				const rect = button.getBoundingClientRect()
				return rect.right > viewport.width + 1 || rect.left < -1
			}).map((button) => button.getAttribute('aria-label') || button.textContent.trim())
			const stop = panel.querySelector('.sa-stop')?.getBoundingClientRect()
			const input = panel.querySelector('textarea.sa-input')?.getBoundingClientRect()
			return {
				pageFits: document.documentElement.scrollWidth <= viewport.width + 1,
				outside,
				stop: stop === undefined ? null : { left: stop.left, right: stop.right, top: stop.top, bottom: stop.bottom },
				input: input === undefined ? null : { left: input.left, right: input.right, bottom: input.bottom },
			}
		})
		assert.equal(measured.pageFits, true)
		assert.deepEqual(measured.outside, [])
		assert.ok(measured.stop !== null && measured.stop.right <= 320, 'Stop remains on screen at 320px')
		assert.ok(measured.input !== null && measured.input.right <= 320 && measured.input.bottom <= 720, 'composer remains on screen at 320px')
		await page.screenshot({ path: join(outDir, 'fixture-320.png'), scale: 'css' })
		await page.setViewportSize({ width: 1000, height: 720 })
	})



	await t.test('the right panel offers an explicit DM adoption and never adopts by itself', async () => {
		await reset()
		await setScenario('idle')
		await page.evaluate(() => { window.__fx.telegramActive = true })
		await page.getByRole('button', { name: 'Settings' }).click()
		await page.locator('#sa-settings-dm').waitFor({ state: 'visible' })
		assert.equal(await page.locator('#sa-settings-dm option').count(), 1)
		assert.equal((await calls()).telegramAdopt.length, 0, 'opening the panel does not adopt')
		await page.locator('#sa-settings-dm').selectOption('dm:777:42:42')
		await page.getByRole('button', { name: 'Adopt' }).click()
		await page.waitForTimeout(200)
		const current = await calls()
		assert.equal(current.telegramAdopt.length, 1)
		assert.equal(current.telegramAdopt[0].key, 'dm:777:42:42')
		const text = await page.locator('.sa-side').innerText()
		assert.match(text, /#42/)
		assert.match(text, /Adopted/)
		await page.getByRole('button', { name: 'Close settings' }).click()
	})

	await t.test('the Agent settings panel reads effective values, saves explicitly, and keeps good state', async () => {
		await reset()
		await setScenario('idle')
		await page.getByRole('button', { name: 'Settings' }).click()
		await page.locator('.sa-side').waitFor({ state: 'visible' })
		await page.locator('#sa-settings-title').waitFor({ state: 'visible' })
		assert.equal(await page.locator('#sa-settings-title').inputValue(), 'Agent')
		assert.equal(await page.locator('#sa-settings-cwd').inputValue(), '/fixture/agent')
		assert.equal(await page.locator('#sa-settings-model').inputValue(), 'fixture\u0000model-a')
		const panelText = await page.locator('.sa-side').innerText()
		assert.match(panelText, /Telegram/)
		assert.match(panelText, /Target/)
		assert.match(panelText, /Agent/)
		assert.match(panelText, /Off/)
		assert.ok(!/token/i.test(panelText), 'no credential material is rendered')
		await page.screenshot({ path: join(outDir, 'fixture-settings-1000.png'), scale: 'css' })

		await page.locator('#sa-settings-title').fill('Sidecar')
		await page.getByRole('button', { name: 'Save' }).click()
		await page.waitForTimeout(150)
		let current = await calls()
		assert.equal(current.saveSettings.length, 1)
		assert.equal(current.saveSettings[0].title, 'Sidecar')
		assert.equal(current.saveSettings[0].expectedRevision, 4)
		assert.equal(Object.hasOwn(current.saveSettings[0], 'provider'), false, 'a title edit leaves the model choice untouched')
		assert.equal(Object.hasOwn(current.saveSettings[0], 'reasoningEffort'), false)
		assert.match(await page.locator('.sa-title').innerText(), /Sidecar/)

		await page.locator('#sa-settings-title').fill('Broken')
		await page.evaluate(() => { window.__fx.failSettingsSave = true })
		await page.getByRole('button', { name: 'Save' }).click()
		await page.waitForTimeout(150)
		assert.match(await page.locator('.sa-side [role="alert"]').innerText(), /Fixture settings save failed/)
		assert.match(await page.locator('.sa-title').innerText(), /Sidecar/, 'a failed save keeps the previous good title')
		await page.getByRole('button', { name: 'Close settings' }).click()
		await page.waitForTimeout(100)
		assert.equal(await page.locator('.sa-side').count(), 0)
	})

	await t.test('the right panel stays inside 320px and 390px without shrinking the restored chat', async () => {
		await reset()
		await setScenario('idle')
		for (const width of [390, 320]) {
			await page.setViewportSize({ width, height: 720 })
			await page.getByRole('button', { name: 'Settings' }).click()
			await page.locator('.sa-side').waitFor({ state: 'visible' })
			const measured = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth,
				side: (() => { const rect = document.querySelector('.sa-side').getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width } })(),
			}))
			assert.ok(measured.scrollWidth <= measured.innerWidth + 1, `no horizontal overflow at ${width}px`)
			assert.ok(measured.side.left >= -1 && measured.side.right <= measured.innerWidth + 1, `panel fits at ${width}px`)
			await page.screenshot({ path: join(outDir, `fixture-settings-${width}.png`), scale: 'css' })
			await page.getByRole('button', { name: 'Close settings' }).click()
			await page.waitForTimeout(80)
			const restored = await page.evaluate(() => {
				const page = document.querySelector('.sa-page').getBoundingClientRect()
				const input = document.querySelector('textarea.sa-input')?.getBoundingClientRect()
				return { scrollWidth: document.documentElement.scrollWidth, innerWidth, pageWidth: page.width, input: input ? { left: input.left, right: input.right } : null }
			})
			assert.ok(restored.scrollWidth <= restored.innerWidth + 1, `restored chat fits at ${width}px`)
			assert.ok(restored.pageWidth <= restored.innerWidth + 1)
			assert.ok(restored.input !== null && restored.input.right <= width + 1, `composer is reachable after closing at ${width}px`)
		}
		await page.setViewportSize({ width: 1000, height: 720 })
	})

	await t.test('transcript and composer match the live native column at 1920/1280', async () => {
		await reset()
		await setScenario('idle')
		const sanity = { 1920: 920, 1280: 680 }
		const measure = () => page.evaluate(() => {
			const content = (selector) => {
				const element = document.querySelector(selector)
				const style = getComputedStyle(element)
				const rect = element.getBoundingClientRect()
				return Math.round(rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
			}
			const pageWidth = document.querySelector('.sa-page').getBoundingClientRect().width
			document.querySelector('#native-probe').style.setProperty('--dsh-conversation-column-width', `${pageWidth}px`)
			return {
				native: content('#native-probe .EvIC1a_column'),
				transcript: content('.sa-column'),
				composer: content('.sa-composerColumn'),
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth,
			}
		})
		for (const [width, expected] of Object.entries(sanity)) {
			await page.setViewportSize({ width: Number(width), height: 900 })
			await page.waitForTimeout(100)
			const measured = await measure()
			assert.equal(measured.native, expected, `native live column sanity at ${width}px`)
			assert.equal(measured.transcript, measured.native, `transcript matches native at ${width}px`)
			assert.equal(measured.composer, measured.native, `composer matches native at ${width}px`)
			assert.ok(measured.scrollWidth <= measured.innerWidth + 1)
		}
		// Pre-change fixture content widths at the 280px-rail breakpoint: 366/296. Width change must not alter them.
		const mobile = { 390: 366, 320: 296 }
		for (const [width, expected] of Object.entries(mobile)) {
			await page.setViewportSize({ width: Number(width), height: 720 })
			await page.waitForTimeout(100)
			const measured = await measure()
			assert.equal(measured.transcript, expected, `mobile transcript unchanged at ${width}px`)
			assert.equal(measured.composer, expected, `mobile composer unchanged at ${width}px`)
			assert.ok(measured.scrollWidth <= measured.innerWidth + 1, `no overflow at ${width}px`)
			await page.screenshot({ path: join(outDir, `fixture-width-${width}.png`), scale: 'css' })
		}
		await page.setViewportSize({ width: 1000, height: 720 })
	})

	await t.test('no uncaught browser errors', () => {
		assert.deepEqual(consoleErrors, [])
	})
})
