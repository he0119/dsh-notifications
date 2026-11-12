/**
 * 发布内容自检：把 `package.json` 的 `files` 白名单真的过一遍 npm 的打包规则。
 *
 * 核对三件只有发布那一刻才会暴露的事：
 * 1. 运行期文件一个都不少（`lib/index.js`、`lib/client.js`、`cordis.patch.yml`、语言文件、图标）；
 * 2. `main` / `exports` / `dsh.bundle.patch` / `icon` 指向的每个路径都在包里；
 * 3. `src/`、`test/`、`node_modules/` 没有被打进包。
 *
 * 外加一条跨文件不变式：`cordis.patch.yml` 里 insert 的 `name` 必须等于本包名。
 *
 * ⚠️ 必须在 `npm run build` 之后跑。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 用当前 node 直接跑 npm 自己的 JS 入口：不经过 PATH，也不起 shell。 */
function resolveNpmCli() {
  const nodeDir = dirname(process.execPath)
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const found = candidates.find(existsSync)
  assert.ok(found, `找不到 npm 的 JS 入口，试过：\n  ${candidates.join('\n  ')}`)
  return found
}

// 让 npm 的缓存与日志写进一次性临时目录，别碰用户真实的 ~/.npm。
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-notifications-check-'))
let packed
try {
  packed = spawnSync(
    process.execPath,
    [resolveNpmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_cache: sandbox,
        npm_config_logs_dir: join(sandbox, '_logs'),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
    },
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
assert.equal(packed.status, 0, `npm pack 失败：\n${packed.stderr || packed.error?.message}`)

const [manifest] = JSON.parse(packed.stdout)
const shipped = new Set(manifest.files.map(file => file.path))

// 1. 运行期文件：装进宿主之后真的会被读到的那些。
const REQUIRED = [
  'lib/index.js',
  'lib/client.js',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'docs/development.md',
]
for (const path of REQUIRED) assert.ok(shipped.has(path), `包里缺少运行期文件：${path}（跑过 build 了吗？）`)

// 2. 入口自洽：manifest 里指向的每个路径都必须真的在包里。
function collectPaths(value, out = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) out.push(value.slice(2))
  } else if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPaths(item, out)
  }
  return out
}
for (const path of collectPaths({ main: pkg.main, exports: pkg.exports, icon: pkg.icon, dsh: pkg.dsh?.bundle })) {
  if (path.includes('*')) {
    const pattern = new RegExp('^' + path.replaceAll('.', '\\.').replaceAll('*', '[^/]+') + '$')
    assert.ok([...shipped].some(file => pattern.test(file)), `导出通配条目没有匹配到任何文件：${path}`)
    continue
  }
  assert.ok(shipped.has(path), `manifest 指向的文件不在包里：${path}`)
}

// 3. 源码、测试与依赖不进包。
for (const file of shipped) {
  assert.ok(!file.startsWith('src/'), `源码被打进包了：${file}`)
  assert.ok(!file.startsWith('test/'), `测试被打进包了：${file}`)
  assert.ok(!file.startsWith('node_modules/'), `依赖被打进包了：${file}`)
}

// 4. patch 里的 name 必须等于包名，否则装进 profile 会「找不到模块」。
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const names = [...patch.matchAll(/^\s*name:\s*(.+)$/gm)].map(match => match[1].trim().replace(/^['"]|['"]$/g, ''))
assert.ok(names.length > 0, 'cordis.patch.yml 里没有 name 行')
for (const name of names) assert.equal(name, pkg.name, `cordis.patch.yml 的 name 与包名不一致：${name}`)

console.log(JSON.stringify({ package: pkg.name, version: pkg.version, files: shipped.size, checked: REQUIRED.length }))
