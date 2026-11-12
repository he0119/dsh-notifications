/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import { createSoundPlayer } from '../src/client/logic/sounds.ts'

class ContextFixture {
  static instances: ContextFixture[] = []
  state: AudioContextState = 'running'
  currentTime = 4
  destination = {}
  frequencies: number[] = []
  stops: number[] = []
  peaks: number[] = []
  resume = vi.fn(async () => { this.state = 'running' })
  close = vi.fn(async () => { this.state = 'closed' })
  constructor() { ContextFixture.instances.push(this) }
  createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: (value: number) => this.peaks.push(value), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() } }
  createOscillator() { return { type: '', frequency: { setValueAtTime: (value: number) => this.frequencies.push(value) }, connect: vi.fn(), disconnect: vi.fn(), onended: null, start: vi.fn(), stop: (at: number) => this.stops.push(at) } }
}
afterEach(() => { vi.unstubAllGlobals(); ContextFixture.instances = [] })
it('synthesizes four distinct short tones and keeps none silent', async () => {
  vi.stubGlobal('AudioContext', ContextFixture)
  const player = createSoundPlayer(vi.fn())
  expect(player.play('none')).toBe(false)
  expect(ContextFixture.instances).toHaveLength(0)
  const tones = []
  for (const sound of ['soft', 'double', 'chime', 'alert'] as const) {
    expect(player.play(sound)).toBe(true)
    const ctx = ContextFixture.instances[0]!
    tones.push(ctx.frequencies.splice(0))
    expect(ctx.resume).not.toHaveBeenCalled()
  }
  expect(new Set(tones.map(tone => JSON.stringify(tone))).size).toBe(4)
  expect(tones.map(tone => tone.length)).toEqual([1, 2, 2, 3])
  await player.dispose()
  expect(ContextFixture.instances[0]!.close).toHaveBeenCalledOnce()
})
it('resumes only on explicit preview and rechecks permission to play after construction', async () => {
  class Suspended extends ContextFixture { state: AudioContextState = 'suspended' }
  vi.stubGlobal('AudioContext', Suspended)
  const state = vi.fn()
  const player = createSoundPlayer(state)
  expect(player.play('soft')).toBe(false)
  expect(ContextFixture.instances[0]!.resume).not.toHaveBeenCalled()
  expect(state).toHaveBeenLastCalledWith('blocked')
  expect(await player.preview('chime')).toBe(true)
  expect(ContextFixture.instances[0]!.resume).toHaveBeenCalledOnce()
  expect(player.play('alert', () => false)).toBe(false)
  await player.dispose()
  expect(player.play('soft')).toBe(false)
})

it('scales the audio gain to the requested volume while zero remains silent', async () => {
  vi.stubGlobal('AudioContext', ContextFixture)
  const player = createSoundPlayer(vi.fn())
  expect(player.play('soft', () => true, 0)).toBe(false)
  expect(ContextFixture.instances).toHaveLength(0)
  expect(player.play('soft', () => true, 80)).toBe(true)
  const audio = ContextFixture.instances[0]!
  expect(audio.peaks.at(-1)).toBeCloseTo(.52)
  expect(player.play('soft', () => true, 100)).toBe(true)
  expect(audio.peaks.at(-1)).toBeCloseTo(.65)
  expect(await player.preview('chime', 25)).toBe(true)
  expect(audio.peaks.slice(-2)).toEqual([.1625, .1625])
  await player.dispose()
})

it('plays a validated custom clip for its own category with an eight-second cap and fade', async () => {
  const sources: { buffer: { duration: number } | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = []
  class CustomContext extends ContextFixture {
    decodeAudioData = vi.fn(async () => ({ duration: 20, numberOfChannels: 1, sampleRate: 48000, length: 960000, getChannelData: () => new Float32Array(960000) }))
    createBuffer(channels: number, length: number, sampleRate: number) { return { duration: length / sampleRate, numberOfChannels: channels, sampleRate, length, copyToChannel: vi.fn() } }
    createBufferSource() { const source = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), onended: null, start: vi.fn(), stop: vi.fn() }; sources.push(source); return source }
  }
  vi.stubGlobal('AudioContext', CustomContext)
  const file = new Blob([new Uint8Array([1, 2])], { type: 'audio/wav' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(2) })
  const get = vi.fn(async () => ({ name: 'notice.wav', type: 'audio/wav', size: file.size, blob: file }))
  const player = createSoundPlayer(vi.fn(), { get })
  expect(await player.play('custom', () => true, 80, 'approval')).toBe(true)
  expect(get).toHaveBeenCalledWith('approval')
  expect(sources[0]!.buffer!.duration).toBe(8)
  expect(sources[0]!.start).toHaveBeenCalledWith(4, 0, 8)
  expect(sources[0]!.stop).toHaveBeenCalledWith(12)
  expect(ContextFixture.instances[0]!.peaks).toContain(.52)
  expect(ContextFixture.instances[0]!.peaks.at(-1)).toBe(.0001)
  await player.dispose()
})
