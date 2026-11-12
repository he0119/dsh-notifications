/** Notification delivery follows committed Native Session boundaries without reading history. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { expect, it, type TestContext } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, LlmError, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createNotificationHost } from '../src/host.ts'
import type { NotificationFrame } from '../src/runtime/types.ts'

function frameOf(result: IteratorResult<NotificationFrame>): NotificationFrame {
  if (result.done) throw new Error('Notification stream ended before its next frame')
  return result.value
}

async function fixture(t: TestContext, agents = false) {
  const ctx = new Context()
  if (agents) { await mountAgentLoopTestDependencies(ctx, { workingDirectory: true }); await ctx.plugin(AgentLoop, { agents: [] }) }
  else await ctx.plugin(SessionStore)
  const host = createNotificationHost(ctx)
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
