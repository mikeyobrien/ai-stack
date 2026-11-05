import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = resolve(here, '../../client.js')
const reactDir = process.env.SA_REACT_DIR ?? '/tmp/sa-fixture/node_modules'

/** One static file response with an explicit content type. */
function send(response, status, type, body) {
	response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
	response.end(body)
}

/**
 * Serve the isolated chat fixture, the real client bundle, and the React UMD
 * vendor files. No DSH host, no session, and no live Agent is involved.
 * @param {{port?: number}} [options] - listen port; 0 chooses a free one.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the running fixture server.
 */
export function startFixtureServer(options = {}) {
	const server = createServer(async (request, response) => {
		const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
		try {
			if (path === '/' || path === '/index.html') {
				return send(response, 200, 'text/html; charset=utf-8', await readFile(join(here, 'index.html')))
			}
			if (path === '/fixture.js') {
				return send(response, 200, 'text/javascript; charset=utf-8', await readFile(join(here, 'fixture.js')))
			}
			if (path === '/client.js') {
				return send(response, 200, 'text/javascript; charset=utf-8', await readFile(clientPath))
			}
			if (path === '/vendor/react.development.js') {
				return send(response, 200, 'text/javascript; charset=utf-8', await readFile(join(reactDir, 'react/umd/react.development.js')))
			}
			if (path === '/vendor/react-dom.development.js') {
				return send(response, 200, 'text/javascript; charset=utf-8', await readFile(join(reactDir, 'react-dom/umd/react-dom.development.js')))
			}
			return send(response, 404, 'text/plain; charset=utf-8', 'not found')
		} catch (error) {
			return send(response, 500, 'text/plain; charset=utf-8', String(error?.message ?? error))
		}
	})
	return new Promise((resolveServer, reject) => {
		server.once('error', reject)
		server.listen(options.port ?? 0, '127.0.0.1', () => {
			const address = server.address()
			resolveServer({
				port: typeof address === 'object' && address !== null ? address.port : 0,
				close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
			})
		})
	})
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const running = await startFixtureServer({ port: Number(process.env.SA_FIXTURE_PORT ?? 4173) })
	console.log(`fixture: http://127.0.0.1:${running.port}/`)
}
