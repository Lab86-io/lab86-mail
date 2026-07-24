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
    {
      ok: false,
      error: error instanceof AuthRequiredError ? error.message : 'Notification preferences failed.',
    },
    { status: error instanceof AuthRequiredError ? 401 : 500 },
  );
}

interface MobilePreferencesDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  convexQuery: typeof convexQuery;
  convexMutation: typeof convexMutation;
  parseMobileNotificationPreferences: typeof parseMobileNotificationPreferences;
}

const defaultDependencies: MobilePreferencesDependencies = {
  requireCurrentUser,
  convexQuery,
  convexMutation,
  parseMobileNotificationPreferences,
};

export function createMobilePreferencesHandlers(deps: MobilePreferencesDependencies = defaultDependencies) {
  async function post() {
    try {
      const user = await deps.requireCurrentUser();
      const preferences = await deps.convexQuery((api as any).albatrossNotifications.mobilePreferences, {
        userId: user.userId,
      });
      return Response.json({ ok: true, preferences });
    } catch (error) {
      return responseError(error);
    }
  }

  async function put(request: Request) {
    try {
      const user = await deps.requireCurrentUser();
      let body: MobileNotificationPreferences;
      try {
        body = deps.parseMobileNotificationPreferences(await request.json());
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : 'Invalid preferences.' },
          { status: 400 },
        );
      }
      await deps.convexMutation((api as any).albatrossNotifications.saveMobilePreferences, {
        userId: user.userId,
        nativePushEnabled: body.nativePushEnabled,
        newMailPushEnabled: body.newMailPushEnabled,
        eventSuggestionPushEnabled: body.eventSuggestionPushEnabled,
        morningBriefEnabled: body.morningBriefEnabled,
        eveningCheckinEnabled: body.eveningCheckinEnabled,
        eveningCheckinLocalTime: body.eveningCheckinLocalTime,
        inAppEnabled: body.inAppEnabled,
        emailFallbackEnabled: body.emailFallbackEnabled,
        emailFallbackDelayMinutes: body.emailFallbackDelayMinutes,
        timezone: body.timezone,
        briefLocationEnabled: body.briefLocationEnabled,
        briefLatitude: body.briefLatitude,
        briefLongitude: body.briefLongitude,
        briefLocationLabel: body.briefLocationLabel,
        briefLocationAccuracy: body.briefLocationAccuracy,
        briefLocationUpdatedAt: body.briefLocationUpdatedAt,
      });
      return Response.json({ ok: true });
    } catch (error) {
      return responseError(error);
    }
  }

  return { POST: post, PUT: put };
}

export const { POST, PUT } = createMobilePreferencesHandlers();
