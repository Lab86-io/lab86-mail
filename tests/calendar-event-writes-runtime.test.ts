import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
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

describe('calendar event writes and counts', () => {
  test('reconciles an overlap window through bounded cursor pages', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'calendar-reconcile-test-secret';
    try {
      const t = convexTest(schema, convexModules);
      await t.run(async (ctx) => {
        for (let index = 0; index < 26; index += 1) {
          await ctx.db.insert('calendarEvents', {
            ...baseEvent,
            providerEventId: `stale_overlap_${index}`,
            startAt: baseEvent.startAt + index,
            endAt: baseEvent.endAt + index,
          });
        }
        await ctx.db.insert('calendarEvents', {
          ...baseEvent,
          providerEventId: 'future_outside_window',
          startAt: baseEvent.startAt + 10 * 86_400_000,
          endAt: baseEvent.endAt + 10 * 86_400_000,
        });
      });

      let cursor: string | undefined;
      let pruned = 0;
      for (let page = 0; page < 3; page += 1) {
        const result = await t.mutation(api.calendarData.reconcileWindow, {
          internalSecret: 'calendar-reconcile-test-secret',
          userId: baseEvent.userId,
          accountId: baseEvent.accountId,
          grantId: baseEvent.grantId,
          provider: baseEvent.provider,
          providerCalendarId: baseEvent.providerCalendarId,
          windowStart: baseEvent.startAt - 1,
          windowEnd: baseEvent.startAt + 2 * 86_400_000,
          keepProviderEventIds: [],
          limit: 25,
          ...(cursor ? { cursor } : {}),
        });
        pruned += result.pruned;
        if (result.done) break;
        expect(result.continueCursor).toBeTruthy();
        cursor = result.continueCursor;
      }
      expect(pruned).toBe(26);
      const remaining = await t.run((ctx) => ctx.db.query('calendarEvents').collect());
      expect(remaining.map((row) => row.providerEventId)).toEqual(['future_outside_window']);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('marks capped calendar counts approximate even when filters exclude most candidates', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'calendar-count-test-secret';
    try {
      const t = convexTest(schema, convexModules);
      await t.run(async (ctx) => {
        for (let index = 0; index < 1_000; index += 1) {
          await ctx.db.insert('calendarEvents', {
            ...baseEvent,
            providerCalendarId: index === 0 ? 'calendar_keep' : 'calendar_excluded',
            providerEventId: `count_${index}`,
            startAt: baseEvent.startAt + index,
            endAt: baseEvent.endAt + index,
          });
        }
      });
      expect(
        await t.query(api.calendarData.countEvents, {
          internalSecret: 'calendar-count-test-secret',
          userId: baseEvent.userId,
          calendarIds: ['calendar_keep'],
        }),
      ).toEqual({ count: 1, approximate: true });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
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

  test('refuses to patch an exact calendar event owned by another user', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'calendar-collision-test-secret';
    try {
      const t = convexTest(schema, convexModules);
      await t.run((ctx) =>
        ctx.db.insert('calendarEvents', {
          ...baseEvent,
          userId: 'other_user',
          providerEventId: 'cross_user_upsert',
          title: 'Other user event',
        }),
      );

      await expect(
        t.mutation(api.calendarData.upsertEventBatch, {
          internalSecret: 'calendar-collision-test-secret',
          userId: baseEvent.userId,
          accountId: baseEvent.accountId,
          grantId: baseEvent.grantId,
          provider: baseEvent.provider,
          events: [
            {
              providerCalendarId: baseEvent.providerCalendarId,
              providerEventId: 'cross_user_upsert',
              title: 'Must not overwrite',
              startAt: baseEvent.startAt,
              endAt: baseEvent.endAt,
            },
          ],
        }),
      ).rejects.toThrow('Cross-user calendar event collision');

      const canonical = await t.run((ctx) => ctx.db.query('calendarEvents').collect());
      expect(canonical).toHaveLength(1);
      expect(canonical[0]).toMatchObject({ userId: 'other_user', title: 'Other user event' });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
