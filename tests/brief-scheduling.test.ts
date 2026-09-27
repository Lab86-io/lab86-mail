import { expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
};
async function seeded() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 8; i++)
      for (let account = 0; account < 3; account++)
        await ctx.db.insert('connectedAccounts', {
          userId: `user-${i}`,
          accountId: `account-${i}-${account}`,
          email: `${i}@example.com`,
          provider: 'google',
          status: i === 7 ? 'disconnected' : 'connected',
          scopes: [],
          grantId: `grant-${i}-${account}`,
          createdAt: 1,
          updatedAt: 1,
        });
  });
  return t;
}

async function drain(t: TestConvex<typeof schema>) {
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.finishInProgressScheduledFunctions();
    const pending = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    if (pending.every((row) => row.state.kind === 'success')) return;
  }
  throw new Error('Scheduled brief continuation did not drain');
}

test('scheduled target pages are bounded and skip duplicate accounts without losing users', async () => {
  const t = await seeded();
  const users: string[] = [];
  let afterUserId: string | undefined;
  do {
    const page: any = await t.query(internal.dailyReports.reportTargetPage, { afterUserId });
    expect(page.targets.length).toBeLessThanOrEqual(2);
    users.push(...page.targets.map((target: any) => target.userId));
    afterUserId = page.nextUserId || undefined;
  } while (afterUserId);
  expect(users).toEqual(Array.from({ length: 7 }, (_, i) => `user-${i}`));
});

test('both scheduled workflows resume all target pages and preserve the original morning instant', async () => {
  const before = {
    url: process.env.LAB86_MAIL_PUBLIC_URL,
    secret: process.env.LAB86_CONVEX_INTERNAL_SECRET,
    railway: process.env.RAILWAY_ENVIRONMENT_NAME,
    mail: process.env.LAB86_MAIL_ENV,
    env: process.env.LAB86_ENV,
  };
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; body: any }> = [];
  process.env.LAB86_MAIL_PUBLIC_URL = 'https://brief.example.com';
  process.env.LAB86_CONVEX_INTERNAL_SECRET = 'test-secret';
  process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return new Response('{}');
  }) as typeof fetch;
  try {
    const t = await seeded();
    await t.action(internal.dailyReports.tick, { at: Date.parse('2026-09-22T11:00:00Z') });
    await drain(t);
    expect(
      calls
        .filter((call) => call.path.endsWith('daily-report'))
        .map((call) => call.body.userId)
        .sort(),
    ).toEqual(Array.from({ length: 7 }, (_, i) => `user-${i}`));
    expect(calls.filter((call) => call.path.endsWith('area-briefs'))).toHaveLength(7);
    // Area jobs are queued before the daily briefs that read their pulses.
    const firstDaily = calls.findIndex((call) => call.path.endsWith('daily-report'));
    const lastArea = calls.findLastIndex((call) => call.path.endsWith('area-briefs'));
    expect(lastArea).toBeLessThan(calls.findLastIndex((call) => call.path.endsWith('daily-report')));
    expect(calls.findIndex((call) => call.path.endsWith('area-briefs'))).toBeLessThan(firstDaily);
    // No user here has a known zone: the scheduling clock is never sent as theirs.
    expect(
      calls.filter((call) => call.path.endsWith('daily-report')).every((call) => !('timezone' in call.body)),
    ).toBe(true);
    calls.length = 0;
    await t.action(internal.dailyReports.areaRefreshTick, {});
    await drain(t);
    expect(calls.map((call) => call.body.userId).sort()).toEqual(
      Array.from({ length: 7 }, (_, i) => `user-${i}`),
    );
    expect(calls.every((call) => call.body.force === false)).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      LAB86_MAIL_PUBLIC_URL: before.url,
      LAB86_CONVEX_INTERNAL_SECRET: before.secret,
      RAILWAY_ENVIRONMENT_NAME: before.railway,
      LAB86_MAIL_ENV: before.mail,
      LAB86_ENV: before.env,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('scheduled targets use the preference zone, then the calendar zone, then the last client zone', async () => {
  const t = await seeded();
  await t.run(async (ctx) => {
    const preference = {
      eveningCheckinEnabled: true,
      eveningCheckinLocalTime: '19:00',
      inAppEnabled: true,
      webPushEnabled: false,
      emailFallbackEnabled: false,
      emailFallbackDelayMinutes: 30,
      createdAt: 1,
      updatedAt: 1,
    };
    await ctx.db.insert('albatrossNotificationPreferences', {
      ...preference,
      userId: 'user-0',
      timezone: 'Europe/Berlin',
    });
    await ctx.db.insert('albatrossNotificationPreferences', {
      ...preference,
      userId: 'user-1',
      timezone: 'UTC',
    });
    for (const userId of ['user-0', 'user-1'])
      await ctx.db.insert('calendars', {
        userId,
        accountId: 'a',
        grantId: 'g',
        provider: 'google',
        providerCalendarId: `cal-${userId}`,
        name: 'Main',
        timezone: 'America/Chicago',
        isPrimary: true,
        createdAt: 1,
        updatedAt: 1,
      });
    const job = { active: false, availableAt: 0, createdAt: 1, attempts: 1, state: 'completed' as const };
    await ctx.db.insert('briefJobs', {
      ...job,
      userId: 'user-2',
      scope: 'daily:x',
      kind: 'daily',
      edition: 'manual',
      timezone: 'Asia/Tokyo',
    });
    // A scheduled job's zone is not a client zone.
    await ctx.db.insert('briefJobs', {
      ...job,
      userId: 'user-3',
      scope: 'daily:y',
      kind: 'daily',
      edition: 'morning',
      timezone: 'America/New_York',
    });
  });
  const targets: any[] = [];
  let afterUserId: string | undefined;
  do {
    const page: any = await t.query(internal.dailyReports.reportTargetPage, { afterUserId });
    targets.push(...page.targets);
    afterUserId = page.nextUserId || undefined;
  } while (afterUserId);
  const byUser = Object.fromEntries(targets.map((target) => [target.userId, target]));
  expect(byUser['user-0']).toMatchObject({ timezone: 'Europe/Berlin', zoneKnown: true });
  expect(byUser['user-1']).toMatchObject({ timezone: 'America/Chicago', zoneKnown: true });
  expect(byUser['user-2']).toMatchObject({ timezone: 'Asia/Tokyo', zoneKnown: true });
  expect(byUser['user-3']).toMatchObject({ zoneKnown: false });
});
