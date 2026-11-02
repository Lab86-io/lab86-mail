// The browser side of Web Push: ask for permission, subscribe this browser,
// and tell the server. The Web Push row and the Needs you row in Settings both
// use this path. Client only. The browser objects come in as one argument, so
// the tests run without a browser.

export type BrowserPushState = 'unsupported' | 'blocked' | 'off' | 'on';

export interface BrowserPushEnvironment {
  serviceWorker: Pick<ServiceWorkerContainer, 'register' | 'getRegistration'> | null;
  permission: () => NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  publicKey: string | undefined;
  fetch: typeof fetch;
  decode: (base64: string) => string;
}

export function browserPushEnvironment(): BrowserPushEnvironment {
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  return {
    serviceWorker: supported ? navigator.serviceWorker : null,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    // The assertion only matters under Bun's types, where fetch also has preconnect.
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch,
    decode: (base64) => atob(base64),
  };
}

export function urlBase64ToUint8Array(value: string, decode: (base64: string) => string = atob) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from([...decode(base64)].map((character) => character.charCodeAt(0)));
}

async function currentSubscription(env: BrowserPushEnvironment) {
  const registration = await env.serviceWorker?.getRegistration('/albatross-sw.js');
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** What this browser can do now, and if it has an active subscription. */
export async function readBrowserPush(
  env: BrowserPushEnvironment = browserPushEnvironment(),
): Promise<BrowserPushState> {
  if (!env.serviceWorker) return 'unsupported';
  if (env.permission() === 'denied') return 'blocked';
  try {
    return (await currentSubscription(env)) ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** Subscribes this browser and saves the subscription. It throws with a line for the user. */
export async function enableBrowserPush(env: BrowserPushEnvironment = browserPushEnvironment()) {
  if (!env.serviceWorker) throw new Error('This browser does not support Web Push.');
  const permission = await env.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  if (!env.publicKey) throw new Error('Web Push is not configured on this deployment.');
  const registration = await env.serviceWorker.register('/albatross-sw.js');
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(env.publicKey, env.decode),
  });
  // The browser subscribed first. Any failure after this leaves no subscription behind.
  try {
    const response = await env.fetch('/api/notifications/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || 'Could not enable Web Push.');
  } catch (error) {
    await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }
}

/** Removes this browser after a failed save. Each part runs even when the other fails. */
export async function abandonBrowserPush(env: BrowserPushEnvironment = browserPushEnvironment()) {
  const subscription = await currentSubscription(env);
  if (!subscription) return;
  await env
    .fetch('/api/notifications/push', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
    .catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}

/** Removes this browser. The server stops first, so after a failure the switch shows the true state. */
export async function disableBrowserPush(env: BrowserPushEnvironment = browserPushEnvironment()) {
  const subscription = await currentSubscription(env);
  if (!subscription) return;
  const response = await env.fetch('/api/notifications/push', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  if (!response.ok) throw new Error('Could not turn off alerts in this browser.');
  await subscription.unsubscribe();
}
