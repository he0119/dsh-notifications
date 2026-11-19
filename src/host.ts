/** Live committed outcomes and terminal failures without retaining Session histories. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { NotificationEvent, NotificationKind, NotificationReaders } from './runtime/types.ts'
import { createNotificationFeed } from './feed.ts'

/** Observable notification owner; disposal closes all outstanding readers. */
export interface NotificationHost extends NotificationReaders {
  /** Refresh accepted delivery preferences without publishing another outcome. */
  refresh(): void
  dispose(): void
}

/** Who caused one turn; only user turns announce completion by default. */
type TurnSource = 'user' | 'goal' | 'subagent' | 'background'
interface TurnState { readonly turn: number | undefined; terminal: boolean; pendingError?: string }
interface SourceState { readonly source: TurnSource; readonly goalId?: string; readonly weak: boolean; at: number }
/** terminal = goal/change; round = a goal-owned turn/end. One terminal outcome is announced once. */
interface GoalNotice { readonly kind: NotificationKind; readonly goalId?: string; readonly terminal: boolean; at: number }
/** Options read live from Volatile config so edits take effect without a reload. */
export interface NotificationHostOptions {
  readonly goalRounds: boolean
  readonly subagentWake: boolean
  readonly backgroundWake: boolean
}
/** Two goal-owned outcomes of the same kind within this window are one announcement. */
const GOAL_DEDUPE_MS = 5000

function outcome(reason: TurnEndReason): Pick<NotificationEvent, 'kind' | 'reason'> | undefined {
  switch (reason.kind) {
    case 'completed': return { kind: 'completed' }
    case 'error': return { kind: 'interrupted', reason: reason.error.code }
    case 'blocked': case 'max-tokens': return { kind: 'interrupted', reason: reason.kind }
    case 'aborted': return reason.reason.kind === 'user' || reason.reason.kind === 'disposed' ? undefined : { kind: 'interrupted', reason: 'aborted:' + reason.reason.kind }
    default: return undefined // Restoration-only and future merge-extensible reasons do not announce success.
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && error.code.length > 0) return error.code
  return 'UNKNOWN'
}

/**
 * Context messages DSH injects into an already-open turn. They arrive as `user/message`
 * events but carry no user intent. Leaving them in the `default: user` branch lets them
 * overwrite the real trigger (goal, schedule, subagent) recorded earlier in the turn.
 */
const INJECTED_CONTEXT_KINDS = new Set([
  'runtime-context',
  'time-context',
  'ptc-mode',
  'agent-instructions',
  'skill-catalog',
  'compact-checkpoint',
  'model-selection',
  'tool-registry',
  'session-reference',
  'tmux-context',
  'repeat-tool-reminder',
  'action-cards',
  'hooks-claude-code',
  'hooks-codex',
  'dsh-session-title-llm',
])

/**
 * A tool-jobs notice is a weak background source: when it wakes an idle session it is the
 * turn's first message (so backgroundWake gates it), but DSH claims next-step input before
 * next-turn, so an injected notice can also precede the real trigger. `weak` lets that real
 * trigger win without making the notice a user turn.
 */
function isWeakSource(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'tool-jobs'
}

/** Merge-extensible message sources: `user` wins, goal rounds and background wakes are distinct. */
function sourceOf(value: unknown): TurnSource | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value) || typeof value.kind !== 'string') return 'user'
  const kind = value.kind
  if (INJECTED_CONTEXT_KINDS.has(kind)) return undefined // Injected context is not a turn trigger.
  switch (kind) {
    case 'user': return 'user'
    case 'goal': case 'tool-goal': return 'goal'
    case 'subagent-settled': case 'agent-message': return 'subagent'
    case 'schedule': case 'tool-jobs': return 'background' // Scheduled and job wakeups are background work.
    default: return 'user' // Unknown producers are treated as user work so nothing is silently missed.
  }
}

/**
 * Subscribe to post-commit ends and terminal idle failures; never infer success from idle.
 * Completion announcements follow the turn's trigger: user turns always announce, goal rounds
 * and background wakes only when their options allow it. Goal terminal changes announce once,
 * even when the final round also announced its completion near the same time.
 */
export function createNotificationHost(ctx: Context, readOptions: () => NotificationHostOptions = () => ({ goalRounds: false, subagentWake: false, backgroundWake: false })): NotificationHost {
  const feed = createNotificationFeed()
  let turns = new WeakMap<Session, TurnState>()
  let sources = new WeakMap<Session, SourceState>()
  let goalNotices = new WeakMap<Session, GoalNotice>()
  let disposed = false
  const stateOf = (session: Session, turn: number) => {
    let state = turns.get(session)
    if (state?.turn !== undefined && state.turn > turn) return
    if (!state || state.turn !== turn) { state = { turn, terminal: false }; turns.set(session, state) }
    return state
  }
  const publish = (session: Session, value: Pick<NotificationEvent, 'kind' | 'reason'>): void => {
    if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) return
    feed.publish({ id: randomUUID(), sessionId: session.id, ...value })
  }
  /** Announce one goal outcome; terminal and its final round share one entry keyed by goal id. */
  const announceGoal = (session: Session, value: Pick<NotificationEvent, 'kind' | 'reason'>, goalId?: string, terminal = false): void => {
    const recent = goalNotices.get(session)
    const sameKind = recent?.kind === value.kind
    const sameGoal = goalId !== undefined && recent?.goalId === goalId
    const missingId = goalId === undefined || recent?.goalId === undefined
    const withinWindow = recent !== undefined && Date.now() - recent.at < GOAL_DEDUPE_MS
    // A terminal is authoritative: its final round is suppressed however late it settles.
    // Otherwise keep the short window so separate rounds of one goal still announce.
    if (recent !== undefined && sameKind && (sameGoal || missingId) && (withinWindow || recent.terminal)) return
    publish(session, value)
    goalNotices.set(session, { kind: value.kind, goalId, terminal, at: Date.now() })
  }
  const flushFailure = (session: Session) => {
    const state = turns.get(session)
    if (disposed || !state?.pendingError || state.terminal) return
    const reason = state.pendingError
    state.terminal = true
    delete state.pendingError
    publish(session, { kind: 'interrupted', reason })
  }
  const removers = [
    ctx.on('session/event', (session, event) => {
      if (disposed) return
      if (event.type === 'user/message') {
        const sourceValue = (event.data as { source?: unknown }).source
        const source = sourceOf(sourceValue)
        if (source === undefined) return // Injected context is not a turn trigger.
        const goalId = source === 'goal' ? (event.data as { source?: { goalId?: unknown } }).source?.goalId : undefined
        const current = sources.get(session)
        const weak = isWeakSource(sourceValue)
        // First real message identifies the turn's trigger; user work outranks the rest.
        // A weak tool-jobs notice sets a background trigger only if none is stronger yet.
        if (current === undefined || (current.source !== 'user' && source === 'user') || (current.weak && !weak)) {
          sources.set(session, { source, weak, goalId: typeof goalId === 'string' ? goalId : undefined, at: Date.now() })
        }
        return
      }
      // goal/change is a merge-extensible session event without a static type entry here.
      const eventType: string = event.type
      if (eventType === 'goal/change') {
        const data = (event as unknown as { data?: { operation?: unknown; goal?: { id?: unknown } } }).data
        const operation = data?.operation
        const goalId = typeof data?.goal?.id === 'string' ? data.goal.id : undefined
        if (operation === 'complete') announceGoal(session, { kind: 'completed' }, goalId, true)
        else if (operation === 'block') announceGoal(session, { kind: 'interrupted', reason: 'goal:block' }, goalId, true)
        return
      }
      if (event.type !== 'turn/start' && event.type !== 'turn/end') return
      if (event.type === 'turn/start') { sources.delete(session); return }
      const state = stateOf(session, event.data.turn)
      if (!state || state.terminal) return
      state.terminal = true
      delete state.pendingError
      const value = outcome(event.data.reason)
      if (!value) return
      const trigger = sources.get(session)
      const goalRound = trigger?.source === 'goal'
      // Failures always announce; goal failures share the terminal's dedupe entry.
      if (value.kind === 'interrupted') {
        if (goalRound) announceGoal(session, value, trigger.goalId)
        else publish(session, value)
        return
      }
      if (trigger === undefined || trigger.source === 'user') publish(session, value)
      else if (goalRound) { if (readOptions().goalRounds) announceGoal(session, value, trigger.goalId) }
      else if (trigger.source === 'subagent') { if (readOptions().subagentWake) publish(session, value) }
      else if (readOptions().backgroundWake) publish(session, value)
    }),
    ctx.on('agent/error', ({ agent, turn, error }) => {
      if (disposed) return
      const state = stateOf(agent.session, turn)
      if (!state || state.terminal) return
      state.pendingError ??= errorCode(error)
      if (agent.status === 'idle') flushFailure(agent.session)
    }),
    ctx.on('agent/status', ({ agent, status }) => {
      if (disposed) return
      if (status === 'running') turns.set(agent.session, { turn: undefined, terminal: false })
      else flushFailure(agent.session)
    }),
    ctx.on('agent/disposed', ({ agent }) => { turns.delete(agent.session); sources.delete(agent.session); goalNotices.delete(agent.session) }),
    ctx.on('session/disposed', session => { turns.delete(session); sources.delete(session); goalNotices.delete(session) }),
  ]
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const remove of removers) remove()
    turns = new WeakMap()
    sources = new WeakMap()
    goalNotices = new WeakMap()
    feed.dispose()
  }
  ctx.effect(() => dispose)
  return { observe: signal => feed.observe(signal), refresh: () => feed.refresh(), dispose }
}
