import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { NOTIFICATION_ACTIVATION_MESSAGE, NOTIFICATION_WORKER_SCRIPT } from '../src/service-worker.ts'

function worker(windows: { url: string; focused?: boolean; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }[] = []) {
  const listeners = new Map<string, (event: unknown) => void>(), openWindow = vi.fn(async (_url: string) => null), matchAll = vi.fn(async () => windows)
  runInNewContext(NOTIFICATION_WORKER_SCRIPT, { self: { location: { origin: 'https://dsh.example' }, clients: { matchAll, openWindow }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) }, URL })
  return { listeners, openWindow, matchAll, async click(data: unknown) { const wait: Promise<unknown>[] = [], close = vi.fn(); const listener = listeners.get('notificationclick'); expect(listener).toBeTypeOf('function'); listener!({ notification: { data, close }, waitUntil: (promise: Promise<unknown>) => wait.push(promise) }); await Promise.all(wait); return close } }
}
it('focuses an existing same-origin DSH page and sends the persistent session identity', async () => {
  const page = { url: 'https://dsh.example/?auth=do-not-forward', focus: vi.fn(async () => page), postMessage: vi.fn() }, foreign = { url: 'https://other.example/', focus: vi.fn(), postMessage: vi.fn() }
  const app = worker([foreign, page])
  const close = await app.click({ id: 'done-1', sessionId: 'real-session', appUrl: 'https://dsh.example/' })
  expect(close).toHaveBeenCalledOnce(); expect(page.focus).toHaveBeenCalledOnce(); expect(foreign.focus).not.toHaveBeenCalled()
  expect(page.postMessage).toHaveBeenCalledWith({ type: NOTIFICATION_ACTIVATION_MESSAGE, sessionId: 'real-session' })
  expect(app.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true }); expect(app.openWindow).not.toHaveBeenCalled()
  expect(app.listeners.has('fetch')).toBe(false)
})
it('opens a clean same-origin application URL when no matching page exists', async () => {
  const unrelated = { url: 'https://dsh.example/unrelated', focus: vi.fn(), postMessage: vi.fn() }, app = worker([unrelated])
  await app.click({ id: 'done-2', sessionId: 'session / 名', appUrl: 'https://dsh.example/app?view=previous#old-panel' })
  const target = new URL(app.openWindow.mock.calls[0]![0])
  expect(target.origin + target.pathname).toBe('https://dsh.example/app'); expect([...target.searchParams]).toEqual([['dshNotificationSession', 'session / 名']]); expect(target.hash).toBe('')
  expect(unrelated.focus).not.toHaveBeenCalled()
})
it.each(['https://evil.example/', 'javascript:alert(1)', 'not a URL'])('rejects an unsafe stored application URL %s', async appUrl => {
  const app = worker(); await app.click({ id: 'bad', sessionId: 'target', appUrl })
  expect(app.matchAll).not.toHaveBeenCalled(); expect(app.openWindow).not.toHaveBeenCalled()
})
it('opens a new page when an existing tab disappears while being focused', async () => {
  const gone = { url: 'https://dsh.example/', focus: vi.fn(async () => { throw new Error('Tab closed') }), postMessage: vi.fn() }, app = worker([gone])
  await app.click({ id: 'closed-tab', sessionId: 'target', appUrl: 'https://dsh.example/' })
  expect(gone.postMessage).not.toHaveBeenCalled(); expect(app.openWindow).toHaveBeenCalledWith('https://dsh.example/?dshNotificationSession=target')
})
it('focuses a test-notification page without inventing a session target', async () => {
  const page = { url: 'https://dsh.example/app', focus: vi.fn(async () => page), postMessage: vi.fn() }, app = worker([page])
  await app.click({ id: 'no-selection-test', appUrl: 'https://dsh.example/app' })
  expect(page.focus).toHaveBeenCalledOnce(); expect(page.postMessage).not.toHaveBeenCalled(); expect(app.openWindow).not.toHaveBeenCalled()
})
