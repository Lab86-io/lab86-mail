import { internal } from './_generated/api';
import { internalAction, internalQuery } from './_generated/server';

// Local times at which scheduled editions fire (24h clock, in each user's tz).
const MORNING_HOUR = 7;
const EVENING_HOUR = 18;
// Users without a synced calendar timezone fall back to this.
const DEFAULT_TZ = 'America/New_York';

// Users eligible for scheduled editions: anyone with a connected mail account.
// (AI availability is resolved app-side; users without AI still get the
// structured edition.) Each target carries the timezone of their primary
// calendar so morning/evening fire in local time.
export const reportTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query('connectedAccounts').collect();
    const userIds = new Set<string>();
    for (const account of accounts) {
      if (account.status === 'connected') userIds.add(account.userId);
    }
    if (!userIds.size) return [] as Array<{ userId: string; timezone: string }>;

    const calendars = await ctx.db.query('calendars').collect();
    const tzByUser = new Map<string, string>();
    for (const calendar of calendars) {
      if (!userIds.has(calendar.userId) || !calendar.timezone) continue;
      // Prefer the primary calendar's tz; otherwise keep the first one seen.
      if (calendar.isPrimary || !tzByUser.has(calendar.userId)) {
        tzByUser.set(calendar.userId, calendar.timezone);
      }
    }
    return [...userIds].map((userId) => ({ userId, timezone: tzByUser.get(userId) || DEFAULT_TZ }));
  },
});

// The hour (0–23) in `timezone` at instant `at`, or null if the tz is invalid.
function localHour(timezone: string, at: Date): number | null {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(at);
    const hour = Number.parseInt(formatted, 10);
    return Number.isFinite(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}

// Hourly tick: file a morning or evening Daily Brief for each user whose local
// clock has reached the target hour. Generation itself runs in the Next.js app
// (AI + Nylas live there), reached over an internal-secret-protected route; the
// route ACKs immediately and generates in the background, so this stays fast.
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[daily-report cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }

    const targets = await ctx.runQuery(internal.dailyReports.reportTargets, {});
    const at = new Date();
    let fired = 0;
    for (const target of targets) {
      const hour = localHour(target.timezone, at);
      const kind = hour === MORNING_HOUR ? 'morning' : hour === EVENING_HOUR ? 'evening' : null;
      if (!kind) continue;
      try {
        const res = await fetch(`${appUrl}/api/cron/daily-report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-lab86-internal-secret': secret },
          body: JSON.stringify({ userId: target.userId, kind }),
        });
        if (res.ok) fired += 1;
        else console.error('[daily-report cron] app returned', res.status, 'for', target.userId);
      } catch (err) {
        console.error('[daily-report cron] fetch failed for', target.userId, err);
      }
    }
    console.log(`[daily-report cron] tick fired ${fired}/${targets.length} editions`);
  },
});
