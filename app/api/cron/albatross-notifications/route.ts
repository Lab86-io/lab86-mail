import { clerkClient } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { checkinIsDue, fallbackEmailIsDue, localDateKey } from '@/lib/albatross/work-v2';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { type NotificationEnvelope, sendCheckinEmail, sendWebPush } from '@/lib/notifications/delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!isInternalCronRequest(req)) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const userId = String(body.userId || '').trim();
  if (!userId) return Response.json({ ok: false, error: 'userId required' }, { status: 400 });
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (isStagingRuntime(host) && body.force !== true) {
    return Response.json({ ok: true, skipped: true, reason: 'staging' });
  }
  const preference = {
    timezone: String(body.timezone || 'UTC'),
    eveningCheckinEnabled: body.eveningCheckinEnabled !== false,
    eveningCheckinLocalTime: String(body.eveningCheckinLocalTime || '19:00'),
    emailFallbackDelayMinutes: Number(body.emailFallbackDelayMinutes ?? 90),
  };
  const at = new Date();
  let checkin: any = null;
  if (body.force === true || checkinIsDue(preference, at, 15)) {
    const ensured = await convexMutation<any>((api as any).albatrossNotifications.ensureCheckin, {
      userId,
      localDate: localDateKey(preference.timezone, at),
      timezone: preference.timezone,
    });
    checkin = ensured?.checkin;
  }
  if (!checkin) {
    checkin = await convexQuery<any>((api as any).albatrossNotifications.latestUnansweredCheckin, { userId });
  }
  if (!checkin) return Response.json({ ok: true, due: false });
  const context = await convexQuery<any>((api as any).albatrossNotifications.deliveryContext, {
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
          await convexMutation((api as any).albatrossNotifications.expireSubscription, {
            endpoint: subscription.endpoint,
          });
        }
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    await convexMutation((api as any).albatrossNotifications.recordDelivery, {
      userId,
      notificationId: String(notification._id),
      channel: 'web_push',
      status: sent > 0 ? 'sent' : 'failed',
      error: sent > 0 ? undefined : errors.join('; ').slice(0, 500),
    });
    results.webPush = { sent, failed: errors.length };
  }

  const emailDue =
    body.emailFallbackEnabled !== false &&
    fallbackEmailIsDue({
      checkinCreatedAt: checkin.createdAt,
      answeredAt: checkin.answeredAt,
      delayMinutes: preference.emailFallbackDelayMinutes,
    });
  if (emailDue && !sentChannels.has('email')) {
    try {
      const client = await clerkClient();
      const user = await client.users.getUser(userId);
      const to =
        user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ||
        user.emailAddresses[0]?.emailAddress ||
        '';
      if (!to) throw new Error('No notification email address found.');
      const providerId = await sendCheckinEmail({ envelope, to, userName: user.fullName || user.firstName });
      await convexMutation((api as any).albatrossNotifications.recordDelivery, {
        userId,
        notificationId: String(notification._id),
        channel: 'email',
        status: 'sent',
        providerId,
      });
      results.email = 'sent';
    } catch (error) {
      await convexMutation((api as any).albatrossNotifications.recordDelivery, {
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
}
