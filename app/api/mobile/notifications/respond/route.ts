import { z } from 'zod';
import { checkinCallerArgs } from '@/lib/albatross/checkin';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const responseSchema = z.object({
  notificationId: z.string().min(1).max(200),
  responseText: z.string().trim().min(1).max(10_000),
  promptKind: z.enum(['reflection', 'tomorrow']).optional(),
});

interface NotificationResponseDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  query: typeof convexQuery;
  mutate: typeof convexMutation;
}

const defaultDependencies: NotificationResponseDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  query: convexQuery,
  mutate: convexMutation,
};

export function createNotificationResponsePost(
  dependencies: NotificationResponseDependencies = defaultDependencies,
) {
  return async function post(request: Request) {
    try {
      const user = await dependencies.requireCurrentUser();
      const parsed = responseSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return Response.json({ ok: false, error: 'A notification response is required.' }, { status: 400 });
      }
      await dependencies.enforceUserRateLimit({
        userId: user.userId,
        key: 'mobile-notification-response',
        limit: 30,
        windowMs: 60_000,
      });
      const notification = await dependencies.query<any>(
        (api as any).albatrossNotifications.notificationResponseContext,
        {
          userId: user.userId,
          notificationId: parsed.data.notificationId,
        },
      );
      if (
        !notification ||
        notification.type !== 'daily_checkin' ||
        notification.entityKind !== 'checkin' ||
        !notification.entityId
      ) {
        return Response.json({ ok: false, error: 'Replyable notification not found.' }, { status: 404 });
      }
      // The durable, user-owned notification is authoritative. The client
      // hint is intentionally ignored so one notification cannot write into
      // the other prompt's field.
      const promptKind = /[?&]prompt=tomorrow\b/.test(String(notification.deepLink || ''))
        ? 'tomorrow'
        : 'reflection';
      const result = await dependencies.mutate<any>((api as any).albatrossNotifications.answerCheckin, {
        ...checkinCallerArgs(user.userId),
        checkinId: String(notification.entityId),
        promptKind,
        responseText: parsed.data.responseText,
        completed: [],
      });
      return Response.json({ ok: true, promptKind, status: result?.status || 'open' });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      console.error('[mobile notification response]', error);
      return Response.json(
        { ok: false, error: 'The notification response could not be saved.' },
        { status: 500 },
      );
    }
  };
}

export const POST = createNotificationResponsePost();
