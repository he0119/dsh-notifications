/** Bounded live notification delivery; new observers start after the current cursor. */
import { randomUUID } from 'node:crypto'
import type { NotificationEvent, NotificationFrame } from './runtime/types.ts'

const RING_LIMIT = 64

/** A single Host generation with no retained message history or per-reader event queue. */
export interface NotificationFeed {
  publish(event: NotificationEvent): void
  /** Wake readers to refresh preferences without adding an outcome or advancing its cursor. */
  refresh(): void
  observe(signal: AbortSignal): AsyncIterable<NotificationFrame>
  dispose(): void
}

/** Keep the latest 64 outcomes and coalesce slow readers onto that bounded ring. */
export function createNotificationFeed(): NotificationFeed {
  const epoch = randomUUID()
  const ring: { cursor: number; event: NotificationEvent }[] = []
  const waiting = new Set<() => void>()
  let cursor = 0
  let revision = 0
  let closed = false
  const wake = () => { for (const notify of [...waiting]) notify() }
  return {
    publish(event) {
      if (closed) return
      ring.push({ cursor: ++cursor, event })
      if (ring.length > RING_LIMIT) ring.shift()
      revision++
      wake()
    },
    refresh() {
      if (closed) return
      revision++
      wake()
    },
    async *observe(signal) {
      if (closed || signal.aborted) return
      let seen = cursor
      let seenRevision = revision
      yield { epoch, cursor: seen, baseline: true, events: [] }
      while (!closed && !signal.aborted) {
        if (revision > seenRevision) {
          const events = ring.filter(row => row.cursor > seen).map(row => row.event)
          seen = cursor
          seenRevision = revision
          yield { epoch, cursor: seen, baseline: false, events }
          continue
        }
        await new Promise<void>(resolve => {
          const notify = () => { waiting.delete(notify); signal.removeEventListener('abort', notify); resolve() }
          waiting.add(notify)
          signal.addEventListener('abort', notify, { once: true })
          if (closed || signal.aborted || revision > seenRevision) notify()
        })
      }
    },
    dispose() {
      if (closed) return
      closed = true
      ring.length = 0
      wake()
    },
  }
}
