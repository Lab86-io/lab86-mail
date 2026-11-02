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
      // A later push with the same tag replaces this one (Needs you: the obligation id),
      // and it alerts again, as an APNs collapse id does. Other pushes stay silent on replace.
      tag: data.tag || data.notificationId || 'albatross',
      renotify: Boolean(data.tag),
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
    let delivered = false;
    try {
      app.postMessage({ type: 'albatross:open-link', url });
      delivered = true;
    } catch (_) {}
    // The tab has the link. The click permission ends at focus, so a new tab cannot open.
    if (delivered) return focusQuietly(app);
  }
  // An app tab may hold a draft, so a page load never goes there.
  const other = clients.find((client) => 'focus' in client && 'navigate' in client && !isAppPage(client));
  if (other) return moveTab(other, url);
  return openNewTab(url);
}

async function focusQuietly(client) {
  try {
    await client.focus();
  } catch (_) {}
}

// A page load can replace the tab, so the tab that navigate returns takes the focus.
async function moveTab(client, url) {
  let moved;
  try {
    moved = await client.navigate(url);
  } catch (_) {
    return openNewTab(url);
  }
  return focusQuietly(moved || client);
}

function openNewTab(url) {
  return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  const inApp = event.notification.data?.inApp === true;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      if (inApp) return openInApp(clients, url);
      const client = clients.find((candidate) => 'focus' in candidate);
      return client ? moveTab(client, url) : openNewTab(url);
    }),
  );
});
