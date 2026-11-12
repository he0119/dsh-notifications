/** Renderer channel and wire data for the native desktop notification carrier. */
export type { DesktopNotificationRequest, DesktopNotificationActivation, DesktopNotificationFrame, DesktopNotificationRuntime } from '../../runtime/types.ts'
export interface DesktopPopup { readonly id: string; readonly title: string; readonly body: string; readonly sessionId?: string }
export interface DesktopNotificationChannel {
  supported(): boolean
  show(popup: DesktopPopup, eligible?: () => boolean, clicked?: () => void): Promise<boolean>
  close(id: string): Promise<void>
  dispose(): void
}
export type DesktopNotificationFactory = (onActivate: (sessionId?: string) => void | Promise<void>) => DesktopNotificationChannel
