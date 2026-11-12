# Agent Note: 通知独立成包，标识符与 Cyaness Tools 各走一套

Status: implemented

## Problem

DSH 的会话提醒原本长在 Cyaness Tools 里——那是一个把工具集、界面扩展与通知放在一起的大插件包。
只想被提醒一下的人得装整包，还得跟着它一起升级。更麻烦的是命名：插件行、接口命名空间、Service
Worker 路径、Windows 协议、本机存储库名，只要两边共用一套，后注册的一方就会覆盖前一方，两边的数据也
会搅在一起。

## Decision

通知单独成包 `@he0119/dsh-notifications`，只做提醒一件事，并且标识符全部独立：

- npm 包名 `@he0119/dsh-notifications`，插件行 id `dsh-notifications`；
- Remote 命名空间 `dshNotifications`，编解码由本包自己的 `@Remote` 方法生成；
- Service Worker 路径 `/dsh-notifications/sw.js`，作用域 `/dsh-notifications/`；
- Windows 协议 `dsh-notifications`，助手目录 `%LOCALAPPDATA%\DshNotifications`；
- 本机音频存储的 IndexedDB 库名各自一份。

Cyaness Tools 里那份实现保持原样，不被本包引用、也不反向引用本包。

## Alternatives considered

- **留在 Cyaness Tools 里**：只想提醒的人得装整包，升级节奏也被工具集绑住。
- **两边共用一套标识符，靠「只装一个」约束**：注册与数据会互相覆盖，且无人能保证用户只装一个。
- **做成 Cyaness Tools 的可选子包**：子包与父包还是同一棵依赖树，「装整包」的问题原样存在。

## Consequences

同时启用两边会重复提醒——两边都在听同一批会话事件。README 写明「用哪个就只启用哪个」，不试图在运行
时互相探测。

两份实现从此各自维护：改一边不会同步到另一边。标识符成了公开契约，动手改名就是破坏性变更，装过旧版
的人会丢掉自己的设置与本机音频。
