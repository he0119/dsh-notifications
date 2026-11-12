/** Independent popup, sound and device-local audio channels owned by one Client. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { NotificationEvent, NotificationKind, NotificationSettings, NotificationSound } from '../../runtime/types.ts'
import { createSoundPlayer, CustomAudioDecodeError, type SoundState } from './sounds.ts'
import { CustomSoundStoreError, type CustomSoundMetadata, type CustomSoundStore, type CustomSoundStoreErrorCode } from './custom-sounds.ts'
import { createServiceWorkerNotifications } from './service-worker-client.ts'
import type { DesktopNotificationFactory } from './desktop-types.ts'

type SoundFiles = Readonly<Partial<Record<NotificationKind, CustomSoundMetadata>>>
type SoundErrors = Readonly<Partial<Record<NotificationKind, CustomSoundStoreErrorCode | 'invalid-audio'>>>
export interface DeliveryState {
  readonly supported: boolean; readonly secure: boolean; readonly permission: NotificationPermission | 'unavailable'; readonly audio: SoundState; readonly failed: boolean
  readonly activationFailed?: boolean
  readonly testStatus?: 'idle' | 'pending' | 'shown' | 'submitted' | 'failed' | 'unknown' | 'closed' | 'clicked'
  readonly customAvailable?: boolean; readonly customFiles?: SoundFiles; readonly customErrors?: SoundErrors; readonly customBusy?: Readonly<Partial<Record<NotificationKind, boolean>>>
}
export interface NotificationCopy { title(kind: NotificationKind): string; body(kind: NotificationKind): string; testTitle: string; testBody: string }
export interface NotificationClient {
  readonly state: ObservableSnapshot<DeliveryState>
  readonly preferences: ObservableSnapshot<NotificationSettings | undefined>
  refresh(): void
  requestPermission(): Promise<void>
  preview(sound: NotificationSound, volume?: number, kind?: NotificationKind): Promise<boolean>
  test(sound: NotificationSound, volume?: number, kind?: NotificationKind): Promise<void>
  importCustomSound(kind: NotificationKind, file: File): Promise<boolean>
  removeCustomSound(kind: NotificationKind): Promise<boolean>
}
export interface NotificationDelivery extends NotificationClient { deliver(event: NotificationEvent, valid?: () => boolean): Promise<void>; dismiss(id: string): void; dispose(): Promise<void> }
const kinds: readonly NotificationKind[] = ['completed', 'interrupted', 'question', 'approval']
/** Own notifications and audio; popup focus policy never suppresses eligible sound. */
export function createNotificationDelivery(preferences: () => NotificationSettings | undefined, openSession: (id: string) => void | Promise<void>, copy: NotificationCopy, selectedSession: () => string | undefined = () => undefined, titleGetter: (id: string) => string | undefined = () => undefined, custom?: CustomSoundStore, desktopFactory?: DesktopNotificationFactory): NotificationDelivery {
  let disposed = false, constructorUnavailable = false, readVersion = 0
  let cancelTest: (() => void) | undefined
  let testVersion = 0, testPopupId: string | undefined
  const popups = new Map<string, Notification>()
  const acceptedPreferences = createSnapshotStore<NotificationSettings | undefined>(preferences())
  const state = createSnapshotStore<DeliveryState>({ supported: typeof Notification === 'function', secure: globalThis.isSecureContext === true, permission: typeof Notification === 'function' ? Notification.permission : 'unavailable', audio: typeof AudioContext === 'function' ? 'unknown' : 'unsupported', failed: false, customAvailable: custom !== undefined, customFiles: {}, customErrors: {}, customBusy: {} })
  const update = (patch: Partial<DeliveryState>): void => {
    if (disposed) return
    const old = state.getSnapshot(), next = { ...old, ...patch }
    if ((Object.keys(patch) as (keyof DeliveryState)[]).some(key => old[key] !== next[key])) state.set(next)
  }
  const activate = async (id?: string): Promise<boolean> => {
    if (disposed) return false
    try { window.focus() } catch (_focusUnavailable) { /* Worker or desktop activation owns native focus. */ }
    try { if (id !== undefined) await openSession(id); update({ activationFailed: false }); return !disposed }
    catch (_activationFailure) { update({ activationFailed: true }); return false }
  }
  const worker = createServiceWorkerNotifications(id => activate(id).then(() => undefined))
  const desktop = desktopFactory?.(async id => { if (!await activate(id)) throw new Error('Could not open the notification conversation') })
  const player = createSoundPlayer(audio => update({ audio }), custom)
  const classify = (error: unknown): CustomSoundStoreErrorCode | 'invalid-audio' => error instanceof CustomAudioDecodeError ? 'invalid-audio' : error instanceof CustomSoundStoreError ? error.code : 'storage'
  const refreshCustom = async (): Promise<void> => {
    if (custom === undefined || disposed) return
    const version = ++readVersion, files: Partial<Record<NotificationKind, CustomSoundMetadata>> = {}, errors: Partial<Record<NotificationKind, CustomSoundStoreErrorCode | 'invalid-audio'>> = {}
    await Promise.all(kinds.map(async kind => { try { const asset = await custom.get(kind); if (asset !== undefined) files[kind] = { name: asset.name, type: asset.type, size: asset.size } } catch (error) { errors[kind] = classify(error) } }))
    if (!disposed && version === readVersion) update({ customFiles: files, customErrors: { ...state.getSnapshot().customErrors, ...errors } })
  }
  const offCustom = custom?.subscribe(() => { player.invalidateCustom(); void refreshCustom() })
  void refreshCustom()
  const refresh = (): void => {
    if (disposed) return
    const accepted = preferences()
    if (acceptedPreferences.getSnapshot() !== accepted) acceptedPreferences.set(accepted)
    update({ supported: desktop?.supported() === true || (typeof Notification === 'function' && !constructorUnavailable) || worker.supported(), secure: globalThis.isSecureContext === true, permission: desktop?.supported() ? 'granted' : typeof Notification === 'function' ? Notification.permission : 'unavailable' })
  }
  const background = (): boolean => document.visibilityState !== 'visible' || !document.hasFocus()
  const show = async (id: string, title: string, body: string, sessionId?: string, eligible: () => boolean = () => true, observe?: (status: 'shown' | 'submitted' | 'failed' | 'closed' | 'clicked') => void): Promise<boolean> => {
    refresh()
    const capability = state.getSnapshot()
    if (disposed || !eligible() || !capability.supported || !capability.secure || capability.permission !== 'granted') return false
    try {
      const sessionTitle = sessionId === undefined ? undefined : titleGetter(sessionId)
      let label = '', length = 0
      if (sessionTitle) for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(sessionTitle)) { if (length++ === 80) { label += '…'; break }; label += part.segment }
      const heading = label ? title + ' · ' + label : title
      if (desktop?.supported()) {
        const submitted = await desktop.show({ id, title: heading, body, ...(sessionId === undefined ? {} : { sessionId }) }, eligible, () => observe?.('clicked'))
        if (submitted && !disposed) { update({ failed: false }); observe?.('submitted') }
        else if (!disposed && eligible()) { update({ failed: true }); observe?.('failed') }
        return submitted
      }
      if (worker.supported()) {
        const submitted = await worker.show({ id, title: heading, body, ...(sessionId === undefined ? {} : { sessionId }) }, eligible)
        if (submitted && !disposed) { update({ failed: false }); observe?.('submitted') }
        return submitted
      }
      const popup = new Notification(heading, { body, tag: crypto.randomUUID(), silent: true, requireInteraction: true })
      popups.get(id)?.close(); popups.set(id, popup)
      let clicked = false
      popup.onclose = () => { if (popups.get(id) === popup) popups.delete(id); if (!clicked) observe?.('closed') }
      popup.onshow = () => { update({ failed: false }); observe?.('shown') }
      popup.onerror = () => { update({ failed: true }); observe?.('failed') }
      popup.onclick = async () => {
        if (disposed || clicked) return
        clicked = true; observe?.('clicked')
        popup.close()
        await activate(sessionId)
      }
      return true
    } catch (error) { constructorUnavailable = error instanceof TypeError && !worker.supported() && !desktop?.supported(); update({ supported: !constructorUnavailable || worker.supported() || desktop?.supported() === true, failed: true }); observe?.('failed'); return false }
  }
  const requestPermission = async (): Promise<void> => {
    refresh(); const capability = state.getSnapshot()
    if (disposed || !capability.supported || !capability.secure) return
    if (capability.permission === 'granted') { update({ failed: false }); return }
    try { update({ permission: await Notification.requestPermission(), failed: false }) } catch (_permissionUnavailable) { update({ failed: true }) }
  }
  const busy = (kind: NotificationKind, value: boolean): void => update({ customBusy: { ...state.getSnapshot().customBusy, [kind]: value } })
  return {
    state, preferences: acceptedPreferences, refresh, requestPermission,
    preview: (sound, volume = preferences()?.volume ?? 80, kind = 'completed') => player.preview(sound, volume, kind),
    async test(sound, volume = preferences()?.volume ?? 80, kind = 'completed') {
      if (disposed) return
      cancelTest?.(); const version = ++testVersion
      if (testPopupId !== undefined) { popups.get(testPopupId)?.close(); popups.delete(testPopupId); void worker.close(testPopupId).catch(() => {}); void desktop?.close(testPopupId).catch(() => {}) }
      const id = testPopupId = 'dsh-notification-test-' + crypto.randomUUID()
      update({ testStatus: 'pending' })
      const done = Promise.withResolvers<void>()
      let active = true, deadline: ReturnType<typeof setTimeout> | undefined
      const finish = (status: 'shown' | 'submitted' | 'failed' | 'unknown' | 'closed' | 'clicked'): void => { if (disposed || version !== testVersion || (!active && state.getSnapshot().testStatus !== 'unknown' && status !== 'closed' && status !== 'clicked')) return; active = false; clearTimeout(deadline); update({ testStatus: status }); done.resolve() }
      cancelTest = () => { if (!active) return; active = false; clearTimeout(deadline); done.resolve() }
      void player.preview(sound, volume, kind)
      void requestPermission().then(async () => { if (!disposed && active) { deadline = setTimeout(() => finish('unknown'), 3000); if (!await show(id, copy.testTitle, copy.testBody, selectedSession(), () => true, finish)) finish('failed') } }).catch(() => finish('failed'))
      await done.promise
    },
    async importCustomSound(kind, file) {
      if (disposed || custom === undefined || state.getSnapshot().customBusy?.[kind]) return false
      busy(kind, true)
      try {
        const metadata = await custom.set(kind, file, selected => player.validate(selected))
        if (!disposed) { player.invalidateCustom(); update({ customFiles: { ...state.getSnapshot().customFiles, [kind]: metadata }, customErrors: { ...state.getSnapshot().customErrors, [kind]: undefined } }) }
        return !disposed
      } catch (error) { update({ customErrors: { ...state.getSnapshot().customErrors, [kind]: classify(error) } }); return false }
      finally { busy(kind, false) }
    },
    async removeCustomSound(kind) {
      if (disposed || custom === undefined || state.getSnapshot().customBusy?.[kind]) return false
      busy(kind, true)
      try {
        await custom.remove(kind); const files = { ...state.getSnapshot().customFiles }; delete files[kind]
        player.invalidateCustom(); update({ customFiles: files, customErrors: { ...state.getSnapshot().customErrors, [kind]: undefined } }); return !disposed
      } catch (error) { update({ customErrors: { ...state.getSnapshot().customErrors, [kind]: classify(error) } }); return false }
      finally { busy(kind, false) }
    },
    async deliver(event, valid = () => true) {
      await Promise.resolve()
      const accepted = preferences()
      const allowed = (): boolean => !disposed && valid() && preferences()?.[event.kind].enabled === true
      if (accepted === undefined || !allowed()) return
      if ((accepted.soundEnabled ?? true) && accepted.volume > 0) void player.play(accepted[event.kind].sound, () => allowed() && (preferences()?.soundEnabled ?? true) && (preferences()?.volume ?? 0) > 0 && preferences()?.[event.kind].sound !== 'none', accepted.volume, event.kind)
      const popupAllowed = (): boolean => { const current = preferences(); const mode = current?.popupMode ?? (current?.desktop ? 'unfocused' : 'never'); return allowed() && (mode === 'always' || (mode === 'unfocused' && background())) }
      if (popupAllowed()) await show(event.id, copy.title(event.kind), copy.body(event.kind), event.sessionId, popupAllowed)
    },
    dismiss(id) { popups.get(id)?.close(); popups.delete(id); void worker.close(id).catch(() => {}); void desktop?.close(id).catch(() => {}) },
    async dispose() {
      if (disposed) return
      disposed = true; cancelTest?.(); readVersion++; offCustom?.(); worker.dispose(); desktop?.dispose()
      for (const popup of popups.values()) popup.close()
      popups.clear(); custom?.close(); await player.dispose()
    },
  }
}
