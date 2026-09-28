import { v } from 'convex/values';
import {
  addUsageEvents,
  type CostSample,
  emptyCostTotals,
  keepSamples,
  type PeriodCredits,
  previousUsagePeriod,
  usagePeriod,
  windowUpperBound,
} from '../lib/ai/cost-alarm';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { internalAction, mutation, query } from './_generated/server';
import { fanOutInternalPost, requireInternalSecret } from './lib';

// The loop alarm (lib/ai/cost-alarm.ts). The hourly cron only starts the
// app route; the route reads these functions and sends the email. Nothing
// here stops or limits a user.

/** Period rows for each page of active users. Each user adds 2 point reads. */
const USER_PAGE = 100;
/** Usage events for each page of the exact scan. The rows are small. */
const EVENT_PAGE = 1000;

const periodCreditsValidator = v.object({ period: v.string(), credits: v.number() });

async function periodCredits(ctx: QueryCtx, userId: string, period: string): Promise<PeriodCredits | null> {
  const row = await ctx.db
    .query('aiUsagePeriods')
    .withIndex('by_user_period_source', (q) =>
      q.eq('userId', userId).eq('period', period).eq('source', 'lab86'),
    )
    .unique();
  return row ? { period, credits: row.creditsUsed } : null;
}

async function watchRow(ctx: QueryCtx, userId: string): Promise<Doc<'aiCostWatch'> | null> {
  return ctx.db
    .query('aiCostWatch')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique();
}

/**
 * One page of the users with hosted model use since `since`, with this
 * month's and last month's hosted credits. A read only, so the frequent
 * usage writes cannot make it conflict.
 */
export const activeUsage = query({
  args: {
    internalSecret: v.optional(v.string()),
    since: v.number(),
    now: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const page = await ctx.db
      .query('aiUsagePeriods')
      .withIndex('by_source_updated', (q) => q.eq('source', 'lab86').gte('updatedAt', args.since))
      .paginate({ cursor: args.cursor ?? null, numItems: USER_PAGE });
    const period = usagePeriod(args.now);
    const previous = previousUsagePeriod(period);
    const users = [];
    for (const userId of new Set(page.page.map((row) => row.userId))) {
      users.push({
        userId,
        current: (await periodCredits(ctx, userId, period)) ?? { period, credits: 0 },
        previous: await periodCredits(ctx, userId, previous),
      });
    }
    return { users, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Stores this run's sample for each user and returns the upper limit of the
 * user's hosted credits in the window, and whether the user already had an
 * alarm on `day`.
 */
export const recordSamples = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    now: v.number(),
    since: v.number(),
    day: v.string(),
    users: v.array(
      v.object({
        userId: v.string(),
        current: periodCreditsValidator,
        previous: v.union(periodCreditsValidator, v.null()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const results = [];
    for (const user of args.users) {
      const watch = await watchRow(ctx, user.userId);
      const samples: CostSample[] = watch?.samples ?? [];
      const upperBoundCredits = windowUpperBound({
        samples,
        since: args.since,
        current: user.current,
        previous: user.previous,
      });
      const next = keepSamples(samples, { at: args.now, ...user.current }, args.since);
      if (watch) await ctx.db.patch(watch._id, { samples: next, updatedAt: args.now });
      else await ctx.db.insert('aiCostWatch', { userId: user.userId, samples: next, updatedAt: args.now });
      results.push({ userId: user.userId, upperBoundCredits, alertedToday: watch?.alertDay === args.day });
    }
    return results;
  },
});

/** One page of a user's usage events in the window, summed for the alarm. */
export const usagePage = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    since: v.number(),
    until: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const page = await ctx.db
      .query('aiUsageEvents')
      .withIndex('by_user_created', (q) =>
        q.eq('userId', args.userId).gte('createdAt', args.since).lte('createdAt', args.until),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: EVENT_PAGE });
    return {
      totals: addUsageEvents(emptyCostTotals(), page.page),
      events: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Claims the one alarm of `day` for a user. False when it was already sent. */
export const claimAlarm = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    day: v.string(),
    credits: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const watch = await watchRow(ctx, args.userId);
    if (watch?.alertDay === args.day) return { claimed: false };
    const alarm = {
      alertDay: args.day,
      alertCredits: args.credits,
      alertedAt: args.now,
      updatedAt: args.now,
    };
    if (watch) await ctx.db.patch(watch._id, alarm);
    else await ctx.db.insert('aiCostWatch', { userId: args.userId, samples: [], ...alarm });
    return { claimed: true };
  },
});

/** Gives back a claim whose email did not send, so the next run tries again. */
export const releaseAlarm = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), day: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const watch = await watchRow(ctx, args.userId);
    if (watch?.alertDay !== args.day) return { released: false };
    await ctx.db.patch(watch._id, { alertDay: undefined, alertCredits: undefined, alertedAt: undefined });
    return { released: true };
  },
});

/** The hourly cron: starts the app route, which reads the usage and sends the email. */
export const tick = internalAction({
  args: {},
  handler: async () => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[cost-alarm cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    await fanOutInternalPost(`${appUrl}/api/cron/cost-alarm`, secret, [{}], { label: 'cost-alarm cron' });
  },
});
