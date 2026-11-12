/** Windows desktop popups: short owner-scoped native ids, readiness and acknowledgement. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { DesktopNotificationFrame, DesktopNotificationRequest } from '../src/client/logic/desktop-types.ts'
import { createDesktopNotificationClient, DESKTOP_OWNER_KEY } from '../src/client/logic/desktop-client.ts'

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

interface StorageProbe { readonly data: Map<string, string>; getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> }
function memoryStorage(initial: Record<string, string> = {}): StorageProbe {
  const data = new Map(Object.entries(initial))
  return { data, getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value) }) }
}
interface WindowProbe {
  readonly dshDesktop?: unknown
  readonly location?: { readonly protocol?: string }
  readonly navigator?: { readonly platform?: string }
  readonly sessionStorage?: unknown
}
function desktopWindow(patch: WindowProbe = {}): WindowProbe {
  return { dshDesktop: {}, location: { protocol: 'dsh-app:' }, navigator: { platform: 'Win32' }, sessionStorage: memoryStorage(), ...patch }
}

/** The real Remote transport boundary; only the carrier is mocked. */
function remoteProbe() {
  const queued: DesktopNotificationFrame[] = []
  let wake: ((frame: DesktopNotificationFrame) => void) | undefined
  const opened: { readonly owner: string; readonly signal: AbortSignal; disposed: number }[] = []
  const desktopEvents = (owner: string, signal: AbortSignal) => {
    const entry = { owner, signal, disposed: 0 }
    opened.push(entry)
    let finished = false
    let settleCurrent: (() => void) | undefined
    const iterator = (async function* () {
      while (!finished && !signal.aborted) {
        const next = queued.shift() ?? await new Promise<DesktopNotificationFrame | undefined>(resolve => {
          let done = false
          const finish = (value?: DesktopNotificationFrame): void => {
            if (done) return
            done = true
            signal.removeEventListener('abort', abort)
            if (wake === finish) wake = undefined
            resolve(value)
          }
          const abort = (): void => finish(undefined)
          settleCurrent = () => finish(undefined)
          signal.addEventListener('abort', abort, { once: true })
          wake = value => finish(value)
        })
        settleCurrent = undefined
        if (next === undefined) return
        yield next
      }
    })()
    return {
      [Symbol.asyncIterator]: () => iterator,
      send: (_item: never) => {},
      end: () => {},
      dispose: () => { entry.disposed += 1; finished = true; settleCurrent?.() },
    }
  }
  const showDesktop = vi.fn(async (_request: DesktopNotificationRequest): Promise<Result<boolean>> => ok(true))
  const closeDesktop = vi.fn(async (_owner: string, _id: string): Promise<Result<void>> => ok(undefined))
  const acknowledgeDesktop = vi.fn(async (_owner: string, _id: string): Promise<Result<void>> => ok(undefined))
  const push = (frame: DesktopNotificationFrame): void => {
    if (wake !== undefined) { const resolve = wake; wake = undefined; resolve(frame) } else queued.push(frame)
  }
  return { opened, push, service: { desktopEvents, showDesktop, closeDesktop, acknowledgeDesktop }, showDesktop, closeDesktop, acknowledgeDesktop }
}

const disposers: (() => Promise<void> | void)[] = []
async function fixture(options: { window?: WindowProbe; remote?: ReturnType<typeof remoteProbe>; onActivate?: (sessionId?: string) => void | Promise<void> } = {}) {
  const view = options.window ?? desktopWindow()
  vi.stubGlobal('window', view)
  const remote = options.remote ?? remoteProbe()
  const ctx = new Context()
  ctx.provide('remote', { dshNotifications: remote.service } as never)
  ctx.provide('remote.dshNotifications', remote.service as never)
  const warnings: string[] = []
  ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'warn') warnings.push(message.args.map(value => typeof value === 'string' ? value : String(value)).join(' ')) } })
  const onActivate = vi.fn(options.onActivate ?? (async () => {}))
  const channel = createDesktopNotificationClient(ctx, onActivate)
  disposers.push(async () => { channel.dispose(); await ctx.fiber.dispose() })
  return { ctx, channel, remote, onActivate, warnings, view, storage: view.sessionStorage as StorageProbe | undefined }
}
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

const inert: readonly [string, WindowProbe][] = [
  ['a plain browser', desktopWindow({ location: { protocol: 'https:' } })],
  ['a non-Windows desktop renderer', desktopWindow({ navigator: { platform: 'MacIntel' } })],
  ['a renderer without the desktop bridge', desktopWindow({ dshDesktop: null })],
]
it.each(inert)('stays inert in %s without storage or RPC', async (_label, view) => {
  const test = await fixture({ window: view })
  await settle()
  expect(test.remote.opened).toHaveLength(0)
  expect(test.channel.supported()).toBe(false)
  expect(await test.channel.show({ id: 'long-logical-id', title: 'Title', body: 'Body' })).toBe(false)
  await expect(test.channel.close('long-logical-id')).resolves.toBeUndefined()
  const storage = view.sessionStorage as StorageProbe
  expect(storage.getItem).not.toHaveBeenCalled()
  expect(storage.setItem).not.toHaveBeenCalled()
  expect(test.remote.showDesktop).not.toHaveBeenCalled()
  test.channel.dispose()
})

it('waits for the supported frame and submits one short native id for the stable owner', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  const owner = test.remote.opened[0]!.owner
  expect(owner.length).toBeGreaterThan(20)
  expect(test.storage!.data.get(DESKTOP_OWNER_KEY)).toBe(owner)
  const logical = 'session-event-' + 'x'.repeat(300)
  let settled: boolean | undefined
  const pending = test.channel.show({ id: logical, sessionId: 's1', title: 'Done', body: 'Body' }).then(value => { settled = value; return value })
  await settle()
  expect(settled).toBeUndefined()
  expect(test.remote.showDesktop).not.toHaveBeenCalled()
  test.remote.push({ supported: true })
  await expect(pending).resolves.toBe(true)
  expect(test.remote.showDesktop).toHaveBeenCalledTimes(1)
  const request = test.remote.showDesktop.mock.calls[0]![0]
  expect(request.owner).toBe(owner)
  expect(request.id).not.toBe(logical)
  expect(request.id.length).toBeLessThan(64)
  expect(request.sessionId).toBe('s1')
  expect(request.title).toBe('Done')
  expect(request.body).toBe('Body')
})

it('waits for a Remote service provided after the channel was created', async () => {
  const view = desktopWindow()
  vi.stubGlobal('window', view)
  const ctx = new Context()
  const remote = remoteProbe()
  const channel = createDesktopNotificationClient(ctx, vi.fn())
  disposers.push(async () => { channel.dispose(); await ctx.fiber.dispose() })
  let settled: boolean | undefined
  const pending = channel.show({ id: 'logical', title: 'Title', body: 'Body' }).then(value => { settled = value; return value })
  await settle()
  expect(settled).toBeUndefined()
  ctx.provide('remote', { dshNotifications: remote.service } as never)
  ctx.provide('remote.dshNotifications', remote.service as never)
  await vi.waitFor(() => expect(remote.opened).toHaveLength(1))
  expect(settled).toBeUndefined()
  remote.push({ supported: true })
  await expect(pending).resolves.toBe(true)
  expect(remote.showDesktop).toHaveBeenCalledTimes(1)
})

it('reuses the stored owner and falls back to an unpersisted random owner when storage is denied', async () => {
  const view = desktopWindow()
  const first = await fixture({ window: view })
  await vi.waitFor(() => expect(first.remote.opened).toHaveLength(1))
  const owner = (view.sessionStorage as StorageProbe).data.get(DESKTOP_OWNER_KEY)
  expect(owner).toBe(first.remote.opened[0]!.owner)
  const second = await fixture({ window: view })
  await vi.waitFor(() => expect(second.remote.opened).toHaveLength(1))
  expect(second.remote.opened[0]!.owner).toBe(owner)
  const denied = { getItem: vi.fn(() => { throw new Error('denied') }), setItem: vi.fn(() => { throw new Error('denied') }) }
  const third = await fixture({ window: desktopWindow({ sessionStorage: denied }) })
  await vi.waitFor(() => expect(third.remote.opened).toHaveLength(1))
  expect(third.remote.opened[0]!.owner.length).toBeGreaterThan(20)
  third.remote.push({ supported: true })
  expect(await third.channel.show({ id: 'logical', title: 'Title', body: 'Body' })).toBe(true)
})

it('navigates a new native id once, acknowledges it, and accepts a missing session', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  const owner = test.remote.opened[0]!.owner
  test.remote.push({ supported: true })
  test.remote.push({ supported: true, activation: { id: 'native-loaded', sessionId: 's9' } })
  await vi.waitFor(() => expect(test.onActivate).toHaveBeenCalledWith('s9'))
  await vi.waitFor(() => expect(test.remote.acknowledgeDesktop).toHaveBeenCalledWith(owner, 'native-loaded'))
  test.remote.push({ supported: true, activation: { id: 'native-loaded', sessionId: 's9' } })
  await vi.waitFor(() => expect(test.remote.acknowledgeDesktop).toHaveBeenCalledTimes(2))
  expect(test.onActivate).toHaveBeenCalledTimes(1)
  test.remote.push({ supported: true, activation: { id: 'native-without-session' } })
  await vi.waitFor(() => expect(test.onActivate).toHaveBeenCalledTimes(2))
  expect(test.onActivate).toHaveBeenLastCalledWith(undefined)
})

it('does not acknowledge a failed navigation and retries it on redelivery', async () => {
  let attempts = 0
  const test = await fixture({ onActivate: async () => { attempts += 1; if (attempts === 1) throw new Error('focus refused') } })
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.push({ supported: true })
  test.remote.push({ supported: true, activation: { id: 'native-retry', sessionId: 's1' } })
  await vi.waitFor(() => expect(test.onActivate).toHaveBeenCalledTimes(1))
  await settle()
  expect(test.remote.acknowledgeDesktop).not.toHaveBeenCalled()
  expect(test.warnings.join('\n')).toContain('activation')
  test.remote.push({ supported: true, activation: { id: 'native-retry', sessionId: 's1' } })
  await vi.waitFor(() => expect(test.remote.acknowledgeDesktop).toHaveBeenCalledWith(test.remote.opened[0]!.owner, 'native-retry'))
  expect(test.onActivate).toHaveBeenCalledTimes(2)
})

it('keeps a navigated id remembered when only the acknowledgement fails', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.acknowledgeDesktop.mockResolvedValue({ ok: false, error: new Error('offline') })
  test.remote.push({ supported: true })
  test.remote.push({ supported: true, activation: { id: 'native-ack', sessionId: 's1' } })
  await vi.waitFor(() => expect(test.remote.acknowledgeDesktop).toHaveBeenCalledTimes(1))
  expect(test.onActivate).toHaveBeenCalledTimes(1)
  expect(test.warnings.join('\n')).toContain('acknowledgement')
  test.remote.acknowledgeDesktop.mockResolvedValue(ok(undefined))
  test.remote.push({ supported: true, activation: { id: 'native-ack', sessionId: 's1' } })
  await vi.waitFor(() => expect(test.remote.acknowledgeDesktop).toHaveBeenCalledTimes(2))
  expect(test.onActivate).toHaveBeenCalledTimes(1)
})

it('invokes the observed click callback before navigation and closes a replaced native card', async () => {
  const order: string[] = []
  const test = await fixture({ onActivate: async () => { order.push('activate') } })
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.acknowledgeDesktop.mockImplementation(async () => { order.push('ack'); return ok(undefined) })
  test.remote.showDesktop.mockImplementation(async request => { order.push('show:' + request.id); return ok(true) })
  test.remote.push({ supported: true })
  const clicked = vi.fn(() => { order.push('clicked') })
  expect(await test.channel.show({ id: 'logical-1', title: 'Title', body: 'Body' }, () => true, clicked)).toBe(true)
  const first = test.remote.showDesktop.mock.calls[0]![0].id
  test.remote.push({ supported: true, activation: { id: first, sessionId: 's1' } })
  await vi.waitFor(() => expect(order).toEqual(['show:' + first, 'clicked', 'activate', 'ack']))
  expect(await test.channel.show({ id: 'logical-1', title: 'Next', body: 'Next body' }, () => true, vi.fn())).toBe(true)
  const second = test.remote.showDesktop.mock.calls[1]![0].id
  expect(second).not.toBe(first)
  await vi.waitFor(() => expect(test.remote.closeDesktop).toHaveBeenCalledWith(test.remote.opened[0]!.owner, first))
})

it('rechecks caller eligibility right before submission and cancels a pending show', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  let allowed = true
  const pending = test.channel.show({ id: 'logical', title: 'Title', body: 'Body' }, () => allowed)
  await settle()
  expect(test.remote.showDesktop).not.toHaveBeenCalled()
  allowed = false
  test.remote.push({ supported: true })
  await expect(pending).resolves.toBe(false)
  expect(test.remote.showDesktop).not.toHaveBeenCalled()
})

it('cancels submission when the desktop bridge reports unsupported', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.push({ supported: false })
  await expect(test.channel.show({ id: 'logical', title: 'Title', body: 'Body' })).resolves.toBe(false)
  expect(test.remote.showDesktop).not.toHaveBeenCalled()
})

it('reports a rejected submission without registering a card', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.push({ supported: true })
  test.remote.showDesktop.mockResolvedValue({ ok: false, error: new Error('denied') })
  expect(await test.channel.show({ id: 'logical', title: 'Title', body: 'Body' })).toBe(false)
  expect(test.warnings.join('\n')).toContain('submission')
  const closedAfterRejection = test.remote.closeDesktop.mock.calls.length
  await test.channel.close('logical')
  expect(test.remote.closeDesktop).toHaveBeenCalledTimes(closedAfterRejection)
})

it('closes only its own remembered cards', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.push({ supported: true })
  expect(await test.channel.show({ id: 'logical', title: 'Title', body: 'Body' })).toBe(true)
  const owner = test.remote.opened[0]!.owner, native = test.remote.showDesktop.mock.calls[0]![0].id
  await test.channel.close('logical')
  expect(test.remote.closeDesktop).toHaveBeenCalledWith(owner, native)
  await test.channel.close('logical')
  await test.channel.close('foreign-native')
  expect(test.remote.closeDesktop).toHaveBeenCalledTimes(1)
})

it('closes the oldest native card before forgetting it beyond the bound', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.push({ supported: true })
  const owner = test.remote.opened[0]!.owner
  const natives: string[] = []
  for (let index = 0; index < 65; index += 1) {
    expect(await test.channel.show({ id: 'logical-' + index, title: 'Title', body: 'Body' })).toBe(true)
    natives.push(test.remote.showDesktop.mock.calls.at(-1)![0].id)
  }
  await vi.waitFor(() => expect(test.remote.closeDesktop).toHaveBeenCalledWith(owner, natives[0]!))
  await test.channel.close('logical-0')
  expect(test.remote.closeDesktop).toHaveBeenCalledTimes(1)
})

it('bounds navigated native ids so a long-forgotten replay navigates again', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.push({ supported: true })
  for (let index = 0; index < 65; index += 1) test.remote.push({ supported: true, activation: { id: 'activation-' + index, sessionId: 's' + index } })
  await vi.waitFor(() => expect(test.onActivate).toHaveBeenCalledTimes(65))
  expect(test.remote.acknowledgeDesktop).toHaveBeenCalledTimes(65)
  test.remote.push({ supported: true, activation: { id: 'activation-0', sessionId: 's0' } })
  await vi.waitFor(() => expect(test.onActivate).toHaveBeenCalledTimes(66))
  test.remote.push({ supported: true, activation: { id: 'activation-64', sessionId: 's64' } })
  await vi.waitFor(() => expect(test.remote.acknowledgeDesktop).toHaveBeenCalledTimes(67))
  expect(test.onActivate).toHaveBeenCalledTimes(66)
})

it('aborts the old stream and waits for a fresh supported frame after a reconnect', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.push({ supported: true })
  expect(await test.channel.show({ id: 'before', title: 'Title', body: 'Body' })).toBe(true)
  const first = test.remote.opened[0]!
  test.ctx.emit('connection/reset')
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(2))
  expect(first.signal.aborted).toBe(true)
  expect(first.disposed).toBeGreaterThan(0)
  let settled: boolean | undefined
  const pending = test.channel.show({ id: 'after', title: 'Title', body: 'Body' }).then(value => { settled = value; return value })
  await settle()
  expect(settled).toBeUndefined()
  test.remote.push({ supported: true })
  await expect(pending).resolves.toBe(true)
  expect(test.remote.showDesktop).toHaveBeenCalledTimes(2)
})

it('aborts its stream, closes its cards and ignores late activations on dispose', async () => {
  const test = await fixture()
  await vi.waitFor(() => expect(test.remote.opened).toHaveLength(1))
  test.remote.push({ supported: true })
  expect(await test.channel.show({ id: 'logical', title: 'Title', body: 'Body' })).toBe(true)
  const owner = test.remote.opened[0]!.owner, native = test.remote.showDesktop.mock.calls[0]![0].id
  test.channel.dispose()
  expect(test.remote.opened[0]!.signal.aborted).toBe(true)
  expect(test.remote.opened[0]!.disposed).toBeGreaterThan(0)
  await vi.waitFor(() => expect(test.remote.closeDesktop).toHaveBeenCalledWith(owner, native))
  test.remote.push({ supported: true, activation: { id: 'late-native', sessionId: 's1' } })
  await settle()
  expect(test.onActivate).not.toHaveBeenCalled()
  expect(await test.channel.show({ id: 'later', title: 'Title', body: 'Body' })).toBe(false)
  expect(test.channel.supported()).toBe(false)
})

it('cancels a native request while the Host submission is still pending',async()=>{
 const test=await fixture(),reply=Promise.withResolvers<Result<boolean>>();test.remote.showDesktop.mockImplementation(()=>reply.promise);test.remote.push({supported:true});const sending=test.channel.show({id:'pending',sessionId:'root',title:'Title',body:'Body'})
 try{await vi.waitFor(()=>expect(test.remote.showDesktop).toHaveBeenCalledOnce());const request=test.remote.showDesktop.mock.calls[0]![0];await test.channel.close('pending');expect(test.remote.closeDesktop).toHaveBeenCalledWith(request.owner,request.id);reply.resolve(ok(true));expect(await sending).toBe(false)}finally{reply.resolve(ok(true));await sending}
})
it('replaces an invalid stored owner with a UUID accepted by the Host',async()=>{
 const view=desktopWindow({sessionStorage:memoryStorage({[DESKTOP_OWNER_KEY]:'old-invalid-owner'})}),test=await fixture({window:view});await vi.waitFor(()=>expect(test.remote.opened).toHaveLength(1));expect(test.remote.opened[0]!.owner).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
})
