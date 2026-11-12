/** Explicit outcomes and answerable interactions without retaining Session histories. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { flushSync } from 'react-dom'
import { closeTopModal, modalSelector } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '../runtime/generated/typert.remote-client.js'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { NotificationDeliveryFrame, NotificationEvent, NotificationKind, NotificationSettings } from '../runtime/types.ts'
import { createNotificationDelivery, type NotificationClient } from './logic/delivery.ts'
import { en, zh } from './logic/locales.ts'
import { createCustomSoundStore, type CustomSoundStore } from './logic/custom-sounds.ts'
import type {} from './logic/slots.ts'
import { createDesktopNotificationClient } from './logic/desktop-client.ts'
import { LOCALE_NS } from '../constants.ts'

export const clientInject = ['uiSession', 'uiWorkspace', 'sessions', 'remote', 'locale']
interface QuestionView { readonly kind: string; readonly key: string; readonly sessionId: SessionId; readonly questions: readonly { readonly intent?: { readonly kind: string } }[]; readonly review: readonly object[] | undefined; getSnapshot(): { readonly channel: 'waterfall' | 'rpc' | 'none'; readonly closed: boolean }; subscribe(listener: () => void): () => void }
interface ApprovalView { readonly kind: 'approval'; readonly key: string; readonly sessionId: SessionId; readonly answerable: boolean }
interface PendingView { id: string; sessionId: SessionId; kind: NotificationKind; ready(): boolean; subscribe?: (listener: () => void) => () => void }
interface PendingBinding { pending: SessionPendingInteraction; view: PendingView; off: () => void; announced: boolean }
function pendingView(value: SessionPendingInteraction): PendingView | undefined {
  const id = 'interaction:' + JSON.stringify([value.sessionId, value.key])
  if (value.kind === 'approval') {
    const approval = value as ApprovalView
    return { id, sessionId: approval.sessionId, kind: 'approval', ready: () => approval.answerable === true }
  }
  if (value.kind !== 'question' && value.kind !== 'plan-review') return undefined
  // This finite projection consumes the public PendingQuestion face on both releases.
  const question = value as QuestionView
  return { id, sessionId: question.sessionId, kind: question.questions.some(item => item.intent?.kind === 'approval') ? 'approval' : 'question',
    ready: () => { const snapshot = question.getSnapshot(); return question.review === undefined && !snapshot.closed && snapshot.channel !== 'none' },
    subscribe: listener => question.subscribe(listener),
  }
}
/** Install browser feedback; accepted local form values take precedence over push preferences. */
export function installNotifications(ctx: Context, preferences: () => NotificationSettings | undefined = () => undefined): NotificationClient {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }))
  const t = ctx.locale.bind(LOCALE_NS)
  let fallback: NotificationSettings | undefined
  let closed = false
  const currentPreferences = (): NotificationSettings | undefined => preferences() ?? fallback
  const summaries = ctx.sessions.list
  // parentId also describes an independent user fork, so durable origin owns child classification.
  const rootSession = (id: string): boolean | undefined => { const row = summaries.getSnapshot().byId[id as SessionId]; return row === undefined ? undefined : row.origin !== 'subagent' }
  let custom: CustomSoundStore | undefined
  try { custom = createCustomSoundStore() } catch (_localStorageUnavailable) { /* Built-in sounds remain available. */ }
  let nativeDesktop = false
  const client = createNotificationDelivery(currentPreferences, async id => {
    const foreground = [...document.querySelectorAll(modalSelector)].at(-1)
    if (foreground?.matches('[data-shortcut-modal="settings"]')) flushSync(() => closeTopModal(document))
    ctx.uiWorkspace.openSession(id as SessionId)
    if (!nativeDesktop && 'dshDesktop' in window && typeof window.dshDesktop === 'object' && window.dshDesktop !== null) {
      const activation = await ctx.remote.dshNotifications.activateDesktop(id)
      if (!activation.ok) { ctx.logger.warn('Desktop session activation failed', activation.error); throw new Error('Desktop activation failed') }
      if (!activation.value) throw new Error('Desktop activation is unavailable')
    }
  }, {
    title: kind => t((kind + 'Title') as 'completedTitle' | 'interruptedTitle' | 'questionTitle' | 'approvalTitle'),
    body: kind => t((kind + 'Body') as 'completedBody' | 'interruptedBody' | 'questionBody' | 'approvalBody'),
    testTitle: t('testTitle'), testBody: t('testBody'),
  }, () => ctx.uiSession.adapter.current.getSnapshot().key, id => {
    const summary = ctx.get('sessions')?.list.getSnapshot().byId[id as SessionId]
    return summary?.displayTitle || summary?.title
  }, custom, onActivate => { const channel = createDesktopNotificationClient(ctx, onActivate); nativeDesktop = channel.supported(); return channel })
  const recent = new Set<string>()
  const remember = (id: string): boolean => {
    if (recent.has(id)) return false
    recent.add(id)
    if (recent.size > 512) recent.delete(recent.values().next().value!)
    return true
  }
  const bindings = new Map<SessionId, PendingBinding>()
  const waitingOutcomes = new Map<string, { event: NotificationEvent; active: () => boolean }>()
  const dispatchOutcome = (event: NotificationEvent, active: () => boolean): void => {
    if (closed || !active()) return
    const root = rootSession(event.sessionId)
    if (root === undefined) {
      waitingOutcomes.set(event.id, { event, active })
      if (waitingOutcomes.size > 64) waitingOutcomes.delete(waitingOutcomes.keys().next().value!)
    } else if (root) { remember(event.id); void client.deliver(event, () => !closed && active() && rootSession(event.sessionId) === true) }
    else client.dismiss(event.id)
  }
  const resolveOutcomes = (): void => {
    for (const [id, pending] of waitingOutcomes) {
      if (closed || !pending.active()) { waitingOutcomes.delete(id); continue }
      if (rootSession(pending.event.sessionId) === undefined) continue
      waitingOutcomes.delete(id); dispatchOutcome(pending.event, pending.active)
    }
  }
  const consider = (binding: PendingBinding): void => {
    const { view } = binding
    if (!view.ready() || rootSession(view.sessionId) !== true) { client.dismiss(view.id); return }
    if (closed || currentPreferences() === undefined || binding.announced) return
    binding.announced = true
    remember(view.id)
    void client.deliver({ id: view.id, sessionId: view.sessionId, kind: view.kind }, () => bindings.get(view.sessionId)?.view === view && view.ready() && rootSession(view.sessionId) === true)
  }
  ctx.effect(() => () => client.dispose())
  ctx.effect(() => {
    const source = ctx.uiSession.sessionStatus
    let baseline = true
    const sync = (): void => {
      const snapshot = source.getSnapshot()
      for (const [id, binding] of bindings) {
        if (snapshot.get(id)?.pendingInteraction !== undefined) continue
        binding.off(); client.dismiss(binding.view.id); bindings.delete(id)
      }
      for (const [id, status] of snapshot) {
        const pending = status.pendingInteraction
        if (pending === undefined) continue
        const existing = bindings.get(id)
        if (existing?.pending === pending) { consider(existing); continue }
        const view = pendingView(pending)
        if (existing !== undefined) { existing.off(); client.dismiss(existing.view.id); bindings.delete(id) }
        if (view === undefined) continue
        const announced = baseline || (existing?.view.id === view.id && existing.announced) || recent.has(view.id)
        if (baseline) remember(view.id)
        const binding: PendingBinding = { pending, view, off: (): void => {}, announced }
        bindings.set(id, binding)
        binding.off = view.subscribe?.(() => consider(binding)) ?? (() => {})
        consider(binding)
      }
      baseline = false
    }
    const off = source.subscribe(sync)
    const offSummaries = summaries.subscribe(() => { for (const binding of bindings.values()) consider(binding); resolveOutcomes() })
    sync()
    const refresh = (): void => client.refresh()
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    return () => { closed = true; off(); offSummaries(); waitingOutcomes.clear(); for (const binding of bindings.values()) binding.off(); bindings.clear(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  })
  ctx.inject(['remote', 'remote.dshNotifications'], scope => {
    let controller: AbortController | undefined
    let stream: RemoteStreamHandle<NotificationDeliveryFrame, never> | undefined
    const start = (): void => {
      controller?.abort(); stream?.dispose(); stream = undefined; waitingOutcomes.clear(); fallback = undefined; client.refresh()
      const active = controller = new AbortController()
      let epoch: string | undefined, cursor = -1
      const accept = (frame: NotificationDeliveryFrame): void => {
        if (closed || active.signal.aborted) return
        fallback = frame.settings
        client.refresh()
        for (const binding of bindings.values()) consider(binding)
        if (frame.baseline || epoch !== frame.epoch) {
          waitingOutcomes.clear()
          epoch = frame.epoch; cursor = frame.cursor
          for (const event of frame.events) remember(event.id)
          return
        }
        if (frame.cursor <= cursor) return
        cursor = frame.cursor
        for (const event of frame.events) if ((event.kind === 'completed' || event.kind === 'interrupted') && remember(event.id)) dispatchOutcome(event, () => !closed && !active.signal.aborted && epoch === frame.epoch)
      }
      void (async () => {
        let current: RemoteStreamHandle<NotificationDeliveryFrame, never> | undefined
        try {
          const next = scope.remote.dshNotifications.events(active.signal)
          current = next
          stream = next
          for await (const frame of next) accept(frame)
        } catch (error) { if (!closed && !active.signal.aborted) scope.logger.warn('Notification events are unavailable', error) }
        finally { current?.dispose(); if (stream === current) { stream = undefined; fallback = undefined; client.refresh() } }
      })()
    }
    scope.on('connection/reset', start)
    scope.effect(() => { start(); return () => { controller?.abort(); stream?.dispose(); fallback = undefined } })
  })
  return client
}
