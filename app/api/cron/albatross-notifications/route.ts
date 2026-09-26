import { clerkClient } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { checkinIsDue, fallbackEmailIsDue, localDateKey } from '@/lib/albatross/work-v2';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import {
  type NotificationEnvelope,
  sendCheckinEmail,
  sendWebPush,
  transactionalEmailConfigured,
} from '@/lib/notifications/delivery';
import { dispatchNativeNotification } from '@/lib/notifications/native-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface NotificationCronDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  isStagingRuntime: typeof isStagingRuntime;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  dispatchNativeNotification: typeof dispatchNativeNotification;
  sendWebPush: typeof sendWebPush;
  sendCheckinEmail: typeof sendCheckinEmail;
  transactionalEmailConfigured: typeof transactionalEmailConfigured;
  primaryEmail: (userId: string) => Promise<{ to: string; userName?: string | null }>;
  now: () => Date;
}

async function clerkPrimaryEmail(userId: string) {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const to =
    user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ||
    user.emailAddresses[0]?.emailAddress ||
    '';
  return { to, userName: user.fullName || user.firstName };
}

const defaults: NotificationCronDependencies = {
  isInternalCronRequest,
  isStagingRuntime,
  convexMutation,
  convexQuery,
  dispatchNativeNotification,
  sendWebPush,
  sendCheckinEmail,
  transactionalEmailConfigured,
  primaryEmail: clerkPrimaryEmail,
  now: () => new Date(),
};

export function createAlbatrossNotificationsPost(overrides: Partial<NotificationCronDependencies> = {}) {
  const deps: NotificationCronDependencies = { ...defaults, ...overrides };
  const { convexMutation, convexQuery, dispatchNativeNotification, sendWebPush } = deps;
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const userId = String(body.userId || '').trim();
    if (!userId) return Response.json({ ok: false, error: 'userId required' }, { status: 400 });
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    if (deps.isStagingRuntime(host) && body.force !== true) {
      return Response.json({ ok: true, skipped: true, reason: 'staging' });
    }
    const preference = {
      timezone: String(body.timezone || 'UTC'),
      eveningCheckinEnabled: body.eveningCheckinEnabled !== false,
      eveningCheckinLocalTime: String(body.eveningCheckinLocalTime || '19:00'),
      emailFallbackDelayMinutes: Number(body.emailFallbackDelayMinutes ?? 90),
    };
    const at = deps.now();
    let checkin: any = null;
    let dueNotificationIds: string[] = [];
    let ensuredToday = false;
    if (body.force === true || checkinIsDue(preference, at)) {
      const ensured = await convexMutation<any>(api.albatrossNotifications.ensureCheckin, {
        userId,
        localDate: localDateKey(preference.timezone, at),
        timezone: preference.timezone,
      });
      checkin = ensured?.checkin;
      ensuredToday = Boolean(ensured?.checkin);
      // The check-in stays due all evening, so push only prompts that are
      // still unread (WRK-15).
      dueNotificationIds = Array.isArray(ensured?.openNotificationIds)
        ? ensured.openNotificationIds.map(String)
        : Array.isArray(ensured?.notificationIds)
          ? ensured.notificationIds.map(String)
          : ensured?.notificationId
            ? [String(ensured.notificationId)]
            : [];
    }
    if (!checkin) {
      checkin = await convexQuery<any>(api.albatrossNotifications.latestUnansweredCheckin, {
        userId,
      });
    }
    if (!checkin) return Response.json({ ok: true, due: false });
    const context = await convexQuery<any>(api.albatrossNotifications.deliveryContext, {
      userId,
      checkinId: String(checkin._id),
    });
    if (!context?.notification) return Response.json({ ok: true, due: false });
    const notification = context.notification;
    const envelope: NotificationEnvelope = {
      id: String(notification._id),
      userId,
      title: notification.title,
      body: notification.body,
      deepLink: notification.deepLink,
    };
    const sentChannels = new Set(
      (context.deliveries || [])
        .filter((delivery: any) => delivery.status === 'sent')
        .map((delivery: any) => delivery.channel),
    );
    const results: Record<string, unknown> = {};

    if (
      body.nativePushEnabled !== false &&
      context.preference?.nativePushEnabled !== false &&
      context.mobileDevices?.length
    ) {
      // `ensured` carries the unread alignment prompts on the due path. On
      // fallback lookup, the open prompt's notification is the single target.
      const nativeNotificationIds =
        dueNotificationIds.length || ensuredToday ? dueNotificationIds : [String(notification._id)];
      results.nativePush = await Promise.all(
        nativeNotificationIds.map((id: string) => dispatchNativeNotification(userId, String(id))),
      );
    }

    if (body.webPushEnabled === true && !sentChannels.has('web_push') && context.subscriptions?.length) {
      let sent = 0;
      const errors: string[] = [];
      for (const subscription of context.subscriptions) {
        try {
          await sendWebPush(envelope, subscription);
          sent += 1;
        } catch (error: any) {
          const statusCode = Number(error?.statusCode || error?.status);
          if (statusCode === 404 || statusCode === 410) {
            await convexMutation(api.albatrossNotifications.expireSubscription, {
              endpoint: subscription.endpoint,
            });
          }
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      await convexMutation(api.albatrossNotifications.recordDelivery, {
        userId,
        notificationId: String(notification._id),
        channel: 'web_push',
        status: sent > 0 ? 'sent' : 'failed',
        error: sent > 0 ? undefined : errors.join('; ').slice(0, 500),
      });
      results.webPush = { sent, failed: errors.length };
    }

    // Without transactional email configuration a send can only fail, so the
    // fallback is off by default and records nothing (INF-4).
    const emailDue =
      body.emailFallbackEnabled !== false &&
      deps.transactionalEmailConfigured() &&
      fallbackEmailIsDue({
        checkinCreatedAt: checkin.createdAt,
        answeredAt: checkin.answeredAt,
        delayMinutes: preference.emailFallbackDelayMinutes,
      });
    if (emailDue && !sentChannels.has('email')) {
      try {
        const { to, userName } = await deps.primaryEmail(userId);
        if (!to) throw new Error('No notification email address found.');
        const providerId = await deps.sendCheckinEmail({ envelope, to, userName });
        await convexMutation(api.albatrossNotifications.recordDelivery, {
          userId,
          notificationId: String(notification._id),
          channel: 'email',
          status: 'sent',
          providerId,
        });
        results.email = 'sent';
      } catch (error) {
        await convexMutation(api.albatrossNotifications.recordDelivery, {
          userId,
          notificationId: String(notification._id),
          channel: 'email',
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        results.email = 'failed';
      }
    }
    return Response.json({ ok: true, checkinId: String(checkin._id), ...results });
  };
}

export const POST = createAlbatrossNotificationsPost();
