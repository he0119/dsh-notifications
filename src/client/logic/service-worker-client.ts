/** Browser-side submission through an isolated worker registration. */
import { NOTIFICATION_ACTIVATION_MESSAGE, NOTIFICATION_SESSION_PARAMETER, NOTIFICATION_WORKER_PATH, NOTIFICATION_WORKER_SCOPE } from '../../service-worker.ts'
export interface WorkerNotification { readonly id: string; readonly title: string; readonly body: string; readonly sessionId?: string }
export interface ServiceWorkerNotifications { supported(): boolean; show(notification: WorkerNotification, eligible?: () => boolean): Promise<boolean>; close(id: string): Promise<void>; dispose(): void }
/** Register only for a real submission; resolution means submitted, never OS shown. */
export function createServiceWorkerNotifications(onActivate: (sessionId: string) => void | Promise<void>): ServiceWorkerNotifications {
  let disposed = false, registration: Promise<ServiceWorkerRegistration> | undefined
  const supported = (): boolean => !disposed && typeof window !== 'undefined' && globalThis.isSecureContext === true && ['https:', 'http:'].includes(window.location.protocol) && typeof Notification === 'function' && typeof navigator !== 'undefined' && typeof navigator.serviceWorker?.register === 'function'
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  const workerUrl = typeof window === 'undefined' ? undefined : new URL(NOTIFICATION_WORKER_PATH, window.location.href).href
  const activate = (sessionId: string): void => { void Promise.resolve().then(() => { if (!disposed) return onActivate(sessionId) }).catch(error => console.warn('Could not activate the notification session', error)) }
  const message = (event: MessageEvent<unknown>): void => {
    if (disposed || event.origin !== window.location.origin) return
    const data = event.data, source = event.source
    if (!data || typeof data !== 'object' || !('type' in data) || data.type !== NOTIFICATION_ACTIVATION_MESSAGE || !('sessionId' in data) || typeof data.sessionId !== 'string' || !data.sessionId) return
    try { if (!source || !('scriptURL' in source) || source.scriptURL !== workerUrl) return } catch (_foreignSource) { return }
    activate(data.sessionId)
  }
  container?.addEventListener('message', message)
  if (typeof window !== 'undefined') {
    const current = new URL(window.location.href)
    if (current.searchParams.has(NOTIFICATION_SESSION_PARAMETER)) {
      const sessionId = current.searchParams.get(NOTIFICATION_SESSION_PARAMETER)
      current.searchParams.delete(NOTIFICATION_SESSION_PARAMETER)
      window.history.replaceState(window.history.state, '', current.href)
      if (sessionId) activate(sessionId)
    }
  }
  const cancelWaits = new Set<() => void>()
  const activated = (owner: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> => new Promise((resolve, reject) => {
    const workers = new Set<ServiceWorker>(); let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true; owner.removeEventListener('updatefound', check)
      for (const worker of workers) worker.removeEventListener('statechange', check)
      cancelWaits.delete(cancel)
      if (error) reject(error); else resolve(owner)
    }
    const cancel = (): void => finish(new DOMException('Notification owner is disposed', 'AbortError'))
    const check = (): void => {
      if (disposed) { cancel(); return }
      const candidates = [owner.active, owner.installing, owner.waiting].filter((worker): worker is ServiceWorker => worker !== null)
      if (candidates.some(worker => worker.state === 'activated')) { finish(); return }
      if (!candidates.length || candidates.every(worker => worker.state === 'redundant')) { finish(new DOMException('The notification worker could not activate', 'InvalidStateError')); return }
      for (const worker of candidates) if (!workers.has(worker)) { workers.add(worker); worker.addEventListener('statechange', check) }
    }
    cancelWaits.add(cancel); owner.addEventListener('updatefound', check); check()
  })
  const getRegistration = (): Promise<ServiceWorkerRegistration> => {
    if (registration !== undefined) return registration
    const pending = new Promise<ServiceWorkerRegistration>((resolve, reject) => {
      const cancel = (): void => { cancelWaits.delete(cancel); reject(new DOMException('Notification owner is disposed', 'AbortError')) }
      cancelWaits.add(cancel)
      let request: Promise<ServiceWorkerRegistration>
      try { request = navigator.serviceWorker.register(NOTIFICATION_WORKER_PATH, { scope: NOTIFICATION_WORKER_SCOPE, type: 'classic', updateViaCache: 'none' }) }
      catch (error) { cancelWaits.delete(cancel); reject(error); return }
      void request.then(activated).then(owner => { cancelWaits.delete(cancel); resolve(owner) }, error => { cancelWaits.delete(cancel); reject(error) })
    }).catch(error => { if (registration === pending) registration = undefined; throw error })
    registration = pending; return pending
  }
  return {
    supported,
    async show(notification, eligible = () => true) {
      if (disposed) return false
      if (!supported()) throw new DOMException('Service worker notifications are unavailable', 'NotSupportedError')
      if (Notification.permission !== 'granted') throw new DOMException('Notification permission is not granted', 'NotAllowedError')
      let owner: ServiceWorkerRegistration
      try { owner = await getRegistration() } catch (error) { if (disposed) return false; throw error }
      const app = new URL(window.location.href); app.username = ''; app.password = ''; app.search = ''; app.hash = ''
      const data = { id: notification.id, ...(notification.sessionId === undefined ? {} : { sessionId: notification.sessionId }), appUrl: app.href }
      if (disposed || !eligible()) return false
      await owner.showNotification(notification.title, { body: notification.body, tag: notification.id, silent: true, data })
      return true
    },
    async close(id) {
      if (disposed || container === undefined || workerUrl === undefined) return
      const owner = registration === undefined ? await container.getRegistration(workerUrl) : await registration
      const scope = new URL(NOTIFICATION_WORKER_SCOPE, workerUrl).href
      if (owner === undefined || owner.scope !== scope) return
      for (const notification of await owner.getNotifications({ tag: id })) if (notification.tag === id) notification.close()
    },
    dispose() { if (disposed) return; disposed = true; container?.removeEventListener('message', message); for (const cancel of [...cancelWaits]) cancel(); cancelWaits.clear() },
  }
}
