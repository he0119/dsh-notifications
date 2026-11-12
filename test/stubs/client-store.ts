/**
 * `@deepseek-ai/dsh-client-store` 的测试替身。
 *
 * 真实实现用的是 zustand + immer；本包只用到「一份不可变快照 + 订阅」这一件事，所以测试里换成这
 * 二十行，装依赖时就不必为了它拉进两个库。行为对齐真实实现的三点：`set` 换新对象、订阅者立刻收到
 * 通知、退订是幂等的。
 */
export interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  set(value: T): void
}

/** 造一份最小快照存储：`set` 直接替换快照，并按插入顺序通知订阅者。 */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    set(next: T) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
