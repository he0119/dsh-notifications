/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { Context as NativeContext, Service } from '@deepseek-ai/cordis'
import { profileComposition } from './profile-composition.ts'
import { Config, type NotificationsConfig as LiveNotificationsConfig } from '../src/config.ts'
import { PLUGIN_NAME } from '../src/constants.ts'
import * as nativePrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import { onTestFinished } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { IDBFactory } from 'fake-indexeddb'
import { createCustomSoundStore } from '../src/client/logic/custom-sounds.ts'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { NotificationSettingsInjected } from '../src/client/logic/slots.ts'
import { installSettingsPage, NotificationsSettings, type NotificationSettingsProps } from '../src/client/components/NotificationsSettings.tsx'
import { en } from '../src/client/logic/locales.ts'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createNotificationDelivery } from '../src/client/logic/delivery.ts'
import type { NotificationEvent, NotificationSettings } from '../src/runtime/types.ts'

class Popup {
  static permission: NotificationPermission = 'granted'
  static instances: Popup[] = []
  static requestPermission = vi.fn(async () => Popup.permission)
  onclick: ((event: Event) => void | Promise<void>) | null = null
  onshow: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn(() => this.onclose?.())
  constructor(readonly title: string, readonly options: NotificationOptions) { Popup.instances.push(this) }
}
class AudioFixture {
  static count = 0
  static instances: AudioFixture[] = []
  state: AudioContextState = 'running'; currentTime = 0; destination = {}
  resume = vi.fn(async () => { this.state = 'running' })
  close = vi.fn(async () => { this.state = 'closed' })
  constructor() { AudioFixture.instances.push(this) }
  createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() } }
  createOscillator() { return { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), onended: null, start: () => AudioFixture.count++, stop: vi.fn() } }
}
const preferences: NotificationSettings = { desktop: true, volume: 80, completed: { enabled: true, sound: 'chime' }, interrupted: { enabled: true, sound: 'alert' }, question: { enabled: true, sound: 'soft' }, approval: { enabled: true, sound: 'double' } }
const event: NotificationEvent = { id: 'completed:1', sessionId: 'session-1', kind: 'completed' }
const copy = { title: (kind: string) => kind, body: (kind: string) => kind + ' body', testTitle: 'Test', testBody: 'Test body' }
function fixture(settings: NotificationSettings = preferences) {
  vi.stubGlobal('Notification', Popup); vi.stubGlobal('AudioContext', AudioFixture); vi.stubGlobal('isSecureContext', true)
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  vi.spyOn(window, 'focus').mockImplementation(() => {})
  const open = vi.fn()
  return { focus, open, delivery: createNotificationDelivery(() => settings, open, copy) }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Popup.instances = []; Popup.permission = 'granted'; Popup.requestPermission.mockClear(); AudioFixture.count = 0; AudioFixture.instances = [] })

it('keeps eligible sound in focus while suppressing stale requests and unfocused-mode popups', async () => {
  const { focus, delivery } = fixture()
  focus.mockReturnValue(true)
  await delivery.deliver(event)
  focus.mockReturnValue(false)
  const queued = delivery.deliver(event)
  focus.mockReturnValue(true)
  await queued
  focus.mockReturnValue(false)
  await delivery.deliver(event, () => false)
  expect(Popup.instances).toHaveLength(0)
  expect(AudioFixture.count).toBe(4)
  expect(Popup.requestPermission).not.toHaveBeenCalled()
  await delivery.dispose()
})
it('uses separate sounds for all four kinds and silent system popups that navigate on click', async () => {
  const { open, delivery } = fixture()
  for (const kind of ['completed', 'interrupted', 'question', 'approval'] as const) await delivery.deliver({ ...event, id: kind, kind })
  expect(Popup.instances.map(popup => popup.title)).toEqual(['completed', 'interrupted', 'question', 'approval'])
  expect(Popup.instances.every(popup => popup.options.silent === true)).toBe(true)
  expect(Popup.instances.every(popup => popup.options.requireInteraction === true)).toBe(true)
  expect(AudioFixture.count).toBe(8)
  await Popup.instances[2]!.onclick?.(new Event('click', { cancelable: true }))
  expect(window.focus).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledWith('session-1')
  expect(AudioFixture.instances[0]!.resume).not.toHaveBeenCalled()
  await delivery.dispose()
  expect(Popup.instances.every(popup => popup.close.mock.calls.length > 0)).toBe(true)
  expect(AudioFixture.instances[0]!.close).toHaveBeenCalledOnce()
  await delivery.deliver(event)
  expect(Popup.instances).toHaveLength(4)
})
it('keeps audio working when system permission is denied', async () => {
  const { delivery } = fixture(); Popup.permission = 'denied'
  await delivery.deliver(event)
  expect(Popup.instances).toHaveLength(0)
  expect(AudioFixture.count).toBe(2)
  expect(delivery.state.getSnapshot().permission).toBe('denied')
  expect(Popup.requestPermission).not.toHaveBeenCalled()
  await delivery.dispose()
})
it('still shows system notifications when audio is suspended and does not automatically resume', async () => {
  const { delivery } = fixture()
  class Suspended extends AudioFixture { state: AudioContextState = 'suspended' }
  vi.stubGlobal('AudioContext', Suspended)
  await delivery.deliver(event)
  expect(Popup.instances).toHaveLength(1)
  expect(AudioFixture.count).toBe(0)
  expect(AudioFixture.instances[0]!.resume).not.toHaveBeenCalled()
  expect(delivery.state.getSnapshot().audio).toBe('blocked')
  await delivery.dispose()
})
it('reports an unsupported mobile constructor without replacing it with a page toast', async () => {
  const { delivery } = fixture()
  class Unsupported extends Popup { constructor(title: string, options: NotificationOptions) { super(title, options); throw new TypeError('Use service worker notifications') } }
  vi.stubGlobal('Notification', Unsupported)
  await delivery.deliver(event)
  expect(delivery.state.getSnapshot().supported).toBe(false)
  expect(AudioFixture.count).toBe(2)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await delivery.dispose()
})

function settingsFixture(writable = true) {
  let snapshot: ConfigFormSnapshot<NotificationSettings> = { status: 'ready', value: preferences, writable, revision: 7 }
  const requestPermission = vi.fn(async () => {}), preview = vi.fn(async (_sound: string) => true), test = vi.fn(async (_sound: string) => {})
  const saveSettings = vi.fn(async (value: NotificationSettings, revision: number | undefined) => { snapshot = { ...snapshot, value, revision: (revision ?? 0) + 1 }; return true })
  const t: NotificationSettingsProps['t'] = (key, values) => { let text = en[key]; for (const [name, value] of Object.entries(values ?? {})) text = text.replace('{' + name + '}', String(value)); return text }
  const importCustomSound = vi.fn(async (_kind: string, _file: File) => true), removeCustomSound = vi.fn(async (_kind: string) => true)
  const props: NotificationSettingsProps = { importCustomSound, removeCustomSound, t, useNotificationPreferences: selector => selector(preferences), useNotificationSettings: selector => selector(snapshot), useNotificationCapabilities: selector => selector({ supported: true, secure: true, permission: 'default', audio: 'unknown', failed: false }), requestPermission, preview, test, saveSettings }
  return { props, requestPermission, preview, test, saveSettings, importCustomSound, removeCustomSound }
}
it('edits each category without autosaving and performs permission or preview only on explicit clicks', async () => {
  const controls = settingsFixture()
  render(<NotificationsSettings {...controls.props} />)
  expect(screen.getAllByRole('checkbox')).toHaveLength(5)
  expect(controls.requestPermission).not.toHaveBeenCalled(); expect(controls.preview).not.toHaveBeenCalled(); expect(controls.test).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox', { name: 'Sound for Reply needed' }), { target: { value: 'alert' } })
  fireEvent.click(screen.getByRole('checkbox', { name: en.approval }))
  expect(controls.saveSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Preview Reply needed' }))
  expect(controls.preview).toHaveBeenCalledWith('alert', 80, 'question')
  fireEvent.click(screen.getByRole('button', { name: en.allow }))
  expect(controls.requestPermission).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.test }))
  expect(controls.test).toHaveBeenCalledWith('chime', 80)
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await waitFor(() => expect(controls.saveSettings).toHaveBeenCalledWith({ ...preferences, popupMode: 'unfocused', soundEnabled: true, question: { enabled: true, sound: 'alert' }, approval: { enabled: false, sound: 'double' } }, 7))
})
it('keeps local permission and audio tests available while host preferences are read-only', () => {
  const controls = settingsFixture(false)
  render(<NotificationsSettings {...controls.props} />)
  for (const field of screen.getAllByRole('combobox')) expect((field as HTMLSelectElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: en.allow }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Preview Work interrupted' }))
  expect(controls.preview).toHaveBeenCalledWith('alert', 80, 'interrupted')
  expect(controls.saveSettings).not.toHaveBeenCalled()
})

it('shows accepted push preferences and preview even when the remote form has no value', () => {
  const controls = settingsFixture(false)
  controls.props.useNotificationSettings = selector => selector({ status: 'unavailable', value: undefined, writable: false, revision: undefined })
  Object.assign(controls.props, { useNotificationPreferences: (selector: (value: NotificationSettings | undefined) => unknown) => selector(preferences) })
  render(<NotificationsSettings {...controls.props} />)
  expect((screen.getByRole('combobox', { name: 'Sound for Conversation completed' }) as HTMLSelectElement).value).toBe('chime')
  fireEvent.click(screen.getByRole('button', { name: 'Preview Conversation completed' }))
  expect(controls.preview).toHaveBeenCalledWith('chime', 80, 'completed')
  expect(controls.saveSettings).not.toHaveBeenCalled()
})

it('registers one settings section and writes native paths only against the accepted revision', async () => {
  const ctx = new Context()
  let face: NotificationSettingsInjected | undefined
  const removed = vi.fn()
  const register = vi.fn((definition: { name: string; id: string; order: number; locale: string; inject: () => NotificationSettingsInjected }) => { face = definition.inject(); return removed })
  // The slot registry ties `inject` callbacks to their caller's Cordis scope, so unloading the owner withdraws the section.
  let plugin: Context | undefined
  ctx.provide('slots', { inject: (_name: string, callback: () => void) => (plugin ?? ctx).effect(() => callback()), register } as never)
  const accepted = createSnapshotStore<ConfigFormSnapshot<NotificationSettings>>({ status: 'ready', writable: true, revision: 7, value: preferences })
  const mutate = vi.fn(async () => true)
  const client = { state: createSnapshotStore({ supported: true, secure: true, permission: 'default' as const, audio: 'unknown' as const, failed: false }), preferences: createSnapshotStore<NotificationSettings | undefined>(preferences), refresh: vi.fn(), requestPermission: vi.fn(async () => {}), preview: vi.fn(async () => true), test: vi.fn(async () => {}), importCustomSound: vi.fn(async () => true), removeCustomSound: vi.fn(async () => true) }
  const owner = ctx.plugin({ name: 'notification-editor-test', apply(scope: Context) { plugin = scope; installSettingsPage(scope, { form: { ...accepted, mutate }, client }) } })
  try {
    await owner.await()
    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls[0]![0].name).toBe('settings.section')
    expect(register.mock.calls[0]![0].id).toBe(PLUGIN_NAME)
    expect(register.mock.calls[0]![0].order).toBe(25)
    expect(register.mock.calls[0]![0].locale).toBe('dshNotifications')
    expect(await face!.saveSettings(preferences, 7)).toBe(true)
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['popupMode'], value: 'unfocused' },
      { op: 'set', path: ['soundEnabled'], value: true },
      { op: 'set', path: ['volume'], value: 80 },
      { op: 'set', path: ['completed'], value: { enabled: true, sound: 'chime' } },
      { op: 'set', path: ['interrupted'], value: { enabled: true, sound: 'alert' } },
      { op: 'set', path: ['question'], value: { enabled: true, sound: 'soft' } },
      { op: 'set', path: ['approval'], value: { enabled: true, sound: 'double' } },
    ], 7)
    accepted.set({ ...accepted.getSnapshot(), revision: 8 })
    expect(await face!.saveSettings(preferences, 7)).toBe(false)
    expect(mutate).toHaveBeenCalledOnce()
  } finally { await owner.dispose() }
  expect(removed).toHaveBeenCalledOnce()
  client.refresh.mockClear(); accepted.set({ ...accepted.getSnapshot(), revision: 9 }); expect(client.refresh).not.toHaveBeenCalled()
})

it('previews and tests draft volume before saving it explicitly', async () => {
  const controls = settingsFixture()
  render(<NotificationsSettings {...controls.props} />)
  const slider = screen.getByRole('slider', { name: 'Notification volume' }) as HTMLInputElement
  expect(slider.min).toBe('0'); expect(slider.max).toBe('100'); expect(slider.value).toBe('80')
  fireEvent.change(slider, { target: { value: '25' } })
  expect(controls.saveSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Preview Conversation completed' }))
  expect(controls.preview).toHaveBeenCalledWith('chime', 25, 'completed')
  fireEvent.click(screen.getByRole('button', { name: en.test }))
  expect(controls.test).toHaveBeenCalledWith('chime', 25)
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await waitFor(() => expect(controls.saveSettings).toHaveBeenCalledWith({ ...preferences, popupMode: 'unfocused', soundEnabled: true, volume: 25 }, 7))
})

it.each(['never', 'unfocused', 'always'] as const)('keeps sound independent of the %s popup mode while focused', async popupMode => {
  const { focus, delivery } = fixture({ ...preferences, popupMode }); focus.mockReturnValue(true)
  await delivery.deliver(event)
  expect(AudioFixture.count).toBe(2)
  expect(Popup.instances).toHaveLength(popupMode === 'always' ? 1 : 0)
  await delivery.dispose()
})
it('keeps popup enabled with global sound off and respects legacy desktop false only as a popup default', async () => {
  const { focus, delivery } = fixture({ ...preferences, desktop: false, popupMode: 'always', soundEnabled: false }); focus.mockReturnValue(true)
  await delivery.deliver(event)
  expect(Popup.instances).toHaveLength(1); expect(AudioFixture.count).toBe(0)
  await delivery.dispose()
})
it('waits for a real show event before reporting a test notification as sent', async () => {
  const { delivery } = fixture(); const sent = delivery.test('chime', 80)
  await Promise.resolve(); await Promise.resolve()
  expect(delivery.state.getSnapshot().testStatus).toBe('pending')
  Popup.instances[0]!.onshow?.(); await sent
  expect(delivery.state.getSnapshot().testStatus).toBe('shown')
  await delivery.dispose()
})
it('reports missing system acknowledgement as unknown after three seconds', async () => {
  vi.useFakeTimers()
  try { const { delivery } = fixture(); const sent = delivery.test('chime', 80); await vi.advanceTimersByTimeAsync(3001); await sent; expect(delivery.state.getSnapshot().testStatus).toBe('unknown'); await delivery.dispose() }
  finally { vi.useRealTimers() }
})
it('reports an asynchronous notification error while preserving test sound', async () => {
  const { delivery } = fixture(); const sent = delivery.test('chime', 80)
  await Promise.resolve(); await Promise.resolve()
  Popup.instances[0]!.onerror?.(); await sent
  expect(delivery.state.getSnapshot().testStatus).toBe('failed'); expect(AudioFixture.count).toBe(2)
  await delivery.dispose()
})

it('validates custom files before committing and keeps the prior local audio after a decode failure', async () => {
  fixture(); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile)
  class Decoder extends AudioFixture { async decodeAudioData(bytes: ArrayBuffer) { if (new Uint8Array(bytes)[0] === 9) throw new Error('Invalid audio'); return { duration: 1, length: 48000 } } }
  vi.stubGlobal('AudioContext', Decoder)
  const store = createCustomSoundStore(new IDBFactory())
  const delivery = createNotificationDelivery(() => preferences, vi.fn(), copy, undefined, undefined, store)
  try {
    const original = new File([new Uint8Array([1, 2])], 'original.wav', { type: 'audio/wav' })
    expect(await delivery.importCustomSound('approval', original)).toBe(true)
    expect(delivery.state.getSnapshot().customFiles?.approval?.name).toBe('original.wav')
    const invalid = new File([new Uint8Array([9])], 'invalid.wav', { type: 'audio/wav' })
    expect(await delivery.importCustomSound('approval', invalid)).toBe(false)
    expect((await store.get('approval'))?.name).toBe('original.wav')
    expect(delivery.state.getSnapshot().customErrors?.approval).toBe('invalid-audio')
    expect((await store.get('question'))).toBeUndefined()
    expect(await delivery.removeCustomSound('approval')).toBe(true)
    expect(await store.get('approval')).toBeUndefined()
  } finally { await delivery.dispose() }
  await expect(store.get('approval')).rejects.toMatchObject({ code: 'closed' })
})
it('falls back to the category built-in sound when this device has no custom asset', async () => {
  fixture(); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile)
  const store = createCustomSoundStore(new IDBFactory())
  const value: NotificationSettings = { ...preferences, completed: { enabled: true, sound: 'custom' } }
  const delivery = createNotificationDelivery(() => value, vi.fn(), copy, undefined, undefined, store)
  try { await delivery.deliver(event); await vi.waitFor(() => expect(AudioFixture.count).toBe(2)); expect(Popup.instances).toHaveLength(1); expect(delivery.state.getSnapshot().customFiles?.completed).toBeUndefined() }
  finally { await delivery.dispose() }
})
it('keeps per-kind local audio import and removal available in the read-only host form', () => {
  const controls = settingsFixture(false)
  controls.props.useNotificationSettings = selector => selector({ status: 'ready', writable: false, revision: 7, value: { ...preferences, approval: { enabled: true, sound: 'custom' } } })
  controls.props.useNotificationCapabilities = selector => selector({ supported: true, secure: true, permission: 'granted', audio: 'unknown', failed: false, customAvailable: true, customFiles: { approval: { name: 'my-notice.wav', type: 'audio/wav', size: 2 } } })
  render(<NotificationsSettings {...controls.props} />)
  expect(screen.getByText('my-notice.wav').getAttribute('title')).toBe('my-notice.wav')
  const input = screen.getByLabelText('Audio file for Approval needed')
  const file = new File([new Uint8Array([1, 2])], 'replacement.wav', { type: 'audio/wav' })
  fireEvent.change(input, { target: { files: [file] } })
  expect(controls.importCustomSound).toHaveBeenCalledWith('approval', file)
  fireEvent.click(screen.getByRole('button', { name: 'Remove audio for Approval needed' }))
  expect(controls.removeCustomSound).toHaveBeenCalledWith('approval')
  expect(controls.saveSettings).not.toHaveBeenCalled()
})
it('adds the cached conversation name to system notifications without splitting long Unicode names', async () => {
  fixture()
  const name = '田间记录👩‍🌾'.repeat(30)
  const delivery = createNotificationDelivery(() => preferences, vi.fn(), copy, () => 'selected', id => id === 'selected' ? 'Selected conversation' : name)
  try {
    await delivery.deliver(event)
    const short = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)].slice(0, 80).map(part => part.segment).join('')
    expect(Popup.instances[0]!.title).toBe('completed · ' + short + '…')
    const sent = delivery.test('soft', 80); await Promise.resolve(); await Promise.resolve(); Popup.instances[1]!.onshow?.(); await sent
    expect(Popup.instances[1]!.title).toBe('Test · Selected conversation')
  } finally { await delivery.dispose() }
})

function releasedSettingsClient<T>(name: string): T {
  const require = createRequire(import.meta.url), entry = require.resolve(name + '/client'), local = createRequire(entry)
  let factory: ((load: NodeJS.Require) => T) | undefined
  runInNewContext(readFileSync(entry, 'utf8'), { window: { __ModuleLoader__: { load(row: { factory: (load: NodeJS.Require) => T }) { factory = row.factory } } }, URL, structuredClone, AbortController, AbortSignal, queueMicrotask, console })
  if (!factory) throw new Error('Missing published settings client factory')
  return factory(Object.assign((id: string) => id === '@deepseek-ai/dsh-client-ui-primitives' ? nativePrimitives : local(id), local))
}
it('persists notification volume through the published ConfigForm and Host ConfigEditor mutation seam', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cyaness-notification-mutation-')), host = new NativeContext(), browser = new NativeContext()
  onTestFinished(async () => { await browser.fiber.dispose(); await host.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const document = join(home, 'cordis.yml')
  const legacy = { desktop: true, completed: { enabled: true, sound: 'chime' }, interrupted: { enabled: true, sound: 'alert' }, question: { enabled: true, sound: 'soft' }, approval: { enabled: true, sound: 'double' } }
  await writeFile(document, stringify([{ id: PLUGIN_NAME, name: 'notification-config', config: legacy }]))
  host.baseUrl = pathToFileURL(home).href + '/'
  await host.plugin(Loader); host.loader.builtins.include = Include
  let live: LiveNotificationsConfig | undefined
  const owner = { name: PLUGIN_NAME, Config: Config, apply(_ctx: NativeContext, config: LiveNotificationsConfig) { live = config } }
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(), import: specifier => { if (specifier !== 'notification-config') throw new Error('Unexpected fixture module ' + specifier); return Promise.resolve(owner) }, register() { throw new Error('Unexpected register') }, getOrCreateModuleJob() { throw new Error('Unexpected module job') }, resolveSync() { throw new Error('Unexpected resolve') }, load() { throw new Error('Unexpected load') } }
  host.loader.internal = internal
  const patch = await profileComposition(host, home, document)
  for (const entry of host.configEditor.entries()) await entry.fiber?.await()
  const errors: string[] = []
  class Transport extends Service {
    constructor() { super(browser, 'remote') }
    $on() { return () => {} }
  }
  class SettingsTransport extends Service {
    constructor() { super(browser, 'remote.settings') }
    async describe() { return { ok: true, value: { writable: host.settings.writable, hasDocument: true, namespaces: host.settings.describe() } } }
    async mutate(namespace: string, ops: Parameters<NativeContext['settings']['mutate']>[1], revision: number | undefined) {
      try { await host.settings.mutate(namespace, ops, revision); return { ok: true, value: host.settings.describe().find(row => row.ns === namespace)! } }
      catch (error) { const message = error instanceof Error ? error.message : String(error); errors.push(message); return { ok: false, error: { code: 'INVALID_ARGUMENT', message } } }
    }
  }
  new Transport(); new SettingsTransport()
  const settings = releasedSettingsClient<{ apply(ctx: NativeContext): void }>('@deepseek-ai/dsh-client-ui-settings')
  settings.apply(browser)
  const form = browser.configForms.get<NotificationSettings>(PLUGIN_NAME)
  await vi.waitFor(() => expect(form.getSnapshot().status).toBe('ready'))
  let face: NotificationSettingsInjected | undefined
  browser.provide('slots', { inject: (_name: string, callback: () => void) => browser.effect(() => callback()), register: (definition: { inject: () => NotificationSettingsInjected }) => { face = definition.inject(); return () => {} } } as never)
  const client = createNotificationDelivery(() => preferences, () => {}, copy)
  onTestFinished(() => client.dispose())
  installSettingsPage(browser, { form, client })
  const revision = form.getSnapshot().revision
  const accepted = await face!.saveSettings({ ...preferences, popupMode: 'unfocused', soundEnabled: true, volume: 25 }, revision)
  expect({ accepted, errors }).toEqual({ accepted: true, errors: [] })
  expect(live!.volume.get()).toBe(25)
  expect(form.getSnapshot().value?.volume).toBe(25)
  expect(host.settings.describe().find(row => row.ns === PLUGIN_NAME)?.value).toMatchObject({ volume: 25 })
  expect(await readFile(patch, 'utf8')).toContain('volume: 25')
})

it('blocks new-field edits until the native Host exposes the volume schema after an update',()=>{
 const legacy=structuredClone(preferences);Reflect.deleteProperty(legacy,'volume')
 const controls=settingsFixture()
 const props:NotificationSettingsProps={...controls.props,useNotificationSettings:selector=>selector({status:'ready',value:legacy,writable:true,revision:7})}
 render(<NotificationsSettings {...props}/>)
 expect((screen.getByRole('slider',{name:'Notification volume'}) as HTMLInputElement).value).toBe('80')
 expect((screen.getByRole('slider',{name:'Notification volume'}) as HTMLInputElement).disabled).toBe(true)
 expect(screen.getByText('The notification component is still updating. Reopen DSH after current tasks finish to edit these settings.')).toBeTruthy()
 expect(controls.saveSettings).not.toHaveBeenCalled()
})

it('reports when the system closes an acknowledged test and when its click arrives',async()=>{
 const {delivery}=fixture();const sent=delivery.test('chime',80);await Promise.resolve();await Promise.resolve()
 const popup=Popup.instances[0]!;popup.onshow?.();await sent;expect(delivery.state.getSnapshot().testStatus).toBe('shown')
 popup.onclose?.();expect(delivery.state.getSnapshot().testStatus).toBe('closed')
 await popup.onclick?.(new Event('click',{cancelable:true}));expect(delivery.state.getSnapshot().testStatus).toBe('clicked')
 await delivery.dispose()
})
it('uses a distinct test tag and ignores old lifecycle callbacks after a new attempt starts',async()=>{
 const {delivery}=fixture();const first=delivery.test('chime',80);await Promise.resolve();await Promise.resolve();const old=Popup.instances[0]!;old.onshow?.();await first
 const next=delivery.test('chime',80);await Promise.resolve();await Promise.resolve();const current=Popup.instances[1]!
 expect(current.options.tag).not.toBe(old.options.tag);old.onclose?.();expect(delivery.state.getSnapshot().testStatus).toBe('pending')
 current.onshow?.();await next;expect(delivery.state.getSnapshot().testStatus).toBe('shown');await delivery.dispose()
})

it('uses already granted permission without waiting for another permission request',async()=>{
 const {delivery}=fixture();const request=vi.spyOn(Popup,'requestPermission').mockImplementation(()=>new Promise<NotificationPermission>(()=>{}))
 try{const sent=delivery.test('chime',80);await Promise.resolve();await Promise.resolve();expect(request).not.toHaveBeenCalled();expect(Popup.instances).toHaveLength(1);Popup.instances[0]!.onshow?.();await sent}
 finally{await delivery.dispose();request.mockRestore()}
})

it('treats a hidden DSH tab as unfocused while its browser window still has focus',async()=>{
 const {focus,delivery}=fixture({...preferences,popupMode:'unfocused'});focus.mockReturnValue(true);const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden')
 await delivery.deliver(event);expect(Popup.instances).toHaveLength(1)
 visibility.mockReturnValue('visible');await delivery.deliver({...event,id:'visible-tab'});expect(Popup.instances).toHaveLength(1)
 focus.mockReturnValue(false);await delivery.deliver({...event,id:'background-window'});expect(Popup.instances).toHaveLength(2);await delivery.dispose()
})

it('keeps Windows tags within the native limit while routing and dismissing full interaction IDs',async()=>{
 const {delivery,open}=fixture();const pending={id:'interaction:'+JSON.stringify(['session-1','approval-key-'.repeat(12)]),sessionId:'session-1',kind:'approval' as const};
 try{await delivery.deliver(pending);const popup=Popup.instances[0]!;expect(('n#dsh-app://app#'+popup.options.tag).length).toBeLessThanOrEqual(64);delivery.dismiss(pending.id);expect(popup.close).toHaveBeenCalledOnce();
 await delivery.deliver({...pending,id:pending.id+':new'});await Popup.instances[1]!.onclick?.(new Event('click',{cancelable:true}));expect(open).toHaveBeenCalledWith('session-1');
 const sent=delivery.test('chime',80);await Promise.resolve();await Promise.resolve();const test=Popup.instances.at(-1)!;expect(('n#dsh-app://app#'+test.options.tag).length).toBeLessThanOrEqual(64);test.onshow?.();await sent}
 finally{await delivery.dispose()}
})

it('accepts a delayed real system acknowledgement after the diagnostic deadline',async()=>{
 vi.useFakeTimers();const {delivery}=fixture();
 try{const sent=delivery.test('chime',80);await Promise.resolve();await Promise.resolve();await vi.advanceTimersByTimeAsync(3000);await sent;expect(delivery.state.getSnapshot().testStatus).toBe('unknown');Popup.instances[0]!.onshow?.();expect(delivery.state.getSnapshot().testStatus).toBe('shown')}
 finally{await delivery.dispose();vi.useRealTimers()}
})

it('dismisses the clicked popup immediately even if local activation fails',async()=>{
 const {delivery,open}=fixture();open.mockRejectedValue(new Error('navigation unavailable'));await delivery.deliver(event);const popup=Popup.instances[0]!
 try{await popup.onclick?.(new Event('click'));expect(popup.close).toHaveBeenCalledOnce();expect(delivery.state.getSnapshot().activationFailed).toBe(true)}finally{await delivery.dispose()}
})
