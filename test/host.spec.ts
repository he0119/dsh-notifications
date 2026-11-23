/** Notification delivery follows committed Native Session boundaries without reading history. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { expect, it, vi, type TestContext } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, LlmError, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createNotificationHost, type NotificationHostOptions } from '../src/host.ts'
import type { NotificationFrame } from '../src/runtime/types.ts'

/** Only user-started turns announce, the shipped default; a case names the family it turns on. */
const USER_ONLY: NotificationHostOptions = { userTurns: true, goalRounds: false, subagentWake: false, backgroundWake: false, teamWake: false, webhookWake: false, pluginWake: false, otherWake: false }

function frameOf(result: IteratorResult<NotificationFrame>): NotificationFrame {
  if (result.done) throw new Error('Notification stream ended before its next frame')
  return result.value
}

async function fixture(t: TestContext, agents = false, options?: () => NotificationHostOptions) {
  const ctx = new Context()
  if (agents) { await mountAgentLoopTestDependencies(ctx, { workingDirectory: true }); await ctx.plugin(AgentLoop, { agents: [] }) }
  else await ctx.plugin(SessionStore)
  const host = createNotificationHost(ctx, options)
  const controller = new AbortController()
  t.onTestFinished(async () => { controller.abort(); host.dispose(); await ctx.fiber.dispose() })
  const stream = host.observe(controller.signal)[Symbol.asyncIterator]()
  return { ctx, host, controller, stream }
}

it('starts at a non-replaying baseline and pushes a committed completed turn once', async t => {
  const { ctx, stream } = await fixture(t)
  const baseline = await stream.next()
  expect(baseline.done).toBe(false)
  expect(baseline.value).toMatchObject({ cursor: 0, baseline: true, events: [] })
  const session = ctx.sessions.create(SessionId('notification-complete'))
  session.append('turn/start', { turn: 1 })
  const pending = stream.next()
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const result = await pending
  expect(result.done).toBe(false)
  expect(result.value).toMatchObject({ epoch: baseline.value!.epoch, cursor: 1, baseline: false, events: [{ sessionId: session.id, kind: 'completed' }] })
  expect(Object.keys(result.value!.events[0]!).sort()).toEqual(['id', 'kind', 'sessionId'])
})

it('preserves terminal reason codes while excluding manual, disposal, and restoration endings', async t => {
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const session = ctx.sessions.create(SessionId('notification-reasons'))
  const reasons: TurnEndReason[] = [
    { kind: 'error', error: { code: 'RATE_LIMIT', message: 'private provider transcript' } },
    { kind: 'blocked' }, { kind: 'max-tokens' },
    { kind: 'aborted', reason: { kind: 'parent' } },
    { kind: 'aborted', reason: { kind: 'hook', reason: 'private hook text' } },
    { kind: 'aborted', reason: { kind: 'legacy' } },
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'aborted', reason: { kind: 'disposed' } },
    { kind: 'interrupted' }, { kind: 'forked' }, { kind: 'completed' },
  ]
  const pending = stream.next()
  for (const [index, reason] of reasons.entries()) {
    session.append('turn/start', { turn: index + 1 })
    session.append('turn/end', { turn: index + 1, reason })
  }
  const frame = frameOf(await pending)
  expect(frame.events.map(event => ({ kind: event.kind, reason: event.reason }))).toEqual([
    ...['RATE_LIMIT', 'blocked', 'max-tokens', 'aborted:parent', 'aborted:hook', 'aborted:legacy'].map(reason => ({ kind: 'interrupted', reason })),
    { kind: 'completed', reason: undefined },
  ])
  expect(JSON.stringify(frame)).not.toContain('private')
})

class Adapter extends LlmAdapter {
  mode: 'done' | 'fail' | 'hold' = 'done'
  entered = Promise.withResolvers<void>()
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, defaultMaxTokens: 1000 } }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.mode === 'fail') throw new LlmError('private adapter response', 'AUTH')
    if (this.mode === 'hold') {
      this.entered.resolve()
      await new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }))
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('does not infer success from real native idle or duplicate a native error and cancellation outcome', async t => {
  const { ctx, stream } = await fixture(t, true)
  await stream.next()
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['notify-fixture'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('native-notify-error'), { provider: 'notify-fixture', model: 'fixture' })
  adapter.mode = 'fail'
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fail' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect((await stream.next()).value!.events).toMatchObject([{ sessionId: agent.id, kind: 'interrupted', reason: 'AUTH' }])
  adapter.mode = 'hold'
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel' }], source: { kind: 'user' } }))
  await adapter.entered.promise
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  adapter.entered = Promise.withResolvers<void>()
  const disposed = await ctx.agentLoop.create(SessionId('native-notify-dispose'), { provider: 'notify-fixture', model: 'fixture' })
  disposed.followup(createUserMessage({ content: [{ type: 'text', text: 'dispose' }], source: { kind: 'user' } }))
  await adapter.entered.promise
  disposed.cancel({ kind: 'disposed' })
  await disposed.whenIdle()
  const sentinel = ctx.sessions.create(SessionId('native-notify-sentinel'))
  const next = stream.next()
  sentinel.append('turn/start', { turn: 1 })
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect((await next).value!.events).toMatchObject([{ sessionId: sentinel.id, kind: 'completed' }])
})

it('fills a public idle-time error without a durable end once and starts fresh on the next real activity', async t => {
  const { ctx, stream } = await fixture(t, true)
  await stream.next()
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['notify-fixture'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('native-notify-outside-turn'), { provider: 'notify-fixture', model: 'fixture' })
  expect(agent.status).toBe('idle')
  const pending = stream.next()
  const failure = { agent, turn: 0, step: 0, error: new LlmError('private out-of-turn payload', 'AUTH') }
  agent.ctx.emit('agent/error', failure)
  agent.ctx.emit('agent/error', failure)
  const sentinel = ctx.sessions.create(SessionId('outside-turn-sentinel'))
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await pending).events.map(event => ({ sessionId: event.sessionId, kind: event.kind, reason: event.reason }))).toEqual([
    { sessionId: agent.id, kind: 'interrupted', reason: 'AUTH' },
    { sessionId: sentinel.id, kind: 'completed', reason: undefined },
  ])
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect((await stream.next()).value!.events).toMatchObject([{ sessionId: agent.id, kind: 'completed' }])
})

it('ignores duplicate committed boundaries even when an older turn is delivered after a newer one', async t => {
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const session = ctx.sessions.create(SessionId('notification-duplicates'))
  const next = stream.next()
  session.append('turn/start', { turn: 1 })
  const first = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const second = session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  ctx.emit('session/event', session, second)
  ctx.emit('session/event', session, first)
  expect((await next).value!.events).toHaveLength(2)
})

it('never replays prior completions or seeded history to a newly observing view', async t => {
  const { ctx, host, controller, stream } = await fixture(t)
  const old = ctx.sessions.create(SessionId('notification-before-view'))
  old.append('turn/start', { turn: 1 })
  old.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect((await stream.next()).value).toMatchObject({ cursor: 1, baseline: true, events: [] })
  const restored = ctx.sessions.create(SessionId('notification-restored'), { seed: [...old.snapshotEvents()] })
  const other = host.observe(controller.signal)[Symbol.asyncIterator]()
  expect((await other.next()).value).toMatchObject({ cursor: 1, baseline: true, events: [] })
  const pending = stream.next()
  restored.append('turn/start', { turn: 2 })
  restored.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect((await pending).value!.events).toMatchObject([{ sessionId: restored.id, kind: 'completed' }])
})

it('coalesces a slow view onto the latest 64 small outcomes without replaying them to a new view', async t => {
  const { ctx, host, controller, stream } = await fixture(t)
  await stream.next()
  const session = ctx.sessions.create(SessionId('notification-slow'))
  for (let turn = 1; turn <= 1000; turn++) {
    session.append('turn/start', { turn })
    session.append('turn/end', { turn, reason: { kind: 'error', error: { code: 'R-' + turn, message: 'private provider transcript '.repeat(100) } } })
  }
  const frame = frameOf(await stream.next())
  expect(frame.cursor).toBe(1000)
  expect(frame.events).toHaveLength(64)
  expect(frame.events[0]!.reason).toBe('R-937')
  expect(frame.events[63]!.reason).toBe('R-1000')
  expect(new Set(frame.events.map(event => event.id)).size).toBe(64)
  expect(JSON.stringify(frame).length).toBeLessThan(20000)
  const other = host.observe(controller.signal)[Symbol.asyncIterator]()
  expect((await other.next()).value).toMatchObject({ cursor: 1000, baseline: true, events: [] })
  session.append('turn/start', { turn: 1001 })
  session.append('turn/end', { turn: 1001, reason: { kind: 'completed' } })
  expect((await stream.next()).value).toMatchObject({ cursor: 1001, events: [{ kind: 'completed' }] })
})

it('cancels one waiting reader without stopping another and closes pending reads on manual disposal', async t => {
  const { ctx, host, controller, stream } = await fixture(t)
  await stream.next()
  const waiting = stream.next()
  controller.abort()
  expect(await waiting).toEqual({ done: true, value: undefined })
  const otherController = new AbortController()
  t.onTestFinished(() => otherController.abort())
  const other = host.observe(otherController.signal)[Symbol.asyncIterator]()
  await other.next()
  const next = other.next()
  const session = ctx.sessions.create(SessionId('notification-after-abort'))
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect((await next).value!.events).toMatchObject([{ sessionId: session.id, kind: 'completed' }])
  const stopped = other.next()
  host.dispose()
  host.dispose()
  expect(await stopped).toEqual({ done: true, value: undefined })
})

it('automatically closes every pending observer when its Cordis owner unloads', async t => {
  const { ctx, host, controller, stream } = await fixture(t)
  await stream.next()
  const other = host.observe(controller.signal)[Symbol.asyncIterator]()
  await other.next()
  const stopped = [stream.next(), other.next()]
  await ctx.fiber.dispose()
  expect(await Promise.all(stopped)).toEqual([{ done: true, value: undefined }, { done: true, value: undefined }])
  expect(await host.observe(controller.signal)[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
})

it('refreshes settings without replaying outcomes or advancing their cursor and coalesces pulse bursts', async t => {
  const { ctx, host, stream } = await fixture(t)
  const baseline = frameOf(await stream.next())
  const session = ctx.sessions.create(SessionId('notification-settings-pulse'))
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await stream.next())).toMatchObject({ cursor: 1, events: [{ kind: 'completed' }] })
  const changed = stream.next()
  for (let index = 0; index < 10000; index++) host.refresh()
  expect(frameOf(await changed)).toEqual({ epoch: baseline.epoch, cursor: 1, baseline: false, events: [] })
  const outcome = stream.next()
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  for (let index = 0; index < 10000; index++) host.refresh()
  const frame = frameOf(await outcome)
  expect(frame.cursor).toBe(2)
  expect(frame.baseline).toBe(false)
  expect(frame.events).toHaveLength(1)
  expect(frame.events[0]).toMatchObject({ sessionId: session.id, kind: 'completed' })
})

it('publishes only main outcomes while ignoring subagent, team and delegated sessions',async t=>{
 const {ctx,stream}=await fixture(t);await stream.next()
 const main=ctx.sessions.create(SessionId('main-audience'))
 const children=[ctx.sessions.create(SessionId('child-audience'),{meta:{origin:'subagent',delegationDepth:1,parentSession:main.id}}),ctx.sessions.create(SessionId('team-audience'),{meta:{origin:'subagent',delegationDepth:1}}),ctx.sessions.create(SessionId('delegated-audience'),{meta:{delegationDepth:2}})]
 const next=stream.next()
 for(const child of children){child.append('turn/start',{turn:1});child.append('turn/end',{turn:1,reason:{kind:'completed'}});child.append('turn/start',{turn:2});child.append('turn/end',{turn:2,reason:{kind:'error',error:{code:'CHILD_FAILURE',message:'child'}}})}
 main.append('turn/start',{turn:1});main.append('turn/end',{turn:1,reason:{kind:'completed'}})
 const frame=frameOf(await next);expect(frame.cursor).toBe(1);expect(frame.events).toMatchObject([{sessionId:main.id,kind:'completed'}])
})

it('keeps user main-session forks eligible even when they have seed lineage',async t=>{
 const {ctx,stream}=await fixture(t);await stream.next();const source=ctx.sessions.create(SessionId('main-fork-source'))
 const fork=ctx.sessions.create(SessionId('main-user-fork'),{meta:{parentSession:source.id}})
 const next=stream.next();fork.append('turn/start',{turn:1});fork.append('turn/end',{turn:1,reason:{kind:'completed'}})
 expect(frameOf(await next).events).toMatchObject([{sessionId:fork.id,kind:'completed'}])
})

/** Append a user message with one of DSH's automatic sources to a live session. */
function sourceTurn(session: ReturnType<Context['sessions']['create']>, turn: number, kind: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', { content: [{ type: 'text', text: kind }], source: { kind } } as never, { surfaceOp: 'append' })
}

it('announces a completed user turn but stays silent for goal rounds and background wakes by default', async t => {
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const user = ctx.sessions.create(SessionId('source-user'))
  const goal = ctx.sessions.create(SessionId('source-goal'))
  const schedule = ctx.sessions.create(SessionId('source-schedule'))
  const settled = ctx.sessions.create(SessionId('source-settled'))
  const next = stream.next()
  sourceTurn(user, 1, 'user')
  user.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sourceTurn(goal, 1, 'goal')
  goal.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sourceTurn(schedule, 1, 'schedule')
  schedule.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sourceTurn(settled, 1, 'subagent-settled')
  settled.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: user.id, kind: 'completed' }])
})

it('honours the goalRounds, subagentWake and backgroundWake options independently', async t => {
  const options = { ...USER_ONLY }
  const { ctx, stream } = await fixture(t, false, () => options)
  await stream.next()
  const goal = ctx.sessions.create(SessionId('option-goal'))
  const sub = ctx.sessions.create(SessionId('option-sub'))
  const schedule = ctx.sessions.create(SessionId('option-schedule'))
  options.goalRounds = true; options.subagentWake = true
  const next = stream.next()
  sourceTurn(goal, 1, 'goal')
  goal.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sourceTurn(sub, 1, 'subagent-settled')
  sub.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sourceTurn(schedule, 1, 'schedule')
  schedule.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: goal.id, kind: 'completed' }, { sessionId: sub.id, kind: 'completed' }])
  options.backgroundWake = true
  const second = stream.next()
  sourceTurn(schedule, 2, 'schedule')
  schedule.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect(frameOf(await second).events).toMatchObject([{ sessionId: schedule.id, kind: 'completed' }])
})

it('lets the user-turns option silence work the user started', async t => {
  // 「你发起的回合」也是清单里的一项：关掉它，连用户自己触发的完成也不再提醒，重试同样算用户发起。
  const options = { ...USER_ONLY, userTurns: false }
  const { ctx, stream } = await fixture(t, false, () => options)
  await stream.next()
  const quietDirect = ctx.sessions.create(SessionId('user-quiet'))
  const quietRetry = ctx.sessions.create(SessionId('retry-quiet'))
  const complete = (session: typeof quietDirect, turn: number, kind: string) => {
    sourceTurn(session, turn, kind)
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  complete(quietDirect, 1, 'user'); complete(quietRetry, 1, 'retry')
  options.userTurns = true
  const next = stream.next()
  const loudDirect = ctx.sessions.create(SessionId('user-loud'))
  const loudRetry = ctx.sessions.create(SessionId('retry-loud'))
  complete(loudDirect, 1, 'user'); complete(loudRetry, 1, 'retry')
  // 只有打开之后的那两条进来：静音阶段若漏出一条，下面的 id 列表就对不上。
  expect(frameOf(await next).events.map(event => event.sessionId)).toEqual([loudDirect.id, loudRetry.id])
})

it('gates every other automatic wake and keeps a retry as user work', async t => {
  // DSH 记录的非人来源不止 goal、子代理、后台三种：团队消息、外部事件（webhook）、插件触发，
  // 以及插件自定义的未知来源，各有自己的开关；重试是用户请求的延续，仍按用户发起处理。
  const options = { ...USER_ONLY }
  const { ctx, stream } = await fixture(t, false, () => options)
  await stream.next()
  const team = ctx.sessions.create(SessionId('wake-team'))
  const hook = ctx.sessions.create(SessionId('wake-webhook'))
  const plugin = ctx.sessions.create(SessionId('wake-plugin'))
  const custom = ctx.sessions.create(SessionId('wake-custom'))
  const retry = ctx.sessions.create(SessionId('wake-retry'))
  const complete = (session: typeof team, turn: number, kind: string) => {
    sourceTurn(session, turn, kind)
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const off = stream.next()
  complete(team, 1, 'team-message'); complete(hook, 1, 'webhook'); complete(plugin, 1, 'cordis-host-runner')
  complete(custom, 1, 'plugin:custom'); complete(retry, 1, 'retry')
  // 四个自动来源都静音，只有重试那一轮算用户发起。
  expect(frameOf(await off).events).toMatchObject([{ sessionId: retry.id, kind: 'completed' }])
  // 逐个打开：每打开一族，只有它那一轮会提醒。
  const families = [
    { option: 'teamWake', kind: 'team-message', session: team },
    { option: 'webhookWake', kind: 'webhook', session: hook },
    { option: 'pluginWake', kind: 'cordis-host-runner', session: plugin },
    { option: 'otherWake', kind: 'plugin:custom', session: custom },
  ] as const
  for (const [index, family] of families.entries()) {
    options[family.option] = true
    const next = stream.next()
    complete(family.session, index + 2, family.kind)
    expect(frameOf(await next).events).toMatchObject([{ sessionId: family.session.id, kind: 'completed' }])
  }
})

it('still announces a failure from a goal round or background wake', async t => {
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const goal = ctx.sessions.create(SessionId('failure-goal'))
  const next = stream.next()
  sourceTurn(goal, 1, 'goal')
  goal.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'private' } } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: goal.id, kind: 'interrupted', reason: 'RATE_LIMIT' }])
})

/** Append a user message with an arbitrary source object to a live session. */
function messageTurn(session: ReturnType<Context['sessions']['create']>, turn: number, source: unknown): void {
  session.append('turn/start', { turn })
  session.append('user/message', { content: [{ type: 'text', text: 'message' }], source } as never, { surfaceOp: 'append' })
}

/** Context message kinds DSH injects into an already-open turn after its trigger. */
const INJECTED_CONTEXTS = [
  { kind: 'time-context', form: 'snapshot' },
  { kind: 'tool-jobs', form: 'notice' },
  { kind: 'ptc-mode' },
  { kind: 'agent-instructions', form: 'instructions' },
  { kind: 'skill-catalog', form: 'catalog' },
  { kind: 'compact-checkpoint' },
]

it('does not let injected context turn a goal round into a user turn when goalRounds is off', async t => {
  // 真实顺序：goal 消息先触发回合，随后每步注入 time-context / tool-jobs / ptc-mode 等上下文，
  // 最后一轮 completed。这些注入消息不能把回合来源从 goal 覆盖成 user，否则绕过 goalRounds。
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const goal = ctx.sessions.create(SessionId('injected-context-goal'))
  const user = ctx.sessions.create(SessionId('injected-context-user'))
  const sentinel = ctx.sessions.create(SessionId('injected-context-sentinel'))
  const next = stream.next()
  messageTurn(goal, 1, { kind: 'goal', goalId: 'g1', revision: 1, round: 1 })
  for (const source of INJECTED_CONTEXTS) {
    goal.append('user/message', { content: [{ type: 'text', text: 'context' }], source } as never, { surfaceOp: 'append' })
  }
  goal.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // 对照组：同样的注入上下文跟在真正的 user 消息后，仍要照常提醒。
  messageTurn(user, 1, { kind: 'user' })
  for (const source of INJECTED_CONTEXTS) {
    user.append('user/message', { content: [{ type: 'text', text: 'context' }], source } as never, { surfaceOp: 'append' })
  }
  user.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sentinel.append('turn/start', { turn: 1 })
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([
    { sessionId: user.id, kind: 'completed' },
    { sessionId: sentinel.id, kind: 'completed' },
  ])
})

it('announces a goal round when goalRounds is on even with injected context', async t => {
  const { ctx, stream } = await fixture(t, false, () => ({ ...USER_ONLY, goalRounds: true }))
  await stream.next()
  const session = ctx.sessions.create(SessionId('injected-context-goal-on'))
  const next = stream.next()
  messageTurn(session, 1, { kind: 'goal', goalId: 'g2', revision: 1, round: 1 })
  for (const source of INJECTED_CONTEXTS) {
    session.append('user/message', { content: [{ type: 'text', text: 'context' }], source } as never, { surfaceOp: 'append' })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: session.id, kind: 'completed' }])
})

it('keeps a tool-jobs wake silent when backgroundWake is off', async t => {
  // DSH 的 tool-jobs 在空闲 owner 上用 followup 投递完成通知，这会真正开启一个回合；
  // 这条消息和「注入到进行中回合」的 tool-jobs 用同一个 source.kind，必须靠「是不是回合
  // 第一条来源」区分：唤醒回合里它是唯一来源，应受 backgroundWake 控制。
  const { ctx, stream } = await fixture(t, false, () => USER_ONLY)
  await stream.next()
  const session = ctx.sessions.create(SessionId('tool-jobs-wake-off'))
  const sentinel = ctx.sessions.create(SessionId('tool-jobs-wake-sentinel'))
  const next = stream.next()
  messageTurn(session, 1, { kind: 'tool-jobs', form: 'notice', summary: 'job done' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sentinel.append('turn/start', { turn: 1 })
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: sentinel.id, kind: 'completed' }])
})

it('announces a tool-jobs wake when backgroundWake is on', async t => {
  const { ctx, stream } = await fixture(t, false, () => ({ ...USER_ONLY, backgroundWake: true }))
  await stream.next()
  const session = ctx.sessions.create(SessionId('tool-jobs-wake-on'))
  const next = stream.next()
  messageTurn(session, 1, { kind: 'tool-jobs', form: 'notice', summary: 'job done' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: session.id, kind: 'completed' }])
})

it('still ignores a tool-jobs notice injected into a goal round with goalRounds off', async t => {
  // 同一个 tool-jobs kind 出现在 goal 回合中段时是注入上下文，不能把回合变成后台唤醒。
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const session = ctx.sessions.create(SessionId('tool-jobs-injected-goal'))
  const sentinel = ctx.sessions.create(SessionId('tool-jobs-injected-sentinel'))
  const next = stream.next()
  messageTurn(session, 1, { kind: 'goal', goalId: 'g1', revision: 1, round: 1 })
  session.append('user/message', { content: [{ type: 'text', text: 'job done' }], source: { kind: 'tool-jobs', form: 'notice' } } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sentinel.append('turn/start', { turn: 1 })
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: sentinel.id, kind: 'completed' }])
})

it('lets a real goal trigger override a tool-jobs notice that arrived first in the turn', async t => {
  // DSH 先认领 next-step 再认领 next-turn，注入的 tool-jobs 可能排在 goal 触发消息前；
  // 它标了 weak，不能被当成后台唤醒，后到的 goal 要能覆盖它。
  const { ctx, stream } = await fixture(t, false, () => ({ ...USER_ONLY, backgroundWake: true }))
  await stream.next()
  const session = ctx.sessions.create(SessionId('tool-jobs-before-goal'))
  const sentinel = ctx.sessions.create(SessionId('tool-jobs-before-goal-sentinel'))
  const next = stream.next()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { content: [{ type: 'text', text: 'job done' }], source: { kind: 'tool-jobs', form: 'notice' } } as never, { surfaceOp: 'append' })
  session.append('user/message', { content: [{ type: 'text', text: 'round' }], source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  sentinel.append('turn/start', { turn: 1 })
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: sentinel.id, kind: 'completed' }])
})

it('announces a goal terminal change once and does not double-announce its final round', async t => {
  const { ctx, stream } = await fixture(t, false, () => ({ ...USER_ONLY, goalRounds: true }))
  await stream.next()
  const session = ctx.sessions.create(SessionId('goal-terminal'))
  const next = stream.next()
  session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'complete', goal: { id: 'g1', revision: 1, phase: 'completed' }, roundsStarted: 3, createdAt: 0, updatedAt: 1 } as never)
  sourceTurn(session, 3, 'goal')
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: session.id, kind: 'completed' }])
})

it('does not double-announce a goal terminal and its final round beyond the dedupe window', async t => {
  // 真实会话里 goal/change(complete) 与末轮 turn/end 相隔 13 秒，超过 5 秒窗口。
  // 两者仍应只提醒一次：终态一旦发布，后续同 goal id 的末轮完成必须抑制，不能靠时间窗。
  const now = { value: 1_000_000 }
  vi.spyOn(Date, 'now').mockImplementation(() => now.value)
  t.onTestFinished(() => vi.restoreAllMocks())
  const { ctx, stream } = await fixture(t, false, () => ({ ...USER_ONLY, goalRounds: true }))
  await stream.next()
  const session = ctx.sessions.create(SessionId('goal-terminal-far'))
  const sentinel = ctx.sessions.create(SessionId('goal-terminal-far-sentinel'))
  const terminal = stream.next()
  session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'complete', goal: { id: 'g1', revision: 1, phase: 'completed' }, roundsStarted: 3 } as never)
  expect(frameOf(await terminal).events).toMatchObject([{ sessionId: session.id, kind: 'completed' }])
  now.value += 13_000
  const final = stream.next()
  messageTurn(session, 3, { kind: 'goal', goalId: 'g1', revision: 1, round: 3 })
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  // 末轮被抑制后没有事件可发，用一条真实 user 回合逼出一帧，断言帧里只有它。
  messageTurn(sentinel, 1, { kind: 'user' })
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await final).events).toMatchObject([{ sessionId: sentinel.id, kind: 'completed' }])
})

it('does not double-announce a goal completion whose final round carries a tool-goal wrap-up', async t => {
  // Real goal completion order: goal/change(complete) first, then the tool-goal
  // wrap-up context appended into the same round, then turn/end. The wrap-up
  // must stay a goal source so it cannot be mistaken for user work and bypass
  // the terminal's dedupe entry.
  const { ctx, stream } = await fixture(t, false, () => ({ ...USER_ONLY, goalRounds: true }))
  await stream.next()
  const session = ctx.sessions.create(SessionId('goal-tool-goal'))
  const next = stream.next()
  session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'complete', goal: { id: 'g1', revision: 1, phase: 'completed' }, roundsStarted: 3, createdAt: 0, updatedAt: 1 } as never)
  session.append('turn/start', { turn: 3 })
  session.append('user/message', { content: [{ type: 'text', text: 'wrap-up' }], source: { kind: 'tool-goal', form: 'notice' } } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: session.id, kind: 'completed' }])
})

it('announces a goal block as interrupted and dedupes the final round', async t => {
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const session = ctx.sessions.create(SessionId('goal-block'))
  const next = stream.next()
  session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'block', goal: { id: 'g1', revision: 2, phase: 'blocked' }, roundsStarted: 2, createdAt: 0, updatedAt: 1 } as never)
  expect(frameOf(await next).events).toMatchObject([{ sessionId: session.id, kind: 'interrupted', reason: 'goal:block' }])
})

it('does not mistake an injected runtime-context message for a user turn', async t => {
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const goal = ctx.sessions.create(SessionId('context-goal'))
  const sentinel = ctx.sessions.create(SessionId('context-sentinel'))
  goal.append('turn/start', { turn: 1 })
  goal.append('user/message', { content: [{ type: 'text', text: 'context' }], source: { kind: 'runtime-context' } } as never, { surfaceOp: 'append' })
  goal.append('user/message', { content: [{ type: 'text', text: 'round' }], source: { kind: 'goal', goalId: 'g1' } } as never, { surfaceOp: 'append' })
  goal.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const next = stream.next()
  sentinel.append('turn/start', { turn: 1 })
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([{ sessionId: sentinel.id, kind: 'completed' }])
})

it('announces two different goals in one session separately', async t => {
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const session = ctx.sessions.create(SessionId('two-goals'))
  const first = stream.next()
  session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'complete', goal: { id: 'g1', revision: 1 }, roundsStarted: 1 } as never)
  expect(frameOf(await first).events).toMatchObject([{ sessionId: session.id, kind: 'completed' }])
  const second = stream.next()
  session.append('goal/change', { kind: 'goal/change', version: 2, operation: 'complete', goal: { id: 'g2', revision: 1 }, roundsStarted: 1 } as never)
  expect(frameOf(await second).events).toMatchObject([{ sessionId: session.id, kind: 'completed' }])
})

it('announces one interruption when a failed goal round is followed by its block terminal', async t => {
  const { ctx, stream } = await fixture(t)
  await stream.next()
  const session = ctx.sessions.create(SessionId('goal-fail-block'))
  const sentinel = ctx.sessions.create(SessionId('goal-fail-sentinel'))
  const next = stream.next()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { content: [{ type: 'text', text: 'round' }], source: { kind: 'goal', goalId: 'g9' } } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'private' } } })
  session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'block', goal: { id: 'g9', revision: 2 }, roundsStarted: 1 } as never)
  sentinel.append('turn/start', { turn: 1 })
  sentinel.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(frameOf(await next).events).toMatchObject([
    { sessionId: session.id, kind: 'interrupted', reason: 'RATE_LIMIT' },
    { sessionId: sentinel.id, kind: 'completed' },
  ])
})
