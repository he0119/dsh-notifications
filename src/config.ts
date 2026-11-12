/** Native notification schema and the reader for accepted preferences. */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { NotificationRule, NotificationSettings, NotificationSound } from './runtime/types.ts'
export type { NotificationSettings } from './runtime/types.ts'
/** Native live fields for independent notification categories. */
export interface NotificationsConfig {
  desktop: Volatile<boolean>
  popupMode: Volatile<'never' | 'unfocused' | 'always' | undefined>
  volume: Volatile<number>
  soundEnabled: Volatile<boolean>
  completed: Volatile<NotificationRule>
  interrupted: Volatile<NotificationRule>
  question: Volatile<NotificationRule>
  approval: Volatile<NotificationRule>
}
const notificationRule = (sound: NotificationSound) => z.object({ enabled: z.boolean().default(true), sound: z.union(['none', 'soft', 'double', 'chime', 'alert', 'custom']).default(sound) }).default({enabled:true,sound}).volatile()
/** Notification permission is local to the browser; only delivery preferences are persisted. */
export const Config: z<Record<string, unknown>, NotificationsConfig> = z.object({
  desktop: z.boolean().default(true).volatile(),
  popupMode: z.union(['never', 'unfocused', 'always']).volatile(),
  volume: z.natural().max(100).default(80).volatile(),
  soundEnabled: z.boolean().default(true).volatile(),
  completed: notificationRule('chime'),
  interrupted: notificationRule('alert'),
  question: notificationRule('soft'),
  approval: notificationRule('double'),
})
/** @param config - accepted native notification preferences. @returns an ordinary immutable view. */
export function readNotificationsConfig(config: NotificationsConfig): NotificationSettings {
  return { desktop: config.desktop.get(), popupMode: config.popupMode.get() ?? (config.desktop.get() ? 'unfocused' : 'never'), volume: config.volume.get(), soundEnabled: config.soundEnabled.get(), completed: config.completed.get(), interrupted: config.interrupted.get(), question: config.question.get(), approval: config.approval.get() }
}
