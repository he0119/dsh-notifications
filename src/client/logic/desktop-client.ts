/** Owner-scoped Windows desktop popups over the public Typert Remote bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '../../runtime/generated/typert.remote-client.js'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { DesktopNotificationChannel, DesktopNotificationFrame, DesktopNotificationRequest, DesktopPopup } from './desktop-types.ts'

/** Stable per-renderer storage key; the Host only ever sees this opaque owner. */
export const DESKTOP_OWNER_KEY = 'dshNotifications.notifications.desktopOwner'
/** Bounded native-card memory; the oldest card is closed before it is forgotten. */
const MAX_NATIVE_IDS = 64

interface DesktopNotificationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
interface DesktopWindow {
  readonly dshDesktop?: unknown
  readonly location?: { readonly protocol?: string }
  readonly navigator?: { readonly platform?: string }
  readonly sessionStorage?: DesktopNotificationStorage
}

function desktopWindow(): DesktopWindow | undefined {
  const candidate = (globalThis as unknown as { window?: unknown }).window
  return typeof candidate === 'object' && candidate !== null ? candidate as DesktopWindow : undefined
}

/** Only a Windows renderer served from the desktop protocol owns native popups. */
function desktopHost(): boolean {
  const view = desktopWindow()
  if (view === undefined) return false
  if (typeof view.dshDesktop !== 'object' || view.dshDesktop === null) return false
  let protocol = '', platform = ''
  try { protocol = view.location?.protocol ?? '' } catch (_unavailable) { protocol = '' }
  try { platform = view.navigator?.platform ?? '' } catch (_unavailable) { platform = '' }
  return protocol === 'dsh-app:' && /^Win/.test(platform)
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function randomId(): string {
  const direct = globalThis.crypto?.randomUUID?.()
  if (typeof direct === 'string' && uuid.test(direct)) return direct
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
}

function ownerStorage(): DesktopNotificationStorage | undefined {
  try { return desktopWindow()?.sessionStorage } catch (_unavailable) { return undefined }
}

/** One stable owner per renderer; a denied storage keeps the owner renderer-local. */
function ownerId(): string {
  const storage = ownerStorage()
  try {
    const stored = storage?.getItem(DESKTOP_OWNER_KEY)
    if (typeof stored === 'string' && uuid.test(stored)) return stored
  } catch (_unavailable) { /* mint below */ }
  const created = randomId()
  try { storage?.setItem(DESKTOP_OWNER_KEY, created) } catch (_unavailable) { /* renderer-local owner */ }
  return created
}

/**
 * Create the local Windows notification channel.
 * The channel subscribes only after the Host confirms support, submits short native ids,
 * acknowledges a click only after local navigation succeeded, and never retains Session data.
 */
export function createDesktopNotificationClient(ctx: Context, onActivate: (sessionId?: string) => void | Promise<void>): DesktopNotificationChannel {
  if (!desktopHost()) return { supported: () => false, show: async () => false, close: async () => {}, dispose: () => {} }
  const owner = ownerId()
  let disposed = false
  let supported: boolean | undefined
  let waiting: Promise<boolean> | undefined
  let settleWaiting: ((value: boolean) => void) | undefined
  let controller: AbortController | undefined
  let stream: RemoteStreamHandle<DesktopNotificationFrame, never> | undefined
  let remote: Context['remote']['dshNotifications'] | undefined
  const cards = new Map<string, { logical: string; clicked?: () => void }>()
  const byLogical = new Map<string, string>()
  const seen = new Set<string>()
  const inflight = new Set<string>()

  const warn = (message: string, error?: unknown): void => {
    try { ctx.logger.warn(message, error) } catch (_loggerUnavailable) { /* delivery must not fail on logging */ }
  }
  const ready = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false)
    if (supported !== undefined) return Promise.resolve(supported)
    if (waiting !== undefined) return waiting
    waiting = new Promise<boolean>(resolve => { settleWaiting = resolve })
    return waiting
  }
  const settle = (value: boolean): void => {
    const resolve = settleWaiting
    settleWaiting = undefined
    waiting = undefined
    resolve?.(value)
  }
  const closeNative = async (id: string): Promise<void> => {
    const service = remote
    if (service === undefined) return
    try {
      const result = await service.closeDesktop(owner, id)
      if (!result.ok) warn('Desktop notification close failed', result.error)
    } catch (error) { warn('Desktop notification close failed', error) }
  }
  const acknowledge = async (id: string): Promise<void> => {
    const service = remote
    if (service === undefined) return
    try {
      const result = await service.acknowledgeDesktop(owner, id)
      if (!result.ok) warn('Desktop notification acknowledgement failed', result.error)
    } catch (error) { warn('Desktop notification acknowledgement failed', error) }
  }
  const forget = (native: string): void => {
    const card = cards.get(native)
    if (card === undefined) return
    cards.delete(native)
    if (byLogical.get(card.logical) === native) byLogical.delete(card.logical)
  }
  const remember = (logical: string, native: string, clicked?: () => void): void => {
    cards.set(native, clicked === undefined ? { logical } : { logical, clicked })
    byLogical.set(logical, native)
    while (cards.size > MAX_NATIVE_IDS) {
      const oldest = cards.keys().next().value
      if (oldest === undefined) break
      forget(oldest)
      void closeNative(oldest)
    }
  }
  const markSeen = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    while (seen.size > MAX_NATIVE_IDS) {
      const oldest = seen.values().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
  }
  const activate = async (activation: { readonly id: string; readonly sessionId?: string }): Promise<void> => {
    const id = activation.id
    if (disposed) return
    if (seen.has(id)) { await acknowledge(id); return }
    if (inflight.has(id)) return
    inflight.add(id)
    const card = cards.get(id)
    const clicked = card?.clicked
    if (card !== undefined) delete card.clicked
    try {
      if (clicked !== undefined) await clicked()
      await onActivate(activation.sessionId)
      if (disposed) return
      markSeen(id)
      await acknowledge(id)
    } catch (error) { warn('Desktop notification activation failed', error) }
    finally { inflight.delete(id) }
  }
  const accept = async (frame: DesktopNotificationFrame): Promise<void> => {
    if (disposed) return
    supported = frame.supported === true
    settle(supported)
    if (frame.activation !== undefined) await activate(frame.activation)
  }

  const fiber = ctx.inject(['remote', 'remote.dshNotifications'], scope => {
    const start = (): void => {
      controller?.abort()
      stream?.dispose()
      stream = undefined
      controller = undefined
      // A pending show keeps waiting for this generation's first frame instead of
      // failing when Remote arrives late or the carrier reconnects.
      supported = undefined
      if (disposed) return
      const active = controller = new AbortController()
      const service = scope.remote.dshNotifications
      remote = service
      void (async () => {
        let handle: RemoteStreamHandle<DesktopNotificationFrame, never> | undefined
        try {
          const current = service.desktopEvents(owner, active.signal)
          handle = current
          stream = current
          for await (const frame of current) await accept(frame)
          if (!disposed && !active.signal.aborted) { supported = false; settle(false) }
        } catch (error) {
          if (!disposed && !active.signal.aborted) { warn('Desktop notification events are unavailable', error); supported = false; settle(false) }
        } finally { handle?.dispose(); if (stream === handle) stream = undefined }
      })()
    }
    scope.on('connection/reset', start)
    scope.effect(() => {
      start()
      return () => {
        controller?.abort()
        stream?.dispose()
        stream = undefined
        controller = undefined
        remote = undefined
      }
    })
  })

  const show = async (popup: DesktopPopup, eligible: () => boolean = () => true, clicked?: () => void): Promise<boolean> => {
    if (disposed || !desktopHost()) return false
    if (!eligible()) return false
    if (!await ready() || disposed) return false
    if (!eligible()) return false
    const service = remote
    if (service === undefined) return false
    const native = randomId()
    const request: DesktopNotificationRequest = { owner, id: native, title: popup.title, body: popup.body, ...(popup.sessionId === undefined ? {} : { sessionId: popup.sessionId }) }
    const previous = byLogical.get(popup.id)
    if (previous !== undefined) { forget(previous); void closeNative(previous) }
    remember(popup.id, native, clicked)
    try {
      const result = await service.showDesktop(request)
      if (!result.ok) warn('Desktop notification submission failed', result.error)
      if (!result.ok || result.value !== true || disposed || (byLogical.get(popup.id) !== native && !seen.has(native)) || !eligible()) { forget(native); await closeNative(native); return false }
      return true
    } catch (error) { forget(native); await closeNative(native); warn('Desktop notification submission failed', error); return false }
  }
  const close = async (id: string): Promise<void> => {
    const native = byLogical.get(id)
    if (native === undefined) return
    forget(native)
    await closeNative(native)
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    supported = false
    settle(false)
    controller?.abort()
    controller = undefined
    stream?.dispose()
    stream = undefined
    const natives = [...cards.keys()]
    cards.clear()
    byLogical.clear()
    seen.clear()
    inflight.clear()
    for (const native of natives) void closeNative(native)
    void fiber.dispose().catch(() => {})
  }
  return { supported: () => !disposed && desktopHost(), show, close, dispose }
}
