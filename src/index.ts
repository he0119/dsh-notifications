/** Background notifications for completed, interrupted, answering and approving sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { installRuntimeMetadata } from './runtime/metadata.ts'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Config, readNotificationsConfig, type NotificationsConfig } from './config.ts'
import { PLUGIN_NAME } from './constants.ts'
import { Notifications } from './runtime/index.ts'
import { activateDesktopApp } from './activation.ts'
import { createNotificationHost } from './host.ts'
import { installNotificationWorkerRoute } from './web.ts'
import { createDesktopNotificationHost } from './desktop-host.ts'
import { createWindowsNotifications } from './windows/carrier.ts'
export { Config }
/** Plugin row id, matching `cordis.patch.yml`. */
export const name = PLUGIN_NAME
/** Native services this plugin needs: committed session outcomes, the Remote gateway and caller access. */
export const inject = ['sessions', 'agents', 'typert', 'typertGateway', 'remoteAccess']
/** @param ctx - native component owner. @param config - accepted per-category preferences. */
export function apply(ctx: Context, config: NotificationsConfig): void {
  installRuntimeMetadata(ctx)
  installNotificationWorkerRoute(ctx)
  const source = createNotificationHost(ctx)
  const desktop = createDesktopNotificationHost({
    createCarrier: onActivate => createWindowsNotifications({ activateDesktop: () => activateDesktopApp(), onActivate }, { onWarning: message => ctx.logger.warn('Windows notification: ' + message) }),
    allowsSession: id => { const session = ctx.sessions.get(id as SessionId); return session === undefined ? undefined : session.header.origin !== 'subagent' && (session.header.delegationDepth ?? 0) === 0 },
  })
  ctx.effect(() => () => desktop.dispose())
  ctx.on('loader/volatile-update', () => source.refresh())
  new Notifications(ctx, {
    observe: signal => source.observe(signal),
    desktop,
    readSettings: () => readNotificationsConfig(config),
    activateDesktop: () => activateDesktopApp(),
    allowsSession: (caller, id) => caller.remoteAccess.allows({kind:'session',id:id as SessionId}),
  })
}
