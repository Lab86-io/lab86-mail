import { createHmac, timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';
import { hostedPublicUrl } from '@/lib/hosted/env';

interface NotificationDeliveryDependencies {
  fetch: typeof fetch;
  hostedPublicUrl: typeof hostedPublicUrl;
  sendNotification: typeof webpush.sendNotification;
  setVapidDetails: typeof webpush.setVapidDetails;
}

const defaultNotificationDeliveryDependencies: NotificationDeliveryDependencies = {
  fetch,
  hostedPublicUrl,
  sendNotification: webpush.sendNotification.bind(webpush),
  setVapidDetails: webpush.setVapidDetails.bind(webpush),
};

let notificationDeliveryDependencies = defaultNotificationDeliveryDependencies;

export function setNotificationDeliveryDependenciesForTest(
  overrides: Partial<NotificationDeliveryDependencies>,
) {
  const previous = notificationDeliveryDependencies;
  notificationDeliveryDependencies = { ...previous, ...overrides };
  return () => {
    notificationDeliveryDependencies = previous;
  };
}

export interface NotificationEnvelope {
  id: string;
  userId: string;
  title: string;
  body: string;
  deepLink: string;
}

function linkSecret() {
  return process.env.LAB86_NOTIFICATION_LINK_SECRET || '';
}

const NOTIFICATION_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signaturePayload(notificationId: string, userId: string, redirect: string, expiresAt: number) {
  return JSON.stringify([notificationId, userId, redirect, expiresAt]);
}

export function signNotificationLink(
  notificationId: string,
  userId: string,
  redirect: string,
  expiresAt: number,
) {
  const secret = linkSecret();
  if (!secret || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return '';
  return createHmac('sha256', secret)
    .update(signaturePayload(notificationId, userId, redirect, expiresAt))
    .digest('hex');
}

export function verifyNotificationLink(
  notificationId: string,
  userId: string,
  redirect: string,
  signature: string,
  expiresAt: number,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expected = signNotificationLink(notificationId, userId, redirect, expiresAt);
  if (!expected) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

export function notificationOpenUrl(envelope: NotificationEnvelope) {
  const redirect = envelope.deepLink.startsWith('/') ? envelope.deepLink : '/';
  const expiresAt = Date.now() + NOTIFICATION_LINK_TTL_MS;
  const sig = signNotificationLink(envelope.id, envelope.userId, redirect, expiresAt);
  if (!sig) throw new Error('Notification link signing is not configured.');
  const params = new URLSearchParams({
    notificationId: envelope.id,
    userId: envelope.userId,
    redirect,
    expiresAt: String(expiresAt),
    sig,
  });
  return `${notificationDeliveryDependencies.hostedPublicUrl()}/api/notifications/open?${params.toString()}`;
}

const PUSH_SERVICE_HOSTS = new Set([
  'android.googleapis.com',
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

function approvedPushHosts() {
  const configured = String(process.env.LAB86_PUSH_ENDPOINT_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...PUSH_SERVICE_HOSTS, ...configured]);
}

export function isAllowedPushEndpoint(endpoint: string) {
  if (!endpoint || endpoint.length > 4096) return false;
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      return false;
    }
    return (
      approvedPushHosts().has(hostname) ||
      hostname === 'notify.windows.com' ||
      hostname.endsWith('.notify.windows.com')
    );
  } catch {
    return false;
  }
}

function configureWebPush() {
  const subject =
    process.env.VAPID_SUBJECT ||
    `mailto:notifications@${new URL(notificationDeliveryDependencies.hostedPublicUrl()).hostname}`;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) throw new Error('Web push is not configured.');
  notificationDeliveryDependencies.setVapidDetails(subject, publicKey, privateKey);
}

export async function sendWebPush(
  envelope: NotificationEnvelope,
  subscription: { endpoint: string; p256dh: string; auth: string },
) {
  configureWebPush();
  return await notificationDeliveryDependencies.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    JSON.stringify({
      title: envelope.title,
      body: envelope.body,
      url: notificationOpenUrl(envelope),
      notificationId: envelope.id,
    }),
    { TTL: 60 * 60 * 12, urgency: 'normal' },
  );
}

export async function sendCheckinEmail(input: {
  envelope: NotificationEnvelope;
  to: string;
  userName?: string | null;
}) {
  const apiKey = process.env.RESEND_API_KEY || '';
  const from = process.env.LAB86_NOTIFICATION_FROM || '';
  if (!apiKey || !from) throw new Error('Transactional email is not configured.');
  const firstName = String(input.userName || '')
    .trim()
    .split(/\s+/)[0];
  const openUrl = notificationOpenUrl(input.envelope);
  const response = await notificationDeliveryDependencies.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: 'What did you actually get done today?',
      html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:32px 20px;color:#1a1a1a"><p style="font-size:14px;color:#6b6b6b">${firstName ? `${escapeHtml(firstName)}, ` : ''}Albatross is checking in.</p><h1 style="font-family:Georgia,serif;font-size:30px;line-height:1.12;margin:12px 0 16px">What did you actually get done today?</h1><p style="font-size:15px;line-height:1.6;color:#454545">${escapeHtml(input.envelope.body)}</p><p style="margin:26px 0"><a href="${escapeHtml(openUrl)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:11px 16px;border-radius:999px;font-size:14px">Answer Albatross</a></p><p style="font-size:12px;color:#777">You can change check-in time and delivery channels in Lab86 Mail settings.</p></div>`,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.message || `Resend failed (${response.status})`));
  return String(payload?.id || '');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
