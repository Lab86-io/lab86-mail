import { expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
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

async function drain(t: ReturnType<typeof convexTest>) {
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
