/** Browser-native notification tones and bounded device-local custom clips. */
import type { NotificationKind, NotificationSound } from '../../runtime/types.ts'
import type { CustomSoundStore } from './custom-sounds.ts'

export type SoundState = 'unsupported' | 'unknown' | 'ready' | 'blocked'
export class CustomAudioDecodeError extends Error { constructor(cause?: unknown) { super('The selected audio could not be decoded.', { cause }); this.name = 'CustomAudioDecodeError' } }
export interface SoundPlayer {
  play(sound: NotificationSound, allowed?: () => boolean, volume?: number, kind?: NotificationKind): boolean | Promise<boolean>
  preview(sound: NotificationSound, volume?: number, kind?: NotificationKind): Promise<boolean>
  validate(file: File): Promise<void>
  invalidateCustom(): void
  dispose(): Promise<void>
}
type BuiltIn = Exclude<NotificationSound, 'none' | 'custom'>
const fallback: Record<NotificationKind, BuiltIn> = { completed: 'chime', interrupted: 'alert', question: 'soft', approval: 'double' }
const tones: Record<BuiltIn, readonly (readonly [number, number, number])[]> = {
  soft: [[660, 0, .12]], double: [[880, 0, .08], [880, .14, .08]],
  chime: [[659, 0, .1], [880, .13, .16]], alert: [[440, 0, .12], [330, .16, .14], [440, .34, .16]],
}
/** Own one AudioContext and at most four decoded clips. Automatic playback never resumes it. */
export function createSoundPlayer(onState: (state: SoundState) => void, custom?: Pick<CustomSoundStore, 'get'>): SoundPlayer {
  let context: AudioContext | undefined
  let disposed = false, customRevision = 0
  const active = new Set<AudioScheduledSourceNode>()
  const clips = new Map<NotificationKind, Promise<AudioBuffer | undefined>>()
  const get = (): AudioContext | undefined => {
    if (disposed) return undefined
    if (typeof AudioContext === 'undefined') { onState('unsupported'); return undefined }
    try { return context ??= new AudioContext() } catch (_unavailableAudio) { onState('blocked'); return undefined }
  }
  const own = (node: AudioScheduledSourceNode, gain: GainNode): void => {
    node.connect(gain); gain.connect(context!.destination); active.add(node)
    node.onended = () => { active.delete(node); node.disconnect(); gain.disconnect() }
  }
  const synthesize = (audio: AudioContext, sound: BuiltIn, peak: number): boolean => {
    try {
      for (const [frequency, offset, duration] of tones[sound]) {
        const oscillator = audio.createOscillator(), gain = audio.createGain(), start = audio.currentTime + offset
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, start)
        gain.gain.setValueAtTime(.0001, start); gain.gain.linearRampToValueAtTime(peak, start + .01); gain.gain.exponentialRampToValueAtTime(.0001, start + duration)
        own(oscillator, gain); oscillator.start(start); oscillator.stop(start + duration + .02)
      }
      onState('ready'); return true
    } catch (_audioFailure) { onState('blocked'); return false }
  }
  const customClip = (audio: AudioContext, kind: NotificationKind): Promise<AudioBuffer | undefined> => {
    const cached = clips.get(kind)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const asset = await custom?.get(kind)
      if (asset === undefined || disposed) return undefined
      const decoded = await audio.decodeAudioData(await asset.blob.arrayBuffer())
      if (disposed) return undefined
      if (decoded.duration <= 8) return decoded
      const length = Math.min(decoded.length, Math.floor(decoded.sampleRate * 8))
      const shortened = audio.createBuffer(decoded.numberOfChannels, length, decoded.sampleRate)
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) shortened.copyToChannel(decoded.getChannelData(channel).subarray(0, length), channel)
      return shortened
    })()
    clips.set(kind, pending)
    void pending.catch(() => { if (clips.get(kind) === pending) clips.delete(kind) })
    return pending
  }
  const play = (sound: NotificationSound, allowed: () => boolean = () => true, volume = 80, kind: NotificationKind = 'completed'): boolean | Promise<boolean> => {
    const peak = .65 * Math.max(0, Math.min(100, volume)) / 100
    if (disposed || sound === 'none' || peak === 0 || !allowed()) return false
    const audio = get()
    if (audio === undefined) return false
    if (audio.state !== 'running') { onState('blocked'); return false }
    if (!allowed()) return false
    if (sound !== 'custom') return synthesize(audio, sound, peak)
    const revision = customRevision
    return (async () => {
      let clip: AudioBuffer | undefined
      try { clip = await customClip(audio, kind) } catch (_customUnavailable) { /* This category retains its built-in fallback. */ }
      if (disposed || revision !== customRevision || !allowed()) return false
      if (clip === undefined) return synthesize(audio, fallback[kind], peak)
      try {
        const node = audio.createBufferSource(), gain = audio.createGain(), duration = Math.min(8, clip.duration), start = audio.currentTime
        if (duration <= 0) return false
        node.buffer = clip
        const attack = Math.min(.01, duration / 4), fade = Math.max(attack, duration - .06)
        gain.gain.setValueAtTime(.0001, start); gain.gain.linearRampToValueAtTime(peak, start + attack); gain.gain.setValueAtTime(peak, start + fade); gain.gain.linearRampToValueAtTime(.0001, start + duration)
        own(node, gain); node.start(start, 0, duration); node.stop(start + duration); onState('ready'); return true
      } catch (_customPlaybackFailure) { onState('blocked'); return false }
    })()
  }
  return {
    play,
    async preview(sound, volume = 80, kind = 'completed') {
      if (sound === 'none' || volume <= 0 || disposed) return false
      const audio = get()
      if (audio === undefined) return false
      try { if (audio.state !== 'running') await audio.resume() } catch (_activationDenied) { onState('blocked'); return false }
      return play(sound, () => true, volume, kind)
    },
    async validate(file) {
      const audio = get()
      if (audio === undefined || disposed) throw new CustomAudioDecodeError()
      try { const decoded = await audio.decodeAudioData(await file.arrayBuffer()); if (decoded.length === 0 || decoded.duration <= 0) throw new CustomAudioDecodeError() }
      catch (cause) { throw cause instanceof CustomAudioDecodeError ? cause : new CustomAudioDecodeError(cause) }
    },
    invalidateCustom() { customRevision++; clips.clear() },
    async dispose() {
      if (disposed) return
      disposed = true; customRevision++; clips.clear()
      for (const node of active) { node.onended = null; node.disconnect() }
      active.clear()
      if (context !== undefined && context.state !== 'closed') await context.close()
    },
  }
}
