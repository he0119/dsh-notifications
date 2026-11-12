/** Generate this package's native codecs from its own Remote service, without the Harness checkout. */
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const runtimeDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(runtimeDirectory, '../..')

/**
 * Analyze only the public read-only API in an isolated, native generator workspace.
 * @param options - optional output directory.
 * @returns the four generated artifact paths.
 */
export async function generateRuntimeArtifacts({ outputDirectory = join(runtimeDirectory, 'generated') } = {}) {
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  const stage = await mkdtemp(join(runtimeDirectory, '.generate-'))
  try {
    const project = join(stage, 'packages/runtime')
    await mkdir(join(project, 'src'), { recursive: true })
    await copyFile(join(runtimeDirectory, 'index.ts'), join(project, 'src/index.ts'))
    await copyFile(join(runtimeDirectory, 'types.ts'), join(project, 'src/types.ts'))
    await writeFile(join(project, 'package.json'), JSON.stringify({
      name: manifest.name,
      type: 'module',
      // The analyzer validates the package's declared codec subpaths before emitting them.
      exports: {
        '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
        './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
        './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
        './runtime/types': './src/types.ts',
      },
      files: ['lib/index.js', 'lib/index.d.ts', 'lib/typert.host.js', 'lib/typert.host.d.ts', 'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts', 'lib/typert.remote-client.d.ts.map'],
    }))
    // The native analyzer recognizes protocol symbols by their registered package ownership.
    const require = createRequire(import.meta.url)
    const protocolRoot = dirname(require.resolve('@deepseek-ai/dsh-typert-protocol/package.json'))
    const protocol = join(stage, 'packages/protocol')
    await mkdir(protocol, { recursive: true })
    await cp(join(protocolRoot, 'lib/types'), join(protocol, 'src'), { recursive: true, filter: file => !file.endsWith('.js') && !file.endsWith('.map') })
    await writeFile(join(protocol, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', type: 'module', exports: { '.': './src/index.d.ts' } }))
    const compilerOptions = {
      paths: { '@deepseek-ai/dsh-typert-protocol': [join(protocol, 'src/index.d.ts')] },
      target: 'ES2024', lib: ['ES2024', 'ESNext.Disposable', 'DOM'], types: [], module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true,
    }
    await writeFile(join(stage, 'tsconfig.host.json'), JSON.stringify({ compilerOptions, files: [], references: [{ path: './packages/runtime' }, { path: './packages/protocol' }] }))
    await writeFile(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src/**/*.ts'] }))
    await writeFile(join(protocol, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src/**/*.d.ts'] }))
    const artifacts = new WorkspaceTypertGenerator(stage).generate([manifest.name], ['host'])
    const artifact = artifacts.find(item => item.face === 'host')
    if (!artifact?.remote) throw new Error('@he0119/dsh-notifications: native runtime generation produced no Remote API')
    const files = [
      ['typert.host.js', artifact.js], ['typert.host.d.ts', artifact.dts],
      ['typert.remote-client.js', artifact.remote.js], ['typert.remote-client.d.ts', artifact.remote.dts],
    ]
    await mkdir(outputDirectory, { recursive: true })
    for (const [name, content] of files) await writeFile(join(outputDirectory, name), content.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'))
    return files.map(([name]) => join(outputDirectory, name))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const files = await generateRuntimeArtifacts()
  console.log('Generated native runtime codecs: ' + files.length + ' files')
}
