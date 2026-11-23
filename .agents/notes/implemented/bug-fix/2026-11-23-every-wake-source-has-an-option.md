# Agent Note: 每个自动唤醒来源各有开关，未知来源不再冒充用户

Status: implemented

## Problem

`sourceOf` 原来只认 goal、子代理、后台三类自动来源，其余一律 `/default: return 'user'`。DSH 实际会
记录更多非人来源：团队消息（`team-message`）、外部事件（`webhook`）、插件触发（`cordis-host-runner`），
以及插件自定义的任意 kind。它们落进默认分支后有两个后果：

1. 发布「完成」时走「用户发起」分支，`goalRounds` / `subagentWake` / `backgroundWake` 都不读，
   用户关掉全部开关，队友每说一句话、每个 webhook 事件、每次插件跑完仍会弹一条「会话完成」。
2. 来源记录的覆盖规则让 user 优先级最高：一回合里先来 goal 消息、后来一条团队消息，整轮就被判成
   用户发起，连「目标每轮完成」关着也提醒。

这不是崩溃或重复，而是「自动跑起来的回合冒充用户亲自发起」——正是完成提醒过滤要治的那类噪音。

## Decision

`src/host.ts` 的 `sourceOf` 列出 DSH 记录的每种自动来源，各归一族：

| 来源 kind | 族 | 开关 |
| --- | --- | --- |
| `goal`、`tool-goal` | goal | `goalRounds` |
| `subagent-settled`、`agent-message` | subagent | `subagentWake` |
| `schedule`、`tool-jobs` | background | `backgroundWake` |
| `team-message` | team | `teamWake` |
| `webhook` | webhook | `webhookWake` |
| `cordis-host-runner` | plugin | `pluginWake` |
| 其它任何 kind | other | `otherWake` |
| `user`、`retry` | user | `userTurns`（默认勾选） |

`retry` 归用户：它是「继续生成」这种用户请求的延续。其余未知 kind 归 `other`，不再归用户——
插件自定义来源不该冒充人的动作。没有记录到触发者的回合也按用户处理。

发布分支也改成查表：`WAKE_OPTIONS` 把族映射到配置字段，`turn/end` 的完成分支只剩「用户发起」
与「查表命中就发」两条，新增一族时只改表。

八个勾选项落进配置卡「哪些完成要提醒」一组里，由「会话完成」的父开关收起或展开；只有「你发起的
回合」默认勾选，其余七项默认关闭。把用户回合也列进来，是为了让这组勾选项成为「会话完成在什么
情况下提醒」的完整答案，而不是「用户回合永远提醒」加一张只列自动来源的清单。

## Alternatives considered

- **只补三个已知来源，未知仍按用户处理**：插件自定义来源（`plugin:*`）仍然冒充用户，等于把缺口
  留在插件生态里。
- **未知来源默认提醒（开关默认开）**：能避免新来源被静音，但与「自动跑起来的回合默认安静」这条
  前提相反，等于把噪音当默认。
- **团队消息并进子代理开关、webhook 与插件并进后台开关**：少四个开关，但用户没法单独关掉某一族，
  也看不出是哪一类自动回合在响。
- **用户回合固定成一直提醒，不列进清单**：清单就不再回答「会话完成什么时候提醒」这个完整问题，
  想只留目标轮次的人也没法关掉自己那部分。

## Consequences

新增五个 volatile 配置字段（`userTurns` 及其余四族）进入 `NotificationSettings` 对外契约，旧配置缺少
`userTurns` 时按开启处理——那是出厂行为；
`test/config.spec.ts`、`test/preferences.spec.ts`、`test/delivery.spec.tsx` 的默认值断言同步更新。

代价：DSH 以后新增一种唤醒来源时，在 `sourceOf` 列出它之前会落进 `other` 并默认静音。
`test/host.spec.ts` 的 `gates every other automatic wake and keeps a retry as user work` 用四种来源
逐一验证「关着静音、打开那一族才提醒」，删掉任一归类或把 default 改回 user 都会红。

原有决策见[完成提醒按回合触发者过滤](2026-11-19-completion-by-turn-source.md)，界面上的这一组勾选项见
[设置卡改用官方控件](../feature/2026-11-19-settings-card-layout.md)。
