import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createCostAlarmPost } from '../app/api/cron/cost-alarm/route';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  addUsageEvents,
  COST_ALARM_WINDOW_MS,
  COST_SAMPLE_LIMIT,
  costAlarmConfig,
  costAlarmDay,
  countsTowardCostAlarm,
  creditsToUsd,
  emptyCostTotals,
  keepSamples,
  mergeCostTotals,
  previousUsagePeriod,
  usagePeriod,
  usdToCredits,
  windowUpperBound,
} from '../lib/ai/cost-alarm';
import {
  type CostAlarmMessage,
  costAlarmEmail,
  resetCostAlarmWarningsForTest,
  runCostAlarm,
  sendCostAlarmEmail,
} from '../lib/notifications/cost-alarm';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-09-27 10:17 UTC.
const NOW = Date.UTC(2026, 8, 27, 10, 17);
const SECRET = 'cost-alarm-test-secret';

describe('the alarm settings', () => {
  test('the threshold is $5 unless LAB86_COST_ALARM_USD sets a positive number', () => {
    expect(costAlarmConfig({})).toEqual({ recipient: null, thresholdUsd: 5, thresholdCredits: 500 });
    expect(
      costAlarmConfig({ LAB86_OWNER_ALERT_EMAIL: ' owner@lab86.io ', LAB86_COST_ALARM_USD: '12.5' }),
    ).toEqual({ recipient: 'owner@lab86.io', thresholdUsd: 12.5, thresholdCredits: 1250 });
    for (const value of ['0', '-3', 'five', ''])
      expect(costAlarmConfig({ LAB86_COST_ALARM_USD: value }).thresholdUsd).toBe(5);
    expect(costAlarmConfig({ LAB86_OWNER_ALERT_EMAIL: '   ' }).recipient).toBeNull();
    expect(usdToCredits(5)).toBe(500);
    expect(creditsToUsd(250)).toBe(2.5);
  });

  test('days and usage periods are UTC', () => {
    expect(costAlarmDay(NOW)).toBe('2026-09-27');
    expect(costAlarmDay(Date.UTC(2026, 8, 27, 23, 59))).toBe('2026-09-27');
    expect(usagePeriod(NOW)).toBe('2026-09');
    expect(previousUsagePeriod('2026-09')).toBe('2026-08');
    expect(previousUsagePeriod('2026-01')).toBe('2025-12');
  });
});

describe('what counts toward the alarm', () => {
  test('only background calls that Lab86 pays for: no chat, no own key', () => {
    expect(countsTowardCostAlarm({ feature: 'jev_mail', source: 'lab86' })).toBe(true);
    expect(countsTowardCostAlarm({ feature: 'daily_brief_layout', source: 'lab86' })).toBe(true);
    expect(countsTowardCostAlarm({ feature: 'agent', source: 'lab86' })).toBe(false);
    expect(countsTowardCostAlarm({ feature: 'chat', source: 'lab86' })).toBe(false);
    expect(countsTowardCostAlarm({ feature: 'jev_mail', source: 'byok' })).toBe(false);
  });

  test('totals sum each feature and put the most expensive first', () => {
    const totals = addUsageEvents(emptyCostTotals(), [
      { feature: 'jev_mail', source: 'lab86', estimatedCredits: 1 },
      { feature: 'jev_mail', source: 'lab86', estimatedCredits: 2 },
      { feature: 'content_embed', source: 'lab86', estimatedCredits: 5 },
      { feature: 'agent', source: 'lab86', estimatedCredits: 100 },
      { feature: 'jev_mail', source: 'byok', estimatedCredits: 100 },
      { feature: 'bad', source: 'lab86', estimatedCredits: Number.NaN },
    ]);
    expect(totals).toEqual({
      credits: 8,
      calls: 4,
      features: [
        { feature: 'content_embed', credits: 5, calls: 1 },
        { feature: 'jev_mail', credits: 3, calls: 2 },
        { feature: 'bad', credits: 0, calls: 1 },
      ],
    });
    const merged = mergeCostTotals(totals, {
      credits: 4,
      calls: 1,
      features: [{ feature: 'jev_mail', credits: 4, calls: 1 }],
    });
    expect(merged.features[0]).toEqual({ feature: 'jev_mail', credits: 7, calls: 3 });
    expect(merged).toMatchObject({ credits: 12, calls: 5 });
  });
});

describe('the upper limit from samples', () => {
  const since = NOW - DAY;
  const current = { period: '2026-09', credits: 900 };

  test('the newest sample at or before the window start is the baseline', () => {
    const samples = [
      { at: since - 3 * HOUR, period: '2026-09', credits: 100 },
      { at: since - HOUR, period: '2026-09', credits: 300 },
      { at: since + HOUR, period: '2026-09', credits: 500 },
    ];
    expect(windowUpperBound({ samples, since, current, previous: null })).toBe(600);
  });

  test('with no baseline the limit is the whole month', () => {
    expect(windowUpperBound({ samples: [], since, current, previous: null })).toBe(900);
    const recentOnly = [{ at: since + HOUR, period: '2026-09', credits: 500 }];
    expect(windowUpperBound({ samples: recentOnly, since, current, previous: null })).toBe(900);
  });

  test('a window that starts last month adds last month after the baseline', () => {
    const now = Date.UTC(2026, 9, 1, 5); // 05:00 UTC on October 1.
    const start = now - DAY;
    const october = { period: '2026-10', credits: 40 };
    const september = { period: '2026-09', credits: 1000 };
    const baseline = [{ at: start - HOUR, period: '2026-09', credits: 950 }];
    expect(windowUpperBound({ samples: baseline, since: start, current: october, previous: september })).toBe(
      90,
    );
    expect(windowUpperBound({ samples: [], since: start, current: october, previous: september })).toBe(1040);
    expect(windowUpperBound({ samples: [], since: start, current: october, previous: null })).toBe(40);
    // A window inside one month never reads last month.
    expect(windowUpperBound({ samples: [], since, current, previous: september })).toBe(900);
  });

  test('a baseline above the row (a reset row) does not go below zero', () => {
    const samples = [{ at: since - HOUR, period: '2026-09', credits: 5000 }];
    expect(windowUpperBound({ samples, since, current, previous: null })).toBe(0);
  });

  test('a run keeps the baseline and the newer samples, with a limit', () => {
    const old = [
      { at: since - 5 * HOUR, period: '2026-09', credits: 1 },
      { at: since - HOUR, period: '2026-09', credits: 2 },
      { at: since + HOUR, period: '2026-09', credits: 3 },
    ];
    const next = keepSamples(old, { at: NOW, period: '2026-09', credits: 9 }, since);
    expect(next.map((sample) => sample.credits)).toEqual([2, 3, 9]);
    // The same run again replaces its own sample.
    expect(keepSamples(next, { at: NOW, period: '2026-09', credits: 10 }, since).at(-1)?.credits).toBe(10);
    const many = Array.from({ length: 80 }, (_, i) => ({
      at: since + i * 60_000,
      period: '2026-09',
      credits: i,
    }));
    const capped = keepSamples(many, { at: NOW, period: '2026-09', credits: 99 }, since);
    // The first of these is at the window start, so it stays as the baseline.
    expect(capped).toHaveLength(COST_SAMPLE_LIMIT);
    expect(capped[0].credits).toBe(0);
    expect(capped.at(-1)?.credits).toBe(99);
    expect(keepSamples([], { at: NOW, period: '2026-09', credits: 1 }, since)).toHaveLength(1);
  });
});

describe('the alarm email', () => {
  test('names the user tail, the cost, the top features, and that nothing stopped', () => {
    const totals = {
      credits: 642,
      calls: 3210,
      features: Array.from({ length: 10 }, (_, i) => ({
        feature: `feature_${i}`,
        credits: 60 - i,
        calls: 300,
      })),
    };
    const email = costAlarmEmail({ userId: 'user_3F2uuD9CIn4dO3LLoX', totals, thresholdUsd: 5, now: NOW });
    expect(email.subject).toBe('Albatross cost alarm: O3LLoX used $6.42 in 24 hours');
    expect(email.text).toContain('User: user_3F2uuD9CIn4dO3LLoX');
    expect(email.text).toContain('went above $5.00 in 24 hours');
    expect(email.text).toContain('Window: 2026-09-26 10:17 UTC to 2026-09-27 10:17 UTC');
    expect(email.text).toContain('Background cost: $6.42 for 3,210 calls');
    expect(email.text).toContain('- feature_0: $0.60, 300 calls');
    expect(email.text).toContain('- feature_7:');
    expect(email.text).not.toContain('feature_8');
    expect(email.text).toContain('Nothing was stopped or limited.');
    expect(email.text).toContain('Chat and own-key calls are not in this count.');
    expect(email.text).not.toContain('page limit');
    expect(costAlarmEmail({ userId: 'u', totals, thresholdUsd: 5, now: NOW, partial: true }).text).toContain(
      'the real cost is higher',
    );
  });

  test('Resend gets a plain-text email from the notification sender', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const message = { to: 'owner@lab86.io', subject: 'Subject', text: 'Body' };
    const env = { RESEND_API_KEY: 're_test', LAB86_NOTIFICATION_FROM: 'Albatross <n@lab86.io>' };
    expect(await sendCostAlarmEmail(message, { fetch: fetchStub, env })).toBe('email_1');
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      from: 'Albatross <n@lab86.io>',
      to: ['owner@lab86.io'],
      subject: 'Subject',
      text: 'Body',
    });
    const failing = (async () =>
      new Response(JSON.stringify({ message: 'bad key' }), { status: 401 })) as unknown as typeof fetch;
    await expect(sendCostAlarmEmail(message, { fetch: failing, env })).rejects.toThrow('bad key');
    const empty = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(sendCostAlarmEmail(message, { fetch: empty, env: {} })).rejects.toThrow(
      'Resend failed (500)',
    );
  });
});

describe('the alarm against Convex', () => {
  let previousSecret: string | undefined;
  beforeAll(() => {
    previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  });
  beforeEach(() => resetCostAlarmWarningsForTest());

  const harness = () =>
    convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/aiCostAlarm.ts': () => import('../convex/aiCostAlarm'),
    });
  type Harness = ReturnType<typeof harness>;

  /** Usage events, plus the period rows that recordUsage keeps beside them. */
  async function use(
    t: Harness,
    userId: string,
    events: Array<{ feature: string; source?: 'lab86' | 'byok'; credits: number; at: number }>,
  ) {
    await t.run(async (ctx) => {
      for (const event of events) {
        const source = event.source ?? 'lab86';
        await ctx.db.insert('aiUsageEvents', {
          userId,
          feature: event.feature,
          source,
          provider: 'openrouter',
          model: 'z-ai/glm-5.3-flash',
          estimatedCredits: event.credits,
          ok: true,
          createdAt: event.at,
        });
        const period = usagePeriod(event.at);
        const row = await ctx.db
          .query('aiUsagePeriods')
          .withIndex('by_user_period_source', (q) =>
            q.eq('userId', userId).eq('period', period).eq('source', source),
          )
          .unique();
        if (row)
          await ctx.db.patch(row._id, {
            creditsUsed: row.creditsUsed + event.credits,
            calls: row.calls + 1,
            updatedAt: Math.max(row.updatedAt, event.at),
          });
        else
          await ctx.db.insert('aiUsagePeriods', {
            userId,
            period,
            source,
            creditsUsed: event.credits,
            calls: 1,
            updatedAt: event.at,
          });
      }
    });
  }

  function deps(t: Harness, overrides: { now?: number; env?: Record<string, string>; send?: any } = {}) {
    const sent: CostAlarmMessage[] = [];
    const calls: string[] = [];
    const scans: string[] = [];
    const send =
      overrides.send ??
      mock(async (message: CostAlarmMessage) => {
        sent.push(message);
        return 'email_1';
      });
    return {
      sent,
      calls,
      scans,
      send,
      deps: {
        env: () =>
          overrides.env ?? {
            LAB86_OWNER_ALERT_EMAIL: 'owner@lab86.io',
            RESEND_API_KEY: 're_test',
            LAB86_NOTIFICATION_FROM: 'Albatross <n@lab86.io>',
          },
        now: () => overrides.now ?? NOW,
        query: (async (ref: any, args: any) => {
          calls.push(getFunctionName(ref));
          if (getFunctionName(ref) === 'aiCostAlarm:usagePage') scans.push(args.userId);
          return t.query(ref, { internalSecret: SECRET, ...args });
        }) as any,
        mutate: (async (ref: any, args: any) => {
          calls.push(getFunctionName(ref));
          return t.mutation(ref, { internalSecret: SECRET, ...args });
        }) as any,
        send,
      },
    };
  }

  test('no owner address or no Resend: no Convex call, no email, and one warning', async () => {
    const t = harness();
    await use(t, 'loop', [{ feature: 'jev_mail', credits: 900, at: NOW - HOUR }]);
    const warn = mock(() => undefined);
    const original = console.warn;
    console.warn = warn;
    try {
      const none = deps(t, { env: { RESEND_API_KEY: 're_test', LAB86_NOTIFICATION_FROM: 'n@lab86.io' } });
      expect(await runCostAlarm(none.deps)).toEqual({ status: 'unconfigured', missing: 'recipient' });
      expect(await runCostAlarm(none.deps)).toEqual({ status: 'unconfigured', missing: 'recipient' });
      expect(none.calls).toEqual([]);
      expect(none.send).not.toHaveBeenCalled();
      const noResend = deps(t, { env: { LAB86_OWNER_ALERT_EMAIL: 'owner@lab86.io' } });
      expect(await runCostAlarm(noResend.deps)).toEqual({ status: 'unconfigured', missing: 'email' });
      expect(noResend.calls).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      console.warn = original;
    }
  });

  test('one email for a background loop, none for chat or own key, and one each UTC day', async () => {
    const t = harness();
    // A Jev loop: $9 of background cost in the last day.
    await use(t, 'user_loop_a1b2c3', [
      ...Array.from({ length: 30 }, (_, i) => ({
        feature: 'jev_mail',
        credits: 25,
        at: NOW - (i + 1) * 10 * 60_000,
      })),
      { feature: 'content_embed', credits: 150, at: NOW - 2 * HOUR },
      { feature: 'agent', credits: 400, at: NOW - HOUR },
    ]);
    // Heavy chat and a little background work: the upper limit passes, the scan does not.
    await use(t, 'user_chatty', [
      { feature: 'agent', credits: 2000, at: NOW - HOUR },
      { feature: 'chat', credits: 800, at: NOW - 2 * HOUR },
      { feature: 'jev_mail', credits: 100, at: NOW - 3 * HOUR },
    ]);
    // An own-key loop costs Lab86 nothing.
    await use(t, 'user_byok', [{ feature: 'jev_mail', source: 'byok', credits: 5000, at: NOW - HOUR }]);
    // Old cost, outside the window.
    await use(t, 'user_old', [{ feature: 'jev_mail', credits: 5000, at: NOW - 2 * DAY }]);

    const first = deps(t);
    expect(await runCostAlarm(first.deps)).toEqual({
      status: 'ran',
      checked: 2,
      scanned: 2,
      sent: 1,
      failed: 0,
    });
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0].to).toBe('owner@lab86.io');
    expect(first.sent[0].subject).toBe('Albatross cost alarm: a1b2c3 used $9.00 in 24 hours');
    expect(first.sent[0].text).toContain('- jev_mail: $7.50, 30 calls');
    expect(first.sent[0].text).toContain('- content_embed: $1.50, 1 call\n');
    expect(first.sent[0].text).not.toContain('agent');

    // An hour later the loop goes on, but the day's alarm was sent.
    await use(t, 'user_loop_a1b2c3', [{ feature: 'jev_mail', credits: 500, at: NOW + 30 * 60_000 }]);
    const later = deps(t, { now: NOW + HOUR });
    expect(await runCostAlarm(later.deps)).toMatchObject({ status: 'ran', sent: 0 });
    expect(later.scans).not.toContain('user_loop_a1b2c3');
    expect(later.scans).toContain('user_chatty');

    // The next UTC day, a loop that is still over the threshold alarms again.
    const tomorrow = Date.UTC(2026, 8, 28, 1, 17);
    await use(t, 'user_loop_a1b2c3', [{ feature: 'jev_mail', credits: 600, at: tomorrow - HOUR }]);
    const next = deps(t, { now: tomorrow });
    expect(await runCostAlarm(next.deps)).toMatchObject({ status: 'ran', sent: 1 });
    expect(next.sent[0].subject).toContain('a1b2c3');
  });

  test('a user under the threshold gets no scan once a day of samples exists', async () => {
    const t = harness();
    // Last month's high use makes the whole month count until a sample exists.
    await use(t, 'user_steady', [{ feature: 'jev_mail', credits: 800, at: NOW - 3 * DAY }]);
    await use(t, 'user_steady', [{ feature: 'jev_mail', credits: 10, at: NOW - HOUR }]);
    const first = deps(t);
    expect(await runCostAlarm(first.deps)).toMatchObject({ checked: 1, scanned: 1, sent: 0 });
    // A day later the sample from the first run is the baseline: $0.20 of new cost, no scan.
    await use(t, 'user_steady', [{ feature: 'jev_mail', credits: 20, at: NOW + DAY - HOUR }]);
    const next = deps(t, { now: NOW + DAY });
    expect(await runCostAlarm(next.deps)).toMatchObject({ checked: 1, scanned: 0, sent: 0 });
    expect(next.scans).toEqual([]);
    expect(next.calls).toContain('aiCostAlarm:recordSamples');
  });

  test('a failed send gives the claim back, so the next run sends', async () => {
    const t = harness();
    await use(t, 'user_loop', [{ feature: 'jev_mail', credits: 700, at: NOW - HOUR }]);
    const error = console.error;
    console.error = () => undefined;
    try {
      const failing = deps(t, {
        send: mock(async () => {
          throw new Error('Resend is down');
        }),
      });
      expect(await runCostAlarm(failing.deps)).toMatchObject({ sent: 0, failed: 1 });
      expect(failing.calls).toContain('aiCostAlarm:releaseAlarm');
    } finally {
      console.error = error;
    }
    const retry = deps(t, { now: NOW + HOUR });
    expect(await runCostAlarm(retry.deps)).toMatchObject({ sent: 1, failed: 0 });
  });

  test('the Convex functions need the internal secret, and a claim holds for its day only', async () => {
    const t = harness();
    await expect(t.query(api.aiCostAlarm.activeUsage, { since: 0, now: NOW })).rejects.toThrow();
    await expect(
      t.mutation(api.aiCostAlarm.claimAlarm, {
        internalSecret: 'wrong',
        userId: 'u',
        day: 'd',
        credits: 1,
        now: 1,
      }),
    ).rejects.toThrow();
    const claim = (day: string) =>
      t.mutation(api.aiCostAlarm.claimAlarm, {
        internalSecret: SECRET,
        userId: 'u',
        day,
        credits: 600,
        now: NOW,
      });
    expect(await claim('2026-09-27')).toEqual({ claimed: true });
    expect(await claim('2026-09-27')).toEqual({ claimed: false });
    const release = (day: string) =>
      t.mutation(api.aiCostAlarm.releaseAlarm, { internalSecret: SECRET, userId: 'u', day });
    expect(await release('2026-09-26')).toEqual({ released: false });
    expect(await release('2026-09-27')).toEqual({ released: true });
    expect(await claim('2026-09-27')).toEqual({ claimed: true });
    expect(await claim('2026-09-28')).toEqual({ claimed: true });
    expect(await release('2026-09-28')).toEqual({ released: true });
    expect(await release('2026-09-28')).toEqual({ released: false });
  });

  test('the usage page sums only the window, and pages through many events', async () => {
    const t = harness();
    await use(t, 'user_many', [
      ...Array.from({ length: 1005 }, (_, i) => ({ feature: 'jev_mail', credits: 1, at: NOW - HOUR + i })),
      { feature: 'jev_mail', credits: 999, at: NOW - DAY - 1 },
      { feature: 'jev_mail', credits: 999, at: NOW + 1 },
    ]);
    const first = await t.query(api.aiCostAlarm.usagePage, {
      internalSecret: SECRET,
      userId: 'user_many',
      since: NOW - DAY,
      until: NOW,
    });
    expect(first).toMatchObject({ events: 1000, isDone: false });
    const second = await t.query(api.aiCostAlarm.usagePage, {
      internalSecret: SECRET,
      userId: 'user_many',
      since: NOW - DAY,
      until: NOW,
      cursor: first.cursor,
    });
    expect(mergeCostTotals(first.totals, second.totals)).toMatchObject({ credits: 1005, calls: 1005 });
  });

  test('a failed usage read for one user does not stop the others', async () => {
    const t = harness();
    await use(t, 'user_broken', [{ feature: 'jev_mail', credits: 700, at: NOW - HOUR }]);
    await use(t, 'user_loop', [{ feature: 'jev_mail', credits: 700, at: NOW - HOUR }]);
    const d = deps(t);
    const query = d.deps.query;
    d.deps.query = (async (ref: any, args: any) => {
      if (getFunctionName(ref) === 'aiCostAlarm:usagePage' && args.userId === 'user_broken')
        throw new Error('Convex is busy');
      return query(ref, args);
    }) as any;
    const error = console.error;
    console.error = () => undefined;
    try {
      expect(await runCostAlarm(d.deps)).toMatchObject({ checked: 2, scanned: 2, sent: 1, failed: 1 });
    } finally {
      console.error = error;
    }
    expect(d.sent[0].subject).toContain('r_loop');
  });

  test('a scan that reaches its page limit sends with a note', async () => {
    const t = harness();
    await use(t, 'user_loop', [{ feature: 'jev_mail', credits: 700, at: NOW - HOUR }]);
    const d = deps(t);
    const query = d.deps.query;
    let pages = 0;
    d.deps.query = (async (ref: any, args: any) => {
      if (getFunctionName(ref) !== 'aiCostAlarm:usagePage') return query(ref, args);
      pages += 1;
      return {
        totals: { credits: 10, calls: 1, features: [{ feature: 'jev_mail', credits: 10, calls: 1 }] },
        events: 1,
        cursor: `page-${pages}`,
        isDone: false,
      };
    }) as any;
    expect(await runCostAlarm(d.deps)).toMatchObject({ sent: 1 });
    expect(pages).toBe(200);
    expect(d.sent[0].text).toContain('the real cost is higher');
    expect(d.sent[0].subject).toContain('$20.00');
  });

  test('the hourly cron starts the app route with the internal secret', async () => {
    const t = harness();
    const saved = { url: process.env.LAB86_MAIL_PUBLIC_URL, fetch: globalThis.fetch };
    const posts: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      posts.push({ url, init });
      return new Response('{}', { status: 202 });
    }) as unknown as typeof fetch;
    const error = console.error;
    console.error = () => undefined;
    try {
      delete process.env.LAB86_MAIL_PUBLIC_URL;
      await t.action(internal.aiCostAlarm.tick, {});
      expect(posts).toEqual([]);
      process.env.LAB86_MAIL_PUBLIC_URL = 'https://mail.example.test/';
      await t.action(internal.aiCostAlarm.tick, {});
      expect(posts.map((post) => post.url)).toEqual(['https://mail.example.test/api/cron/cost-alarm']);
      expect((posts[0].init.headers as Record<string, string>)['x-lab86-internal-secret']).toBe(SECRET);
    } finally {
      console.error = error;
      globalThis.fetch = saved.fetch;
      if (saved.url === undefined) delete process.env.LAB86_MAIL_PUBLIC_URL;
      else process.env.LAB86_MAIL_PUBLIC_URL = saved.url;
    }
  });
});

describe('the cost alarm route', () => {
  let previousSecret: string | undefined;
  beforeAll(() => {
    previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  });

  const request = (headers: Record<string, string> = {}) =>
    new NextRequest('http://localhost/api/cron/cost-alarm', { method: 'POST', headers });

  test('only the internal secret starts a run', async () => {
    const run = mock(async () => ({ status: 'ran' as const, checked: 1, scanned: 1, sent: 1, failed: 0 }));
    const info = console.info;
    console.info = () => undefined;
    try {
      const post = createCostAlarmPost({ runCostAlarm: run });
      expect((await post(request())).status).toBe(401);
      expect((await post(request({ 'x-lab86-internal-secret': 'wrong' }))).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
      const response = await post(request({ 'x-lab86-internal-secret': SECRET }));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, started: true });
      expect(run).toHaveBeenCalledTimes(1);
      const bearer = await post(request({ authorization: `Bearer ${SECRET}` }));
      expect(bearer.status).toBe(202);
    } finally {
      console.info = info;
    }
  });

  test('a failed run does not fail the response', async () => {
    const error = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const post = createCostAlarmPost({
        runCostAlarm: async () => {
          throw new Error('Convex is down');
        },
      });
      expect((await post(request({ 'x-lab86-internal-secret': SECRET }))).status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logged).toHaveLength(1);
    } finally {
      console.error = error;
    }
  });
});

test('the window is 24 hours', () => {
  expect(COST_ALARM_WINDOW_MS).toBe(DAY);
});
