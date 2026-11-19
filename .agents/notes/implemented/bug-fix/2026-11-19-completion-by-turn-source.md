# Agent Note: 完成提醒按回合触发者过滤，goal 终态只提醒一次

Status: implemented

## Problem

只按「是不是主会话」过滤提醒不够。一次任务在主会话里会拆成很多回合：goal 的每个自动续轮是一个回合，
计时任务和子代理结束时也会往主会话塞一条消息、把它唤醒再跑一个回合。这些回合都算主会话，于是用户
会看到 goal 每轮都弹一次「完成」，后台任务结束后又唤醒前台再弹一次——用户看到的「每个 subagent
提醒一次」其实是子代理唤醒主会话后主会话收尾产生的通知，弹窗上写的是主会话名字。

真正需要用户回来的那一刻（整个任务做完、报错）因此淹没在一屏通知里。

## Decision

事件源在发布「完成」之前先看这次回合是谁触发的：从回合内的 `user/message` 事件读 `source.kind`，
`user` 算用户主动；`goal`、`schedule`、`subagent-settled`、`agent-message` 算自动触发。用户主动的
完成始终提醒；goal 轮次、子代理唤醒的收尾、计时任务唤醒的收尾默认都不提醒，分别由 `goalRounds`、
`subagentWake`、`backgroundWake` 三个配置开关控制，默认关闭。每回合开始（`turn/start`）清空来源记录，避免上一回合的来源泄漏到下一回合；
注进来的上下文消息不算触发者，包括 `runtime-context`、`time-context`、`ptc-mode`、
`agent-instructions`、`skill-catalog`、`compact-checkpoint` 等，统一在 `src/host.ts` 的
`INJECTED_CONTEXT_KINDS` 白名单里列出并跳过。这一步很关键：这些注入消息在 DSH 里也是 `user/message`
事件，若不跳过，它们落进 `sourceOf` 的 default 会被当成用户主动，把回合开头记录的 `goal` / `schedule` /
`subagent` 来源覆盖掉（user 优先级最高），于是 goal 每轮照样提醒、`goalRounds` 关了也不起作用。
白名单是逐个列举而不是「凡带 `form` 字段就跳过」，因为 `goal`、`tool-goal`、`user-approval` 这些真实
来源同样带 `form`；反过来未列举的未知来源仍按用户处理，避免悄悄漏掉提醒。

goal 真正的终态由 `goal/change` 事件发布：`complete` 报完成，`block` 报中止。终态是权威结论，
`goalNotices` 里记下它是终态（`terminal`），此后同一个 goal id、同类型的末轮一律抑制，不管相隔多久；
同一会话里连续两个不同 goal 的终态各发各的。这样避开了原来「终态加末轮必须用 5 秒时间窗配对」的缺陷：
实测一次 `goal/change(complete)` 后 13 秒才到末轮 `turn/end`，超出窗口就重复提醒。`goalRounds` 打开时
同一 goal 的多个普通轮次仍按 5 秒窗去重，各自提醒，不受终态抑制影响。
出错、限流、用户取消等结束原因不受来源过滤影响，始终提醒。原有的「只提醒主会话」边界保持不变，见
[只对主会话发提醒](../feature/2026-11-12-only-root-sessions-notify.md)。

## Alternatives considered

- **维持按主会话过滤，只调界面**：现象来自事件源，界面改不了触发次数。
- **把所有自动回合的通知合成一条汇总**：要跟踪回合边界、归并成功与失败，状态复杂，且用户真正要的
  是「只在需要我时响一次」。
- **彻底不报 goal 与后台的完成**：goal 卡住或失败时用户就没有任何提示，两个开关提供了回到提醒的
  余地。
- **只按时间窗去重终态与最后一轮**：终态与末轮可能相隔超过窗口（实测 13 秒），会重复提醒；最终改成
  终态记为权威结论，同 goal id 同类型的末轮无条件抑制，普通轮次之间仍用时间窗。
- **把 `tool-jobs` 全当注入上下文跳过**：空闲 owner 的后台作业完成通知用 `followup` 开新回合，跳过就
  绕过了 `backgroundWake`；最终按是否回合首个来源区分，并用 `weak` 标记让后到的真实触发者覆盖它。

## Consequences

默认行为安静下来：只有用户主动发起的工作完成、goal 终态、以及所有失败会提醒。想恢复逐轮或唤醒后提醒的人需要
自己打开对应开关。新增三个配置字段会进入 `NotificationSettings` 对外契约，旧会话缺少这些字段时按关闭
处理。判断来源是靠 `user/message` 的 `source.kind`，DSH 换这种表达方式时 `src/host.ts` 的
`sourceOf` 要同步改，`test/host.spec.ts` 会先红。

`sourceOf` 除了 `goal`，还要把 `tool-goal` 归到 goal：模型调用 `tool-goal` 的 complete/blocked 时，除了发
`goal/change`，还会在同一轮追加一条来源为 `tool-goal` 的收尾上下文。若 `tool-goal` 落到 default 当成
用户来源，会把本轮来源从 goal 覆盖成 user，最后一轮就以「用户任务完成」再发一条，绕开终态去重。
`test/host.spec.ts` 有一条按真实顺序（goal/change → tool-goal → turn/end）的回归用例守住这点；删掉
`tool-goal` 归类，这条用例会红。

同理，其余注入型上下文的白名单也有回归用例：`test/host.spec.ts` 里用一条 goal 消息起头、随后依次注入
`time-context` / `ptc-mode` / `agent-instructions` / `skill-catalog` / `compact-checkpoint`
再结束，断言 `goalRounds` 关闭时不提醒；并有一条对照用例证明同样注入跟在真实 `user` 消息后仍提醒。
把白名单清空，这两条用例会红。

`tool-jobs` 单独处理：它有两种用法，空闲 owner 上用 `followup` 投递完成通知，会真正开一个回合；
忙碌或超预算时用 `inject` 注入进行中的回合。两者 `source` 完全一样，没法从字段区分。实测会话里唤醒回合
的 `tool-jobs` 是唯一真实来源，注入的 `tool-jobs` 从不排在 goal 触发消息之前，于是把它归到
`background`（受 `backgroundWake` 控制），并在 `SourceState` 上标 `weak`：回合里后出现更强的真实触发者
（user / goal / subagent / schedule）时能覆盖它。这样既让 `backgroundWake` 关闭时后台作业唤醒的回合安静，
又不会把注入的完成通知当成回合触发者。这是从实际会话里「关了 `backgroundWake` 仍弹后台作业完成」复现出来的
缺陷，`test/host.spec.ts` 有唤醒开关开/关两条用例守住。

配置卡本身的布局改造见[设置卡改成两列布局并保留状态入口](../feature/2026-11-19-settings-card-layout.md)。
