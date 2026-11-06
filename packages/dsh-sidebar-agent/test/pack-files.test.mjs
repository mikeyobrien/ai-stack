import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'

const packageDir = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(resolve(packageDir, '..', 'package.json'), 'utf8'))

function runtimeRelativeImports(file) {
	const source = readFileSync(resolve(packageDir, '..', file), 'utf8')
	const specifiers = []
	for (const match of source.matchAll(/(?:import|export)\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1])
	for (const match of source.matchAll(/import\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1])
	return [...new Set(specifiers.filter((s) => s.startsWith('./')))]
}

test('every runtime module reachable by relative import is included in the npm pack file list', () => {
	const packFiles = new Set(packageJson.files)
	for (const entry of Object.values(packageJson.exports ?? {})) if (typeof entry === 'string') packFiles.add(entry.replace(/^\.\//, ''))
	const runtime = ['index.js', 'client.js', 'telegram-host.js', 'voice.js', 'telegram-miniapp.js', 'deployment-callback.js', 'ingress-gate.js', 'judge.js', 'decision-log.js', 'pulse-feed.js', 'machine-meta.js']
	for (const file of runtime) {
		assert.ok(packFiles.has(file), `runtime module ${file} is missing from package.json files`)
	}
	for (const file of runtime) {
		for (const spec of runtimeRelativeImports(file)) {
			const target = spec.slice(2)
			assert.ok(packFiles.has(target) || target.endsWith('.json'), `${file} imports ${spec} which is not in the npm pack file list`)
		}
	}
})
