import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createDailyReportPost } from '../app/api/cron/daily-report/route';
import { api, internal } from '../convex/_generated/api';
import { dueTargets } from '../convex/dailyReports';
import schema from '../convex/schema';
import {
  BRIEF_EMAIL_UNAVAILABLE_REASON,
  loadBriefPreferences,
  saveBriefPreferences,
} from '../lib/brief/preferences';
import {
  briefHourLabel,
  DEFAULT_BRIEF_SCHEDULE,
  localWeekday,
  normalizeBriefSchedule,
  scheduledEditionFor,
} from '../lib/brief/schedule';
import { composeBudgetBriefDocument } from '../lib/mail/brief-budget-document';
import type { DailyReport, DailyReportItem } from '../lib/shared/types';

const SECRET = 'brief-schedule-secret';
const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
  '../convex/briefJobs.ts': () => import('../convex/briefJobs'),
};
const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

// 2026-09-22 is a Tuesday, 2026-09-26 a Saturday, 2026-09-27 a Sunday.
const NY = 'America/New_York';
const at = (iso: string) => new Date(Date.parse(iso));

describe('brief schedule rules', () => {
  test('normalizes stored preferences and keeps the defaults for bad values', () => {
    expect(normalizeBriefSchedule(null)).toEqual(DEFAULT_BRIEF_SCHEDULE);
    expect(
      normalizeBriefSchedule({ briefDeliveryHour: 9, briefWeekendMode: 'off', weeklyReviewEnabled: false }),
    ).toEqual({ deliveryHour: 9, weekendMode: 'off', weeklyReview: false });
    expect(
      normalizeBriefSchedule({ briefDeliveryHour: 14, briefWeekendMode: 'party', weeklyReviewEnabled: 'no' }),
    ).toEqual(DEFAULT_BRIEF_SCHEDULE);
    expect(briefHourLabel(7)).toBe('7:00 AM');
    expect(briefHourLabel(11)).toBe('11:00 AM');
    expect(briefHourLabel(12)).toBe('12:00 PM');
  });

  test('the local weekday picks the edition', () => {
    expect(localWeekday(NY, at('2026-09-22T12:00:00Z'))).toBe(2);
    expect(localWeekday(NY, at('2026-09-27T12:00:00Z'))).toBe(0);
    expect(localWeekday('Not/AZone', at('2026-09-27T12:00:00Z'))).toBeNull();
    const schedule = DEFAULT_BRIEF_SCHEDULE;
    expect(scheduledEditionFor(schedule, 2)).toEqual({ kind: 'morning', light: false });
    expect(scheduledEditionFor(schedule, 6)).toEqual({ kind: 'morning', light: true });
    expect(scheduledEditionFor(schedule, 0)).toEqual({ kind: 'weekly', light: false });
    expect(scheduledEditionFor({ ...schedule, weeklyReview: false }, 0)).toEqual({
      kind: 'morning',
      light: true,
    });
    expect(scheduledEditionFor({ ...schedule, weekendMode: 'off', weeklyReview: false }, 0)).toBeNull();
    expect(scheduledEditionFor({ ...schedule, weekendMode: 'full' }, 6)).toEqual({
      kind: 'morning',
      light: false,
    });
  });

  test('each user fires at their own hour, and the catch-up follows that hour', () => {
    const targets = [
      { userId: 'seven', timezone: NY },
      { userId: 'nine', timezone: NY, schedule: { ...DEFAULT_BRIEF_SCHEDULE, deliveryHour: 9 } },
    ];
    // Tuesday 07:00 New York.
    expect(dueTargets(targets, at('2026-09-22T11:00:00Z'), () => false)).toEqual([
      { userId: 'seven', kind: 'morning', timezone: NY, catchUp: false },
    ]);
    // Tuesday 09:00 New York: nine is due; seven catches up only without an edition.
    const kinds: string[] = [];
    const nine = dueTargets(targets, at('2026-09-22T13:00:00Z'), (target, kind) => {
      kinds.push(`${target.userId}:${kind}`);
      return target.userId === 'seven';
    });
    expect(nine.map((row) => `${row.userId}:${row.catchUp}`)).toEqual(['nine:false']);
    expect(kinds).toEqual(['seven:morning']);
    // 13:00 is inside nine's window and outside seven's.
    expect(
      dueTargets(targets, at('2026-09-22T17:00:00Z'), () => false).map(
        (row) => `${row.userId}:${row.catchUp}`,
      ),
    ).toEqual(['nine:true']);
    // 14:00 closes nine's window as well.
    expect(dueTargets(targets, at('2026-09-22T18:00:00Z'), () => false)).toEqual([]);
  });

  test('weekends follow the weekend edition, and Sunday brings the weekly review', () => {
    const targets = [
      { userId: 'light', timezone: NY },
      { userId: 'off', timezone: NY, schedule: { ...DEFAULT_BRIEF_SCHEDULE, weekendMode: 'off' as const } },
      {
        userId: 'full-no-weekly',
        timezone: NY,
        schedule: { ...DEFAULT_BRIEF_SCHEDULE, weekendMode: 'full' as const, weeklyReview: false },
      },
    ];
    // Saturday 07:00 New York.
    expect(dueTargets(targets, at('2026-09-26T11:00:00Z'), () => false)).toEqual([
      { userId: 'light', kind: 'morning', timezone: NY, light: true, catchUp: false },
      { userId: 'full-no-weekly', kind: 'morning', timezone: NY, catchUp: false },
    ]);
    // Sunday 07:00 New York.
    const sunday = dueTargets(targets, at('2026-09-27T11:00:00Z'), () => false);
    expect(sunday.map((row) => `${row.userId}:${row.kind}`)).toEqual([
      'light:weekly',
      'off:weekly',
      'full-no-weekly:morning',
    ]);
    // A Sunday catch-up asks for the weekly edition, not the morning one.
    const asked: string[] = [];
    dueTargets([targets[0]], at('2026-09-27T13:00:00Z'), (_target, kind) => {
      asked.push(kind);
      return true;
    });
    expect(asked).toEqual(['weekly']);
  });
});

describe('brief preferences in Convex', () => {
  test('reads the defaults, then saves only the fields sent, and validates the hour', async () => {
    const t = convexTest(schema, modules);
    const caller = { internalSecret: SECRET, userId: 'u1' };
    expect(await t.query((api as any).dailyReports.briefPreferences, caller)).toEqual({
      ...DEFAULT_BRIEF_SCHEDULE,
      emailEnabled: false,
      timezone: null,
    });
    await expect(
      t.mutation((api as any).dailyReports.saveBriefPreferences, { ...caller, deliveryHour: 4 }),
    ).rejects.toThrow('5 to 11');
    await expect(
      t.query((api as any).dailyReports.briefPreferences, { ...caller, internalSecret: 'wrong' }),
    ).rejects.toThrow();
    const saved = await t.mutation((api as any).dailyReports.saveBriefPreferences, {
      ...caller,
      deliveryHour: 9,
      timezone: 'Europe/London',
    });
    expect(saved).toEqual({ ...DEFAULT_BRIEF_SCHEDULE, deliveryHour: 9, emailEnabled: false });
    const row = await t.run((ctx) => ctx.db.query('albatrossNotificationPreferences').unique());
    expect(row).toMatchObject({ userId: 'u1', timezone: 'Europe/London', briefDeliveryHour: 9 });
    await t.mutation((api as any).dailyReports.saveBriefPreferences, {
      ...caller,
      weekendMode: 'off',
      weeklyReview: false,
      emailEnabled: true,
      timezone: 'America/Chicago',
    });
    const after = await t.query((api as any).dailyReports.briefPreferences, caller);
    // A saved zone never moves under the user.
    expect(after).toEqual({
      deliveryHour: 9,
      weekendMode: 'off',
      weeklyReview: false,
      emailEnabled: true,
      timezone: 'Europe/London',
    });
  });

  test('a new row with no real client zone stores UTC filler, never a guessed zone', async () => {
    const t = convexTest(schema, modules);
    await t.mutation((api as any).dailyReports.saveBriefPreferences, {
      internalSecret: SECRET,
      userId: 'u2',
      weekendMode: 'full',
    });
    const row = await t.run((ctx) => ctx.db.query('albatrossNotificationPreferences').unique());
    expect(row?.timezone).toBe('UTC');
    expect(
      (await t.query((api as any).dailyReports.briefPreferences, { internalSecret: SECRET, userId: 'u2' }))
        .timezone,
    ).toBeNull();
  });

  test('scheduled target pages carry each user schedule, and the catch-up asks for the right kind', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('connectedAccounts', {
        userId: 'u1',
        accountId: 'a1',
        email: 'u1@example.com',
        provider: 'google',
        status: 'connected',
        scopes: [],
        grantId: 'g1',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('albatrossNotificationPreferences', {
        userId: 'u1',
        timezone: NY,
        eveningCheckinEnabled: true,
        eveningCheckinLocalTime: '19:00',
        inAppEnabled: true,
        webPushEnabled: false,
        emailFallbackEnabled: false,
        emailFallbackDelayMinutes: 90,
        briefDeliveryHour: 8,
        briefWeekendMode: 'off',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('userDocs', {
        userId: 'u1',
        kind: 'dailyReport',
        key: 'weekly-1',
        doc: { _id: 'weekly-1', kind: 'weekly', generatedAt: Date.parse('2026-09-27T12:05:00Z') },
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const page: any = await t.query(internal.dailyReports.reportTargetPage, {});
    expect(page.targets).toEqual([
      {
        userId: 'u1',
        timezone: NY,
        zoneKnown: true,
        schedule: { deliveryHour: 8, weekendMode: 'off', weeklyReview: true },
      },
    ]);
    const probe = { userId: 'u1', timezone: NY, at: Date.parse('2026-09-27T14:00:00Z') };
    expect(await t.query(internal.dailyReports.hasMorningEdition, { ...probe, edition: 'weekly' })).toBe(
      true,
    );
    expect(await t.query(internal.dailyReports.hasMorningEdition, probe)).toBe(false);
  });

  test('a weekly job keeps its own scope, and a light job marks its placeholder edition', async () => {
    const t = convexTest(schema, modules);
    const caller = { internalSecret: SECRET, userId: 'u1', kind: 'daily', timezone: NY };
    const weekly: any = await t.mutation((api as any).briefJobs.enqueue, {
      ...caller,
      edition: 'weekly',
      reportId: 'weekly-edition',
    });
    const manual: any = await t.mutation((api as any).briefJobs.enqueue, {
      ...caller,
      edition: 'manual',
      reportId: 'manual-edition',
      light: true,
    });
    expect(weekly.started).toBe(true);
    expect(manual.started).toBe(true);
    const jobs = await t.run((ctx) => ctx.db.query('briefJobs').collect());
    expect(jobs.map((job) => [job.scope.split(':')[0], job.active, job.light ?? false])).toEqual([
      ['weekly', true, false],
      ['daily', true, true],
    ]);
    const docs = await t.run((ctx) => ctx.db.query('userDocs').collect());
    expect(docs.find((row) => row.key === 'weekly-edition')?.doc).toMatchObject({
      kind: 'weekly',
      title: 'Weekly Review',
    });
    expect(docs.find((row) => row.key === 'manual-edition')?.doc).toMatchObject({ light: true });
  });
});

describe('the daily-report cron route', () => {
  function request(body: unknown) {
    return new NextRequest('https://mail.example.com/api/cron/daily-report', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  test('passes the weekly kind and the light flag to the job queue', async () => {
    const queued: any[] = [];
    const post = createDailyReportPost({
      isInternalCronRequest: () => true,
      isStagingRuntime: () => false,
      enqueue: async (input: any) => {
        queued.push(input);
        return { jobId: 'job', reportId: 'r', started: true };
      },
    } as any);
    const weekly = await post(request({ userId: 'u1', kind: 'weekly', light: true }));
    expect(weekly.status).toBe(202);
    const light = await post(request({ userId: 'u1', kind: 'morning', light: true, timezone: NY }));
    expect(await light.json()).toMatchObject({ ok: true, kind: 'morning', light: true });
    await post(request({ userId: 'u1', kind: 'other' }));
    expect(queued).toEqual([
      { userId: 'u1', kind: 'daily', edition: 'weekly', timezone: undefined },
      { userId: 'u1', kind: 'daily', edition: 'morning', timezone: NY, light: true },
      { userId: 'u1', kind: 'daily', edition: 'manual', timezone: undefined },
    ]);
  });
});

describe('the light edition document', () => {
  const NOW = Date.parse('2026-09-26T11:00:00Z');
  const item = (threadId: string, extra: Partial<DailyReportItem> = {}): DailyReportItem => ({
    account: 'a1',
    threadId,
    subject: `Subject ${threadId}`,
    people: ['Sam <sam@example.com>'],
    whyItMatters: 'Because.',
    unread: false,
    ...extra,
  });
  const report = (light: boolean) =>
    ({
      generatedAt: NOW,
      narrative: 'Lede.',
      light,
      sections: {
        replyOwed: [],
        followUpOwed: [],
        newPeople: [],
        timeSensitive: [],
        tracked: [],
        fyi: [],
        bulkTail: [],
        answer: [item('answer')],
        today: [item('today')],
        know: [item('know')],
        waiting: [item('waiting')],
        tasks: [
          {
            cardId: 'c1',
            boardId: 'b1',
            columnId: 'k1',
            title: 'Pay rent',
            dueAt: NOW + 3_600_000,
            scope: 'week',
          },
        ],
        mcp: [
          {
            server: 'github',
            kind: 'pull_request',
            title: 'Review me',
            assignedToUser: true,
            updatedAt: NOW,
          },
        ],
        calendar: [
          {
            account: 'a1',
            eventId: 'e1',
            title: 'Standup',
            startAt: NOW + 3_600_000,
            endAt: NOW + 5_400_000,
            scope: 'week',
          },
        ],
      },
    }) as unknown as DailyReport;
  const regions = (light: boolean) =>
    composeBudgetBriefDocument({
      report: report(light),
      prose: { lede: 'Lede.', weekAhead: 'Monday is busy.', lines: {} },
      areas: [{ areaId: 'area1', name: 'Home', line: 'Quiet.' }],
      timezone: NY,
    }).regions.map((region) => region.id);

  test('keeps the lede, answer, today with the calendar, and the week ahead', () => {
    expect(regions(false)).toEqual([
      'lede',
      'answer',
      'today',
      'know',
      'waiting',
      'tasks',
      'connected',
      'week-ahead',
      'areas',
    ]);
    expect(regions(true)).toEqual(['lede', 'answer', 'today', 'week-ahead']);
  });
});

describe('brief preferences on the server', () => {
  const stored = { ...DEFAULT_BRIEF_SCHEDULE, emailEnabled: true, timezone: NY };
  test('email reads as off, with the reason, when the email service is not set up', async () => {
    const deps = {
      query: async () => stored,
      mutation: async () => undefined,
      emailConfigured: () => false,
    } as any;
    expect(await loadBriefPreferences('u1', deps)).toEqual({
      ...stored,
      emailEnabled: false,
      email: { available: false, reason: BRIEF_EMAIL_UNAVAILABLE_REASON },
    });
    await expect(saveBriefPreferences('u1', { emailEnabled: true }, {}, deps)).rejects.toThrow(
      BRIEF_EMAIL_UNAVAILABLE_REASON,
    );
  });

  test('saves the validated fields with the client zone', async () => {
    const calls: any[] = [];
    const deps = {
      query: async () => stored,
      mutation: async (_fn: unknown, args: unknown) => {
        calls.push(args);
      },
      emailConfigured: () => true,
    } as any;
    const result = await saveBriefPreferences('u1', { deliveryHour: 6 }, { timezone: NY }, deps);
    expect(calls).toEqual([{ userId: 'u1', deliveryHour: 6, timezone: NY }]);
    expect(result.email).toEqual({ available: true, reason: null });
    await expect(saveBriefPreferences('u1', { deliveryHour: 12 }, {}, deps)).rejects.toThrow();
    await expect(saveBriefPreferences('u1', { extra: true } as any, {}, deps)).rejects.toThrow();
  });
});
