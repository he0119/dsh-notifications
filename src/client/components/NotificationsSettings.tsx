import { normalizeNotificationPreferences } from '../logic/preferences.ts'
/** Native revision-fenced settings and user-activated notification checks. */
import { Fragment, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Button, SettingsForm, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// 这一行只为类型：插件页的插槽名与 props 由官方插件管理器声明。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { NotificationKind, NotificationSettings, NotificationSound } from '../../runtime/types.ts'
import { LOCALE_NS, PACKAGE_NAME } from '../../constants.ts'
import type { NotificationClient } from '../logic/delivery.ts'
import type { NotificationSettingsInjected } from '../logic/slots.ts'
import type {} from '../logic/slots.ts'
import styles from './NotificationsSettings.module.css'

export interface NotificationForm extends ObservableSnapshot<ConfigFormSnapshot<NotificationSettings>> { mutate(ops: readonly SettingsPathOpView[], revision?: number): Promise<boolean> }
export type NotificationSettingsProps = PropsRuntime<'plugins.bundle.config'> & InjectFace<NotificationSettingsInjected> & PropsLocale<typeof LOCALE_NS>
const kinds: readonly NotificationKind[] = ['completed', 'interrupted', 'question', 'approval']
const sounds: readonly NotificationSound[] = ['none', 'soft', 'double', 'chime', 'alert', 'custom']
/** 「会话完成」下面那组开关：自动跑起来的回合结束时算不算完成。 */
const wakeOptions = [
  { field: 'goalRounds', label: 'goalRounds', hint: 'goalRoundsHint' },
  { field: 'subagentWake', label: 'subagentWake', hint: 'subagentWakeHint' },
  { field: 'backgroundWake', label: 'backgroundWake', hint: 'backgroundWakeHint' },
] as const
/**
 * 画这张通知配置卡：一个决定一行，排布与 DSH 设置页一致——左边一句话，右边它的控件。
 *
 * 开关用官方 `Switch`：设置页里的开关就是在开/关一项能力，比拿 `Checkbox` 再改它内部排布稳；
 * 状态颜色交给 `StateDot`，不自己画圆点。其余都是原生控件（select、range），整张卡读起来像宿主页面。
 */
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
  const testStatusText = capability.testStatus !== undefined && capability.testStatus !== 'idle'
    ? t(capability.testStatus === 'pending' ? 'testPending' : capability.testStatus === 'shown' ? 'testShown' : capability.testStatus === 'submitted' ? 'testSubmitted' : capability.testStatus === 'failed' ? 'testFailed' : capability.testStatus === 'closed' ? 'testClosed' : capability.testStatus === 'clicked' ? 'testClicked' : 'testUnknown')
    : undefined
  const hostStale = snapshot.status === 'ready' && snapshot.writable && !hostFieldsReady
  // 只有真会拦住提醒的才写进说明：首次访问时 audio 还是 unknown，那不是问题。
  const problems = [
    capability.permission === 'granted' ? undefined : t(permission),
    !capability.secure ? t('insecure') : undefined,
    hostStale ? t('hostUpdateRequired') : undefined,
    capability.failed ? t('desktopFailed') : undefined,
    capability.activationFailed ? t('activationFailed') : undefined,
    capability.audio === 'blocked' || capability.audio === 'unsupported' ? t(audio) : undefined,
    capability.testStatus === 'failed' ? testStatusText : undefined,
  ].filter((line): line is string => line !== undefined)
  const attention = problems.length > 0
  // 刚点过「测试通知」时它的结果比「已就绪」更相关，所以先显示它。
  const headline = capability.testStatus !== 'failed' && testStatusText !== undefined
    ? testStatusText
    : attention ? t('stateAttention') : t('stateOk')
  return <section className={styles.root} data-dsh-notifications data-dsh-notifications-settings>
    <SettingsForm labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }} state={{ available: value !== undefined, writable: snapshot.writable, dirty: draft !== null, invalid: blocked || conflicted, saving: write === 'saving', failed: write === 'failed' }} onSave={save} onDiscard={discard}>
      <div className={styles.row}>
        <div className={styles.rowMain} role="status">
          <p className={styles.rowTitle}><StateDot state={attention ? 'warning' : 'done'} />{headline}</p>
          {problems.map(line => <p key={line} className={styles.rowHint}>{line}</p>)}
        </div>
        <div className={styles.rowActions}>
          <Button size="sm" variant="outline" disabled={!capability.supported || !capability.secure || capability.permission === 'granted'} onClick={() => { void props.requestPermission() }}>{t('allow')}</Button>
          <Button size="sm" variant="ghost" disabled={!capability.supported || !capability.secure} onClick={() => { void props.test(value?.completed.sound ?? 'chime', value?.volume ?? 80) }}>{t('test')}</Button>
        </div>
      </div>
      {value !== undefined && <Fragment>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor="dsh-notifications-popup-mode">{t('popupMode')}</label>
          </div>
          <select id="dsh-notifications-popup-mode" className={styles.select} value={value.popupMode ?? (value.desktop ? 'unfocused' : 'never')} disabled={blocked} onChange={event => { const popupMode = event.currentTarget.value; if (popupMode === 'never' || popupMode === 'unfocused' || popupMode === 'always') change({ ...value, popupMode }) }}>
            <option value="never">{t('popupNever')}</option>
            <option value="unfocused">{t('popupUnfocused')}</option>
            <option value="always">{t('popupAlways')}</option>
          </select>
        </div>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{t('soundEnabled')}</span>
          </div>
          <div className={styles.rowActions}>
            <Switch label={t('soundEnabled')} checked={value.soundEnabled ?? true} disabled={blocked} onChange={soundEnabled => change({ ...value, soundEnabled })} />
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor="dsh-notifications-volume">{t('volume')}</label>
            <p className={styles.rowHint}>{t('volumeHint')}</p>
          </div>
          <div className={styles.rowActions}>
            <output className={styles.output} htmlFor="dsh-notifications-volume">{value.volume}%</output>
            <input id="dsh-notifications-volume" className={styles.slider} type="range" min={0} max={100} step={1} value={value.volume} disabled={blocked} onChange={event => { const volume = event.currentTarget.valueAsNumber; if (Number.isFinite(volume)) change({ ...value, volume }) }} />
          </div>
        </div>
        {kinds.map(kind => {
          const file = capability.customFiles?.[kind], busy = capability.customBusy?.[kind] === true, error = capability.customErrors?.[kind]
          const errorKey = error === 'too-large' ? 'customTooLarge' : error === 'invalid-audio' || error === 'empty' || error === 'unsupported-type' ? 'customInvalid' : 'customFailed'
          const customStatus = !capability.customAvailable ? t('customUnavailable') : error ? t(errorKey) : !file ? t('customMissing') : t('customHint')
          return <Fragment key={kind}>
            {/* 事件和它的提示音在同一行：左边是这件事，右边依次是音色、试听、开关。 */}
            <div className={styles.row} data-notification-kind={kind}>
              <div className={styles.rowMain}>
                <span className={styles.rowTitle}>{t(kind)}</span>
              </div>
              <div className={styles.rowActions}>
                <select className={styles.select} aria-label={t('soundFor', { kind: t(kind) })} value={value[kind].sound} disabled={blocked} onChange={event => { const sound = sounds.find(item => item === event.currentTarget.value); if (sound !== undefined) change({ ...value, [kind]: { ...value[kind], sound } }) }}>
                  {sounds.map(sound => <option key={sound} value={sound}>{t(sound)}</option>)}
                </select>
                <Button size="sm" variant="ghost" aria-label={t('previewFor', { kind: t(kind) })} disabled={capability.audio === 'unsupported'} onClick={() => { void props.preview(value[kind].sound, value.volume, kind) }}>{t('preview')}</Button>
                <Switch className={styles.toggle} label={t(kind)} checked={value[kind].enabled} disabled={blocked} onChange={enabled => change({ ...value, [kind]: { ...value[kind], enabled } })} />
              </div>
            </div>
            {/* 自定义音频是上面那一行的补充，所以不画分隔线、标题降一级。 */}
            {value[kind].sound === 'custom' && <div className={[styles.row, styles.customRow].join(' ')}>
              <div className={styles.rowMain}>
                <span className={styles.subTitle}>{t('custom')}</span>
                <p className={styles.rowHint}>
                  <span data-notification-file title={file?.name ?? t('noFile')}>{file?.name ?? t('noFile')}</span>
                  {' · '}{customStatus}
                </p>
              </div>
              <div className={styles.rowActions}>
                <Button size="sm" variant="outline" disabled={busy || !capability.customAvailable || capability.audio === 'unsupported'} aria-label={t('importFor', { kind: t(kind) })} onClick={() => fileInputs.current[kind]?.click()}>{t(file ? 'replaceSound' : 'importSound')}</Button>
                {file && <Button size="sm" variant="ghost" disabled={busy} aria-label={t('removeFor', { kind: t(kind) })} onClick={() => { void props.removeCustomSound(kind) }}>{t('removeSound')}</Button>}
                <input ref={element => { fileInputs.current[kind] = element }} type="file" accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus" hidden aria-label={t('audioFileFor', { kind: t(kind) })} disabled={busy || !capability.customAvailable} onChange={event => { const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (selected !== undefined) void props.importCustomSound(kind, selected) }} />
              </div>
            </div>}
            {/* 「会话完成」下面这组：勾上哪些额外时机也算一次完成（照子智能体那张卡的可勾选列表）。 */}
            {kind === 'completed' && value.completed.enabled && <fieldset className={styles.group}>
              <legend>{t('wakeGroup')}</legend>
              {wakeOptions.map(option => <label key={option.field} className={styles.groupItem}>
                <input type="checkbox" checked={value[option.field]} disabled={blocked} aria-label={t(option.label)}
                  onChange={event => change({ ...value, [option.field]: event.currentTarget.checked })} />
                <span className={styles.groupText}>
                  <span className={styles.groupTitle}>{t(option.label)}</span>
                  <span className={styles.groupNote}>{t(option.hint)}</span>
                </span>
              </label>)}
            </fieldset>}
          </Fragment>
        })}
        {/* 草稿撞上别处的编辑：官方外框只提供「保存」，所以给一条说明和一个退出的入口。 */}
        {conflicted && <div className={styles.conflict}>
          <p role="alert" className={styles.rowHint}>{t('conflict')}</p>
          <Button size="sm" variant="ghost" onClick={discard}>{t('discard')}</Button>
        </div>}
      </Fragment>}
    </SettingsForm>
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
      { op: 'set', path: ['goalRounds'], value: value.goalRounds },
      { op: 'set', path: ['subagentWake'], value: value.subagentWake },
      { op: 'set', path: ['backgroundWake'], value: value.backgroundWake },
      { op: 'set', path: ['volume'], value: value.volume },
      ...kinds.map(kind => ({ op: 'set' as const, path: [kind], value: { ...value[kind] } })),
    ], revision) : Promise.resolve(false),
    requestPermission: () => client.requestPermission(), preview: (sound, volume, kind) => client.preview(sound, volume, kind), test: (sound, volume, kind) => client.test(sound, volume, kind),
    importCustomSound: (kind, file) => client.importCustomSound(kind, file), removeCustomSound: kind => client.removeCustomSound(kind),
  }
  ctx.effect(() => form.subscribe(() => client.refresh()))
  // 这个槽位由插件页在运行时声明，所以 inject 要等它出现再注册。
  ctx.slots.inject(PLUGIN_CONFIG_SLOT, () => ctx.slots.register({
    name: PLUGIN_CONFIG_SLOT, key: PACKAGE_NAME, locale: LOCALE_NS, inject: () => injected,
  }, NotificationsSettings))
}
