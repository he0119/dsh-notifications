/** Credential-free data exchanged between the notification Host and its browser half. */
import type { Context } from '@deepseek-ai/cordis'

/** Four user-facing background notification categories. */
export type NotificationKind = 'completed' | 'interrupted' | 'question' | 'approval'
/** Built-in short tones; none preserves the popup without sound. */
export type NotificationPopupMode = 'never' | 'unfocused' | 'always'
export type NotificationSound = 'none' | 'soft' | 'double' | 'chime' | 'alert' | 'custom'
/** One category's independent delivery preference. */
export interface NotificationRule { readonly enabled: boolean; readonly sound: NotificationSound }
/** Browser notification preferences carried by the native notifications entry. */
export interface NotificationSettings {
  readonly desktop: boolean
  readonly popupMode?: NotificationPopupMode
  readonly volume: number
  readonly soundEnabled?: boolean
  /** Announce completed turns the user started; on by default, unlike the automatic ones. */
  readonly userTurns: boolean
  /** Announce every automatic goal round, instead of only the goal's final state. */
  readonly goalRounds: boolean
  /** Announce the closing turn after a subagent wakes the main session. */
  readonly subagentWake: boolean
  /** Announce the closing turn after a scheduled task or background job wakes it. */
  readonly backgroundWake: boolean
  /** Announce the closing turn after a teammate message wakes the main session. */
  readonly teamWake: boolean
  /** Announce the closing turn after an external event (a webhook delivery) wakes it. */
  readonly webhookWake: boolean
  /** Announce the closing turn after a plugin run wakes it. */
  readonly pluginWake: boolean
  /** Announce the closing turn for any other automatic producer DSH does not classify. */
  readonly otherWake: boolean
  readonly completed: NotificationRule
  readonly interrupted: NotificationRule
  readonly question: NotificationRule
  readonly approval: NotificationRule
}
/** Small live outcome; contains no message history or provider error payload. */
export interface NotificationEvent {
  readonly id: string
  readonly sessionId: string
  readonly kind: NotificationKind
  readonly reason?: string
}
/** A bounded snapshot from a single generation of the notification Host. */
export interface NotificationFrame {
  readonly epoch: string
  readonly cursor: number
  readonly baseline: boolean
  readonly events: readonly NotificationEvent[]
}
/** The standalone notifications entry owns this push source. */
export interface NotificationReaders {
  observe(signal: AbortSignal): AsyncIterable<NotificationFrame>
}

/** Client delivery frames also carry the current non-sensitive notification preferences. */
export interface NotificationDeliveryFrame extends NotificationFrame { readonly settings: NotificationSettings }
/** A Windows popup belongs to one desktop renderer and at most one accessible root session. */
export interface DesktopNotificationRequest { readonly owner: string; readonly id: string; readonly sessionId?: string; readonly title: string; readonly body: string }
export interface DesktopNotificationActivation { readonly id: string; readonly sessionId?: string }
export interface DesktopNotificationFrame { readonly supported: boolean; readonly activation?: DesktopNotificationActivation }
export interface DesktopNotificationRuntime {
  show(request: DesktopNotificationRequest): Promise<boolean>
  close(owner: string, id: string): Promise<void>
  acknowledge(owner: string, id: string): void
  events(owner: string, signal: AbortSignal): AsyncIterable<DesktopNotificationFrame>
}
/** Host-owned live events and accepted preferences, exposed without configuration mutation. */
export interface NotificationRuntimeReaders extends NotificationReaders {
  readSettings(): NotificationSettings
  activateDesktop(): Promise<boolean>
  readonly desktop?: DesktopNotificationRuntime
  /** Use the invocation Context so each caller keeps its native session access boundary. */
  allowsSession(ctx: Context, sessionId: string): boolean
}
