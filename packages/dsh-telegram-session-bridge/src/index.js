import { createBridge } from './bridge.js';

export const name = 'telegram-session-bridge';

/**
 * The bridge is in-host: it rides cordis push envelopes and the session
 * service. Two long-polls on one bot token conflict, so it ships as its own
 * bot identity; it never touches dsh-im's token or state.
 */
export const inject = ['sessionController'];

function servicesOf(ctx) {
  return { sessionController: ctx?.sessionController };
}

/**
 * Cordis host entry. Config is the profile-patch row; a missing token or an
 * unusable state file disables the plugin with a readable error instead of
 * blocking DSH boot, so an operator can install it before provisioning the
 * second bot.
 */
export async function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console;
  let bridge;
  try {
    bridge = await createBridge({
      config,
      services: servicesOf(ctx),
      logger,
    });
  } catch (error) {
    logger?.error?.(`[telegram-session-bridge] disabled: ${error?.message ?? error}`);
    return;
  }

  const disposers = [
    ctx.on('session/event', (session, event) => bridge.handleSessionEvent(session, event), { global: true }),
    ctx.on(
      'approval/request',
      (request, next) => bridge.handleApproval(request, next),
      { global: true, prepend: true },
    ),
    ctx.on(
      'user-questions/request',
      (request, next) => bridge.handleQuestion(request, next),
      { global: true, prepend: true },
    ),
  ];
  ctx.effect?.(() => async () => {
    for (const dispose of disposers.reverse()) dispose?.();
    await bridge.stop();
  });
  await bridge.start();
  return bridge;
}
