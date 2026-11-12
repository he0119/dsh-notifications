/** Behavior tests against the declared DSH development dependencies. */
import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { transformDecorators } from './build/decorators.ts'

const require = createRequire(import.meta.url)
export default defineConfig({
  resolve: { alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) } },
  plugins: [{ name: 'standard-decorators', enforce: 'pre', transform: transformDecorators }],
  test: {
    include: ['test/**/*.spec.{ts,tsx}', 'test/**/*.test.ts'],
    pool: 'forks',
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
    execArgv: process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : [],
  },
  oxc: { jsx: { runtime: 'automatic' } },
})
