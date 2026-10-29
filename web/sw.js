// Service worker for new-mail notifications. It never caches or intercepts requests:
// mail always loads through the signed-in app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const local = url => typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';

// Payload: { title, body, tag, url } with sender and subject only. Every push shows a notification.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(String(data.title || 'New mail').slice(0, 120), {
    body: String(data.body || '').slice(0, 200), tag: typeof data.tag === 'string' ? data.tag : undefined, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: local(data.url) },
  }));
});

// Focus an open Inbox window and let it open the conversation, or open a new one.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(local(event.notification.data?.url), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (open) { await open.focus(); open.postMessage({ type: 'inbox:open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
