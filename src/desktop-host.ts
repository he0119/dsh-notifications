/** Bounded desktop-only activation queues; no Session histories are retained. */
import type { DesktopNotificationActivation, DesktopNotificationFrame, DesktopNotificationRequest, DesktopNotificationRuntime } from './runtime/types.ts'
export interface NativePopupCarrier { readonly supported: boolean; show(popup: { id: string; title: string; body: string }): Promise<boolean>; close(id: string): Promise<void>; dispose(): Promise<void> }
export interface DesktopHostOptions { readonly createCarrier: (onActivate: (id: string) => void) => NativePopupCarrier; readonly allowsSession: (id: string) => boolean | undefined }
interface Channel { readonly pending: Map<string, DesktopNotificationActivation>; readonly wake: Set<() => void> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Native tokens are scoped to one renderer; acknowledged events are never replayed. */
export function createDesktopNotificationHost(options: DesktopHostOptions): DesktopNotificationRuntime & { dispose(): Promise<void> } {
  let disposed = false
  const requests = new Map<string, DesktopNotificationRequest>(), channels = new Map<string, Channel>()
  const channel = (owner: string): Channel | undefined => {
    let result = channels.get(owner)
    if (result) return result
    if (channels.size >= 128) {
      const unused = [...channels].find(([, value]) => value.pending.size === 0 && value.wake.size === 0)
      if (!unused) return
      channels.delete(unused[0])
    }
    result = { pending: new Map(), wake: new Set() }; channels.set(owner, result); return result
  }
  const carrier = options.createCarrier(key => {
    const request = requests.get(key)
    if (!request || disposed) return
    requests.delete(key)
    if (request.sessionId !== undefined && options.allowsSession(request.sessionId) === false) return
    const target = channel(request.owner)
    if (!target) return
    target.pending.set(request.id, { id: request.id, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) })
    if (target.pending.size > 64) target.pending.delete(target.pending.keys().next().value!)
    for (const wake of target.wake) wake()
  })
  const keyOf = (owner: string, id: string): string => owner + ':' + id
  const close = async (owner: string, id: string): Promise<void> => {
    if (!uuid.test(owner) || !uuid.test(id)) return
    const key = keyOf(owner, id)
    if (!requests.delete(key)) return
    await carrier.close(key)
  }
  return {
    async show(request) {
      if (disposed || !carrier.supported || !uuid.test(request.owner) || !uuid.test(request.id) || typeof request.title !== 'string' || typeof request.body !== 'string' || request.title.length > 1024 || request.body.length > 4096 || (request.sessionId !== undefined && (typeof request.sessionId !== 'string' || !request.sessionId || options.allowsSession(request.sessionId) !== true)) || !channel(request.owner)) return false
      const key = keyOf(request.owner, request.id)
      if (!requests.has(key) && requests.size >= 256) return false
      requests.set(key, { ...request })
      try { const accepted = await carrier.show({ id: key, title: request.title, body: request.body }); if (!accepted) requests.delete(key); return accepted }
      catch (error) { requests.delete(key); throw error }
    },
    close,
    acknowledge(owner, id) { if (uuid.test(owner) && uuid.test(id)) channels.get(owner)?.pending.delete(id) },
    async *events(owner, signal): AsyncIterable<DesktopNotificationFrame> {
      if (disposed || !uuid.test(owner) || !carrier.supported) { yield { supported: false }; return }
      const source = channel(owner)
      if (!source) { yield { supported: false }; return }
      yield { supported: true }
      const seen = new Set<string>()
      while (!disposed && !signal.aborted) {
        for (const [id, activation] of source.pending) {
          if (disposed || signal.aborted) return
          if (seen.has(id)) continue
          seen.add(id)
          if (seen.size > 256) seen.delete(seen.values().next().value!)
          if (activation.sessionId !== undefined && options.allowsSession(activation.sessionId) === false) { source.pending.delete(id); continue }
          yield { supported: true, activation }
        }
        if (disposed || signal.aborted) return
        await new Promise<void>(resolve => {
          const wake = (): void => { source.wake.delete(wake); signal.removeEventListener('abort', wake); resolve() }
          source.wake.add(wake); signal.addEventListener('abort', wake, { once: true })
          if (disposed || signal.aborted || [...source.pending.keys()].some(id => !seen.has(id))) wake()
        })
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const source of channels.values()) for (const wake of source.wake) wake()
      requests.clear(); channels.clear(); await carrier.dispose()
    },
  }
}
