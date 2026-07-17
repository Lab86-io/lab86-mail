import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { QueryCtx } from './_generated/server';
import { internalMutation, mutation, query } from './_generated/server';
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
  searchText: v.optional(v.string()),
  yearMonth: v.optional(v.string()),
  providerUpdatedAt: v.optional(v.number()),
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
      const removed = existing.filter((row) => !seen.has(row.providerCalendarId));
      if (removed.length) {
        // One account-wide event fetch, not one per removed calendar.
        const events = await ctx.db
          .query('calendarEvents')
          .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
          .collect();
        const removedIds = new Set(removed.map((row) => row.providerCalendarId));
        for (const row of removed) await ctx.db.delete(row._id);
        for (const event of events) {
          if (removedIds.has(event.providerCalendarId)) {
            await ctx.db.delete(event._id);
          }
        }
        await deleteLegacyCalendarCorpus(ctx, args.userId, args.accountId, removedIds);
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
      const patch = {
        ...event,
        searchText: normalizeCalendarCorpusText(event.searchText || buildEventSearchText(event)),
        yearMonth: event.yearMonth || yearMonth(event.startAt),
        updatedAt: ts,
      };
      const row = await ctx.db
        .query('calendarEvents')
        .withIndex('by_account_calendar_event', (q) =>
          q
            .eq('accountId', args.accountId)
            .eq('providerCalendarId', event.providerCalendarId)
            .eq('providerEventId', event.providerEventId),
        )
        .unique();
      if (row) {
        if (row.userId !== args.userId) {
          throw new Error(`Cross-user calendar event collision for ${event.providerEventId}.`);
        }
        await ctx.db.patch(row._id, patch);
      } else {
        await ctx.db.insert('calendarEvents', {
          ...patch,
          userId: args.userId,
          accountId: args.accountId,
          grantId: args.grantId,
          provider: args.provider,
          createdAt: ts,
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
    providerCalendarId: v.optional(v.string()),
    providerEventId: v.string(),
    // Recurring deletes take the expanded instances with the master.
    includeInstances: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await findEventByProviderId(ctx, args);
    if (row && row.userId === args.userId) await ctx.db.delete(row._id);
    await deleteLegacyCorpusEvent(ctx, args);
    if (args.includeInstances) {
      const instances = await ctx.db
        .query('calendarEvents')
        .withIndex('by_account_master', (q) =>
          q.eq('accountId', args.accountId).eq('masterEventId', args.providerEventId),
        )
        .collect();
      for (const instance of instances) {
        if (args.providerCalendarId && instance.providerCalendarId !== args.providerCalendarId) continue;
        if (instance.userId === args.userId) {
          await ctx.db.delete(instance._id);
          await deleteLegacyCorpusEvent(ctx, {
            userId: args.userId,
            accountId: args.accountId,
            providerCalendarId: instance.providerCalendarId,
            providerEventId: instance.providerEventId,
          });
        }
      }
    }
    return { ok: true };
  },
});

export const removeCalendar = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerCalendarId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('calendars')
      .withIndex('by_account_calendar', (q) =>
        q.eq('accountId', args.accountId).eq('providerCalendarId', args.providerCalendarId),
      )
      .unique();
    if (row && row.userId === args.userId) await ctx.db.delete(row._id);
    const events = await ctx.db
      .query('calendarEvents')
      .withIndex('by_user_account_calendar_start', (q) =>
        q
          .eq('userId', args.userId)
          .eq('accountId', args.accountId)
          .eq('providerCalendarId', args.providerCalendarId),
      )
      .collect();
    for (const event of events) await ctx.db.delete(event._id);
    await deleteLegacyCalendarCorpus(ctx, args.userId, args.accountId, new Set([args.providerCalendarId]));
    return { ok: true };
  },
});

export const setCalendarHiddenInternal = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerCalendarId: v.string(),
    hidden: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('calendars')
      .withIndex('by_account_calendar', (q) =>
        q.eq('accountId', args.accountId).eq('providerCalendarId', args.providerCalendarId),
      )
      .unique();
    if (!row || row.userId !== args.userId) return { ok: true };
    await ctx.db.patch(row._id, { hidden: args.hidden, updatedAt: now() });
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
      .withIndex('by_user_account_calendar_end', (q) =>
        q
          .eq('userId', args.userId)
          .eq('accountId', args.accountId)
          .eq('providerCalendarId', args.providerCalendarId)
          .gt('endAt', args.windowStart),
      )
      .collect();
    let pruned = 0;
    for (const row of rows) {
      if (row.startAt >= args.windowEnd) continue;
      if (keep.has(row.providerEventId)) continue;
      await ctx.db.delete(row._id);
      await deleteLegacyCorpusEvent(ctx, {
        userId: args.userId,
        accountId: args.accountId,
        providerCalendarId: row.providerCalendarId,
        providerEventId: row.providerEventId,
      });
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
    lastIncrementalSyncAt: v.optional(v.number()),
    lastWebhookAt: v.optional(v.number()),
    lastHistoryBackfillAt: v.optional(v.number()),
    historyCursorEnd: v.optional(v.number()),
    historyWindowStart: v.optional(v.number()),
    historyBackfillReady: v.optional(v.boolean()),
    progress: v.optional(v.any()),
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
      'lastIncrementalSyncAt',
      'lastWebhookAt',
      'lastHistoryBackfillAt',
      'historyCursorEnd',
      'historyWindowStart',
      'historyBackfillReady',
      'progress',
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
      lastIncrementalSyncAt: args.lastIncrementalSyncAt,
      lastWebhookAt: args.lastWebhookAt,
      lastHistoryBackfillAt: args.lastHistoryBackfillAt,
      historyCursorEnd: args.historyCursorEnd,
      historyWindowStart: args.historyWindowStart,
      historyBackfillReady: args.historyBackfillReady,
      progress: args.progress,
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const claimCalendarSync = mutation({
  args: {
    ...accountScope,
    activeWindowMs: v.optional(v.number()),
    force: v.optional(v.boolean()),
    progress: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const activeWindowMs = Math.max(60_000, Number(args.activeWindowMs) || 10 * 60_000);
    const existing = await ctx.db
      .query('calendarSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (!args.force && existing?.status === 'unauthorized') {
      return { claimed: false, reason: 'unauthorized', state: existing };
    }
    if (!args.force && existing?.status === 'syncing' && ts - existing.updatedAt < activeWindowMs) {
      return { claimed: false, reason: 'active', state: existing };
    }
    const patch = {
      userId: args.userId,
      accountId: args.accountId,
      grantId: args.grantId,
      provider: args.provider,
      status: 'syncing' as const,
      error: undefined,
      progress: args.progress || { stage: 'claimed' },
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { claimed: true, state: { ...existing, ...patch } };
    }
    const id = await ctx.db.insert('calendarSyncStates', {
      ...patch,
      createdAt: ts,
    });
    return { claimed: true, state: { _id: id, ...patch } };
  },
});

export const getSyncState = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.db
      .query('calendarSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
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
    providerCalendarId: v.optional(v.string()),
    providerEventId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await findEventByProviderId(ctx, args);
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

export const searchEvents = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    query: v.optional(v.string()),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    accountIds: v.optional(v.array(v.string())),
    calendarIds: v.optional(v.array(v.string())),
    includeCancelled: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 25, 100);
    const text = (args.query || '').trim();
    let rows: any[];
    if (text) {
      rows = await ctx.db
        .query('calendarEvents')
        .withSearchIndex('by_search_text', (q) => q.search('searchText', text).eq('userId', args.userId))
        .take(limit * 4);
    } else if (typeof args.startAt === 'number' && typeof args.endAt === 'number') {
      rows = await queryEventsInWindow(
        ctx,
        args.userId,
        args.startAt,
        args.endAt,
        limit * 4,
        Boolean(args.includeCancelled),
      );
    } else {
      rows = await ctx.db
        .query('calendarEvents')
        .withIndex('by_user_start', (q) => q.eq('userId', args.userId))
        .order('desc')
        .take(limit * 4);
    }
    return filterCalendarRows(rows, args)
      .sort((a, b) => a.startAt - b.startAt)
      .slice(0, limit);
  },
});

export const countEvents = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    query: v.optional(v.string()),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    accountIds: v.optional(v.array(v.string())),
    calendarIds: v.optional(v.array(v.string())),
    includeCancelled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const CAP = 1000;
    const text = (args.query || '').trim();
    let rows: any[];
    if (text) {
      rows = await ctx.db
        .query('calendarEvents')
        .withSearchIndex('by_search_text', (q) => q.search('searchText', text).eq('userId', args.userId))
        .take(CAP);
    } else if (typeof args.startAt === 'number' && typeof args.endAt === 'number') {
      rows = await queryEventsInWindow(
        ctx,
        args.userId,
        args.startAt,
        args.endAt,
        CAP,
        Boolean(args.includeCancelled),
      );
    } else {
      rows = await ctx.db
        .query('calendarEvents')
        .withIndex('by_user_start', (q) => q.eq('userId', args.userId))
        .take(CAP);
    }
    const matched = filterCalendarRows(rows, args);
    return { count: matched.length, approximate: rows.length >= CAP && matched.length >= CAP };
  },
});

// User-facing calendar prefs (Clerk identity — called from the surface).
export const setCalendarColor = mutation({
  args: { calendarId: v.id('calendars'), colorIndex: v.number() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.subject) throw new Error('Not authenticated');
    const row = await ctx.db.get(args.calendarId);
    if (!row || row.userId !== identity.subject) throw new Error('Calendar not found.');
    const colorIndex = Math.min(9, Math.max(0, Math.round(args.colorIndex)));
    await ctx.db.patch(args.calendarId, { colorIndex, updatedAt: now() });
  },
});

// Live feeds for the calendar surface.
export const liveCalendars = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const [calendars, syncStates, accounts] = await Promise.all([
      ctx.db
        .query('calendars')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('calendarSyncStates')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('connectedAccounts')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    ]);
    const accountById = new Map(accounts.map((account) => [account.accountId, account]));
    return {
      calendars,
      syncStates: syncStates.map((state) => ({
        ...state,
        email: accountById.get(state.accountId)?.email,
        provider: accountById.get(state.accountId)?.provider ?? state.provider,
      })),
    };
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

// Search now runs on calendarEvents directly. Drain the former duplicate
// corpus in small scheduled transactions so existing deployments reclaim its
// document and index storage without a large mutation. Legacy canonical rows
// may predate the searchable fields, so preserve that corpus data before each
// duplicate is deleted.
export const purgeLegacyEventCorpusBatch = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 250), 25), 500);
    const page = await ctx.db
      .query('calendarEventCorpus')
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    let migrated = 0;
    let skipped = 0;
    for (const row of page.page) {
      const canonical = await findEventByProviderId(ctx, row);
      if (canonical && canonical.userId !== row.userId) {
        console.warn(`Skipping cross-user calendar event ${row.providerEventId}.`);
        skipped += 1;
        continue;
      }
      if (!canonical) {
        const { _id, _creationTime, ...event } = row;
        await ctx.db.insert('calendarEvents', event);
        migrated += 1;
      } else if (!canonical.searchText || !canonical.yearMonth) {
        await ctx.db.patch(canonical._id, {
          searchText: canonical.searchText || row.searchText,
          yearMonth: canonical.yearMonth || row.yearMonth,
        });
        migrated += 1;
      }
      await ctx.db.delete(row._id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.calendarData.purgeLegacyEventCorpusBatch, {
        limit,
        cursor: page.continueCursor,
      });
    }
    return { deleted: page.page.length - skipped, migrated, skipped, done: page.isDone };
  },
});

async function queryEventsInWindow(
  ctx: QueryCtx,
  userId: string,
  startAt: number,
  endAt: number,
  limit?: number,
  includeCancelled = false,
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
  return rows.filter((row) => row.endAt > startAt && (includeCancelled || row.status !== 'cancelled'));
}

async function findEventByProviderId(
  ctx: any,
  args: { accountId: string; providerEventId: string; providerCalendarId?: string },
) {
  if (args.providerCalendarId) {
    return ctx.db
      .query('calendarEvents')
      .withIndex('by_account_calendar_event', (q: any) =>
        q
          .eq('accountId', args.accountId)
          .eq('providerCalendarId', args.providerCalendarId as string)
          .eq('providerEventId', args.providerEventId),
      )
      .unique();
  }
  return ctx.db
    .query('calendarEvents')
    .withIndex('by_account_event', (q: any) =>
      q.eq('accountId', args.accountId).eq('providerEventId', args.providerEventId),
    )
    .unique();
}

// Delete-only compatibility for the bounded corpus migration. New and updated
// events are no longer dual-written, but a user deletion must remove an
// existing legacy duplicate until the one-time purge has drained the table.
async function deleteLegacyCorpusEvent(
  ctx: any,
  args: { userId: string; accountId: string; providerEventId: string; providerCalendarId?: string },
) {
  const row = args.providerCalendarId
    ? await ctx.db
        .query('calendarEventCorpus')
        .withIndex('by_account_calendar_event', (q: any) =>
          q
            .eq('accountId', args.accountId)
            .eq('providerCalendarId', args.providerCalendarId as string)
            .eq('providerEventId', args.providerEventId),
        )
        .unique()
    : await ctx.db
        .query('calendarEventCorpus')
        .withIndex('by_account_event', (q: any) =>
          q.eq('accountId', args.accountId).eq('providerEventId', args.providerEventId),
        )
        .unique();
  if (row && row.userId === args.userId) await ctx.db.delete(row._id);
}

async function deleteLegacyCalendarCorpus(
  ctx: any,
  userId: string,
  accountId: string,
  providerCalendarIds: Set<string>,
) {
  if (providerCalendarIds.size === 0) return;
  for (const providerCalendarId of providerCalendarIds) {
    const rows = await ctx.db
      .query('calendarEventCorpus')
      .withIndex('by_user_account_calendar_start', (q: any) =>
        q.eq('userId', userId).eq('accountId', accountId).eq('providerCalendarId', providerCalendarId),
      )
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

function filterCalendarRows(rows: any[], args: any) {
  const accounts = args.accountIds?.length ? new Set(args.accountIds) : null;
  const calendars = args.calendarIds?.length ? new Set(args.calendarIds) : null;
  return rows.filter((row) => {
    if (accounts && !accounts.has(row.accountId)) return false;
    if (calendars && !calendars.has(row.providerCalendarId)) return false;
    if (!args.includeCancelled && row.status === 'cancelled') return false;
    if (typeof args.startAt === 'number' && row.endAt <= args.startAt) return false;
    if (typeof args.endAt === 'number' && row.startAt >= args.endAt) return false;
    return true;
  });
}

function buildEventSearchText(event: any) {
  const parts = [
    event.title,
    event.description,
    event.location,
    event.status,
    event.htmlLink,
    event.icalUid,
    ...(event.recurrence || []),
    ...textFromUnknown(event.organizer),
    ...textFromUnknown(event.conferencing),
    ...(event.participants || []).flatMap(textFromUnknown),
  ];
  return normalizeCalendarCorpusText(parts.filter(Boolean).join('\n'));
}

function normalizeCalendarCorpusText(value: unknown, maxChars = 16_000) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function yearMonth(ts: unknown) {
  const value = Number(ts);
  const date = new Date(Number.isFinite(value) && value > 0 ? value : now());
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Keep this extractor in sync with lib/calendar/corpus.ts. Convex functions are
// bundled separately, so query helpers keep a pure local copy rather than
// importing from app/runtime modules.
function textFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(textFromUnknown);
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    record.name,
    record.email,
    record.title,
    record.phone,
    record.url,
    record.link,
    record.status,
    record.comment,
  ]
    .filter((item): item is string | number | boolean =>
      ['string', 'number', 'boolean'].includes(typeof item),
    )
    .map(String);
}

function clampLimit(value: unknown, fallback: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
