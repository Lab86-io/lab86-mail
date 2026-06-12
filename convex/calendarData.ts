import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Calendar corpus storage (see docs/productivity-platform-spec.md). Writers
// are the Next server's sync/mutation paths (internal secret); the calendar
// surface reads live via Clerk identity so provider writes show up pushed.

async function requireUserId(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

const calendarInput = v.object({
  providerCalendarId: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  timezone: v.optional(v.string()),
  isPrimary: v.optional(v.boolean()),
  readOnly: v.optional(v.boolean()),
  hexColor: v.optional(v.string()),
});

const eventInput = v.object({
  providerEventId: v.string(),
  providerCalendarId: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  status: v.optional(v.string()),
  busy: v.optional(v.boolean()),
  readOnly: v.optional(v.boolean()),
  startAt: v.number(),
  endAt: v.number(),
  allDay: v.optional(v.boolean()),
  startTimezone: v.optional(v.string()),
  endTimezone: v.optional(v.string()),
  masterEventId: v.optional(v.string()),
  recurrence: v.optional(v.array(v.string())),
  participants: v.optional(v.array(v.any())),
  organizer: v.optional(v.any()),
  conferencing: v.optional(v.any()),
  icalUid: v.optional(v.string()),
  htmlLink: v.optional(v.string()),
});

const accountScope = {
  internalSecret: v.optional(v.string()),
  userId: v.string(),
  accountId: v.string(),
  grantId: v.string(),
  provider: v.union(v.literal('google'), v.literal('microsoft'), v.literal('icloud'), v.literal('imap')),
};

export const upsertCalendarBatch = mutation({
  args: {
    ...accountScope,
    calendars: v.array(calendarInput),
    // Calendars absent from a full listing were deleted upstream.
    pruneMissing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const existing = await ctx.db
      .query('calendars')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .collect();
    const byProviderId = new Map(existing.map((row) => [row.providerCalendarId, row]));
    const seen = new Set<string>();
    for (const cal of args.calendars) {
      seen.add(cal.providerCalendarId);
      const row = byProviderId.get(cal.providerCalendarId);
      if (row) {
        await ctx.db.patch(row._id, { ...cal, updatedAt: ts });
      } else {
        await ctx.db.insert('calendars', {
          ...cal,
          userId: args.userId,
          accountId: args.accountId,
          grantId: args.grantId,
          provider: args.provider,
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }
    if (args.pruneMissing) {
      for (const row of existing) {
        if (seen.has(row.providerCalendarId)) continue;
        await ctx.db.delete(row._id);
        // Orphaned events of a deleted calendar go with it.
        const events = await ctx.db
          .query('calendarEvents')
          .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
          .collect();
        for (const event of events) {
          if (event.providerCalendarId === row.providerCalendarId) await ctx.db.delete(event._id);
        }
      }
    }
    return { ok: true, count: args.calendars.length };
  },
});

export const upsertEventBatch = mutation({
  args: {
    ...accountScope,
    events: v.array(eventInput),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    for (const event of args.events) {
      const row = await ctx.db
        .query('calendarEvents')
        .withIndex('by_account_event', (q) =>
          q.eq('accountId', args.accountId).eq('providerEventId', event.providerEventId),
        )
        .unique();
      if (row) {
        await ctx.db.patch(row._id, { ...event, updatedAt: ts });
      } else {
        await ctx.db.insert('calendarEvents', {
          ...event,
          userId: args.userId,
          accountId: args.accountId,
          grantId: args.grantId,
          provider: args.provider,
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }
    return { ok: true, count: args.events.length };
  },
});

export const deleteEvent = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerEventId: v.string(),
    // Recurring deletes take the expanded instances with the master.
    includeInstances: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('calendarEvents')
      .withIndex('by_account_event', (q) =>
        q.eq('accountId', args.accountId).eq('providerEventId', args.providerEventId),
      )
      .unique();
    if (row && row.userId === args.userId) await ctx.db.delete(row._id);
    if (args.includeInstances) {
      const instances = await ctx.db
        .query('calendarEvents')
        .withIndex('by_account_master', (q) =>
          q.eq('accountId', args.accountId).eq('masterEventId', args.providerEventId),
        )
        .collect();
      for (const instance of instances) {
        if (instance.userId === args.userId) await ctx.db.delete(instance._id);
      }
    }
    return { ok: true };
  },
});

// Replace the synced window for one calendar: delete rows inside the bounds
// that the fresh listing no longer contains, upsert the rest. Run per page is
// wrong — callers invoke this once with the full window's event ids.
export const reconcileWindow = mutation({
  args: {
    ...accountScope,
    providerCalendarId: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
    keepProviderEventIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const keep = new Set(args.keepProviderEventIds);
    const rows = await ctx.db
      .query('calendarEvents')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .collect();
    let pruned = 0;
    for (const row of rows) {
      if (row.providerCalendarId !== args.providerCalendarId) continue;
      if (row.startAt < args.windowStart || row.startAt > args.windowEnd) continue;
      if (keep.has(row.providerEventId)) continue;
      await ctx.db.delete(row._id);
      pruned += 1;
    }
    return { ok: true, pruned };
  },
});

export const markSyncState = mutation({
  args: {
    ...accountScope,
    status: v.optional(
      v.union(
        v.literal('idle'),
        v.literal('syncing'),
        v.literal('ready'),
        v.literal('error'),
        v.literal('unauthorized'),
      ),
    ),
    error: v.optional(v.string()),
    calendarsSynced: v.optional(v.number()),
    eventsSynced: v.optional(v.number()),
    windowStart: v.optional(v.number()),
    windowEnd: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const existing = await ctx.db
      .query('calendarSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    const patch: Record<string, unknown> = { updatedAt: ts };
    for (const key of [
      'status',
      'calendarsSynced',
      'eventsSynced',
      'windowStart',
      'windowEnd',
      'lastSyncedAt',
    ] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    // error clears on any status change that isn't an explicit error.
    if (args.error !== undefined) patch.error = args.error;
    else if (args.status && args.status !== 'error' && args.status !== 'unauthorized')
      patch.error = undefined;
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return ctx.db.insert('calendarSyncStates', {
      userId: args.userId,
      accountId: args.accountId,
      grantId: args.grantId,
      provider: args.provider,
      status: args.status ?? 'idle',
      error: args.error,
      calendarsSynced: args.calendarsSynced,
      eventsSynced: args.eventsSynced,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      lastSyncedAt: args.lastSyncedAt,
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const getSyncStates = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.db
      .query('calendarSyncStates')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
  },
});

export const listCalendars = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.db
      .query('calendars')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
  },
});

export const getEventByProviderId = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerEventId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('calendarEvents')
      .withIndex('by_account_event', (q) =>
        q.eq('accountId', args.accountId).eq('providerEventId', args.providerEventId),
      )
      .unique();
    return row && row.userId === args.userId ? row : null;
  },
});

export const listEvents = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    startAt: v.number(),
    endAt: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return queryEventsInWindow(ctx, args.userId, args.startAt, args.endAt, args.limit);
  },
});

// Live feeds for the calendar surface.
export const liveCalendars = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const [calendars, syncStates] = await Promise.all([
      ctx.db
        .query('calendars')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('calendarSyncStates')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    ]);
    return { calendars, syncStates };
  },
});

export const liveEvents = query({
  args: {
    startAt: v.number(),
    endAt: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return queryEventsInWindow(ctx, userId, args.startAt, args.endAt, args.limit);
  },
});

async function queryEventsInWindow(
  ctx: QueryCtx,
  userId: string,
  startAt: number,
  endAt: number,
  limit?: number,
) {
  const cap = Math.min(Math.max(limit ?? 2000, 1), 5000);
  // Events overlapping [startAt, endAt): rows starting inside the window plus
  // rows that started earlier but end inside it. Multi-day spans are bounded
  // (longest realistic events are weeks), so the lookback is 62 days.
  const lookback = 62 * 24 * 60 * 60 * 1000;
  const rows = await ctx.db
    .query('calendarEvents')
    .withIndex('by_user_start', (q) =>
      q
        .eq('userId', userId)
        .gte('startAt', startAt - lookback)
        .lt('startAt', endAt),
    )
    .take(cap);
  return rows.filter((row) => row.endAt > startAt && row.status !== 'cancelled');
}
