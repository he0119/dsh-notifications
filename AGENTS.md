# AGENTS.md

本仓库的协作约定，给 AI 助手与贡献者看。安装与用法在 [README](README.md)，目录结构与开发命令在
[docs/development.md](docs/development.md)，发布流程在 [docs/releasing.md](docs/releasing.md)，
决策的依据与被否决的备选方案在 [.agents/notes/](.agents/notes/AGENTS.md)。文档、提交信息、给维护者的
报告一律用中文。

## 文档分工

每条信息只写一处，别处放链接或一句话指过去：

| 文档 | 写什么 |
| --- | --- |
| `README.md` / `README.en.md` | 怎么装、能提醒什么、有哪些前提和限制；两份的键与结构保持对齐 |
| `AGENTS.md` | 本文件：协作约定、提交信息口径、验证清单、改一次就会静默坏掉的硬约束 |
| `.agents/notes/` | 决策的依据与被否决的备选方案；一条决策一篇，格式由 `test/notes.spec.ts` 核 |
| `docs/AGENTS.md` | `docs/` 这一层的写作规范 |
| `docs/development.md` | 目录结构、逐文件职责、常用命令 |
| `docs/releasing.md` | 本地打包、推标签之后工作流做什么、npm 那边要先配什么 |

一次改动**引入了新的决策**（安全边界、默认值、对外契约、行为规则、修掉一个有现象可查的缺陷）时，与
代码同一个提交里写一篇笔记，判据见 [.agents/notes/AGENTS.md](.agents/notes/AGENTS.md)。已经有一篇
笔记持有该决策就更新它，不新建重复笔记。措辞调整与纯局部实现细节豁免。

## 说人话

文档、提交信息、PR 描述和给维护者的报告都写清谁做什么、条件、结果；术语第一次出现先解释。不用
「收口」「闭环」这类词代替动作，不写只表态度的句子；技术术语照 DSH 官方口径保留，不为了口语化把
准确说法换掉。

## 提交信息

**只写这个提交做了什么、为什么这么做、有什么取舍。** 明确不要写：

- 维护者本人的使用面或口述（「我完全没机会用这个东西」这类）；
- 谁报的（「用户报的」「用户截图报的」）——把现象与量到的数字写出来就够了；
- 演化过程（「原本是…后来改成…」）——直接写最终形态。

其余口径：

- 中文 conventional commits：`feat / fix / docs / refactor / test / build / chore`；破坏性变更加 `!`，
  并在正文单独写一段 **破坏性**（装过旧版的人会遇到什么）。
- 标题一句话说完「改了什么」，不写解释性括号；塞不下说明这件事该拆成两个提交。
- 正文手折行，每行 ≤ 100 字符；一段一件事；一次逻辑改动一个提交，连带改动的文档与测试并入同一提交。
- 数字只写实测值：测试条数（`tests / pass / fail / skipped`）、量出来的文件数或字节数。

## 验证（提交前必须全绿）

```sh
pnpm run typecheck && pnpm run build && pnpm test && pnpm run check:package
```

- **新断言要篡改验证**：把被测行为改回去，测试必须变红；报告里说明做了哪些篡改。
- `test/notes.spec.ts` 只核**声明**：`.agents/notes/` 下的路径形状、头部三行、`Status:` 与所在目录
  是否一致、`## Problem` 是不是第一个二级标题、必备章节在不在、相对链接能不能解析。改笔记格式就同一次
  改动里改它。
- 界面与样式的改动要**在真实 dev GUI 里看**，深浅两套主题各看一遍（本包的配置卡注册在插件页的
  `plugins.bundle.config` 槽位，按包名作键；宿主由 `dsh web` 提供）。
- 验收需要临时夹具（假会话、假音频等）时，用完立刻删干净，并在报告里写明造过什么、清掉了没有。

## 硬约束

违反一次就静默坏掉、且每轮都要在上下文里的门：

- **浏览器半侧只 `require` 平台基线模块**：`react`、`react/jsx-runtime`、`react-dom`、
  `@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、
  `dsh-client-ui-dockkit`——这些在 `tsdown.config.ts` 的 `CLIENT_BASELINE` 里保持外置，其余内联。
  要引新的非基线模块，先确认宿主提供它，再同时改那张表和 `test/package-artifact.spec.ts` 的外置清单。
- **标识符不许和 Cyaness Tools 混用**：包名与插件行 `dsh-notifications`、接口命名空间
  `dshNotifications`、Service Worker 路径 `/dsh-notifications/sw.js`、Windows 协议
  `dsh-notifications`、助手目录 `%LOCALAPPDATA%\DshNotifications`、IndexedDB 库名各自一份。
  两边共用一个名字会互相覆盖注册与数据。
- **只对主会话发通知**：`origin === 'subagent'` 或 `delegationDepth > 0` 的会话在宿主事件源
  （`src/host.ts` 的 `publish()`）就丢掉，桌面投递器再按同一条件挡一次。放宽之前先想清「一次任务里
  子代理轮番结束、一屏通知」的后果。
- **不把 idle 当成功**：事件只来自已提交的回合结束与终态失败（`turn/end`、`agent/error`）。从「安静了」
  推断「做完了」会把取消、限流、断线都报成完成。
- **Windows 只在 win32 动手**：其它平台不写盘、不起进程。写的地方只有 `HKCU` 的协议注册与本机
  `%LOCALAPPDATA%\DshNotifications`，不碰 DSH 自己的协议、快捷方式与图标。
- **产物形状固定**：宿主是 ESM 的 `lib/index.js`，浏览器是经典脚本 `lib/client.js`
  （`window.__ModuleLoader__.load({ id, factory })`）。`package.json` 的 `files` 白名单决定进包内容，
  改包结构要同步 `scripts/check-package.mjs` 的必需文件清单。
- **配置只走 `Config`**：schema 必须从 `src/index.ts` 导出为 `Config`，插件管理器靠它生成表单；
  这些字段都是 `volatile()`，改完立即生效，别在别处再存一份。
- **测试里不要装回渲染栈**：官方控件库与快照存储由 `test/stubs/` 的替身代替（`vitest.config.ts` 的
  `resolve.alias`）。替身只保证语义（可访问名字、禁用、勾选/点击），要加新断言先看替身够不够，别为了
  一次渲染把 shiki / katex / micromark 那一套拉回开发依赖。
- **文案两处**：插件行的标题与描述在 `locale/zh.json` / `locale/en.json`（两份键对齐）；配置卡文案在
  `src/client/logic/locales.ts`（`zh` 是基准，`en` 的类型是 `Record<keyof typeof zh, string>`，
  少一个键就编译不过）。
