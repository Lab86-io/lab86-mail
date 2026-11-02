// This worker only shows pushes, so a new version can take over at once. A tab
// that it controls can move to a link.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Albatross', {
      body: data.body || 'Albatross needs your input.',
      icon: '/apple-touch-icon.png',
      badge: '/favicon.ico',
      // A later push with the same tag replaces this one (Needs you: the obligation id).
      tag: data.tag || data.notificationId || 'albatross',
      renotify: false,
      data: { url: data.url || '/', inApp: data.inApp === true },
    }),
  );
});

function isAppPage(client) {
  try {
    return new URL(client.url).pathname === '/';
  } catch (_) {
    return false;
  }
}

// Needs you: a tab of the app takes the link with no page load, so a draft in
// it stays. A tab on another page moves to the link. With no tab, or with a tab
// that cannot move, a new tab opens.
async function openInApp(clients, url) {
  const app = clients.find((client) => 'focus' in client && isAppPage(client));
  if (app) {
    app.postMessage({ type: 'albatross:open-link', url });
    return app.focus();
  }
  const other = clients.find((client) => 'focus' in client && 'navigate' in client);
  if (other) {
    try {
      const moved = await other.navigate(url);
      return await (moved || other).focus();
    } catch (_) {}
  }
  return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  const inApp = event.notification.data?.inApp === true;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (inApp) return openInApp(clients, url);
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    }),
  );
});
