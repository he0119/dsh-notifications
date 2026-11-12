/** The plugin entry mounts with real Session state and registers its public worker route. */
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import { NOTIFICATION_WORKER_PATH, NOTIFICATION_WORKER_SCOPE } from '../src/service-worker.ts'

/** Minimal stand-ins for the Host services the entry declares as dependencies. */
class RemoteAccess extends Service {
  constructor(ctx: Context) { super(ctx, 'remoteAccess') }
  allows(): boolean { return false }
}
class Agents extends Service {
  constructor(ctx: Context) { super(ctx, 'agents') }
}
class Typert extends Service {
  readonly contributions: unknown[] = []
  constructor(ctx: Context) { super(ctx, 'typert') }
  register(contribution: unknown): () => void {
    this.contributions.push(contribution)
    return () => { this.contributions.splice(this.contributions.indexOf(contribution), 1) }
  }
}
class TypertGateway extends Service {
  constructor(ctx: Context) { super(ctx, 'typertGateway') }
}
interface Route { kind: string; path: string; handler: unknown }
class WebServer extends Service {
  readonly routes: Route[] = []
  constructor(ctx: Context) { super(ctx, 'webServer') }
  register(route: Route): () => void {
    this.routes.push(route)
    return () => { this.routes.splice(this.routes.indexOf(route), 1) }
  }
}

/** @returns a host context with the declared dependencies and, optionally, a web server. */
async function host(web: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  new RemoteAccess(ctx); new Agents(ctx); new Typert(ctx); new TypertGateway(ctx)
  if (web) new WebServer(ctx)
  return ctx
}

it('exports the row identity and the accepted configuration schema', () => {
  expect(name).toBe('dsh-notifications')
  expect(inject).toEqual(['sessions', 'agents', 'typert', 'typertGateway', 'remoteAccess'])
  expect(typeof Config).toBe('function')
})

it('registers the Remote codec and the isolated worker route while mounted', async () => {
  const ctx = await host(true)
  try {
    await ctx.plugin({ name, inject, apply, Config })
    const typert = ctx.get('typert') as Typert
    expect(typert.contributions).toHaveLength(1)
    const web = ctx.get('webServer') as WebServer
    const route = web.routes.find(item => item.path === NOTIFICATION_WORKER_PATH)
    expect(route, 'worker route').toBeDefined()
    expect(route?.kind).toBe('exact')
    // The worker must keep its own scope so it cannot control the DSH page.
    expect(NOTIFICATION_WORKER_SCOPE).toBe('/dsh-notifications/')
  } finally { await ctx.fiber.dispose() }
})

it('mounts without a web server', async () => {
  const ctx = await host(false)
  try {
    await ctx.plugin({ name, inject, apply, Config })
    expect((ctx.get('typert') as Typert).contributions).toHaveLength(1)
  } finally { await ctx.fiber.dispose() }
})
