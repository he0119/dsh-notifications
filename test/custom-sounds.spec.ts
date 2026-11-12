/** IndexedDB persistence of device-local notification audio. */
import { afterEach, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { createCustomSoundStore, type CustomSoundStore } from '../src/client/logic/custom-sounds.ts'

const stores: CustomSoundStore[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const store of stores.splice(0)) store.close() })
function store(factory: IDBFactory): CustomSoundStore {
  const value = createCustomSoundStore(factory)
  stores.push(value)
  return value
}

it('persists Blob bytes and lightweight metadata across a closed and reopened store', async () => {
  const factory = new IDBFactory()
  const first = store(factory)
  const file = new File([new Uint8Array([1, 2, 3, 4])], 'finished.mp3', { type: 'audio/mpeg' })
  await expect(first.set('completed', file)).resolves.toEqual({ name: 'finished.mp3', type: 'audio/mpeg', size: 4 })
  first.close()
  const saved = await store(factory).get('completed')
  expect(saved).toMatchObject({ name: 'finished.mp3', type: 'audio/mpeg', size: 4 })
  expect(saved!.blob).toBeInstanceOf(Blob)
  expect(new Uint8Array(await saved!.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
})

it.each([
  { name: 'empty', file: () => new File([], 'empty.wav', { type: 'audio/wav' }), code: 'empty' },
  { name: 'over 5 MiB', file: () => new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.wav', { type: 'audio/wav' }), code: 'too-large' },
  { name: 'not audio', file: () => new File(['text'], 'note.txt', { type: 'text/plain' }), code: 'unsupported-type' },
])('rejects $name without replacing the saved audio', async ({ file, code }) => {
  const saved = store(new IDBFactory())
  await saved.set('approval', new File(['original'], 'original.mp3', { type: 'audio/mpeg' }))
  await expect(saved.set('approval', file())).rejects.toMatchObject({ code })
  const original = await saved.get('approval')
  expect(original!.name).toBe('original.mp3')
  expect(await original!.blob.text()).toBe('original')
})

it('keeps four categories independent while replacing and removing one category', async () => {
  const saved = store(new IDBFactory())
  const kinds = ['completed', 'interrupted', 'question', 'approval'] as const
  for (const kind of kinds) await saved.set(kind, new File([kind], kind + '.wav', { type: 'audio/wav' }))
  await saved.set('question', new File(['replacement'], 'replacement.wav', { type: 'audio/wav' }))
  for (const kind of kinds) expect(await (await saved.get(kind))!.blob.text()).toBe(kind === 'question' ? 'replacement' : kind)
  await saved.remove('question')
  expect(await saved.get('question')).toBeUndefined()
  expect(await (await saved.get('approval'))!.blob.text()).toBe('approval')
  await expect(saved.remove('question')).resolves.toBeUndefined()
})

it('accepts the inclusive 5 MiB boundary and audio MIME without an extension', async () => {
  const saved = store(new IDBFactory())
  const file = new File([new Uint8Array(5 * 1024 * 1024)], 'tone', { type: 'audio/wav' })
  await expect(saved.set('completed', file)).resolves.toMatchObject({ size: 5 * 1024 * 1024 })
})

it('accepts an audio extension with no MIME and stores only the filename', async () => {
  const saved = store(new IDBFactory())
  await saved.set('question', new File(['audio'], 'C:\\private\\chosen.WAV'))
  const asset = await saved.get('question')
  expect(asset).toMatchObject({ name: 'chosen.WAV', type: '', size: 5 })
  expect(asset!.blob).not.toBeInstanceOf(File)
})

it('does not overwrite prior bytes or emit changes when decoding rejects the replacement', async () => {
  const saved = store(new IDBFactory())
  await saved.set('interrupted', new File(['original'], 'original.wav', { type: 'audio/wav' }))
  const changed = vi.fn()
  saved.subscribe(changed)
  const error = new Error('Audio decoding failed')
  await expect(saved.set('interrupted', new File(['replacement'], 'replacement.wav', { type: 'audio/wav' }), async () => { throw error })).rejects.toBe(error)
  expect(await (await saved.get('interrupted'))!.blob.text()).toBe('original')
  expect(changed).not.toHaveBeenCalled()
})

it('publishes completed saves and removals and permits a subscriber to detach', async () => {
  const saved = store(new IDBFactory())
  const changed = vi.fn()
  const stop = saved.subscribe(changed)
  await saved.set('approval', new File(['audio'], 'tone.wav', { type: 'audio/wav' }))
  expect(changed).toHaveBeenCalledTimes(1)
  await saved.remove('approval')
  expect(changed).toHaveBeenCalledTimes(2)
  stop()
  await saved.set('approval', new File(['audio'], 'next.wav', { type: 'audio/wav' }))
  expect(changed).toHaveBeenCalledTimes(2)
})

it('reports missing IndexedDB instead of pretending to save locally', () => {
  vi.stubGlobal('indexedDB', undefined)
  expect(() => createCustomSoundStore()).toThrowError(expect.objectContaining({ code: 'unavailable' }))
})

it('rejects operations after close while preserving the stored file for another instance', async () => {
  const factory = new IDBFactory()
  const first = store(factory)
  const file = new File(['audio'], 'saved.wav', { type: 'audio/wav' })
  await first.set('completed', file)
  first.close()
  first.close()
  await expect(first.get('completed')).rejects.toMatchObject({ code: 'closed' })
  await expect(first.set('completed', file)).rejects.toMatchObject({ code: 'closed' })
  await expect(first.remove('completed')).rejects.toMatchObject({ code: 'closed' })
  expect(() => first.subscribe(() => {})).toThrowError(expect.objectContaining({ code: 'closed' }))
  expect(await (await store(factory).get('completed'))!.blob.text()).toBe('audio')
})

it('does not commit a replacement if the component closes while decoding', async () => {
  const factory = new IDBFactory()
  const first = store(factory)
  await first.set('question', new File(['original'], 'original.wav', { type: 'audio/wav' }))
  const decoding = Promise.withResolvers<void>()
  const pending = first.set('question', new File(['replacement'], 'new.wav', { type: 'audio/wav' }), () => decoding.promise)
  first.close()
  decoding.resolve()
  await expect(pending).rejects.toMatchObject({ code: 'closed' })
  expect(await (await store(factory).get('question'))!.blob.text()).toBe('original')
})

it('reports a transaction abort after request success without replacing old bytes or publishing success', async () => {
  const saved = store(new IDBFactory())
  await saved.set('approval', new File(['original'], 'original.wav', { type: 'audio/wav' }))
  const changed = vi.fn()
  saved.subscribe(changed)
  const put = FakeObjectStore.prototype.put
  const abort = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = key === undefined ? put.call(this, value) : put.call(this, value, key)
    request.addEventListener('success', () => this.transaction.abort(), { once: true })
    return request
  })
  await expect(saved.set('approval', new File(['replacement'], 'new.wav', { type: 'audio/wav' }))).rejects.toMatchObject({ code: 'storage' })
  abort.mockRestore()
  expect(await (await saved.get('approval'))!.blob.text()).toBe('original')
  expect(changed).not.toHaveBeenCalled()
})
