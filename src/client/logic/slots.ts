/** A root settings editor for the native notifications namespace. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { NotificationSettings } from '../../runtime/types.ts'
import type { NotificationClient, DeliveryState } from './delivery.ts'
import type { NotificationKey } from './locales.ts'

export interface NotificationSettingsInjected {
  hooks: { notificationSettings: ObservableSnapshot<ConfigFormSnapshot<NotificationSettings>>; notificationCapabilities: ObservableSnapshot<DeliveryState>; notificationPreferences: ObservableSnapshot<NotificationSettings | undefined> }
  saveSettings(value: NotificationSettings, revision: number | undefined): Promise<boolean>
  requestPermission(): Promise<void>
  preview: NotificationClient['preview']
  test: NotificationClient['test']
  importCustomSound: NotificationClient['importCustomSound']
  removeCustomSound: NotificationClient['removeCustomSound']
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dshNotifications: NotificationKey }
}
