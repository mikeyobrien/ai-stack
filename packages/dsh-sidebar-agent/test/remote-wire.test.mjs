import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { test } from 'node:test'
import { NAMESPACE, agentService } from '../index.js'

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * The Host's own SRC descriptor builder, wired to the registry it reads. An
 * external plugin has no strict definition, so this is the path the running
 * Gateway takes for every `agent` method.
 */
function hostGateway() {
	const gateway = Object.create(TypertGatewayService.prototype)
	gateway.ctx = { typert: { lookups: { definitions: () => [] }, contexts: { getHost: () => undefined } } }
	return gateway
}

function serviceUnderTest() {
	const Klass = agentService({ host: {}, agent: null, gate: null, delegations: new Map() })
	const instance = new Klass(new Context())
	const marker = Object.getOwnPropertyDescriptor(Klass.prototype, REMOTE_METHOD_DESCRIPTOR).value
	const gateway = hostGateway()
	const describe = (declaration) => gateway.srcDescriptor(
		{ service: instance, serviceKey: 'agent', namespace: NAMESPACE },
		declaration,
		declaration.method,
		`${NAMESPACE}/${declaration.method}`,
	)
	return { marker, describe }
}

test('every agent Remote method is dispatchable by the Host Gateway', () => {
	const { marker, describe } = serviceUnderTest()
	assert.ok(marker.methods.length > 0)
	for (const declaration of marker.methods) {
		assert.doesNotThrow(() => describe(declaration), `${NAMESPACE}/${declaration.method}`)
	}
})

test('each derived wire contract matches the parameters the service declares', () => {
	const { marker, describe } = serviceUnderTest()
	for (const declaration of marker.methods) {
		const descriptor = describe(declaration)
		assert.deepEqual(
			descriptor.parameters.map((parameter) => parameter.wire),
			(declaration.parameters ?? []).map((parameter) => parameter.wire),
			`${NAMESPACE}/${declaration.method}`,
		)
		assert.equal(descriptor.invocation.kind, declaration.invocation.kind)
	}
})

test('the composer takes only the request field, so a client cannot skip the gate', () => {
	const { marker, describe } = serviceUnderTest()
	const chat = marker.methods.find((declaration) => declaration.method === 'chat')
	assert.ok(chat)
	assert.deepEqual(describe(chat).parameters.map((parameter) => parameter.wire), ['request'])
})
