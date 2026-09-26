import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { QueryCtx } from './_generated/server';
import { internalAction, internalQuery, query } from './_generated/server';
import { fanOutInternalPost, requireInternalSecret } from './lib';

// Local hour the scheduled morning edition fires (24h clock, in each user's tz).
// Evening editions were dropped — mornings + manual generation only.
export const MORNING_HOUR = 7;
// Catch-up window (brief round 2026-09-22): when the 07:00 tick failed (a
// deploy, a model outage, a timeout), each later hourly tick inside this
// window fires again for every user who still has no morning edition for the
// local date. The window closes at noon so a late brief never lands at night.
export const CATCH_UP_LAST_HOUR = 11;
// The clock that schedules users with no known zone. It only picks the hour
// the cron fires; it is never written into the job as the user's zone.
const DEFAULT_TZ = 'America/New_York';
const SCHEDULE_ONLY_TZ = DEFAULT_TZ;

/** A real, resolvable IANA zone. UTC/GMT/Etc are provider filler, not a place. */
export function isRealZone(tz: string | null | undefined): tz is string {
  const value = String(tz || '').trim();
  if (!value || /^(UTC|GMT|Etc\/)/i.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export interface BriefTimezoneSources {
  preference: string | null;
  calendars: Array<{ timezone?: string | null; isPrimary?: boolean | null }>;
  lastClient: string | null;
}

/** The brief zone: the notification preference, then the calendars (primary
 * first), then the zone the user's own client last sent. Never a default. */
export function pickBriefZone(sources: BriefTimezoneSources): string | undefined {
  if (isRealZone(sources.preference)) return sources.preference;
  let calendarZone: string | undefined;
  for (const calendar of sources.calendars) {
    if (!isRealZone(calendar.timezone)) continue;
    if (calendar.isPrimary) return calendar.timezone;
    calendarZone ??= calendar.timezone;
  }
  if (calendarZone) return calendarZone;
  return isRealZone(sources.lastClient) ? sources.lastClient : undefined;
}

async function briefTimezoneSourcesFor(ctx: QueryCtx, userId: string): Promise<BriefTimezoneSources> {
  const [preference, calendars, jobs] = await Promise.all([
    ctx.db
      .query('albatrossNotificationPreferences')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique(),
    ctx.db
      .query('calendars')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
    ctx.db
      .query('briefJobs')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(20),
  ]);
  // A manual edition is the only job whose zone the user's client sent.
  const lastClient =
    jobs.find((job) => job.kind === 'daily' && job.edition === 'manual' && isRealZone(job.timezone))
      ?.timezone ?? null;
  return {
    preference: preference?.timezone ?? null,
    calendars: calendars.map((calendar) => ({ timezone: calendar.timezone, isPrimary: calendar.isPrimary })),
    lastClient,
  };
}

/** The sources the app resolves a brief zone from, for a job with no usable zone. */
export const briefTimezoneSources = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await briefTimezoneSourcesFor(ctx, args.userId);
  },
});

function isStagingCronTarget(appUrl: string) {
  const environment = String(
    process.env.RAILWAY_ENVIRONMENT_NAME || process.env.LAB86_MAIL_ENV || process.env.LAB86_ENV || '',
  ).toLowerCase();
  if (environment === 'staging' || environment === 'development') return true;
  try {
    const host = new URL(appUrl).hostname.toLowerCase();
    return host === 'mail-staging.lab86.io';
  } catch {
    return /\bstaging\b/i.test(appUrl);
  }
}

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
      // UTC/GMT/Etc are provider filler, not the user's place — a UTC-labeled
      // primary must not beat a real zone (or the morning edition fires at
      // 7am UTC and the brief datelines the wrong locale).
      if (/^(UTC|GMT|Etc\/)/i.test(calendar.timezone)) continue;
      // Prefer the primary calendar's tz; otherwise keep the first one seen.
      if (calendar.isPrimary || !tzByUser.has(calendar.userId)) {
        tzByUser.set(calendar.userId, calendar.timezone);
      }
    }
    return [...userIds].map((userId) => ({ userId, timezone: tzByUser.get(userId) || DEFAULT_TZ }));
  },
});

// Two users fit in a single network batch. The next action resumes by user
// identity, skipping that user's other accounts without dropping later users.
const TARGET_BATCH_SIZE = 2;
export const reportTargetPage = internalQuery({
  args: { afterUserId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_status_user', (q) =>
        args.afterUserId
          ? q.eq('status', 'connected').gt('userId', args.afterUserId)
          : q.eq('status', 'connected'),
      )
      .take(TARGET_BATCH_SIZE);
    const userIds = [...new Set(accounts.map((account) => account.userId))];
    const targets = await Promise.all(
      userIds.map(async (userId) => {
        const zone = pickBriefZone(await briefTimezoneSourcesFor(ctx, userId));
        // `timezone` schedules the tick; `zoneKnown` says whether it is the
        // user's real zone and may be written into the job.
        return { userId, timezone: zone ?? SCHEDULE_ONLY_TZ, zoneKnown: Boolean(zone) };
      }),
    );
    return { targets, nextUserId: accounts.length === TARGET_BATCH_SIZE ? userIds.at(-1) : undefined };
  },
});

// The local calendar date (YYYY-MM-DD) in `timezone` at instant `at`.
export function localDateKey(timezone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

// True when the user already has a morning edition dated today in their zone.
export const hasMorningEdition = internalQuery({
  args: { userId: v.string(), timezone: v.string(), at: v.number() },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_report_edition_generated', (q) =>
        q.eq('userId', args.userId).eq('kind', 'dailyReport').eq('doc.kind', 'morning'),
      )
      .order('desc')
      .first();
    const generatedAt = Number((latest as any)?.doc?.generatedAt || 0);
    if (!generatedAt) return false;
    return (
      localDateKey(args.timezone, new Date(generatedAt)) === localDateKey(args.timezone, new Date(args.at))
    );
  },
});

// Which targets fire on this tick: the morning hour always, and the catch-up
// hours only when the local date has no morning edition yet. Pure, for tests.
export function dueTargets(
  targets: Array<{ userId: string; timezone: string }>,
  at: Date,
  hasEdition: (target: { userId: string; timezone: string }) => boolean,
) {
  const due: Array<{ userId: string; kind: 'morning'; timezone: string; catchUp: boolean }> = [];
  for (const target of targets) {
    const hour = localHour(target.timezone, at);
    if (hour === MORNING_HOUR) {
      due.push({ userId: target.userId, kind: 'morning', timezone: target.timezone, catchUp: false });
    } else if (hour !== null && hour > MORNING_HOUR && hour <= CATCH_UP_LAST_HOUR && !hasEdition(target)) {
      due.push({ userId: target.userId, kind: 'morning', timezone: target.timezone, catchUp: true });
    }
  }
  return due;
}

// The hour (0–23) in `timezone` at instant `at`, or null if the tz is invalid.
export function localHour(timezone: string, at: Date): number | null {
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

// Hourly tick: file a morning Daily Brief for each user whose local clock has
// reached the target hour. Generation itself runs in the Next.js app
// (AI + Nylas live there), reached over an internal-secret-protected route. The
// route acknowledges a persisted job; background workers finish independently.
export const tick = internalAction({
  args: { afterUserId: v.optional(v.string()), at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[daily-report cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    if (isStagingCronTarget(appUrl)) {
      console.log('[daily-report cron] skipped on staging target');
      return;
    }

    const { targets, nextUserId } = await ctx.runQuery(internal.dailyReports.reportTargetPage, {
      afterUserId: args.afterUserId,
    });
    const at = new Date(args.at ?? Date.now());
    // The morning hour fires every target. Inside the catch-up window only
    // the users with no edition for the local date fire again.
    const editionByUser = new Map<string, boolean>();
    for (const target of targets) {
      const hour = localHour(target.timezone, at);
      if (hour === null || hour <= MORNING_HOUR || hour > CATCH_UP_LAST_HOUR) continue;
      editionByUser.set(
        target.userId,
        await ctx.runQuery(internal.dailyReports.hasMorningEdition, {
          userId: target.userId,
          timezone: target.timezone,
          at: at.getTime(),
        }),
      );
    }
    const unknownZone = new Set(
      targets.filter((target: any) => target.zoneKnown === false).map((target) => target.userId),
    );
    const due = dueTargets(targets, at, (target) => editionByUser.get(target.userId) !== false).map(
      ({ catchUp, ...target }) => {
        if (catchUp) console.log(`[daily-report cron] catch-up edition for ${target.userId}`);
        // Never send the scheduling clock as the user's zone.
        return unknownZone.has(target.userId) ? { userId: target.userId, kind: target.kind } : target;
      },
    );
    // The morning hour also rewrites every area's living brief so the Daily
    // Brief and the area views open on the same fresh context. The daily brief
    // reads the area pulses, so the area jobs are queued first.
    const briefed = await fanOutInternalPost(
      `${appUrl}/api/cron/area-briefs`,
      secret,
      due.map((target) => ({ userId: target.userId })),
      { label: 'area-briefs cron', concurrency: 2 },
    );
    const fired = await fanOutInternalPost(`${appUrl}/api/cron/daily-report`, secret, due, {
      label: 'daily-report cron',
      concurrency: 2,
    });
    if (nextUserId)
      await ctx.scheduler.runAfter(0, internal.dailyReports.tick, {
        afterUserId: nextUserId,
        at: at.getTime(),
      });
    console.log(
      `[daily-report cron] tick fired ${fired}/${due.length} editions, ${briefed}/${due.length} area-brief refreshes`,
    );
  },
});

// Every 3 hours (brief round 2026-09-22): refresh each active area's living
// brief without force. The generator compares the bounded source revision and
// skips unchanged areas, so a quiet area costs one query and no model call.
export const areaRefreshTick = internalAction({
  args: { afterUserId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[area-refresh cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    if (isStagingCronTarget(appUrl)) {
      console.log('[area-refresh cron] skipped on staging target');
      return;
    }
    const { targets, nextUserId } = await ctx.runQuery(internal.dailyReports.reportTargetPage, {
      afterUserId: args.afterUserId,
    });
    const refreshed = await fanOutInternalPost(
      `${appUrl}/api/cron/area-briefs`,
      secret,
      targets.map((target) => ({ userId: target.userId, force: false })),
      { label: 'area-refresh cron', concurrency: 2 },
    );
    if (nextUserId)
      await ctx.scheduler.runAfter(0, internal.dailyReports.areaRefreshTick, { afterUserId: nextUserId });
    console.log(`[area-refresh cron] refreshed ${refreshed}/${targets.length} users`);
  },
});
