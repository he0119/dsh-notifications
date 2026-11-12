# Agent Note: 配置卡挂在插件页，不单独占设置页的一页

Status: implemented

## Problem

本包的设置项有四类事件各自的音色、音量、弹窗方式与自定义音频，原本注册成设置页里单独的一页
（`settings.section`）。设置页是官方那几项的清单（通用、模型、内置插件、Agent 预设），装一个只做通知
的插件却在那里多认一页；而「这个包装了什么、能调什么、要不要启用」本来就在插件页——两处分开之后，
用户改完音色想关掉插件，还得换一页去找那个开关。

## Decision

客户端把整张表单注册到插件页的 `plugins.bundle.config` 槽位，键是包名 `@he0119/dsh-notifications`：官方插件
管理器声明这个槽位，并按包名把贡献派给「这个包」的那一页，渲染在描述与它声明的行之间。列表视图
（`view === 'summary'`）本包不画，那一行的一句话由插件页自己排版。

设置页不再有「通知」一项；`plugin rows` 的启用开关、卸载按钮与这张卡在同一页。宿主侧的 `Config`
schema 与写入路径一条没改：字段仍是 `volatile()`，改完立即生效，保存仍是一次带 `revision` 围栏的
原生 mutation。

## Alternatives considered

- **继续用 `settings.section`**：多一页，且与插件页的启用、卸载分开；配置改完想停用插件要换页。
- **两处都挂**：两套入口各自维护草稿与 `revision`，用户还得被告知「哪边改了另一边会作废」。官方
  `dsh-context`、`dsh-aperture`、`dsh-session-manager` 都只挂插件页，没有两处并存的先例。
- **挂在 `plugins.row.config`（键 `<包名>#<行 id>`）**：那是「一个包里某一行插件」的配置位，本包只有
  一行、配置也整包共用，包级格子更贴合，还省掉把行 id 抄进客户端这一份重复事实。

## Consequences

插件页若删掉或改名这个槽位，本包的表单会静默不出现（`slots.inject` 等不到槽位，不报错）。届时改
`src/client/components/NotificationsSettings.tsx` 里的 `PLUGIN_CONFIG_SLOT` 一处即可；
`test/delivery.spec.tsx` 里那条用例断言注册到 `plugins.bundle.config`、键是包名，槽位写错先红。
