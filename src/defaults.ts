/** Factory values for the notification settings; the schema, the reader and the card's reset share them. */
import type { NotificationKind, NotificationPopupMode, NotificationRule } from './runtime/types.ts'

/** What every category delivers with until the user picks something else. */
export const DEFAULT_RULES: Record<NotificationKind, NotificationRule> = {
  completed: { enabled: true, sound: 'chime' },
  interrupted: { enabled: true, sound: 'alert' },
  question: { enabled: true, sound: 'soft' },
  approval: { enabled: true, sound: 'double' },
}

export const DEFAULT_VOLUME = 80
export const DEFAULT_SOUND_ENABLED = true
/** Turns the user starts announce by default; every automatic wake stays quiet. */
export const DEFAULT_USER_TURNS = true

/** A popup only makes sense on the channel that can raise one. */
export function defaultPopupMode(desktop: boolean): NotificationPopupMode {
  return desktop ? 'unfocused' : 'never'
}
