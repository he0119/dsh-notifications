/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement, useRef, useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import * as nativePrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId as sessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NotificationDeliveryFrame, NotificationSettings } from '../src/runtime/types.ts'
import { installNotifications } from '../src/client/notifications.ts'

class Popup {
  static permission = 'granted'; static instances: Popup[] = []; static requestPermission = vi.fn()
  onclick: ((event: Event) => void | Promise<void>) | null = null; onclose = null; close = vi.fn()
  constructor(readonly title: string, readonly options: NotificationOptions) { Popup.instances.push(this) }
}
const preferences: NotificationSettings = { desktop: true, volume: 80, completed: { enabled: true, sound: 'none' }, interrupted: { enabled: true, sound: 'none' }, question: { enabled: true, sound: 'none' }, approval: { enabled: true, sound: 'none' } }
const frame = (cursor: number, baseline: boolean, ids: string[] = []): NotificationDeliveryFrame => ({ epoch: 'epoch-1', cursor, baseline, events: ids.map(id => ({ id, sessionId: 's1', kind: 'completed' })), settings: preferences })
const disposers: (() => Promise<void>)[] = []
function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary { return { id: sessionId(id), displayTitle: id, running: false, retainedBy: {}, blank: false, updatedAt: 0, ...extra } }
async function fixture(initial: ReadonlyMap<SessionId, SessionStatus> = new Map(), rows: SessionSummary[] = [summary('s1')]) {
  vi.stubGlobal('Notification', Popup); vi.stubGlobal('isSecureContext', true); vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  const ctx = new Context()
  const statuses = createSnapshotStore<ReadonlyMap<SessionId, SessionStatus>>(initial)
  const summaries = createSnapshotStore<SessionListState>({ phase: 'ready', ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), projectionsBySession: {} })
  const forbiddenHistory = vi.fn(() => { throw new Error('Notifications must not retain or follow Session history') })
  ctx.provide('sessions', { list: summaries, retain: forbiddenHistory } as Context['sessions'])
  const queued: NotificationDeliveryFrame[] = []; let wake: ((value: NotificationDeliveryFrame | undefined) => void) | undefined
  const signals: AbortSignal[] = []
  const events = (signal: AbortSignal) => {
    signals.push(signal)
    let cancelled = false
    const iterator = (async function* () {
      while (!signal.aborted && !cancelled) {
        const next = queued.shift() ?? await new Promise<NotificationDeliveryFrame | undefined>(resolve => {
          const abort = () => { wake = undefined; resolve(undefined) }
          signal.addEventListener('abort', abort, { once: true })
          wake = value => { signal.removeEventListener('abort', abort); resolve(value) }
        })
        if (next === undefined || signal.aborted || cancelled) return
        yield next
      }
    })()
    return Object.assign(iterator, { send: (_value: never) => {}, end: () => {}, dispose: () => { cancelled = true; wake?.(undefined) } })
  }
  const push = (value: NotificationDeliveryFrame) => { if (wake) { const next = wake; wake = undefined; next(value) } else queued.push(value) }
  ctx.provide('uiSession', { sessionStatus: statuses, adapter: { current: createSnapshotStore({ key: undefined, target: undefined }) } } as Context['uiSession'])
  ctx.provide('uiWorkspace', { openSession: vi.fn() } as Context['uiWorkspace'])
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as Context['locale'])
  ctx.provide('remote', { dshNotifications: { events } } as Context['remote'])
  ctx.provide('remote.dshNotifications', { events } as never)
  const owner = ctx.plugin({ name: 'notifications-test', apply(scope: Context) { installNotifications(scope) } })
  await owner.await()
  disposers.push(() => owner.dispose())
  return { ctx, statuses, summaries, forbiddenHistory, push, signals, dispose: () => owner.dispose() }
}
afterEach(async () => { cleanup(); for (const dispose of disposers.splice(0)) await dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Popup.instances = [] })
it('seeds the outcome baseline, notifies only new frames and aborts the owned stream', async () => {
  const test = await fixture()
  test.push(frame(3, true, ['old']))
  await Promise.resolve(); await Promise.resolve()
  expect(Popup.instances).toHaveLength(0)
  test.push(frame(4, false, ['new']))
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1))
  test.push(frame(4, false, ['new'])); test.push(frame(5, false, ['new']))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(Popup.instances).toHaveLength(1)
  await test.dispose()
  expect(test.signals.every(signal => signal.aborted)).toBe(true)
  expect(Popup.instances[0]!.close).toHaveBeenCalledOnce()
})

it('does not infer success from idle and does not replay existing interactions', async () => {
  const id = 's1' as SessionId
  const old = { kind: 'approval', key: 'old', sessionId: id, answerable: true }
  const test = await fixture(new Map([[id, { running: false, completionUnread: true, pendingInteraction: old }]]))
  test.push(frame(0, true)); await new Promise(resolve => setTimeout(resolve, 0))
  test.statuses.set(new Map([[id, { running: false, completionUnread: true, pendingInteraction: undefined }]]))
  test.push({ ...frame(1, false), events: [{ id: 'raw-asked', sessionId: id, kind: 'question' }] })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(Popup.instances).toHaveLength(0)
})
it('subscribes to questions before reading their channel and notifies once when they become answerable', async () => {
  const test = await fixture(); test.push(frame(0, true)); await new Promise(resolve => setTimeout(resolve, 0))
  const id = 's1' as SessionId, listeners = new Set<() => void>()
  let snapshot = { channel: 'none', closed: false, state: 'open' }
  const question = { kind: 'question', key: 'question-1', sessionId: id, questions: [{}], review: undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getSnapshot: () => snapshot }
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: question }]]))
  expect(listeners.size).toBe(1)
  expect(Popup.instances).toHaveLength(0)
  snapshot = { channel: 'waterfall', closed: false, state: 'open' }; listeners.forEach(listener => listener())
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1))
  expect(Popup.instances[0]!.title).toBe('questionTitle · s1')
  snapshot = { channel: 'rpc', closed: false, state: 'continued' }; listeners.forEach(listener => listener())
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(1)
  snapshot = { channel: 'none', closed: true, state: 'continued' }; listeners.forEach(listener => listener())
  expect(Popup.instances[0]!.close).toHaveBeenCalledOnce()
  await test.dispose(); expect(listeners.size).toBe(0)
})
it('drops a cancelled question and classifies approval intent without reading tool names', async () => {
  const test = await fixture(); test.push(frame(0, true)); await new Promise(resolve => setTimeout(resolve, 0))
  const id = 's1' as SessionId, listeners = new Set<() => void>()
  let closed = false
  const makeQuestion = (key: string, kind: string) => ({ kind: 'plan-review', key, sessionId: id, questions: [{ intent: { kind } }], review: undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getSnapshot: () => ({ channel: closed ? 'none' : 'rpc', closed }) })
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: makeQuestion('cancelled', 'plan-review') }]]))
  closed = true; listeners.forEach(listener => listener())
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0)
  closed = false
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: makeQuestion('approval-question', 'approval') }]]))
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1))
  expect(Popup.instances[0]!.title).toBe('approvalTitle · s1')
  const approval = { kind: 'approval', key: 'human', sessionId: id, answerable: false }
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: approval }]]))
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(1)
  approval.answerable = true
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: approval }]]))
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(2))
  expect(Popup.instances[1]!.title).toBe('approvalTitle · s1')
})

it('does not replay an active question after a thousand outcome alerts evict recent history', async () => {
  const test = await fixture(); test.push(frame(0, true)); await new Promise(resolve => setTimeout(resolve, 0))
  const id = 's1' as SessionId, listeners = new Set<() => void>()
  const question = { kind: 'question', key: 'long-question', sessionId: id, questions: [{}], review: undefined,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getSnapshot: () => ({ channel: 'rpc', closed: false }) }
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: question }]]))
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1))
  for (let start = 0; start < 1000; start += 64) test.push(frame(Math.min(start + 64, 1000), false, Array.from({ length: Math.min(64, 1000 - start) }, (_, offset) => 'outcome-' + (start + offset))))
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1001))
  listeners.forEach(listener => listener())
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(Popup.instances.filter(popup => popup.title === 'questionTitle · s1')).toHaveLength(1)
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: { ...question } }]]))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(Popup.instances.filter(popup => popup.title === 'questionTitle · s1')).toHaveLength(1)
})

// Execute the published native client factories, as the existing native residency integration does.
function nativeClient<T>(name: string, from = createRequire(import.meta.url)): T {
  const entry = from.resolve(name + '/client'), local = createRequire(entry), source = readFileSync(entry, 'utf8')
  if (!source.trimStart().startsWith('window.__ModuleLoader__.load(')) return from(name + '/client')
  let factory: ((load: NodeJS.Require) => T) | undefined
  runInNewContext(source, { window: { __ModuleLoader__: { load(row: { factory: (load: NodeJS.Require) => T }) { factory = row.factory } } }, URL, AbortController, AbortSignal, queueMicrotask, console, setTimeout, clearTimeout, performance })
  if (!factory) throw new Error('Missing native client factory')
  const load = Object.assign((id: string): object => id === '@deepseek-ai/dsh-client-ui-primitives' ? nativePrimitives : id.startsWith('@deepseek-ai/') && id.endsWith('/client') ? nativeClient<object>(id.slice(0, -7), local) : local(id), local)
  return factory(load)
}
function NativeSettingsLayer({ rejection }: { rejection?: () => void }) {
  const [open, setOpen] = useState(true), ref = useRef<HTMLDivElement>(null)
  useModalLayer(ref, open, () => { rejection?.(); setOpen(false) })
  return open ? createElement('div', { ref, role: 'dialog', 'aria-modal': true, 'data-shortcut-modal': rejection ? 'approval' : 'settings' }, createElement('button', null, 'Close')) : null
}
async function nativeRouteFixture() {
  const ctx = new Context(), require = createRequire(import.meta.url)
  const ids = ['5325829e-e9f7-48dd-b136-8067328a9142', '2b611b6b-11b6-479e-9a0f-4393599026ef', 'd93089ca-7764-44cc-befb-ceb35ce7ad5a'].map(sessionId)
  const controllerRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
  const gateway = nativeClient<{ RemoteStream: new (connection: object, options: object) => object }>('@deepseek-ai/dsh-api-gateway', controllerRequire)
  const controller = nativeClient<{ apply(ctx: Context): void }>('@deepseek-ai/dsh-api-session-controller')
  const ui = nativeClient<{ UiSession: new (ctx: Context, sessions: Context['sessions']) => object }>('@deepseek-ai/dsh-client-ui-session')
  const workspace = nativeClient<{ apply(ctx: Context): void }>('@deepseek-ai/dsh-client-ui-workspace')
  const generation = createSnapshotStore({ id: 1, host: { home: '' } })
  const untilAbort = (signal: AbortSignal) => new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
  class Wire extends Service {
    constructor() { super(ctx, 'remote') }
    $host = { home: '' }
    $on() { return () => {} }
    $stream(options: object) { return new gateway.RemoteStream({ generation }, options) }
    session = {
      list: async () => ({ ok: true, value: { items: ids.map((id, index) => ({ sessionId: id, title: 'Native conversation ' + (index + 1), updatedAt: index + 1, agentAvailable: true, formatStatus: 'current', running: false, blank: false })) } }),
      control: async function* (signal: AbortSignal) { yield { type: 'baseline', value: { projections: {} } }; await untilAbort(signal) },
      follow: async function* (request: { address: { sessionId: SessionId } }, signal: AbortSignal) { yield { type: 'snapshot', header: { version: 2, id: request.address.sessionId, createdAt: 1, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } }; await untilAbort(signal) },
    }
  }
  new Wire()
  ctx.provide('connection', { generation } as never)
  ctx.provide('typert', { contexts: { registerClient: () => () => {} } } as never)
  ctx.provide('slots', { bindStoreScope: () => {}, provideRoot: () => {}, inject: () => () => {}, registerFactory: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ phase: 'loading', items: [], archivedSessionIds: [], pinnedSessionIds: [] }) } as never)
  ctx.provide('layout', { selectPanel: () => {}, beginNavigation: () => new AbortController().signal } as never)
  ctx.provide('shortcuts', { register: () => () => {} } as never)
  // rc.1 registers context-menu contributions during apply; menu rendering is outside this routing fixture.
  ctx.provide('contextMenus', { register: () => () => {} } as never)
  controller.apply(ctx); await ctx.sessions.refresh(); new ui.UiSession(ctx, ctx.sessions); workspace.apply(ctx)
  const queued: NotificationDeliveryFrame[] = []; let wake: ((frame: NotificationDeliveryFrame | undefined) => void) | undefined
  const events = (signal: AbortSignal) => {
    const iterator = (async function* () { while (!signal.aborted) { const next = queued.shift() ?? await new Promise<NotificationDeliveryFrame | undefined>(resolve => { wake = resolve; signal.addEventListener('abort', () => resolve(undefined), { once: true }) }); if (!next || signal.aborted) return; yield next } })()
    return Object.assign(iterator, { send: (_value: never) => {}, end: () => {}, dispose: () => wake?.(undefined) })
  }
  const activateDesktop = vi.fn(async (id: string) => { expect(ctx.sessions.retainInfo(id as SessionId).getSnapshot().retainedBy.mainView).toBe(1); return { ok: true, value: true } })
  Object.assign(ctx.remote, { dshNotifications: { events, activateDesktop } }); ctx.provide('remote.dshNotifications', { events, activateDesktop } as never)
  const owner = ctx.plugin({ name: 'native-notification-route', apply(scope: Context) { installNotifications(scope) } }); await owner.await()
  disposers.push(() => ctx.fiber.dispose())
  const push = (frame: NotificationDeliveryFrame) => { if (wake) { const resolve = wake; wake = undefined; resolve(frame) } else queued.push(frame) }
  push(frame(0, true)); await new Promise(resolve => setTimeout(resolve, 0))
  return { ctx, ids, push, activateDesktop }
}
it.each(['completed', 'question', 'approval'] as const)('reveals the native %s session and closes only the foreground settings layer', async kind => {
  vi.stubGlobal('Notification', Popup); vi.stubGlobal('isSecureContext', true); vi.spyOn(document, 'hasFocus').mockReturnValue(false); vi.spyOn(window, 'focus').mockImplementation(() => {})
  const route = await nativeRouteFixture(), id = route.ids[['completed', 'question', 'approval'].indexOf(kind)]!
  render(createElement(NativeSettingsLayer))
  if (kind === 'completed') route.push({ ...frame(1, false), events: [{ id: 'native-completed', sessionId: id, kind }] })
  else {
    const publish = route.ctx.uiSession.registerPendingInteraction(() => 1)
    const off = publish({ kind, key: 'native-' + kind, sessionId: id, answerable: true, questions: [{}], review: undefined, getSnapshot: () => ({ channel: 'rpc', closed: false }), subscribe: () => () => {} }, async () => {})
    disposers.push(async () => { off() })
  }
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1))
  expect(Popup.instances[0]!.title).toBe(kind + 'Title · ' + route.ctx.sessions.list.getSnapshot().byId[id]!.displayTitle)
  const clicked = new Event('click', { cancelable: true })
  await act(async () => { await Popup.instances[0]!.onclick?.(clicked) })
  expect(clicked.defaultPrevented).toBe(false)
  expect(route.ctx.sessions.retainInfo(id).getSnapshot().retainedBy.mainView).toBe(1)
  expect(route.ctx.uiSession.adapter.current.getSnapshot().key).toBe(id)
  expect(document.querySelector('[data-shortcut-modal="settings"]')).toBeNull()
  expect(route.activateDesktop).not.toHaveBeenCalled()
})
it('keeps an approval above settings untouched instead of rejecting it on navigation', async () => {
  vi.stubGlobal('Notification', Popup); vi.stubGlobal('isSecureContext', true); vi.spyOn(document, 'hasFocus').mockReturnValue(false); vi.spyOn(window, 'focus').mockImplementation(() => {})
  const route = await nativeRouteFixture(), reject = vi.fn(), id = route.ids[0]!
  render(createElement('div', null, createElement(NativeSettingsLayer), createElement(NativeSettingsLayer, { rejection: reject })))
  route.push({ ...frame(1, false), events: [{ id: 'blocked-overlay', sessionId: id, kind: 'completed' }] })
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1))
  await act(async () => { await Popup.instances[0]!.onclick?.(new Event('click', { cancelable: true })) })
  expect(reject).not.toHaveBeenCalled()
  expect(document.querySelector('[data-shortcut-modal="approval"]')).not.toBeNull()
  expect(document.querySelector('[data-shortcut-modal="settings"]')).not.toBeNull()
  expect(route.ctx.uiSession.adapter.current.getSnapshot().key).toBe(id)
})
it('activates the native desktop only after local navigation in the desktop bridge branch', async () => {
  vi.stubGlobal('Notification', Popup); vi.stubGlobal('isSecureContext', true); vi.stubGlobal('dshDesktop', {}); vi.spyOn(document, 'hasFocus').mockReturnValue(false); vi.spyOn(window, 'focus').mockImplementation(() => {})
  expect('dshDesktop' in window).toBe(true)
  const route = await nativeRouteFixture(), id = route.ids[2]!
  render(createElement(NativeSettingsLayer))
  route.push({ ...frame(1, false), events: [{ id: 'desktop-activation', sessionId: id, kind: 'completed' }] })
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1))
  await act(async () => { await Popup.instances[0]!.onclick?.(new Event('click', { cancelable: true })) })
  expect(route.activateDesktop).toHaveBeenCalledWith(id)
  expect(route.ctx.uiSession.adapter.current.getSnapshot().key).toBe(id)
  expect(document.querySelector('[data-shortcut-modal="settings"]')).toBeNull()
})

class AudibleContext {
  static played = 0
  state = 'running'; currentTime = 0; destination = {}
  createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} } }
  createOscillator() { return { type: '', frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, onended: null, start() { AudibleContext.played++ }, stop() {} } }
  async close() { this.state = 'closed' }
}
const audiblePreferences: NotificationSettings = { ...preferences, popupMode: 'always', soundEnabled: true, question: { enabled: true, sound: 'soft' }, approval: { enabled: true, sound: 'double' }, completed: { enabled: true, sound: 'chime' }, interrupted: { enabled: true, sound: 'alert' } }
function updateSummaries(store: ReturnType<typeof createSnapshotStore<SessionListState>>, rows: SessionSummary[]): void { store.set({ phase: 'ready', ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), projectionsBySession: {} }) }
function question(id: SessionId, key: string, kind = 'question') { return { kind, key, sessionId: id, questions: [{}], review: undefined, subscribe: () => () => {}, getSnapshot: () => ({ channel: 'rpc', closed: false }) } }
it.each(['question', 'plan-review', 'approval'])('does not popup or play %s requests belonging to a subagent or teammate', async kind => {
  AudibleContext.played = 0; vi.stubGlobal('AudioContext', AudibleContext)
  const child = summary('child', { origin: 'subagent', parentId: sessionId('s1') }), test = await fixture(new Map(), [summary('s1'), child])
  test.push({ ...frame(0, true), settings: audiblePreferences }); await new Promise(resolve => setTimeout(resolve, 0))
  const pending = kind === 'approval' ? { kind, key: 'child-approval', sessionId: child.id, answerable: true } : question(child.id, 'child-question', kind)
  test.statuses.set(new Map([[child.id, { running: true, completionUnread: false, pendingInteraction: pending }]]))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(Popup.instances).toHaveLength(0); expect(AudibleContext.played).toBe(0); expect(test.forbiddenHistory).not.toHaveBeenCalled()
})
it('waits for unknown pending identity and notifies an independent fork only once when its summary arrives', async () => {
  AudibleContext.played = 0; vi.stubGlobal('AudioContext', AudibleContext)
  const test = await fixture(new Map(), []), id = sessionId('fork-root')
  test.push({ ...frame(0, true), settings: audiblePreferences }); await new Promise(resolve => setTimeout(resolve, 0))
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: question(id, 'unknown-root') }]]))
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0); expect(AudibleContext.played).toBe(0)
  updateSummaries(test.summaries, [summary(id, { parentId: sessionId('fork-source') })])
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(1)); expect(AudibleContext.played).toBe(1)
  updateSummaries(test.summaries, [summary(id, { parentId: sessionId('fork-source'), title: 'Renamed root' })])
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(1); expect(AudibleContext.played).toBe(1); expect(test.forbiddenHistory).not.toHaveBeenCalled()
})
it('drops an unknown pending request when its late metadata identifies a child', async () => {
  AudibleContext.played = 0; vi.stubGlobal('AudioContext', AudibleContext)
  const test = await fixture(new Map(), []), id = sessionId('late-child')
  test.push({ ...frame(0, true), settings: audiblePreferences }); await new Promise(resolve => setTimeout(resolve, 0))
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: question(id, 'pending-child') }]]))
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0)
  updateSummaries(test.summaries, [summary(id, { origin: 'subagent' })]); await new Promise(resolve => setTimeout(resolve, 0))
  expect(Popup.instances).toHaveLength(0); expect(AudibleContext.played).toBe(0)
})

it.each(['completed', 'interrupted'] as const)('rejects %s child outcomes still emitted by an old Host', async kind => {
  AudibleContext.played = 0; vi.stubGlobal('AudioContext', AudibleContext)
  const child = summary('worker', { origin: 'subagent', parentId: sessionId('main') }), test = await fixture(new Map(), [child])
  test.push({ ...frame(0, true), settings: audiblePreferences }); await new Promise(resolve => setTimeout(resolve, 0))
  test.push({ ...frame(1, false), settings: audiblePreferences, events: [{ id: 'old-host-child', sessionId: child.id, kind }] })
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0); expect(AudibleContext.played).toBe(0)
})
it('keeps only the latest 64 unresolved outcomes and delivers roots once after metadata arrives', async () => {
  const test = await fixture(new Map(), [])
  test.push(frame(0, true)); await new Promise(resolve => setTimeout(resolve, 0))
  const events = Array.from({ length: 70 }, (_, index) => ({ id: 'waiting-' + index, sessionId: 'unknown-' + index, kind: 'completed' as const }))
  test.push({ ...frame(64, false), events: events.slice(0, 64) }); test.push({ ...frame(70, false), events: events.slice(64) })
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0)
  updateSummaries(test.summaries, events.map(event => summary(event.sessionId)))
  await vi.waitFor(() => expect(Popup.instances).toHaveLength(64))
  expect(Popup.instances.map(popup => popup.title)).toEqual(events.slice(6).map(event => 'completedTitle · ' + event.sessionId))
  updateSummaries(test.summaries, events.map(event => summary(event.sessionId)))
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(64); expect(test.forbiddenHistory).not.toHaveBeenCalled()
})
it('drops queued child outcomes and rechecks pending root identity at dispatch time', async () => {
  AudibleContext.played = 0; vi.stubGlobal('AudioContext', AudibleContext)
  const test = await fixture(new Map(), []), id = sessionId('uncertain')
  test.push({ ...frame(0, true), settings: audiblePreferences }); await new Promise(resolve => setTimeout(resolve, 0))
  test.push({ ...frame(1, false), settings: audiblePreferences, events: [{ id: 'unresolved-child', sessionId: id, kind: 'completed' }] })
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0)
  updateSummaries(test.summaries, [summary(id, { origin: 'subagent' })])
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0); expect(AudibleContext.played).toBe(0)
  updateSummaries(test.summaries, [summary(id)])
  test.statuses.set(new Map([[id, { running: true, completionUnread: false, pendingInteraction: question(id, 'changing-identity') }]]))
  updateSummaries(test.summaries, [summary(id, { origin: 'subagent' })])
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0); expect(AudibleContext.played).toBe(0)
})

it('discards unresolved outcomes when a fresh Host baseline replaces their epoch', async () => {
  const test = await fixture(new Map(), []), id = sessionId('old-generation-root')
  test.push(frame(0, true)); await new Promise(resolve => setTimeout(resolve, 0))
  test.push({ ...frame(1, false), events: [{ id: 'old-generation-outcome', sessionId: id, kind: 'completed' }] })
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0)
  test.push({ ...frame(0, true), epoch: 'new-host-generation' }); await new Promise(resolve => setTimeout(resolve, 0))
  updateSummaries(test.summaries, [summary(id)])
  await new Promise(resolve => setTimeout(resolve, 0)); expect(Popup.instances).toHaveLength(0)
})
