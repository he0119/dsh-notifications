/** Optional same-origin web carrier for the isolated notification worker. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { NOTIFICATION_WORKER_PATH, NOTIFICATION_WORKER_SCOPE, NOTIFICATION_WORKER_SCRIPT } from './service-worker.ts'

/** Follow the public web carrier without making notification delivery depend on Remote. */
export function installNotificationWorkerRoute(ctx: Context): void {
  ctx.inject(['webServer'], scope => {
    scope.effect(() => scope.webServer.register({ kind: 'exact', path: NOTIFICATION_WORKER_PATH, handler(_request, response) {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8')
      response.setHeader('Cache-Control', 'no-cache')
      response.setHeader('Service-Worker-Allowed', NOTIFICATION_WORKER_SCOPE)
      response.end(NOTIFICATION_WORKER_SCRIPT)
    } }))
  })
}
