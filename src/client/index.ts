/** Browser half: live notification delivery and the standalone settings page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { CONFIG_NS } from '../constants.ts'
import { TYPERT_REMOTE } from '../runtime/generated/typert.remote-client.js'
import type { NotificationSettings } from '../runtime/types.ts'
import { installNotifications } from './notifications.ts'
import { normalizeNotificationPreferences } from './logic/preferences.ts'
import { installSettingsPage } from './components/NotificationsSettings.tsx'
import { installStyles } from './styles.ts'
export const inject = ['uiSession', 'uiWorkspace', 'sessions', 'remote', 'locale', 'slots', 'configForms']
/** Install the notification delivery client, its styles and its settings page. */
export function apply(ctx: Context): void {
  ctx.effect(() => installStyles())
  // This package owns the Remote namespace itself, so it mounts it without a Remote component.
  ctx.effect(async function* () { yield await ctx.remote.$mount(TYPERT_REMOTE) })
  const form = ctx.configForms.get<NotificationSettings>(CONFIG_NS)
  const client = installNotifications(ctx, () => normalizeNotificationPreferences(form.getSnapshot().value))
  installSettingsPage(ctx, { form, client })
}
