/** Package-local CSS compilation; sheets enter the root plugin's reversible effect. */
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import type { TsdownPlugin } from 'tsdown'
const prefix = '\0cyaness-css:'
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const runtime = fileURLToPath(new URL('../src/client/styles.ts', import.meta.url))
/** @returns the package's CSS Modules compiler with no repository-relative inputs. */
export function cssModules(): TsdownPlugin {
  return { name: 'cyaness-css-modules',
    resolveId(source, importer) {
      if (source === '\0cyaness-style-runtime') return runtime
      if (!source.endsWith('.module.css')) return null
      return prefix + relative(packageRoot, resolve(importer === undefined ? packageRoot : dirname(importer), source)).replaceAll('\\', '/') + '.mjs'
    },
    async load(id) {
      if (!id.startsWith(prefix)) return null
      const path = resolve(packageRoot, id.slice(prefix.length, -4))
      this.addWatchFile(path)
      const { code, exports } = transform({ filename: relative(process.cwd(), path).replaceAll('\\', '/'), code: await readFile(path), cssModules: { pattern: '[hash]_[local]' }, minify: true })
      const classes = Object.fromEntries(Object.entries(exports ?? {}).map(([key, value]) => [key, value.name]))
      return 'import { registerStyle } from "\\0cyaness-style-runtime"; registerStyle(' + JSON.stringify(relative(process.cwd(), path).replaceAll('\\', '/')) + ',' + JSON.stringify(code.toString()) + '); export default ' + JSON.stringify(classes) + ';'
    },
  }
}
