/**
 * Session links — shareable URLs that open one chat thread in the Web GUI.
 *
 * The Client half reads the session out of the page URL and selects it. This
 * Host half contributes the `session_link` tool, so an agent can produce the
 * link (and its short `dsh-session:` reference) for the current thread or one
 * it names.
 *
 * @module @local/dsh-session-links
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { sessionReference, sessionUrl } from './links.js';

/** Cordis plugin name. */
export const name = 'dsh-session-links';

/** The tool needs the tool registry; the GUI URL is optional. */
export const inject = ['tools'];

/** Canonical output of `session_link`. */
const LINK_OUTPUT = {
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			sessionId: { type: 'string', required: true },
			url: { type: 'string', required: true },
			reference: { type: 'string', required: true },
		},
	},
	render: (_args, value) => [{ type: 'text', text: `${value.url}\n${value.reference}` }],
};

/**
 * Register the link tool.
 * @param ctx - Cordis context carrying the `tools` service.
 */
export function apply(ctx) {
	ctx.tools.register(defineTool({
		name: 'session_link',
		description:
			'Get the shareable link for one chat thread: a URL that opens that session in the DSH web GUI, plus its short `dsh-session:` reference. Use it when the person asks for a link to this conversation or another thread.',
		parameters: {
			sessionId: {
				type: 'string',
				description: 'Session to link; defaults to the session calling the tool.',
			},
		},
		output: LINK_OUTPUT,
		execute(args, exec) {
			const requested = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
			const sessionId = requested !== '' ? requested : exec?.agent?.session?.id;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('session_link: no session to link');
			const base = ctx.get('webApp')?.getAdvertisedUrl?.();
			if (typeof base !== 'string' || base.trim() === '') throw new Error('session_link: this host serves no web GUI');
			return {
				sessionId,
				url: sessionUrl(base, sessionId),
				reference: sessionReference(sessionId),
			};
		},
	}));
}
