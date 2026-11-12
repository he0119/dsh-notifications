/** Device-local notification audio, stored as IndexedDB Blobs rather than Host configuration. */
import type { NotificationKind } from '../../runtime/types.ts'

/** Lightweight file details suitable for the settings UI. */
export interface CustomSoundMetadata { readonly name: string; readonly type: string; readonly size: number }
/** One local sound with its persisted audio bytes. */
export interface CustomSoundAsset extends CustomSoundMetadata { readonly blob: Blob }
/** Failures the settings UI can translate without exposing database diagnostics. */
export type CustomSoundStoreErrorCode = 'unavailable' | 'closed' | 'empty' | 'too-large' | 'unsupported-type' | 'storage'
const messages: Record<CustomSoundStoreErrorCode, string> = {
  unavailable: 'Local audio storage is not available in this browser.', closed: 'Local audio storage is closed.',
  empty: 'Notification audio must not be empty.', 'too-large': 'Notification audio exceeds 5 MiB.',
  'unsupported-type': 'Choose an audio file.', storage: 'Local audio storage could not complete the operation.',
}
/** Classified local-storage failure; original diagnostics remain in cause. */
export class CustomSoundStoreError extends Error {
  constructor(readonly code: CustomSoundStoreErrorCode, cause?: unknown) {
    super(messages[code], { cause })
    this.name = 'CustomSoundStoreError'
  }
}
/** One component-owned connection; closing it preserves the device's saved sounds. */
export interface CustomSoundStore {
  get(kind: NotificationKind): Promise<CustomSoundAsset | undefined>
  set(kind: NotificationKind, file: File, validate?: (file: File) => Promise<void>): Promise<CustomSoundMetadata>
  remove(kind: NotificationKind): Promise<void>
  subscribe(listener: () => void): () => void
  close(): void
}

const DATABASE = 'dshNotifications.notifications'
const SOUNDS = 'sounds'

function soundRecord(value: unknown, kind: NotificationKind): CustomSoundAsset | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== kind
    || !('name' in value) || typeof value.name !== 'string' || !('type' in value) || typeof value.type !== 'string'
    || !('size' in value) || typeof value.size !== 'number' || !('blob' in value) || !(value.blob instanceof Blob)
    || value.size !== value.blob.size) throw new CustomSoundStoreError('storage')
  return { name: value.name, type: value.type, size: value.size, blob: value.blob }
}

/**
 * Create storage for the current origin and device, without reading any Host files.
 * @param factory - Native IndexedDB factory, or an isolated implementation for tests.
 * @returns A connection owned by the notification component; close it on component unload.
 */
export function createCustomSoundStore(factory?: IDBFactory): CustomSoundStore {
  let idb: IDBFactory | undefined
  try { idb = factory ?? globalThis.indexedDB } catch (cause) { throw new CustomSoundStoreError('unavailable', cause) }
  if (idb === undefined) throw new CustomSoundStoreError('unavailable')
  const databaseFactory = idb
  let closed = false
  let connection: IDBDatabase | undefined
  let opening: Promise<IDBDatabase> | undefined
  const listeners = new Set<() => void>()
  const assertOpen = (): void => { if (closed) throw new CustomSoundStoreError('closed') }
  const changed = (): void => {
    for (const listener of [...listeners]) {
      try { listener() } catch (error) { console.error('Custom sound change listener failed', error) }
    }
  }
  const close = (): void => { closed = true; connection?.close(); connection = undefined; listeners.clear() }
  const database = (): Promise<IDBDatabase> => {
    assertOpen()
    if (opening !== undefined) return opening
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      let abandoned = false
      const request = databaseFactory.open(DATABASE, 1)
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(SOUNDS)) request.result.createObjectStore(SOUNDS, { keyPath: 'kind' }) }
      request.onerror = () => { abandoned = true; reject(new CustomSoundStoreError('storage', request.error)) }
      request.onblocked = () => { abandoned = true; reject(new CustomSoundStoreError('storage')) }
      request.onsuccess = () => {
        const db = request.result
        if (closed || abandoned) { db.close(); reject(new CustomSoundStoreError(closed ? 'closed' : 'storage')); return }
        connection = db
        db.onversionchange = close
        db.onclose = () => { if (connection === db) { connection = undefined; opening = undefined } }
        resolve(db)
      }
    }).catch((cause: unknown) => {
      opening = undefined
      throw cause instanceof CustomSoundStoreError ? cause : new CustomSoundStoreError('storage', cause)
    })
    return opening
  }
  const transact = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await database()
    assertOpen()
    return new Promise<T>((resolve, reject) => {
      try {
        const transaction = db.transaction(SOUNDS, mode)
        const request = operation(transaction.objectStore(SOUNDS))
        transaction.oncomplete = () => resolve(request.result)
        transaction.onabort = () => reject(new CustomSoundStoreError('storage', transaction.error))
      } catch (cause) { reject(new CustomSoundStoreError('storage', cause)) }
    })
  }
  return {
    async get(kind) { const value: unknown = await transact('readonly', store => store.get(kind)); return soundRecord(value, kind) },
    async set(kind, file, validate) {
      assertOpen()
      if (file.size === 0) throw new CustomSoundStoreError('empty')
      if (file.size > 5 * 1024 * 1024) throw new CustomSoundStoreError('too-large')
      if (!file.type.toLowerCase().startsWith('audio/') && !/[.](mp3|wav|ogg|oga|m4a|aac|flac|opus|aif|aiff|webm)$/i.test(file.name)) throw new CustomSoundStoreError('unsupported-type')
      await validate?.(file)
      const metadata = { name: file.name.split(/[\\/]/).at(-1)!, type: file.type, size: file.size }
      const blob = new Blob([file], { type: file.type })
      await transact('readwrite', store => store.put({ kind, ...metadata, blob }))
      changed()
      return metadata
    },
    async remove(kind) { await transact('readwrite', store => store.delete(kind)); changed() },
    subscribe(listener) { assertOpen(); listeners.add(listener); return () => { listeners.delete(listener) } },
    close,
  }
}
