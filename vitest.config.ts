/** Behavior tests against the declared DSH development dependencies. */
import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformDecorators } from './build/decorators.ts'

const require = createRequire(import.meta.url)
const stub = (name: string): string => fileURLToPath(new URL('./test/stubs/' + name, import.meta.url))
export default defineConfig({
  resolve: {
    alias: {
      react: dirname(require.resolve('react/package.json')),
      'react-dom': dirname(require.resolve('react-dom/package.json')),
      // 这两个官方客户端包的产物会顺带 import 一整套渲染依赖（shiki / katex / micromark / simple-icons …）。
      // 本包的测试只关心自己的接线与语义，用 test/stubs/ 里的替身代替，开发依赖因此不必跟着装那一套。
      '@deepseek-ai/dsh-client-ui-primitives': stub('ui-primitives.tsx'),
      '@deepseek-ai/dsh-client-store': stub('client-store.ts'),
    },
  },
  plugins: [{ name: 'standard-decorators', enforce: 'pre', transform: transformDecorators }],
  test: {
    include: ['test/**/*.spec.{ts,tsx}', 'test/**/*.test.ts'],
    pool: 'forks',
    execArgv: process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : [],
  },
  oxc: { jsx: { runtime: 'automatic' } },
})
