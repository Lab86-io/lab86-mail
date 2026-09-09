import { NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { gatherBriefWeather } from '@/lib/mail/brief-weather';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { withDeadline } from '@/lib/shared/deadline';
import { kvList } from '@/lib/store/kv';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const defaults = {
  user: requireCurrentUser,
  rate: enforceUserRateLimit,
  weather: gatherBriefWeather,
  preferences: (userId: string) =>
    convexQuery<any>((api as any).albatrossNotifications.mobilePreferences, { userId }),
  reports: () => kvList<any>('dailyReport', { limit: 1 }),
};
export function createBriefWeatherGet(deps = defaults) {
  return async () => {
    try {
      const user = await deps.user();
      await deps.rate({ userId: user.userId, key: 'brief-weather', limit: 12, windowMs: 60_000 });
      const preferences = await deps.preferences(user.userId).catch(() => null);
      const weather = await runWithAiRequestContext(
        { userId: user.userId, userTimezone: preferences?.timezone || 'UTC' },
        async () => {
          const reports = await deps.reports();
          return withDeadline(
            deps.weather(reports[0] || { sections: {} }, user.userId, {
              mobilePreferencesQuery: async () => preferences,
            }),
            15_000,
            'Today weather',
          ).catch(() => null);
        },
      );
      // The UI does not need to receive precise stored coordinates.
      const { latitude: _latitude, longitude: _longitude, ...forecast } = weather || {};
      return NextResponse.json(
        {
          weather: weather
            ? {
                ...forecast,
                source: weather.source || 'Open-Meteo',
                attributionURL: weather.attributionURL || 'https://open-meteo.com/',
              }
            : null,
          asOf: Date.now(),
        },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    } catch (error) {
      if (error instanceof AuthRequiredError)
        return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
      if (error instanceof RateLimitError) return rateLimitJson(error);
      return NextResponse.json({ error: 'Weather is unavailable.' }, { status: 503 });
    }
  };
}
export const GET = createBriefWeatherGet();
