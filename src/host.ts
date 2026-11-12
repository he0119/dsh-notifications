/** Live committed outcomes and terminal failures without retaining Session histories. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { NotificationEvent, NotificationReaders } from './runtime/types.ts'
import { createNotificationFeed } from './feed.ts'

/** Observable notification owner; disposal closes all outstanding readers. */
export interface NotificationHost extends NotificationReaders {
  /** Refresh accepted delivery preferences without publishing another outcome. */
  refresh(): void
  dispose(): void
}
interface TurnState { readonly turn: number | undefined; terminal: boolean; pendingError?: string }

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

/** Subscribe to post-commit ends and terminal idle failures; never infer success from idle. */
export function createNotificationHost(ctx: Context): NotificationHost {
  const feed = createNotificationFeed()
  let turns = new WeakMap<Session, TurnState>()
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
      if (disposed || (event.type !== 'turn/start' && event.type !== 'turn/end')) return
      const state = stateOf(session, event.data.turn)
      if (!state || event.type === 'turn/start' || state.terminal) return
      state.terminal = true
      delete state.pendingError
      const value = outcome(event.data.reason)
      if (value) publish(session, value)
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
    ctx.on('agent/disposed', ({ agent }) => { turns.delete(agent.session) }),
    ctx.on('session/disposed', session => { turns.delete(session) }),
  ]
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const remove of removers) remove()
    turns = new WeakMap()
    feed.dispose()
  }
  ctx.effect(() => dispose)
  return { observe: signal => feed.observe(signal), refresh: () => feed.refresh(), dispose }
}
