import { normalizeNotificationPreferences } from '../logic/preferences.ts'
/** Native revision-fenced settings and user-activated notification checks. */
import { useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, Checkbox, SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// 这一行只为类型：插件页的插槽名与 props 由官方插件管理器声明。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { NotificationKind, NotificationSettings, NotificationSound } from '../../runtime/types.ts'
import { LOCALE_NS, PLUGIN_NAME } from '../../constants.ts'
import type { NotificationClient } from '../logic/delivery.ts'
import type { NotificationSettingsInjected } from '../logic/slots.ts'
import type {} from '../logic/slots.ts'
import styles from './SettingsFrame.module.css'
import notificationStyles from './NotificationsSettings.module.css'

export interface NotificationForm extends ObservableSnapshot<ConfigFormSnapshot<NotificationSettings>> { mutate(ops: readonly SettingsPathOpView[], revision?: number): Promise<boolean> }
export type NotificationSettingsProps = PropsRuntime<'plugins.bundle.config'> & InjectFace<NotificationSettingsInjected> & PropsLocale<typeof LOCALE_NS>
const kinds: readonly NotificationKind[] = ['completed', 'interrupted', 'question', 'approval']
const sounds: readonly NotificationSound[] = ['none', 'soft', 'double', 'chime', 'alert', 'custom']
/** Render independent category preferences with one explicit native Save operation. */
export function NotificationsSettings(props: NotificationSettingsProps) {
  // 列表里那一行只画一句摘要，由插件页自己排版；这张表单只在整页时出现。
  if (props.view === 'summary') return null
  const { t } = props
  const snapshot = props.useNotificationSettings(value => value)
  const capability = props.useNotificationCapabilities(value => value)
  const accepted = props.useNotificationPreferences(value => value)
  const [draft, setDraft] = useState<{ value: NotificationSettings; revision: number | undefined } | null>(null)
  const fileInputs = useRef<Partial<Record<NotificationKind, HTMLInputElement | null>>>({})
  const [write, setWrite] = useState<'idle' | 'saving' | 'failed'>('idle')
  const value = normalizeNotificationPreferences(draft?.value ?? snapshot.value ?? accepted)
  const hostFieldsReady = typeof snapshot.value?.volume === 'number'
  const blocked = !hostFieldsReady || snapshot.status !== 'ready' || !snapshot.writable || write === 'saving' || snapshot.revision === undefined
  const conflicted = draft !== null && draft.revision !== snapshot.revision
  const change = (next: NotificationSettings): void => { if (blocked) return; setDraft({ value: next, revision: draft?.revision ?? snapshot.revision }); setWrite('idle') }
  const discard = (): void => { setDraft(null); setWrite('idle') }
  const save = (): void => {
    if (draft === null || blocked || conflicted) return
    setWrite('saving')
    void props.saveSettings(draft.value, draft.revision).then(accepted => { if (accepted) discard(); else setWrite('failed') }).catch((_saveFailure) => setWrite('failed'))
  }
  const permission = !capability.supported ? 'unsupported' : capability.permission === 'granted' ? 'permissionGranted' : capability.permission === 'denied' ? 'permissionDenied' : 'permissionDefault'
  const audio = capability.audio === 'ready' ? 'audioReady' : capability.audio === 'blocked' ? 'audioBlocked' : capability.audio === 'unsupported' ? 'audioUnsupported' : 'audioUnknown'
  return <section className={notificationStyles.root} data-dsh-notifications data-dsh-notifications-settings>
    <header><h4>{t('title')}</h4><p>{t('help')}</p></header>
    <div data-notification-global>
      <div data-notification-capabilities>
        <p role="status" aria-label={t('systemPermission')}>{t(permission)}</p>
        {!capability.secure && <p role="status">{t('insecure')}</p>}
        {snapshot.status === 'ready' && snapshot.writable && !hostFieldsReady && <p role="status">{t('hostUpdateRequired')}</p>}
        {capability.failed && <p role="status">{t('desktopFailed')}</p>}
        {capability.activationFailed && <p role="alert">{t('activationFailed')}</p>}
        <p role="status" aria-label={t('audioStatus')}>{t(audio)}</p>
        {capability.testStatus && capability.testStatus !== 'idle' && <p role="status" aria-label={t('testStatus')}>{t(capability.testStatus === 'pending' ? 'testPending' : capability.testStatus === 'shown' ? 'testShown' : capability.testStatus === 'submitted' ? 'testSubmitted' : capability.testStatus === 'failed' ? 'testFailed' : capability.testStatus === 'closed' ? 'testClosed' : capability.testStatus === 'clicked' ? 'testClicked' : 'testUnknown')}</p>}
        <div data-notification-permission-actions>
          <Button size="sm" variant="outline" disabled={!capability.supported || !capability.secure || capability.permission === 'granted'} onClick={() => { void props.requestPermission() }}>{t('allow')}</Button>
          <Button size="sm" variant="ghost" disabled={!capability.supported || !capability.secure} onClick={() => { void props.test(value?.completed.sound ?? 'chime', value?.volume ?? 80) }}>{t('test')}</Button>
        </div>
      </div>
      {value !== undefined && <div data-notification-preferences>
        <label data-notification-mode><span>{t('popupMode')}</span><select data-notification-mode-select aria-label={t('popupMode')} value={value.popupMode ?? (value.desktop ? 'unfocused' : 'never')} disabled={blocked} onChange={event => { const popupMode = event.currentTarget.value; if (popupMode === 'never' || popupMode === 'unfocused' || popupMode === 'always') change({ ...value, popupMode }) }}><option value="never">{t('popupNever')}</option><option value="unfocused">{t('popupUnfocused')}</option><option value="always">{t('popupAlways')}</option></select></label>
        <div data-notification-sound-enabled><Checkbox label={t('soundEnabled')} checked={value.soundEnabled ?? true} disabled={blocked} onChange={soundEnabled => change({ ...value, soundEnabled })} /></div>
        <label data-notification-volume><span>{t('volume')} · <output>{value.volume}%</output></span><input type="range" min={0} max={100} step={1} aria-label={t('volume')} value={value.volume} disabled={blocked} onChange={event => { const volume = event.currentTarget.valueAsNumber; if (Number.isFinite(volume)) change({ ...value, volume }) }} /><span>{t('volumeHint')}</span></label>
      </div>}
    </div>
    <div className={styles.form} data-dsh-settings-form><SettingsForm labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }} state={{ available: value !== undefined, writable: snapshot.writable, dirty: draft !== null, invalid: blocked || conflicted, saving: write === 'saving', failed: write === 'failed' }} onSave={save} onDiscard={discard}>
      {value !== undefined && <div data-notification-categories>
        {kinds.map(kind => {
          const file = capability.customFiles?.[kind], busy = capability.customBusy?.[kind] === true, error = capability.customErrors?.[kind]
          const errorKey = error === 'too-large' ? 'customTooLarge' : error === 'invalid-audio' || error === 'empty' || error === 'unsupported-type' ? 'customInvalid' : 'customFailed'
          return <div key={kind} data-notification-kind={kind}>
          <Checkbox label={t(kind)} checked={value[kind].enabled} disabled={blocked} onChange={enabled => change({ ...value, [kind]: { ...value[kind], enabled } })} />
          <div data-notification-sound-controls>
            <select aria-label={t('soundFor', { kind: t(kind) })} value={value[kind].sound} disabled={blocked} onChange={event => { const sound = sounds.find(item => item === event.currentTarget.value); if (sound !== undefined) change({ ...value, [kind]: { ...value[kind], sound } }) }}>{sounds.map(sound => <option key={sound} value={sound}>{t(sound)}</option>)}</select>
            <Button size="sm" variant="ghost" aria-label={t('previewFor', { kind: t(kind) })} disabled={capability.audio === 'unsupported'} onClick={() => { void props.preview(value[kind].sound, value.volume, kind) }}>{t('preview')}</Button>
          </div>
          {value[kind].sound === 'custom' && <div data-notification-custom>
            <span data-notification-file title={file?.name ?? t('noFile')}>{file?.name ?? t('noFile')}</span>
            <Button size="sm" variant="outline" disabled={busy || !capability.customAvailable || capability.audio === 'unsupported'} aria-label={t('importFor', { kind: t(kind) })} onClick={() => fileInputs.current[kind]?.click()}>{t(file ? 'replaceSound' : 'importSound')}</Button>
            {file && <Button size="sm" variant="ghost" disabled={busy} aria-label={t('removeFor', { kind: t(kind) })} onClick={() => { void props.removeCustomSound(kind) }}>{t('removeSound')}</Button>}
            <input ref={element => { fileInputs.current[kind] = element }} type="file" accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus" hidden aria-label={t('audioFileFor', { kind: t(kind) })} disabled={busy || !capability.customAvailable} onChange={event => { const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (selected !== undefined) void props.importCustomSound(kind, selected) }} />
            <span data-notification-custom-status>{!capability.customAvailable ? t('customUnavailable') : error ? t(errorKey) : !file ? t('customMissing') : t('customHint')}</span>
          </div>}
        </div>})}
      </div>}
      {conflicted && <p role="alert">{t('conflict')}</p>}
      <div className={styles.formActions} data-notification-actions data-dsh-settings-actions><Button size="sm" variant="ghost" disabled={draft === null || write === 'saving'} onClick={discard}>{t('discard')}</Button></div>
    </SettingsForm></div>
  </section>
}
/** 插件页里这一格配置的槽位：官方插件管理器声明它，按**包名**作键。 */
export const PLUGIN_CONFIG_SLOT = 'plugins.bundle.config'
/** 把通知设置注册成插件页里的配置卡（不再单独占设置页的一页）。 */
export function installNotificationsCard(ctx: Context, { form, client }: { form: NotificationForm; client: NotificationClient }): void {
  const injected: NotificationSettingsInjected = {
    hooks: { notificationSettings: form, notificationCapabilities: client.state, notificationPreferences: client.preferences },
    saveSettings: (value, revision) => revision !== undefined && form.getSnapshot().revision === revision && typeof form.getSnapshot().value?.volume === 'number' ? form.mutate([
      { op: 'set', path: ['popupMode'], value: value.popupMode ?? (value.desktop ? 'unfocused' : 'never') },
      { op: 'set', path: ['soundEnabled'], value: value.soundEnabled ?? true },
      { op: 'set', path: ['volume'], value: value.volume },
      ...kinds.map(kind => ({ op: 'set' as const, path: [kind], value: { ...value[kind] } })),
    ], revision) : Promise.resolve(false),
    requestPermission: () => client.requestPermission(), preview: (sound, volume, kind) => client.preview(sound, volume, kind), test: (sound, volume, kind) => client.test(sound, volume, kind),
    importCustomSound: (kind, file) => client.importCustomSound(kind, file), removeCustomSound: kind => client.removeCustomSound(kind),
  }
  ctx.effect(() => form.subscribe(() => client.refresh()))
  // 这个槽位由插件页在运行时声明，所以 inject 要等它出现再注册。
  ctx.slots.inject(PLUGIN_CONFIG_SLOT, () => ctx.slots.register({
    name: PLUGIN_CONFIG_SLOT, key: PLUGIN_NAME, locale: LOCALE_NS, inject: () => injected,
  }, NotificationsSettings))
}
