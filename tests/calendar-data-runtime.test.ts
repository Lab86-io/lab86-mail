import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/calendarData.ts': () => import('../convex/calendarData'),
};

const SECRET = 'calendar-data-runtime-secret';
const USER = 'calendar_runtime_user';
const scope = {
  internalSecret: SECRET,
  userId: USER,
  accountId: 'account_1',
  grantId: 'grant_1',
  provider: 'google' as const,
};
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function newHarness() {
  return convexTest(schema, convexModules);
}

type Harness = ReturnType<typeof newHarness>;

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 6, 20, 12, 0, 0); // 2026-07-20T12:00Z

function eventInput(overrides: Record<string, unknown> = {}) {
  return {
    providerEventId: 'event_1',
    providerCalendarId: 'cal_1',
    title: 'Quarterly planning zebra',
    startAt: BASE,
    endAt: BASE + HOUR,
    ...overrides,
  };
}

async function seedLegacyCorpusRow(t: Harness, overrides: Record<string, unknown> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('calendarEventCorpus', {
      userId: USER,
      accountId: scope.accountId,
      grantId: scope.grantId,
      provider: 'google',
      providerEventId: 'legacy_event',
      providerCalendarId: 'cal_1',
      title: 'Legacy xylophone rehearsal',
      startAt: BASE,
      endAt: BASE + HOUR,
      searchText: 'legacy xylophone rehearsal',
      yearMonth: '2026-07',
      createdAt: BASE,
      updatedAt: BASE,
      ...overrides,
    }),
  );
}

describe('calendar and event upserts', () => {
  test('upsertCalendarBatch inserts, patches, and prunes missing calendars with their events', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertCalendarBatch, {
      ...scope,
      calendars: [
        { providerCalendarId: 'cal_1', name: 'Primary', isPrimary: true },
        { providerCalendarId: 'cal_2', name: 'Secondary' },
      ],
    });
    await t.mutation(api.calendarData.upsertCalendarBatch, {
      ...scope,
      calendars: [{ providerCalendarId: 'cal_1', name: 'Primary renamed' }],
    });
    let calendars = await t.query(api.calendarData.listCalendars, { internalSecret: SECRET, userId: USER });
    expect(calendars.map((c) => c.name).sort()).toEqual(['Primary renamed', 'Secondary']);

    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [eventInput({ providerCalendarId: 'cal_2', providerEventId: 'event_on_2' })],
    });
    await seedLegacyCorpusRow(t, { providerCalendarId: 'cal_2', providerEventId: 'legacy_on_2' });

    const result = await t.mutation(api.calendarData.upsertCalendarBatch, {
      ...scope,
      calendars: [{ providerCalendarId: 'cal_1', name: 'Primary renamed' }],
      pruneMissing: true,
    });
    expect(result).toEqual({ ok: true, count: 1 });
    calendars = await t.query(api.calendarData.listCalendars, { internalSecret: SECRET, userId: USER });
    expect(calendars.map((c) => c.providerCalendarId)).toEqual(['cal_1']);
    expect(await t.run((ctx) => ctx.db.query('calendarEvents').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('calendarEventCorpus').collect())).toHaveLength(0);
  });

  test('upsertEventBatch derives search fields, patches in place, and rejects cross-user collisions', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [
        eventInput({
          description: 'Deep dive',
          participants: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
          organizer: { email: 'org@example.com' },
        }),
      ],
    });
    let row = await t.run((ctx) => ctx.db.query('calendarEvents').unique());
    expect(row?.searchText).toContain('Quarterly planning zebra');
    expect(row?.searchText).toContain('ada@example.com');
    expect(row?.yearMonth).toBe('2026-07');

    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [eventInput({ title: 'Retitled zebra' })],
    });
    const rows = await t.run((ctx) => ctx.db.query('calendarEvents').collect());
    expect(rows).toHaveLength(1);
    row = rows[0];
    expect(row.title).toBe('Retitled zebra');

    await expect(
      t.mutation(api.calendarData.upsertEventBatch, {
        ...scope,
        userId: 'other_user',
        events: [eventInput()],
      }),
    ).rejects.toThrow(/Cross-user calendar event collision/);
  });

  test('mutations reject a bad internal secret', async () => {
    const t = newHarness();
    await expect(
      t.mutation(api.calendarData.upsertEventBatch, { ...scope, internalSecret: 'nope', events: [] }),
    ).rejects.toThrow(/Invalid Convex internal secret/);
  });
});

describe('event deletion', () => {
  test('deleteEvent removes the row, its legacy duplicate, and recurring instances on request', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [
        eventInput({ providerEventId: 'master', recurrence: ['RRULE:FREQ=DAILY'] }),
        eventInput({
          providerEventId: 'inst_1',
          masterEventId: 'master',
          startAt: BASE + 24 * HOUR,
          endAt: BASE + 25 * HOUR,
        }),
        eventInput({
          providerEventId: 'inst_other_cal',
          providerCalendarId: 'cal_9',
          masterEventId: 'master',
        }),
        eventInput({ providerEventId: 'unrelated' }),
      ],
    });
    await seedLegacyCorpusRow(t, { providerEventId: 'master' });
    await t.mutation(api.calendarData.deleteEvent, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerCalendarId: 'cal_1',
      providerEventId: 'master',
      includeInstances: true,
    });
    const remaining = await t.run((ctx) => ctx.db.query('calendarEvents').collect());
    // The instance on another calendar is skipped when a calendar id was given.
    expect(remaining.map((r) => r.providerEventId).sort()).toEqual(['inst_other_cal', 'unrelated']);
    expect(await t.run((ctx) => ctx.db.query('calendarEventCorpus').collect())).toHaveLength(0);
  });

  test("deleteEvent never removes another user's row", async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, { ...scope, events: [eventInput()] });
    await t.mutation(api.calendarData.deleteEvent, {
      internalSecret: SECRET,
      userId: 'someone_else',
      accountId: scope.accountId,
      providerEventId: 'event_1',
    });
    expect(await t.run((ctx) => ctx.db.query('calendarEvents').collect())).toHaveLength(1);
  });

  test('removeCalendar drops the calendar, its events, and legacy corpus rows', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertCalendarBatch, {
      ...scope,
      calendars: [{ providerCalendarId: 'cal_1', name: 'Doomed' }],
    });
    await t.mutation(api.calendarData.upsertEventBatch, { ...scope, events: [eventInput()] });
    await seedLegacyCorpusRow(t);
    await t.mutation(api.calendarData.removeCalendar, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerCalendarId: 'cal_1',
    });
    expect(await t.run((ctx) => ctx.db.query('calendars').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('calendarEvents').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('calendarEventCorpus').collect())).toHaveLength(0);
  });

  test('setCalendarHiddenInternal hides only matching-owner calendars and tolerates misses', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertCalendarBatch, {
      ...scope,
      calendars: [{ providerCalendarId: 'cal_1', name: 'Hideable' }],
    });
    expect(
      await t.mutation(api.calendarData.setCalendarHiddenInternal, {
        internalSecret: SECRET,
        userId: USER,
        accountId: scope.accountId,
        providerCalendarId: 'missing',
        hidden: true,
      }),
    ).toEqual({ ok: true });
    await t.mutation(api.calendarData.setCalendarHiddenInternal, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerCalendarId: 'cal_1',
      hidden: true,
    });
    const row = await t.run((ctx) => ctx.db.query('calendars').unique());
    expect(row?.hidden).toBe(true);
  });
});

describe('reconcileWindow', () => {
  test('prunes window rows missing from the keep list and leaves the rest', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [
        eventInput({ providerEventId: 'keep_me' }),
        eventInput({ providerEventId: 'prune_me', startAt: BASE + HOUR, endAt: BASE + 2 * HOUR }),
        eventInput({ providerEventId: 'after_window', startAt: BASE + 100 * HOUR, endAt: BASE + 101 * HOUR }),
      ],
    });
    await seedLegacyCorpusRow(t, { providerEventId: 'prune_me' });
    const result = await t.mutation(api.calendarData.reconcileWindow, {
      ...scope,
      providerCalendarId: 'cal_1',
      windowStart: BASE - HOUR,
      windowEnd: BASE + 10 * HOUR,
      keepProviderEventIds: ['keep_me'],
    });
    expect(result).toMatchObject({ ok: true, pruned: 1, done: true });
    const remaining = await t.run((ctx) => ctx.db.query('calendarEvents').collect());
    expect(remaining.map((r) => r.providerEventId).sort()).toEqual(['after_window', 'keep_me']);
    expect(await t.run((ctx) => ctx.db.query('calendarEventCorpus').collect())).toHaveLength(0);
  });
});

describe('sync state machine', () => {
  test('markSyncState inserts, patches, and clears errors on healthy statuses', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.markSyncState, {
      ...scope,
      status: 'error',
      error: 'boom',
      eventsSynced: 5,
    });
    let state = await t.query(api.calendarData.getSyncState, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
    });
    expect(state).toMatchObject({ status: 'error', error: 'boom', eventsSynced: 5 });

    await t.mutation(api.calendarData.markSyncState, { ...scope, status: 'ready', calendarsSynced: 2 });
    state = await t.query(api.calendarData.getSyncState, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
    });
    expect(state).toMatchObject({ status: 'ready', calendarsSynced: 2, eventsSynced: 5 });
    expect(state?.error).toBeUndefined();

    const states = await t.query(api.calendarData.getSyncStates, { internalSecret: SECRET, userId: USER });
    expect(states).toHaveLength(1);
  });

  test('claimCalendarSync respects active and unauthorized states unless forced', async () => {
    const t = newHarness();
    const first = await t.mutation(api.calendarData.claimCalendarSync, { ...scope });
    expect(first.claimed).toBe(true);
    const second = await t.mutation(api.calendarData.claimCalendarSync, { ...scope });
    expect(second).toMatchObject({ claimed: false, reason: 'active' });
    const forced = await t.mutation(api.calendarData.claimCalendarSync, { ...scope, force: true });
    expect(forced.claimed).toBe(true);

    await t.mutation(api.calendarData.markSyncState, { ...scope, status: 'unauthorized' });
    const blocked = await t.mutation(api.calendarData.claimCalendarSync, { ...scope });
    expect(blocked).toMatchObject({ claimed: false, reason: 'unauthorized' });
    const reclaimed = await t.mutation(api.calendarData.claimCalendarSync, {
      ...scope,
      force: true,
      progress: { stage: 'retry' },
    });
    expect(reclaimed.claimed).toBe(true);
    expect(reclaimed.state?.progress).toEqual({ stage: 'retry' });
  });
});

describe('event reads', () => {
  test('getEventByProviderId scopes by user and optional calendar', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, { ...scope, events: [eventInput()] });
    const withCal = await t.query(api.calendarData.getEventByProviderId, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerCalendarId: 'cal_1',
      providerEventId: 'event_1',
    });
    expect(withCal?.providerEventId).toBe('event_1');
    const withoutCal = await t.query(api.calendarData.getEventByProviderId, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerEventId: 'event_1',
    });
    expect(withoutCal?._id).toBe(withCal?._id);
    expect(
      await t.query(api.calendarData.getEventByProviderId, {
        internalSecret: SECRET,
        userId: 'other',
        accountId: scope.accountId,
        providerEventId: 'event_1',
      }),
    ).toBeNull();
  });

  test('listEvents returns overlapping events and hides cancelled ones', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [
        eventInput({ providerEventId: 'inside' }),
        // Started before the window but still running into it.
        eventInput({ providerEventId: 'overlap', startAt: BASE - 3 * HOUR, endAt: BASE + HOUR }),
        eventInput({ providerEventId: 'cancelled', status: 'cancelled' }),
        eventInput({ providerEventId: 'before', startAt: BASE - 5 * HOUR, endAt: BASE - 4 * HOUR }),
      ],
    });
    const rows = await t.query(api.calendarData.listEvents, {
      internalSecret: SECRET,
      userId: USER,
      startAt: BASE - HOUR,
      endAt: BASE + 5 * HOUR,
    });
    expect(rows.map((r) => r.providerEventId).sort()).toEqual(['inside', 'overlap']);
  });

  test('searchEvents merges legacy rows before cutover and trusts canonical after', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [eventInput({ providerEventId: 'canonical_evt', title: 'Zebra summit' })],
    });
    await seedLegacyCorpusRow(t, {
      providerEventId: 'legacy_only',
      title: 'Zebra legacy briefing',
      searchText: 'zebra legacy briefing',
    });

    // Before cutover: text search sees both canonical and legacy rows.
    const merged = await t.query(api.calendarData.searchEvents, {
      internalSecret: SECRET,
      userId: USER,
      query: 'zebra',
    });
    expect(merged.map((r) => r.providerEventId).sort()).toEqual(['canonical_evt', 'legacy_only']);

    // After cutover: legacy corpus is ignored.
    await t.run(async (ctx) => {
      await ctx.db.insert('dataMigrations', {
        name: 'calendar-search-canonical-v1',
        status: 'completed',
        updatedAt: Date.now(),
      });
    });
    const canonicalOnly = await t.query(api.calendarData.searchEvents, {
      internalSecret: SECRET,
      userId: USER,
      query: 'zebra',
    });
    expect(canonicalOnly.map((r) => r.providerEventId)).toEqual(['canonical_evt']);
  });

  test('searchEvents window and unfiltered paths apply account/calendar filters', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [
        eventInput({ providerEventId: 'a1' }),
        eventInput({ providerEventId: 'a2', providerCalendarId: 'cal_2' }),
      ],
    });
    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      accountId: 'account_2',
      events: [eventInput({ providerEventId: 'b1' })],
    });
    const windowRows = await t.query(api.calendarData.searchEvents, {
      internalSecret: SECRET,
      userId: USER,
      startAt: BASE - HOUR,
      endAt: BASE + 2 * HOUR,
      accountIds: ['account_1'],
      calendarIds: ['cal_1'],
    });
    expect(windowRows.map((r) => r.providerEventId)).toEqual(['a1']);
    const recentRows = await t.query(api.calendarData.searchEvents, {
      internalSecret: SECRET,
      userId: USER,
      accountIds: ['account_2'],
      limit: 5,
    });
    expect(recentRows.map((r) => r.providerEventId)).toEqual(['b1']);
  });

  test('countEvents counts text and window matches without approximation on small data', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, {
      ...scope,
      events: [
        eventInput({ providerEventId: 'c1', title: 'Walrus standup' }),
        eventInput({
          providerEventId: 'c2',
          title: 'Walrus retro',
          startAt: BASE + 2 * HOUR,
          endAt: BASE + 3 * HOUR,
        }),
        eventInput({ providerEventId: 'c3', title: 'Unrelated' }),
      ],
    });
    const byText = await t.query(api.calendarData.countEvents, {
      internalSecret: SECRET,
      userId: USER,
      query: 'walrus',
    });
    expect(byText).toEqual({ count: 2, approximate: false });
    const byWindow = await t.query(api.calendarData.countEvents, {
      internalSecret: SECRET,
      userId: USER,
      startAt: BASE - HOUR,
      endAt: BASE + HOUR,
    });
    expect(byWindow).toEqual({ count: 2, approximate: false });
    const all = await t.query(api.calendarData.countEvents, { internalSecret: SECRET, userId: USER });
    expect(all).toEqual({ count: 3, approximate: false });
  });
});

describe('user-facing calendar surface', () => {
  test('setCalendarColor clamps the palette slot and enforces ownership', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertCalendarBatch, {
      ...scope,
      calendars: [{ providerCalendarId: 'cal_1', name: 'Colorful' }],
    });
    const calendarId = (await t.run((ctx) => ctx.db.query('calendars').unique()))!._id;
    const asOwner = t.withIdentity({ subject: USER });
    await asOwner.mutation(api.calendarData.setCalendarColor, { calendarId, colorIndex: 42 });
    expect((await t.run((ctx) => ctx.db.get(calendarId)))?.colorIndex).toBe(9);
    await asOwner.mutation(api.calendarData.setCalendarColor, { calendarId, colorIndex: -3 });
    expect((await t.run((ctx) => ctx.db.get(calendarId)))?.colorIndex).toBe(0);
    const stranger = t.withIdentity({ subject: 'stranger' });
    await expect(
      stranger.mutation(api.calendarData.setCalendarColor, { calendarId, colorIndex: 1 }),
    ).rejects.toThrow(/Calendar not found/);
    await expect(
      t.mutation(api.calendarData.setCalendarColor, { calendarId, colorIndex: 1 }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test('liveCalendars joins sync states with connected account emails', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertCalendarBatch, {
      ...scope,
      calendars: [{ providerCalendarId: 'cal_1', name: 'Mine' }],
    });
    await t.mutation(api.calendarData.markSyncState, { ...scope, status: 'ready' });
    await t.run(async (ctx) => {
      const ts = Date.now();
      await ctx.db.insert('connectedAccounts', {
        userId: USER,
        accountId: scope.accountId,
        email: 'me@example.com',
        provider: 'google',
        status: 'connected',
        scopes: [],
        grantId: scope.grantId,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    const asOwner = t.withIdentity({ subject: USER });
    const live = await asOwner.query(api.calendarData.liveCalendars, {});
    expect(live.calendars.map((c) => c.name)).toEqual(['Mine']);
    expect(live.syncStates[0]).toMatchObject({
      status: 'ready',
      email: 'me@example.com',
      provider: 'google',
    });
    await expect(t.query(api.calendarData.liveCalendars, {})).rejects.toThrow(/Not authenticated/);
  });

  test('liveEvents serves the identity user window', async () => {
    const t = newHarness();
    await t.mutation(api.calendarData.upsertEventBatch, { ...scope, events: [eventInput()] });
    const asOwner = t.withIdentity({ subject: USER });
    const rows = await asOwner.query(api.calendarData.liveEvents, {
      startAt: BASE - HOUR,
      endAt: BASE + 2 * HOUR,
    });
    expect(rows.map((r) => r.providerEventId)).toEqual(['event_1']);
    const stranger = t.withIdentity({ subject: 'stranger' });
    expect(
      await stranger.query(api.calendarData.liveEvents, { startAt: BASE - HOUR, endAt: BASE + 2 * HOUR }),
    ).toEqual([]);
  });
});
