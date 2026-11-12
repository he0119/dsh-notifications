import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it } from 'vitest'
import { installNotificationWorkerRoute } from '../src/web.ts'
import { NOTIFICATION_WORKER_PATH, NOTIFICATION_WORKER_SCRIPT } from '../src/service-worker.ts'

it('serves only the exact worker path on the public web carrier and removes it with its owner', async () => {
  const ctx = new Context()
  try {
    const owner = ctx.inject([], scope => installNotificationWorkerRoute(scope)); await owner.await()
    expect(ctx.get('webServer')).toBeUndefined()
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await new Promise(resolve => setTimeout(resolve, 0))
    const origin = ctx.webServer.getOrigin(), response = await fetch(origin + NOTIFICATION_WORKER_PATH)
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('javascript'); expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toBe(NOTIFICATION_WORKER_SCRIPT)
    expect((await fetch(origin + NOTIFICATION_WORKER_PATH + '/other')).status).toBe(404)
    await owner.dispose(); expect((await fetch(origin + NOTIFICATION_WORKER_PATH)).status).toBe(404)
  } finally { await ctx.fiber.dispose() }
})
