/**
 * 构建配置：Host 端沿用官方包的产物形状——源码打成一个 ESM `lib/index.js`，所有包依赖
 * 保持外部（Cordis、DSH 与普通 npm 依赖都由安装环境解析），本包自己的生成代码随源码内联。
 *
 * Web Client 端另外出一份 `lib/client.js`，遵守 DSH 客户端模块系统的经典脚本契约：
 * `window.__ModuleLoader__.load({ id, factory })` 报名，工厂拿同步的 `require` 只解析平台
 * 基线模块，其余一律内联进产物。
 */
import { readFileSync } from 'node:fs'

import { defineConfig, type UserConfig } from 'tsdown'

import { cssModules } from './build/css-modules.ts'
import { transformDecorators } from './build/decorators.ts'

const { name: PACKAGE } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string }

/** 标准装饰器（`@Remote`）在进入普通 JavaScript 之前先由 TypeScript 降级。 */
const decorators = { name: 'standard-decorators', transform: transformDecorators }

/** 浏览器模块表里由宿主提供、产物里保持 `require(...)` 的模块。 */
const CLIENT_BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

const host: UserConfig = {
  name: `${PACKAGE}/host`,
  entry: { index: 'src/index.ts' },
  tsconfig: 'tsconfig.json',
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: false,
  fixedExtension: false,
  // Host 与 Client 共用 lib/；完整构建由 package.json 的 prebuild 一次性清理。
  clean: false,
  plugins: [decorators],
  deps: { neverBundle: true },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

const client: UserConfig = {
  name: `${PACKAGE}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  fixedExtension: false,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_BASELINE],
    alwaysBundle: ['@deepseek-ai/dsh-typert-protocol/remote-info', 'zod'],
  },
  plugins: [cssModules(), decorators],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([host, client])
