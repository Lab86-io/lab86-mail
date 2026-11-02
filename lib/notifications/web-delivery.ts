// Browser push of one notification row (Needs you). The mirror of
// lib/notifications/native-delivery.ts: the Convex claim already decided that
// this push goes, so this file only sends it and records it. A subscription
// that the push service no longer knows (404 or 410) goes away.

import { api, convexMutation, convexQuery } from '../hosted/convex';
import { NEEDS_YOU_LINK, needsYouItemLink } from '../obligations/contract';
import { truncateText } from '../shared/text';
import { type NotificationEnvelope, sendWebPush } from './delivery';
import type { NativeDeliveryOptions } from './native-delivery';

/** A code push says only this. The value, the sender, and the subject stay out of the payload. */
export const CODE_PUSH_TITLE = 'A code is ready';
export const CODE_PUSH_BODY = 'Open Albatross to copy it.';

/** A push payload has a limit near 4 KB. This body and the 180-character title stay under it. */
const WEB_BODY_CHARS = 300;

interface WebDeliveryContext {
  notification: { _id: string; title: string; body: string; deepLink: string; type: string };
  subscriptions: Array<{ endpoint: string; p256dh: string; auth: string }>;
  deliveries: Array<{ channel: string; status: string }>;
}

interface WebDeliveryDependencies {
  query: typeof convexQuery;
  mutate: typeof convexMutation;
  send: typeof sendWebPush;
}

const defaultDependencies: WebDeliveryDependencies = {
  query: convexQuery,
  mutate: convexMutation,
  send: sendWebPush,
};

function errorStatus(error: unknown) {
  const record = (error ?? {}) as { statusCode?: unknown; status?: unknown };
  return Number(record.statusCode || record.status);
}

function webEnvelope(
  userId: string,
  notification: WebDeliveryContext['notification'],
  options: NativeDeliveryOptions,
): NotificationEnvelope {
  const code = options.codeAvailable === true;
  return {
    id: String(notification._id),
    userId,
    type: notification.type,
    title: code ? CODE_PUSH_TITLE : notification.title,
    body: code ? CODE_PUSH_BODY : truncateText(notification.body, WEB_BODY_CHARS),
    deepLink: notification.deepLink,
    appLink: options.obligationId ? needsYouItemLink(options.obligationId) : NEEDS_YOU_LINK,
    ...(code ? ({ codeAvailable: true } as const) : {}),
    ...(options.collapseId ? { collapseId: options.collapseId } : {}),
    ...(options.timeSensitive ? ({ timeSensitive: true } as const) : {}),
    ...(options.obligationId ? { obligationId: options.obligationId } : {}),
  };
}

export async function dispatchWebNotification(
  userId: string,
  notificationId: string,
  dependencies: WebDeliveryDependencies = defaultDependencies,
  options: NativeDeliveryOptions = {},
) {
  const context = await dependencies.query<WebDeliveryContext | null>(
    api.albatrossNotifications.webDeliveryContext,
    { userId, notificationId },
  );
  if (!context?.notification) return { sent: 0, failed: 0, skipped: 'not_found' as const };
  if (!context.subscriptions.length) return { sent: 0, failed: 0, skipped: 'no_subscriptions' as const };
  if (context.deliveries.some((row) => row.channel === 'web_push' && row.status === 'sent'))
    return { sent: 0, failed: 0, skipped: 'already_sent' as const };

  const envelope = webEnvelope(userId, context.notification, options);
  const errors: string[] = [];
  let sent = 0;
  let expired = 0;
  await Promise.all(
    context.subscriptions.map(async (subscription) => {
      try {
        await dependencies.send(envelope, subscription);
        sent += 1;
      } catch (error) {
        const status = errorStatus(error);
        if (status === 404 || status === 410) {
          expired += 1;
          await dependencies
            .mutate(api.albatrossNotifications.expireSubscription, { endpoint: subscription.endpoint })
            .catch(() => undefined);
        } else errors.push(error instanceof Error ? error.message : String(error));
      }
    }),
  );
  const failure = errors.length ? errors.join('; ') : 'All browser subscriptions are expired.';
  // The send is over. A failed record does not make it a failed send.
  await dependencies
    .mutate(api.albatrossNotifications.recordDelivery, {
      userId,
      notificationId,
      channel: 'web_push',
      status: sent > 0 ? 'sent' : 'failed',
      error: sent > 0 ? undefined : truncateText(failure, 500),
    })
    .catch(() => undefined);
  return { sent, failed: errors.length + expired };
}
