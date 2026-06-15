import { internal } from './_generated/api';
import { internalAction, internalQuery } from './_generated/server';
import { fanOutInternalPost } from './lib';

// Local hour the scheduled morning edition fires (24h clock, in each user's tz).
// Evening editions were dropped — mornings + manual generation only.
const MORNING_HOUR = 7;
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
    // Only the users whose local clock is at the morning/evening hour right now.
    const due: Array<{ userId: string; kind: 'morning' }> = [];
    for (const target of targets) {
      if (localHour(target.timezone, at) === MORNING_HOUR) {
        due.push({ userId: target.userId, kind: 'morning' });
      }
    }
    const fired = await fanOutInternalPost(`${appUrl}/api/cron/daily-report`, secret, due, {
      label: 'daily-report cron',
      // Generation is fire-and-forget on the app side (202), so calls return
      // fast; a small timeout just guards against a hung connection.
      timeoutMs: 15_000,
    });
    console.log(`[daily-report cron] tick fired ${fired}/${due.length} editions`);
  },
});
