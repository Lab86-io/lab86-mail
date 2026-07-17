import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/calendarData.ts': () => import('../convex/calendarData'),
};

const baseEvent = {
  userId: 'calendar_user',
  accountId: 'account_1',
  grantId: 'grant_1',
  provider: 'google' as const,
  providerCalendarId: 'calendar_1',
  title: 'Preserved event',
  startAt: Date.UTC(2026, 6, 17, 12),
  endAt: Date.UTC(2026, 6, 17, 13),
  searchText: 'preserved event',
  yearMonth: '2026-07',
  createdAt: 1,
  updatedAt: 1,
};

describe('legacy calendar corpus migration', () => {
  test('creates missing canonical events and backfills searchable fields before deletion', async () => {
    const t = convexTest(schema, convexModules);
    await t.run(async (ctx) => {
      await ctx.db.insert('calendarEventCorpus', {
        ...baseEvent,
        providerEventId: 'orphaned_event',
      });
      await ctx.db.insert('calendarEvents', {
        ...baseEvent,
        providerEventId: 'existing_event',
        searchText: undefined,
        yearMonth: undefined,
      });
      await ctx.db.insert('calendarEventCorpus', {
        ...baseEvent,
        providerEventId: 'existing_event',
      });
    });

    const result = await t.mutation(internal.calendarData.purgeLegacyEventCorpusBatch, { limit: 25 });
    expect(result).toEqual({ deleted: 2, migrated: 2, skipped: 0, done: true });

    const state = await t.run(async (ctx) => ({
      canonical: await ctx.db.query('calendarEvents').collect(),
      legacy: await ctx.db.query('calendarEventCorpus').collect(),
    }));
    expect(state.legacy).toHaveLength(0);
    expect(state.canonical).toHaveLength(2);
    expect(state.canonical.map((row) => row.providerEventId).sort()).toEqual([
      'existing_event',
      'orphaned_event',
    ]);
    expect(state.canonical.every((row) => row.searchText === 'preserved event')).toBe(true);
    expect(state.canonical.every((row) => row.yearMonth === '2026-07')).toBe(true);
  });

  test('does not recreate an event deleted while the bounded purge is running', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'calendar-migration-test-secret';
    try {
      const t = convexTest(schema, convexModules);
      await t.run(async (ctx) => {
        const event = { ...baseEvent, providerEventId: 'deleted_event' };
        await ctx.db.insert('calendarEvents', event);
        await ctx.db.insert('calendarEventCorpus', event);
      });

      await t.mutation(api.calendarData.deleteEvent, {
        internalSecret: 'calendar-migration-test-secret',
        userId: baseEvent.userId,
        accountId: baseEvent.accountId,
        providerCalendarId: baseEvent.providerCalendarId,
        providerEventId: 'deleted_event',
      });
      const purge = await t.mutation(internal.calendarData.purgeLegacyEventCorpusBatch, { limit: 25 });
      expect(purge).toEqual({ deleted: 0, migrated: 0, skipped: 0, done: true });

      const state = await t.run(async (ctx) => ({
        canonical: await ctx.db.query('calendarEvents').collect(),
        legacy: await ctx.db.query('calendarEventCorpus').collect(),
      }));
      expect(state).toEqual({ canonical: [], legacy: [] });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('never falls back to the same provider event id in another calendar', async () => {
    const t = convexTest(schema, convexModules);
    await t.run(async (ctx) => {
      await ctx.db.insert('calendarEvents', {
        ...baseEvent,
        providerCalendarId: 'calendar_2',
        providerEventId: 'shared_event_id',
        title: 'Other calendar event',
      });
      await ctx.db.insert('calendarEventCorpus', {
        ...baseEvent,
        providerCalendarId: 'calendar_1',
        providerEventId: 'shared_event_id',
        title: 'Migrated calendar event',
      });
    });

    await t.mutation(internal.calendarData.purgeLegacyEventCorpusBatch, { limit: 25 });
    const canonical = await t.run((ctx) => ctx.db.query('calendarEvents').collect());
    expect(canonical).toHaveLength(2);
    expect(
      canonical
        .map((row) => [row.providerCalendarId, row.title])
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      ['calendar_1', 'Migrated calendar event'],
      ['calendar_2', 'Other calendar event'],
    ]);
  });

  test('upserts a calendar-qualified event without overwriting another calendar', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'calendar-upsert-test-secret';
    try {
      const t = convexTest(schema, convexModules);
      await t.run((ctx) =>
        ctx.db.insert('calendarEvents', {
          ...baseEvent,
          providerCalendarId: 'calendar_2',
          providerEventId: 'shared_upsert_id',
          title: 'Existing calendar event',
        }),
      );

      await t.mutation(api.calendarData.upsertEventBatch, {
        internalSecret: 'calendar-upsert-test-secret',
        userId: baseEvent.userId,
        accountId: baseEvent.accountId,
        grantId: baseEvent.grantId,
        provider: baseEvent.provider,
        events: [
          {
            providerCalendarId: 'calendar_1',
            providerEventId: 'shared_upsert_id',
            title: 'New calendar event',
            startAt: baseEvent.startAt,
            endAt: baseEvent.endAt,
          },
        ],
      });

      const canonical = await t.run((ctx) => ctx.db.query('calendarEvents').collect());
      expect(canonical).toHaveLength(2);
      expect(
        canonical
          .map((row) => [row.providerCalendarId, row.title])
          .sort(([left], [right]) => left.localeCompare(right)),
      ).toEqual([
        ['calendar_1', 'New calendar event'],
        ['calendar_2', 'Existing calendar event'],
      ]);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('removing a calendar drains legacy-only rows before the purge can recreate them', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'calendar-remove-test-secret';
    try {
      const t = convexTest(schema, convexModules);
      await t.run((ctx) =>
        ctx.db.insert('calendarEventCorpus', {
          ...baseEvent,
          providerEventId: 'legacy_only_removed_event',
        }),
      );

      await t.mutation(api.calendarData.removeCalendar, {
        internalSecret: 'calendar-remove-test-secret',
        userId: baseEvent.userId,
        accountId: baseEvent.accountId,
        providerCalendarId: baseEvent.providerCalendarId,
      });
      const purge = await t.mutation(internal.calendarData.purgeLegacyEventCorpusBatch, { limit: 25 });
      expect(purge).toEqual({ deleted: 0, migrated: 0, skipped: 0, done: true });

      const state = await t.run(async (ctx) => ({
        canonical: await ctx.db.query('calendarEvents').collect(),
        legacy: await ctx.db.query('calendarEventCorpus').collect(),
      }));
      expect(state).toEqual({ canonical: [], legacy: [] });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('pruning a missing calendar also drains its legacy-only rows', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'calendar-prune-test-secret';
    try {
      const t = convexTest(schema, convexModules);
      await t.run(async (ctx) => {
        await ctx.db.insert('calendars', {
          userId: baseEvent.userId,
          accountId: baseEvent.accountId,
          grantId: baseEvent.grantId,
          provider: baseEvent.provider,
          providerCalendarId: baseEvent.providerCalendarId,
          name: 'Removed calendar',
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert('calendarEventCorpus', {
          ...baseEvent,
          providerEventId: 'legacy_only_pruned_event',
        });
      });

      await t.mutation(api.calendarData.upsertCalendarBatch, {
        internalSecret: 'calendar-prune-test-secret',
        userId: baseEvent.userId,
        accountId: baseEvent.accountId,
        grantId: baseEvent.grantId,
        provider: baseEvent.provider,
        calendars: [],
        pruneMissing: true,
      });
      const purge = await t.mutation(internal.calendarData.purgeLegacyEventCorpusBatch, { limit: 25 });
      expect(purge).toEqual({ deleted: 0, migrated: 0, skipped: 0, done: true });

      const state = await t.run(async (ctx) => ({
        calendars: await ctx.db.query('calendars').collect(),
        canonical: await ctx.db.query('calendarEvents').collect(),
        legacy: await ctx.db.query('calendarEventCorpus').collect(),
      }));
      expect(state).toEqual({ calendars: [], canonical: [], legacy: [] });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('skips corrupt cross-user collisions without stalling later rows', async () => {
    const t = convexTest(schema, convexModules);
    await t.run(async (ctx) => {
      await ctx.db.insert('calendarEvents', {
        ...baseEvent,
        userId: 'other_user',
        providerEventId: 'cross_user_collision',
      });
      await ctx.db.insert('calendarEventCorpus', {
        ...baseEvent,
        providerEventId: 'cross_user_collision',
      });
      await ctx.db.insert('calendarEventCorpus', {
        ...baseEvent,
        providerEventId: 'safe_later_event',
      });
    });

    const result = await t.mutation(internal.calendarData.purgeLegacyEventCorpusBatch, { limit: 25 });
    expect(result).toEqual({ deleted: 1, migrated: 1, skipped: 1, done: true });
    const state = await t.run(async (ctx) => ({
      canonical: await ctx.db.query('calendarEvents').collect(),
      legacy: await ctx.db.query('calendarEventCorpus').collect(),
    }));
    expect(state.canonical.map((row) => row.providerEventId).sort()).toEqual([
      'cross_user_collision',
      'safe_later_event',
    ]);
    expect(state.legacy.map((row) => row.providerEventId)).toEqual(['cross_user_collision']);
  });
});
