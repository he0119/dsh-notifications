/** @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://dsh.example/app"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServiceWorkerNotifications } from '../src/client/logic/service-worker-client.ts'
import { NOTIFICATION_ACTIVATION_MESSAGE, NOTIFICATION_WORKER_PATH, NOTIFICATION_WORKER_SCOPE } from '../src/service-worker.ts'

class WorkerFixture extends EventTarget { constructor(readonly scriptURL: string, public state: ServiceWorkerState = 'activated') { super() } }
class RegistrationFixture extends EventTarget {
  scope = 'https://dsh.example' + NOTIFICATION_WORKER_SCOPE
  active: WorkerFixture | null = new WorkerFixture('https://dsh.example' + NOTIFICATION_WORKER_PATH)
  installing: WorkerFixture | null = null; waiting: WorkerFixture | null = null
  showNotification = vi.fn(async (_title: string, _options: NotificationOptions) => {})
  getNotifications = vi.fn(async (_options?: GetNotificationOptions) => [] as { tag: string; close(): void }[])
  unregister = vi.fn(async () => true)
}
class ContainerFixture extends EventTarget {
  register = vi.fn(async (_url: string, _options?: RegistrationOptions) => this.registration)
  getRegistration = vi.fn(async (_url?: string) => this.registration)
  constructor(readonly registration: RegistrationFixture) { super() }
  get ready(): never { throw new Error('Never wait on the root page controller') }
}
let constructorCalls = 0
const owned: { dispose(): void }[] = []
beforeEach(() => { history.replaceState(null, '', '/app?auth=private#route'); constructorCalls = 0 })
afterEach(() => { owned.splice(0).forEach(owner => owner.dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture(onActivate = vi.fn()) {
  class AndroidNotification { static permission: NotificationPermission = 'granted'; constructor() { constructorCalls++; throw new TypeError('Illegal constructor') } }
  const registration = new RegistrationFixture(), container = new ContainerFixture(registration)
  vi.stubGlobal('navigator', { serviceWorker: container }); vi.stubGlobal('Notification', AndroidNotification); vi.stubGlobal('isSecureContext', true)
  const helper = createServiceWorkerNotifications(onActivate); owned.push(helper)
  return { registration, container, helper, onActivate }
}
it('lazily submits Android notifications through its own narrow registration without using the constructor', async () => {
  const { helper, container, registration } = fixture()
  expect(helper.supported()).toBe(true); expect(container.register).not.toHaveBeenCalled()
  await helper.show({ id: 'result-1', title: 'Done', body: 'Finished', sessionId: 'root-session' })
  expect(container.register).toHaveBeenCalledWith(NOTIFICATION_WORKER_PATH, { scope: NOTIFICATION_WORKER_SCOPE, type: 'classic', updateViaCache: 'none' })
  expect(registration.showNotification).toHaveBeenCalledWith('Done', { body: 'Finished', tag: 'result-1', silent: true, data: { id: 'result-1', sessionId: 'root-session', appUrl: 'https://dsh.example/app' } })
  expect(constructorCalls).toBe(0)
})
it('waits for this returned registration to activate while the root page remains uncontrolled', async () => {
  const { helper, registration } = fixture(), installing = new WorkerFixture('https://dsh.example' + NOTIFICATION_WORKER_PATH, 'installing')
  registration.active = null; registration.installing = installing
  const submitted = helper.show({ id: 'installing', title: 'Done', body: 'Body' })
  await Promise.resolve(); await Promise.resolve(); expect(registration.showNotification).not.toHaveBeenCalled()
  registration.active = installing; registration.installing = null; installing.state = 'activated'; installing.dispatchEvent(new Event('statechange'))
  await submitted; expect(registration.showNotification).toHaveBeenCalledOnce()
})
function notify(container: ContainerFixture, data: unknown, source: unknown, origin = 'https://dsh.example'): void {
  const event = new Event('message'); Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: origin } }); container.dispatchEvent(event)
}
it('routes a valid message from its persisted worker without requiring this page to have shown the notification', async () => {
  const { helper, container, onActivate } = fixture()
  notify(container, { type: NOTIFICATION_ACTIVATION_MESSAGE, sessionId: 'clicked-root' }, new WorkerFixture('https://dsh.example' + NOTIFICATION_WORKER_PATH))
  await Promise.resolve(); await Promise.resolve()
  expect(onActivate).toHaveBeenCalledWith('clicked-root'); expect(container.register).not.toHaveBeenCalled()
  helper.dispose(); notify(container, { type: NOTIFICATION_ACTIVATION_MESSAGE, sessionId: 'after-dispose' }, new WorkerFixture('https://dsh.example' + NOTIFICATION_WORKER_PATH))
  await Promise.resolve(); expect(onActivate).toHaveBeenCalledOnce()
})
it('consumes only the owned session parameter before activating a newly opened page', async () => {
  history.replaceState({ keep: true }, '', '/app?auth=private&dshNotificationSession=opened-root#route')
  const { helper, onActivate, container } = fixture()
  expect(new URL(location.href).searchParams.has('dshNotificationSession')).toBe(false)
  expect(new URL(location.href).searchParams.get('auth')).toBe('private'); expect(location.hash).toBe('#route'); expect(history.state).toEqual({ keep: true })
  await Promise.resolve(); expect(onActivate).toHaveBeenCalledWith('opened-root'); expect(container.register).not.toHaveBeenCalled()
  helper.dispose(); const next = fixture(); await Promise.resolve(); expect(next.onActivate).not.toHaveBeenCalled()
})
it('closes only the requested tag in an existing own registration without registering a worker', async () => {
  const { helper, registration, container } = fixture(), target = { tag: 'close-me', close: vi.fn() }, other = { tag: 'keep-me', close: vi.fn() }
  registration.getNotifications.mockResolvedValue([target, other])
  await helper.close('close-me')
  expect(container.register).not.toHaveBeenCalled(); expect(registration.getNotifications).toHaveBeenCalledWith({ tag: 'close-me' })
  expect(target.close).toHaveBeenCalledOnce(); expect(other.close).not.toHaveBeenCalled()
})
it('returns false when eligibility changes while its own worker activates', async () => {
  const { helper, registration } = fixture(), installing = new WorkerFixture('https://dsh.example' + NOTIFICATION_WORKER_PATH, 'installing')
  registration.active = null; registration.installing = installing; let eligible = true
  const result = helper.show({ id: 'answered-in-flight', title: 'Question', body: 'Body' }, () => eligible)
  await Promise.resolve(); await Promise.resolve(); eligible = false
  registration.active = installing; registration.installing = null; installing.state = 'activated'; installing.dispatchEvent(new Event('statechange'))
  expect(await result).toBe(false); expect(registration.showNotification).not.toHaveBeenCalled()
})

it.each([
  { origin: 'https://evil.example', script: 'https://dsh.example' + NOTIFICATION_WORKER_PATH, type: NOTIFICATION_ACTIVATION_MESSAGE },
  { origin: 'https://dsh.example', script: 'https://dsh.example/core-sw.js', type: NOTIFICATION_ACTIVATION_MESSAGE },
  { origin: 'https://dsh.example', script: 'https://dsh.example' + NOTIFICATION_WORKER_PATH, type: 'foreign-protocol' },
])('rejects foreign message origin, worker or protocol: %j', async entry => {
  const { container, onActivate } = fixture()
  notify(container, { type: entry.type, sessionId: 'do-not-open' }, new WorkerFixture(entry.script), entry.origin)
  await Promise.resolve(); expect(onActivate).not.toHaveBeenCalled()
})
it('never closes notifications from the Core root registration', async () => {
  const { helper, container, registration } = fixture(); registration.scope = 'https://dsh.example/'
  await helper.close('logical-id')
  expect(container.register).not.toHaveBeenCalled(); expect(registration.getNotifications).not.toHaveBeenCalled()
})
it('returns submitted true only after the platform submission promise resolves', async () => {
  const { helper, registration } = fixture(); const delivery = Promise.withResolvers<void>()
  registration.showNotification.mockReturnValue(delivery.promise)
  let settled: boolean | undefined
  const submitted = helper.show({ id: 'platform-pending', title: 'Done', body: 'Body' }).then(result => { settled = result; return result })
  await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledOnce()); expect(settled).toBeUndefined()
  delivery.resolve(); expect(await submitted).toBe(true)
})
it('cancels an activation wait on dispose without unregistering the persistent worker', async () => {
  const { helper, registration } = fixture(), installing = new WorkerFixture('https://dsh.example' + NOTIFICATION_WORKER_PATH, 'installing')
  registration.active = null; registration.installing = installing
  const pending = helper.show({ id: 'unloaded', title: 'Done', body: 'Body' })
  await Promise.resolve(); await Promise.resolve(); helper.dispose()
  expect(await pending).toBe(false); installing.state = 'activated'; installing.dispatchEvent(new Event('statechange'))
  expect(registration.showNotification).not.toHaveBeenCalled(); expect(registration.unregister).not.toHaveBeenCalled()
})
it('settles a pending register operation as cancelled immediately when its owner is disposed', async () => {
  const { helper, container, registration } = fixture(), registering = Promise.withResolvers<RegistrationFixture>()
  container.register.mockReturnValue(registering.promise)
  let settled: boolean | undefined
  const pending = helper.show({ id: 'register-pending', title: 'Done', body: 'Body' }).then(result => { settled = result; return result })
  helper.dispose()
  try { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false) }
  finally { registering.resolve(registration); await pending }
  expect(registration.showNotification).not.toHaveBeenCalled()
})
it('propagates a platform submission error instead of reporting submitted', async () => {
  const { helper, registration } = fixture(), error = new DOMException('System rejected notification', 'NotAllowedError')
  registration.showNotification.mockRejectedValue(error)
  await expect(helper.show({ id: 'rejected', title: 'Done', body: 'Body' })).rejects.toBe(error)
})
it('allows a later explicit retry after registration fails', async () => {
  const { helper, container } = fixture(), error = new TypeError('Worker script unavailable')
  container.register.mockRejectedValueOnce(error)
  await expect(helper.show({ id: 'first', title: 'Done', body: 'Body' })).rejects.toBe(error)
  expect(await helper.show({ id: 'retry', title: 'Done', body: 'Body' })).toBe(true)
  expect(container.register).toHaveBeenCalledTimes(2)
})
it('does not register or request permission implicitly when system notification permission is denied', async () => {
  const { helper, container } = fixture(); Object.defineProperty(Notification, 'permission', { configurable: true, value: 'denied' })
  await expect(helper.show({ id: 'denied', title: 'Done', body: 'Body' })).rejects.toMatchObject({ name: 'NotAllowedError' })
  expect(container.register).not.toHaveBeenCalled()
})
