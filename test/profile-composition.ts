/** Minimal native profile composition for this package's Loader integration fixture. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'

/**
 * Mount fixture rows through native profile patches.
 * @param ctx - initialized Loader with an explicit fixture module importer.
 * @param home - private fixture home.
 * @param baseFile - fixture's cordis YAML.
 * @returns writable native profile patch path.
 */
export async function profileComposition(ctx: Context, home: string, baseFile: string): Promise<string> {
  const dir = join(home, 'profile')
  initProfile(dir, ['test-profile-bundle'])
  const bundle = join(dir, 'node_modules', 'test-profile-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-profile-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const rows = parse(await readFile(baseFile, 'utf8')) as EntryOptions[]
  for (const row of rows) row.id ??= row.name.replace('@deepseek-ai/dsh-', '')
  await writeFile(join(bundle, 'cordis.patch.yml'), stringify([{ insert: rows }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-profile-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profile)
  ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(Settings)
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
  await ctx.loader.await()
  return profile.patchPath
}
