/** Read-only native Remote API for background notification delivery. */
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopNotificationFrame, DesktopNotificationRequest, NotificationDeliveryFrame, NotificationRuntimeReaders } from './types.ts'
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'

/** Standalone live notification stream; it does not depend on enabling Remote network access. */
export class Notifications extends TypertRemoteService {
  constructor(ctx: Context, private readonly readers: NotificationRuntimeReaders) { super(ctx, 'dshNotifications') }
  /** Activate the registered desktop protocol only for a session the caller can access. */
  @Remote
  async activateDesktop(sessionId: string): Promise<boolean> {
    if (!this.readers.allowsSession(this.ctx, sessionId)) return false
    return this.readers.activateDesktop()
  }
  /** Native system popups are available only to the local owner, never a remote visitor. */
  private desktopOwner(): boolean { const principal = principalOf(this.ctx.invocation); return principal === undefined || principal.kind === 'owner' }
  @Remote
  async showDesktop(request: DesktopNotificationRequest): Promise<boolean> {
    if (!this.desktopOwner() || !this.readers.desktop || (request.sessionId !== undefined && !this.readers.allowsSession(this.ctx, request.sessionId))) return false
    return this.readers.desktop.show(request)
  }
  @Remote
  async closeDesktop(owner: string, id: string): Promise<void> { if (this.desktopOwner()) await this.readers.desktop?.close(owner, id) }
  @Remote
  acknowledgeDesktop(owner: string, id: string): void { if (this.desktopOwner()) this.readers.desktop?.acknowledge(owner, id) }
  /** Activation frames remain pending until the desktop confirms local navigation. */
  @Remote({ mode: 'stream' })
  async *desktopEvents(owner: string, signal: AbortSignal): AsyncIterable<DesktopNotificationFrame> {
    if (!this.desktopOwner() || !this.readers.desktop) { yield { supported: false }; return }
    for await (const frame of this.readers.desktop.events(owner, signal)) {
      if (frame.activation?.sessionId !== undefined && !this.readers.allowsSession(this.ctx, frame.activation.sessionId)) { this.readers.desktop.acknowledge(owner, frame.activation.id); continue }
      yield frame
    }
  }
  /** @param signal - cancellation from the native Remote carrier. @returns live, access-filtered outcomes and current preferences. */
  @Remote({ mode: 'stream' })
  async *events(signal: AbortSignal): AsyncIterable<NotificationDeliveryFrame> {
    for await (const frame of this.readers.observe(signal)) {
      const settings = this.readers.readSettings()
      yield {
        epoch: frame.epoch, cursor: frame.cursor, baseline: frame.baseline,
        events: frame.events.filter(event => this.readers.allowsSession(this.ctx, event.sessionId)),
        settings: { desktop: settings.desktop, popupMode: settings.popupMode ?? (settings.desktop ? 'unfocused' : 'never'), volume: settings.volume, soundEnabled: settings.soundEnabled ?? true, completed: {...settings.completed}, interrupted: {...settings.interrupted}, question: {...settings.question}, approval: {...settings.approval} },
      }
    }
  }
}
