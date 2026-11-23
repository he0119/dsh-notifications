/** Native notification schema and the reader for accepted preferences. */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { NotificationRule, NotificationSettings } from './runtime/types.ts'
import { DEFAULT_RULES, DEFAULT_SOUND_ENABLED, DEFAULT_USER_TURNS, DEFAULT_VOLUME, defaultPopupMode } from './defaults.ts'
export type { NotificationSettings } from './runtime/types.ts'
/** Native live fields for independent notification categories. */
export interface NotificationsConfig {
  desktop: Volatile<boolean>
  popupMode: Volatile<'never' | 'unfocused' | 'always' | undefined>
  volume: Volatile<number>
  soundEnabled: Volatile<boolean>
  userTurns: Volatile<boolean>
  goalRounds: Volatile<boolean>
  subagentWake: Volatile<boolean>
  backgroundWake: Volatile<boolean>
  teamWake: Volatile<boolean>
  webhookWake: Volatile<boolean>
  pluginWake: Volatile<boolean>
  otherWake: Volatile<boolean>
  completed: Volatile<NotificationRule>
  interrupted: Volatile<NotificationRule>
  question: Volatile<NotificationRule>
  approval: Volatile<NotificationRule>
}
const notificationRule = (fallback: NotificationRule) => z.object({ enabled: z.boolean().default(fallback.enabled), sound: z.union(['none', 'soft', 'double', 'chime', 'alert', 'custom']).default(fallback.sound) }).default(fallback).volatile()
/** Notification permission is local to the browser; only delivery preferences are persisted. */
export const Config: z<Record<string, unknown>, NotificationsConfig> = z.object({
  desktop: z.boolean().default(true).volatile(),
  popupMode: z.union(['never', 'unfocused', 'always']).volatile(),
  volume: z.natural().max(100).default(DEFAULT_VOLUME).volatile(),
  soundEnabled: z.boolean().default(DEFAULT_SOUND_ENABLED).volatile(),
  userTurns: z.boolean().default(DEFAULT_USER_TURNS).volatile(),
  goalRounds: z.boolean().default(false).volatile(),
  subagentWake: z.boolean().default(false).volatile(),
  backgroundWake: z.boolean().default(false).volatile(),
  teamWake: z.boolean().default(false).volatile(),
  webhookWake: z.boolean().default(false).volatile(),
  pluginWake: z.boolean().default(false).volatile(),
  otherWake: z.boolean().default(false).volatile(),
  completed: notificationRule(DEFAULT_RULES.completed),
  interrupted: notificationRule(DEFAULT_RULES.interrupted),
  question: notificationRule(DEFAULT_RULES.question),
  approval: notificationRule(DEFAULT_RULES.approval),
})
/** @param config - accepted native notification preferences. @returns an ordinary immutable view. */
export function readNotificationsConfig(config: NotificationsConfig): NotificationSettings {
  return { desktop: config.desktop.get(), popupMode: config.popupMode.get() ?? defaultPopupMode(config.desktop.get()), volume: config.volume.get(), soundEnabled: config.soundEnabled.get(), userTurns: config.userTurns.get(), goalRounds: config.goalRounds.get(), subagentWake: config.subagentWake.get(), backgroundWake: config.backgroundWake.get(), teamWake: config.teamWake.get(), webhookWake: config.webhookWake.get(), pluginWake: config.pluginWake.get(), otherWake: config.otherWake.get(), completed: config.completed.get(), interrupted: config.interrupted.get(), question: config.question.get(), approval: config.approval.get() }
}
