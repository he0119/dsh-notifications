# 通知插件：开发与发布

这份文档写给要改这个插件的人。想装来用，看 [README](../README.md)；提交前的验证清单、提交信息
口径与改一次就会静默坏掉的硬约束在根 [AGENTS.md](../AGENTS.md)。

## 环境

- Node 22.19 或更新（仓库在 Node 24 上开发）。
- 依赖用 **pnpm** 安装（`packageManager` 固定版本，锁文件是 `pnpm-lock.yaml`）；发布到 npm 用的是 npm 自己的 CLI。
- 开发时对照的 DSH 版本是 **0.2.2-rc.2**（`package.json` 的 `devDependencies` 全是这个版本）。
- 对外声明的版本要求与 dsh-session-manager 一致：`engines.dsh` 与所有 `@deepseek-ai/dsh*` 的 peer 区间都写
  `^0.2.0-rc.1`。DSH 用**自己的版本**判断兼容，并且让预发布版参与区间匹配，所以 0.2.x 的 rc 与正式版都算满足；
  `engines.dsh` 存在时 peer 区间不参与兼容判断，只影响 npm 的安装提示。

## 常用命令

```sh
pnpm install          # 按 pnpm-lock.yaml 装依赖
pnpm run generate     # 生成 Host 与浏览器的接口编解码文件（src/runtime/generated/）
pnpm run typecheck    # 先生成，再分别检查宿主端与浏览器端的类型
pnpm run build        # 生成 + 打出 lib/index.js 与 lib/client.js
pnpm test             # 先生成与构建，再跑 test/ 下的测试
pnpm run check:package # 用 npm 自己的打包规则核对发布内容（要先 build）
pnpm run pack:release # 构建并打包到 artifacts/
```

### 测试里的两个替身，以及为什么还要留 zustand / immer

`test/stubs/` 里放着两个官方客户端包的替身，`vitest.config.ts` 用 `resolve.alias` 换上去：

- `ui-primitives.tsx`：官方控件库的产物会顺带 import 一整套渲染依赖（shiki、katex、micromark、
  simple-icons、clsx、anser、diff……），而它们没在该包的 `package.json` 里声明。本包的测试只用其中
  四个入口（按钮、勾选框、设置表单外框、关掉最上层弹窗），替身按**语义**实现：可访问名字、禁用状态、
  勾选与点击照真实控件走，外观不参与断言。于是那二十来个渲染依赖不必进本仓库的开发依赖。
- `client-store.ts`：真实实现基于 zustand + immer；本包只用到「不可变快照 + 订阅」，替身是二十来行。

`zustand` 与 `immer` 仍然留在 devDependencies：`test/client.spec.ts` 里有一组用例会把**真实的**
原生客户端包（`dsh-client-ui-session`、`dsh-client-ui-workspace`、`dsh-api-session-controller`）跑起来，
它们各自 require 真实的 `dsh-client-store`，alias 管不到那条路径。

`dsh-app-boot`、`dsh-config-editor`、`dsh-settings`、`dsh-llm`、`cordis-plugin-include` 也是同理：
测试直接 import 它们（挂一个最小的宿主 profile、驱动一次真实的 agent 回合），所以要显式声明。

### 依赖安装的三条设置

`pnpm-workspace.yaml` 里那几项不是可选项，改错一处就会在本机或 CI 上装不上：

- `nodeLinker: hoisted`：pnpm 默认的 isolated 布局只把直接依赖链到 `node_modules` 根下，测试里
  间接用到的包（例如 `@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis-plugin-include`）就解析不到，
  报 `Cannot find package`。hoisted 还原成与 npm 一样的扁平真实目录。
  注意键名是**驼峰**：写成 kebab 的 `node-linker` 会被 pnpm 11 静默忽略，布局仍然是 isolated。
- `allowBuilds: koffi: true`：pnpm 默认拦住带安装脚本的依赖，命中时连 `pnpm run` 的依赖检查都会失败。
  koffi 是 `@deepseek-ai/dsh-fs-local` 的原生绑定，随测试用的 DSH 开发依赖带进来；本包不 import 它，
  但安装过程得过这一关。
- `minimumReleaseAgeExclude`：pnpm 11 默认不让发布不满 24 小时的版本进入安装结果，`--frozen-lockfile`
  也会逐条验。本包跟着 DSH 的 `0.2.2-rc.2` 这一代走，而它发布当天就得装上，所以那一代每条都按版本
  精确放行；过了 24 小时窗口，整段可以删掉。

`src/runtime/generated/` 和 `lib/` 都是产物，已在 `.gitignore` 里。`generate` 会调用 `@deepseek-ai/dsh-typert-generator`，用本包的包名分析 `src/runtime/index.ts` 里的 `@Remote` 方法，生成宿主要用的一份、浏览器用的一份。

## 代码结构

这个包只做通知一件事，所以没有按功能分目录：宿主端（跑在 DSH 进程里）的文件直接放在 `src/` 下，
浏览器端的文件全部收在 `src/client/` 里，两边的边界与两个 tsconfig 的 include / exclude 是同一条线。

| 位置 | 作用 |
| --- | --- |
| `src/index.ts` | 宿主入口（薄）：装接口编解码、挂 Worker 路由、造桌面弹窗投递器，启动 `Notifications` 服务 |
| `src/config.ts` | 插件配置 schema（名字必须导出为 `Config`，插件管理器靠它生成表单）与读配置的函数 |
| `src/constants.ts` | 宿主入口、浏览器端与测试共用的标识：包名、语言命名空间、配置命名空间 |
| `src/host.ts` | 宿主事件源：从会话状态折出「完成 / 中止 / 待答复 / 待审批」四类事件 |
| `src/feed.ts` | 事件队列：给每个订阅者发带代次与游标的快照，断线重来不漏也不重 |
| `src/desktop-host.ts` | 桌面弹窗投递器：哪个窗口（owner）能弹、点开通知后交给谁 |
| `src/activation.ts` | 点通知回到桌面版 DSH：Windows 走协议，其余平台走 `dsh://` 链接 |
| `src/windows/carrier.ts` | Windows 原生通知载体：装协议处理器、起本地 HTTP 端点、弹出与关闭 |
| `src/windows/launcher.ts` | 协议处理器那个小程序（`activate.exe`）的源码与校验 |
| `src/windows/scripts.ts` | PowerShell 与注册表脚本，以及协议名、注册表键等常量 |
| `src/service-worker.ts` | Service Worker 脚本正文与路径常量：宿主挂路由、浏览器注册都读这一份 |
| `src/web.ts` | 宿主把 Service Worker 挂在 `/dsh-notifications/sw.js` |
| `src/runtime/index.ts` | `@Remote` 方法：`events`、`activateDesktop`、`showDesktop`、`closeDesktop`、`acknowledgeDesktop`、`desktopEvents` |
| `src/runtime/types.ts` | 宿主与浏览器之间传的数据（不含消息历史，也不含错误详情） |
| `src/client/index.ts` | 浏览器入口（薄）：装样式、挂载本包的接口、注册插件页里那张配置卡 |
| `src/client/notifications.ts` | 浏览器端的通知本体：订阅事件流，按四类偏好决定弹窗与提示音 |
| `src/client/logic/` | 不碰 React 的逻辑：投递、声音、自定义音频存储、文案与字典、偏好归一、桌面通道、Service Worker 客户端 |
| `src/client/components/` | 插件页里的配置卡 `NotificationsSettings.tsx`（槽位 `plugins.bundle.config`，按包名作键）与两份 CSS Modules |
| `test/` | 通知行为与打包契约的测试，一条行为一个文件 |

`src/runtime/generated/` 是生成物（见上一节），不要手改。`src/windows/` 是唯一按操作系统分的目录，
判据是「还有谁实现同一个接口」：现在只有 Windows 一家，其余平台走浏览器通知，所以 `src/activation.ts`
（点通知回到桌面这个动作，不分系统）留在 `src/` 下。将来加 macOS / Linux 的原生载体，就在 `src/windows/`
旁边放同级实现，不要另起 `src/platform/`——DSH 里的 `platform` 指客户端平台 `web`。

宿主端与浏览器端分别由 `tsconfig.json` / `tsconfig.client.json` 检查：浏览器那半要 DOM 和 JSX，
宿主那半不该出现 `window` 或 `document`。两个工程的分界线就是 `src/client/`——它以外的一切都按宿主端检查。

## 与 Cyaness Tools 内置通知的关系

这个包是从 Cyaness Tools（`dsh-cyaness-tool`）的通知组件拆出来的，代码逻辑一致，但**标识符全部独立**：插件行 id 是 `dsh-notifications`（包名 `@he0119/dsh-notifications` 只用于 npm 与客户端模块 id），接口命名空间是 `dshNotifications`，Worker 路径、Windows 协议与助手目录、IndexedDB 库名也各自一份。两边的数据与注册互相不覆盖。

代价是：如果同一个人同时启用两边的通知，两边都会响、都会弹。用哪个就只启用哪个。

## 发布

本地打包试用、改版本号打标签、推标签之后工作流做什么、npm 那边要先配什么，都在
[releasing.md](releasing.md)。

