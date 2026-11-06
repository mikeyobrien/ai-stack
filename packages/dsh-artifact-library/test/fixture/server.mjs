/**
 * Static server for the Artifact Library client fixture.
 *
 * It serves the package's real `client.js`, the fixture page/harness, and the
 * staged React CommonJS files. It is not a DSH host and never reads a profile,
 * artifact store or session. `/exfil*` exists only so the browser test can
 * prove that the sandboxed report never reaches it.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = resolve(here, '../../client.js');
const reactDir = process.env.LIB_REACT_DIR ?? '/tmp/libclient-repair/reactstage/node_modules';
const requests = [];

const vendor = {
	'/vendor/react/cjs/react.development.js': join(reactDir, 'react/cjs/react.development.js'),
	'/vendor/scheduler/cjs/scheduler.development.js': join(reactDir, 'scheduler/cjs/scheduler.development.js'),
	'/vendor/react-dom/cjs/react-dom.development.js': join(reactDir, 'react-dom/cjs/react-dom.development.js'),
	'/vendor/react-dom/cjs/react-dom-client.development.js': join(reactDir, 'react-dom/cjs/react-dom-client.development.js'),
};

/** One static file response with an explicit content type. */
function send(response, status, type, body) {
	response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
	response.end(body);
}

/**
 * Serve the fixture, the real client bundle, and the staged React vendor files.
 * @param {{port?: number}} [options] - listen port; 0 chooses a free one.
 * @returns {Promise<{port: number, close: () => Promise<void>, exfil: Array<{url: string, method: string}>}>}
 */
export function startFixtureServer(options = {}) {
	const server = createServer(async (request, response) => {
		const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
		try {
			if (path === '/' || path === '/index.html') {
				return send(response, 200, 'text/html; charset=utf-8', await readFile(join(here, 'index.html')));
			}
			if (path === '/fixture.js') {
				return send(response, 200, 'text/javascript; charset=utf-8', await readFile(join(here, 'fixture.js')));
			}
			if (path === '/client.js') {
				return send(response, 200, 'text/javascript; charset=utf-8', await readFile(clientPath));
			}
			if (path === '/__exfil') {
				return send(response, 200, 'application/json; charset=utf-8', JSON.stringify(requests));
			}
			if (path.startsWith('/exfil')) {
				requests.push({ url: request.url, method: request.method });
				if (path.endsWith('.png')) {
					const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2h8AAAAASUVORK5CYII=', 'base64');
					return send(response, 200, 'image/png', pixel);
				}
				if (path.endsWith('.css')) return send(response, 200, 'text/css; charset=utf-8', 'body{display:none}');
				return send(response, 200, 'text/plain; charset=utf-8', 'exfil');
			}
			const file = vendor[path];
			if (file !== undefined) {
				return send(response, 200, 'text/javascript; charset=utf-8', await readFile(file));
			}
			return send(response, 404, 'text/plain; charset=utf-8', 'not found');
		} catch (error) {
			return send(response, 500, 'text/plain; charset=utf-8', String(error?.message ?? error));
		}
	});
	return new Promise((resolveServer, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, '127.0.0.1', () => {
			const address = server.address();
			resolveServer({
				port: typeof address === 'object' && address !== null ? address.port : 0,
				close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
				exfil: requests,
			});
		});
	});
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const running = await startFixtureServer({ port: Number(process.env.LIB_FIXTURE_PORT ?? 4174) });
	console.log(`library fixture: http://127.0.0.1:${running.port}/`);
}
