/** Register the generated Remote API of this package while the plugin stays active. */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TYPERT } from './generated/typert.host.js'

const contribution = TYPERT as TypertContribution

/**
 * Keep this package's Host contribution while the plugin is loaded.
 * @param ctx - plugin scope with the typert service injected.
 */
export function installRuntimeMetadata(ctx: Context): void {
  ctx.effect(() => {
    const withdraw = ctx.typert.register(contribution)
    return () => withdraw()
  }, 'dsh-notifications: metadata')
}
