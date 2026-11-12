/** The published pair must load as-is, without a source transform. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

/** Modules the Host artifact may require at run time: the install environment resolves all of them. */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-typert-protocol/remote-info',
  '@deepseek-ai/dsh-typert-registry',
  'open',
  'zod',
]

/** Modules the browser module table provides; everything else must be inlined. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

it('loads the built Host entry with its declared exports', async () => {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { name: string }
  const entry = await import(pathToFileURL(resolve('lib/index.js')).href) as Record<string, unknown>
  expect(entry.name).toBe(pkg.name)
  expect(typeof entry.apply).toBe('function')
  expect(typeof entry.Config).toBe('function')
  expect(entry.inject).toEqual(['sessions', 'agents', 'typert', 'typertGateway', 'remoteAccess'])
})

it('imports only install-environment modules from the Host artifact', async () => {
  const source = await readFile(resolve('lib/index.js'), 'utf8')
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]!)
  for (const specifier of specifiers) {
    if (specifier.startsWith('node:')) continue
    expect(HOST_EXTERNALS, `unexpected Host import ${specifier}`).toContain(specifier)
  }
  // The generated codecs belong to this package, so they must be inlined rather than imported.
  expect(specifiers).not.toContain('./typert.host.js')
})

it('emits the browser artifact as one module-table script', async () => {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { name: string }
  const source = await readFile(resolve('lib/client.js'), 'utf8')
  expect(source.startsWith('window.__ModuleLoader__.load({')).toBe(true)
  expect(source).toContain(`id: ${JSON.stringify(pkg.name)}`)
  expect(/return module\.exports;\s*\}\s*\}\);\s*(\/\/# sourceMappingURL=[^\n]*)?\s*$/.test(source)).toBe(true)
  const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]!)
  for (const specifier of requires) expect(CLIENT_EXTERNALS, `non-baseline Client require ${specifier}`).toContain(specifier)
  expect(source).toContain('dshNotifications')
  expect(source).not.toContain('cyanessNotifications')
})
