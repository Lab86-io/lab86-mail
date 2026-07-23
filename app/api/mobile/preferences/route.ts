import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import {
  type MobileNotificationPreferences,
  parseMobileNotificationPreferences,
} from '@/lib/notifications/mobile-preferences';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function responseError(error: unknown) {
  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : 'Notification preferences failed.' },
    { status: error instanceof AuthRequiredError ? 401 : 500 },
  );
}

export async function POST() {
  try {
    const user = await requireCurrentUser();
    const preferences = await convexQuery((api as any).albatrossNotifications.mobilePreferences, {
      userId: user.userId,
    });
    return Response.json({ ok: true, preferences });
  } catch (error) {
    return responseError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireCurrentUser();
    let body: MobileNotificationPreferences;
    try {
      body = parseMobileNotificationPreferences(await request.json());
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : 'Invalid preferences.' },
        { status: 400 },
      );
    }
    await convexMutation((api as any).albatrossNotifications.saveMobilePreferences, {
      userId: user.userId,
      nativePushEnabled: body.nativePushEnabled,
      newMailPushEnabled: body.newMailPushEnabled,
      eventSuggestionPushEnabled: body.eventSuggestionPushEnabled,
      eveningCheckinEnabled: body.eveningCheckinEnabled,
      eveningCheckinLocalTime: body.eveningCheckinLocalTime,
      inAppEnabled: body.inAppEnabled,
      emailFallbackEnabled: body.emailFallbackEnabled,
      emailFallbackDelayMinutes: body.emailFallbackDelayMinutes,
      timezone: body.timezone,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return responseError(error);
  }
}
