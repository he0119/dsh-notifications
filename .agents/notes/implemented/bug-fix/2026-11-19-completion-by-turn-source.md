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
注进来的 `runtime-context` 消息不算触发者。

goal 真正的终态由 `goal/change` 事件发布：`complete` 报完成，`block` 报中止。终态、最后一轮
`turn/end` 和 goal 轮次的失败，以同一个 goal id 加一个短时间窗去重，只发一条；同一会话里连续两个不同
goal 的终态各发各的。

出错、限流、用户取消等结束原因不受来源过滤影响，始终提醒。原有的「只提醒主会话」边界保持不变，见
[只对主会话发提醒](../feature/2026-11-12-only-root-sessions-notify.md)。

## Alternatives considered

- **维持按主会话过滤，只调界面**：现象来自事件源，界面改不了触发次数。
- **把所有自动回合的通知合成一条汇总**：要跟踪回合边界、归并成功与失败，状态复杂，且用户真正要的
  是「只在需要我时响一次」。
- **彻底不报 goal 与后台的完成**：goal 卡住或失败时用户就没有任何提示，两个开关提供了回到提醒的
  余地。
- **只按时间窗去重终态与最后一轮**：同一会话里连续两个 goal 会互相吞掉；最终用时间窗加 goal id
  一起判断，既覆盖事件先后顺序，又不误吞不同 goal。

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

配置卡本身的布局改造见[设置卡改成两列布局并保留状态入口](../feature/2026-11-19-settings-card-layout.md)。
