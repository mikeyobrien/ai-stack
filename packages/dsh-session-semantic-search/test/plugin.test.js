/**
 * Plugin wiring test: the package owns `ctx.sessionQuery`, constructs the
 * native engine on an isolated realm, and delegates every non-hybrid method.
 */

import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import SemanticSessionQueryEngine, { resolveConfig } from '../index.js';
import { makeTempHome } from './helpers.js';

/** Minimal live-session registry: no live sessions, no persistence service. */
class SessionsService extends Service {
	constructor(ctx) {
		super(ctx, 'sessions');
	}

	list() {
		return [];
	}

	get() {
		return undefined;
	}
}

test('the plugin registers one sessionQuery provider over an isolated inner engine', async () => {
	const home = await makeTempHome();
	const root = new Context();
	new SessionsService(root);
	const plugin = new SemanticSessionQueryEngine(root, {
		dshHome: home,
		indexer: false,
		endpointUrl: 'http://127.0.0.1:1/v1/embeddings',
	});
	try {
		const service = root.get('sessionQuery');
		assert.ok(service instanceof SemanticSessionQueryEngine);
		assert.equal(service.constructor.name, 'SemanticSessionQueryEngine');

		const page = await service.searchSessions({ query: 'anything at all' });
		assert.deepEqual(page, { items: [] }, 'an empty corpus returns the native empty page');

		assert.deepEqual(await service.listSessions(), [], 'reads delegate to the inner engine');

		await assert.rejects(service.searchEvents({ sessionId: 'session-missing', query: 'x' }), (error) => {
			assert.equal(error.code, 'SESSION_QUERY_SESSION_NOT_FOUND');
			return true;
		});

		const ftsPath = join(home, 'embeddings', 'session-query.sqlite');
		await access(ftsPath);
	} finally {
		await plugin.close();
	}
});

test('the inner engine never becomes a second outer provider', async () => {
	const home = await makeTempHome();
	const root = new Context();
	new SessionsService(root);
	const plugin = new SemanticSessionQueryEngine(root, { dshHome: home, indexer: false, endpointUrl: 'http://127.0.0.1:1/v1/embeddings' });
	try {
		const outer = root.get('sessionQuery');
		// The outer realm resolves exactly one provider, and it is this package.
		assert.ok(outer instanceof SemanticSessionQueryEngine);
		assert.equal(outer.constructor.name, 'SemanticSessionQueryEngine');
		assert.equal(typeof outer.readTitle, 'function');
	} finally {
		await plugin.close();
	}
});

test('the default endpoint is local and DSH_EMBED_ENDPOINT overrides it', () => {
	const saved = process.env.DSH_EMBED_ENDPOINT;
	try {
		delete process.env.DSH_EMBED_ENDPOINT;
		assert.equal(resolveConfig({ dshHome: '/tmp/dsh' }).endpointUrl, 'http://127.0.0.1:8890/v1/embeddings');
		process.env.DSH_EMBED_ENDPOINT = 'http://embeddings.example:9000/v1/embeddings';
		assert.equal(resolveConfig({ dshHome: '/tmp/dsh' }).endpointUrl, 'http://embeddings.example:9000/v1/embeddings');
		assert.equal(resolveConfig({ dshHome: '/tmp/dsh', endpointUrl: 'http://127.0.0.1:1/v1/embeddings' }).endpointUrl, 'http://127.0.0.1:1/v1/embeddings', 'explicit config wins');
	} finally {
		if (saved === undefined) delete process.env.DSH_EMBED_ENDPOINT;
		else process.env.DSH_EMBED_ENDPOINT = saved;
	}
});
