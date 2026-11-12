/** Isolated classic worker protocol; its scope never controls the DSH root page. */
export const NOTIFICATION_WORKER_PATH = '/dsh-notifications/sw.js'
export const NOTIFICATION_WORKER_SCOPE = '/dsh-notifications/'
export const NOTIFICATION_ACTIVATION_MESSAGE = 'dsh-notifications.notifications.activate.v1'
export const NOTIFICATION_SESSION_PARAMETER = 'dshNotificationSession'
export const NOTIFICATION_WORKER_SCRIPT = `
'use strict';
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    if (!data || typeof data !== 'object' || typeof data.id !== 'string' || typeof data.appUrl !== 'string') return;
    if (data.sessionId !== undefined && (typeof data.sessionId !== 'string' || !data.sessionId)) return;
    let app;
    try { app = new URL(data.appUrl); } catch (_) { return; }
    if (app.origin !== self.location.origin || !['https:', 'http:'].includes(app.protocol)) return;
    app.username = ''; app.password = ''; app.search = ''; app.hash = '';
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const candidates = pages.filter(page => { const url = new URL(page.url); return url.origin === app.origin && url.pathname === app.pathname; });
    candidates.sort((left, right) => Number(!!right.focused) - Number(!!left.focused));
    for (const page of candidates) {
      try {
        const focused = await page.focus();
        if (data.sessionId) (focused || page).postMessage({ type: ${JSON.stringify(NOTIFICATION_ACTIVATION_MESSAGE)}, sessionId: data.sessionId });
        return;
      } catch (_) { /* A closing tab may no longer accept focus. */ }
    }
    if (data.sessionId) app.searchParams.set(${JSON.stringify(NOTIFICATION_SESSION_PARAMETER)}, data.sessionId);
    await self.clients.openWindow(app.href);
  })());
});
`
