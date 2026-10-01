import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { hashChannelToken } from '../lib/google/push/channel-token';
import { gmailPollDue, PUSH_MESSAGE_WRITE_INTERVAL_MS } from '../lib/google/push/rules';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/googleDirect.ts': () => import('../convex/googleDirect'),
  '../convex/googlePush.ts': () => import('../convex/googlePush'),
};

const SECRET = 'google-push-runtime-secret';
const USER = 'user_push';
const USER_B = 'user_push_b';
const ACCOUNT = 'acct_push';
const GRANT = 'google:33333333-3333-4333-8333-333333333333';
const GRANT_B = 'google:44444444-4444-4444-8444-444444444444';
const HASH = hashChannelToken('channel-token');
const CHANNEL = '5f1c2a7e-4c1b-4b0e-9d3a-2a9c1e0b7f11';
const DAY = 86_400_000;
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function harness() {
  return convexTest(schema, convexModules);
}

type Harness = ReturnType<typeof harness>;

async function seedAccount(t: Harness, overrides: Record<string, unknown> = {}) {
  await t.run(async (ctx) => {
    const ts = Date.now();
    await ctx.db.insert('connectedAccounts', {
      userId: USER,
      accountId: ACCOUNT,
      email: 'ann@example.com',
      provider: 'google',
      status: 'connected',
      scopes: [],
      grantId: GRANT,
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    } as any);
  });
}

async function seedCalendar(t: Harness, calendarId: string, accountId = ACCOUNT) {
  await t.run(async (ctx) => {
    const ts = Date.now();
    await ctx.db.insert('calendars', {
      userId: USER,
      accountId,
      grantId: GRANT,
      provider: 'google',
      providerCalendarId: calendarId,
      name: calendarId,
      createdAt: ts,
      updatedAt: ts,
    });
  });
}

async function seedRow(t: Harness, overrides: Record<string, unknown>) {
  await t.run(async (ctx) => {
    const ts = Date.now();
    await ctx.db.insert('googlePushChannels', {
      userId: USER,
      kind: 'calendar',
      channelId: CHANNEL,
      accountId: ACCOUNT,
      grantId: GRANT,
      status: 'active',
      requestedAt: ts - 60_000,
      renewedAt: ts - 60_000,
      expiration: ts + 5 * DAY,
      lastMessageAt: ts - 30_000,
      tokenHash: HASH,
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    } as any);
  });
}

const rows = (t: Harness) => t.run(async (ctx) => await ctx.db.query('googlePushChannels').collect());

describe('registration rows', () => {
  test('every function needs the internal secret', async () => {
    const t = harness();
    await expect(t.query(api.googlePush.userPlan, { internalSecret: 'wrong', userId: USER })).rejects.toThrow(
      'Invalid Convex internal secret',
    );
    await expect(
      t.query(api.googlePush.channelForPush, { internalSecret: 'wrong', channelId: CHANNEL }),
    ).rejects.toThrow('Invalid Convex internal secret');
  });

  test('a channel row starts pending with its token hash, then becomes active', async () => {
    const t = harness();
    await t.mutation(api.googlePush.beginRegistration, {
      internalSecret: SECRET,
      userId: USER,
      kind: 'calendar',
      channelId: CHANNEL,
      accountId: ACCOUNT,
      grantId: GRANT,
      calendarId: 'primary@example.com',
      tokenHash: HASH,
    });
    expect((await rows(t))[0]).toMatchObject({
      status: 'pending',
      tokenHash: HASH,
      calendarId: 'primary@example.com',
    });
    // The sync message can come before the watch call returns.
    expect(
      await t.query(api.googlePush.channelForPush, { internalSecret: SECRET, channelId: CHANNEL }),
    ).toMatchObject({ userId: USER, kind: 'calendar', tokenHash: HASH, status: 'pending' });
    expect(
      await t.mutation(api.googlePush.finishRegistration, {
        internalSecret: SECRET,
        userId: USER,
        channelId: CHANNEL,
        outcome: 'active',
        resourceId: 'res-1',
        expiration: Date.now() + 7 * DAY,
      }),
    ).toEqual({ updated: true });
    expect((await rows(t))[0]).toMatchObject({ status: 'active', resourceId: 'res-1', failures: 0 });
    // A finish for another user changes nothing.
    expect(
      await t.mutation(api.googlePush.finishRegistration, {
        internalSecret: SECRET,
        userId: USER_B,
        channelId: CHANNEL,
        outcome: 'failed',
      }),
    ).toEqual({ updated: false });
  });

  test('a channel needs a valid token hash and a unique id; an active finish needs an expiration', async () => {
    const t = harness();
    const base = {
      internalSecret: SECRET,
      userId: USER,
      kind: 'drive' as const,
      channelId: CHANNEL,
      connectionId: 'c',
    };
    await expect(t.mutation(api.googlePush.beginRegistration, base)).rejects.toThrow('SHA-256 hash');
    await expect(
      t.mutation(api.googlePush.beginRegistration, { ...base, tokenHash: 'channel-token' }),
    ).rejects.toThrow('SHA-256 hash');
    await t.mutation(api.googlePush.beginRegistration, { ...base, tokenHash: HASH });
    await expect(t.mutation(api.googlePush.beginRegistration, { ...base, tokenHash: HASH })).rejects.toThrow(
      'in use',
    );
    await expect(
      t.mutation(api.googlePush.finishRegistration, {
        internalSecret: SECRET,
        userId: USER,
        channelId: CHANNEL,
        outcome: 'active',
      }),
    ).rejects.toThrow('expiration');
  });

  test('a failed channel stores the error, the retry time, and the unsupported mark', async () => {
    const t = harness();
    await seedRow(t, { status: 'pending', resourceId: undefined });
    await t.mutation(api.googlePush.finishRegistration, {
      internalSecret: SECRET,
      userId: USER,
      channelId: CHANNEL,
      outcome: 'failed',
      error: 'x'.repeat(500),
      retryAfter: 123,
      unsupported: true,
    });
    const [row] = await rows(t);
    expect(row).toMatchObject({ status: 'failed', failures: 1, retryAfter: 123, unsupported: true });
    expect(row.lastError).toHaveLength(300);
  });

  test('a Gmail mailbox keeps one row; a renewal of the same grant stays active, a failed renewal keeps a live watch', async () => {
    const t = harness();
    const begin = (channelId: string, grantId = GRANT) =>
      t.mutation(api.googlePush.beginRegistration, {
        internalSecret: SECRET,
        userId: USER,
        kind: 'gmail',
        channelId,
        accountId: ACCOUNT,
        grantId,
      });
    await expect(
      t.mutation(api.googlePush.beginRegistration, {
        internalSecret: SECRET,
        userId: USER,
        kind: 'gmail',
        channelId: 'x',
      }),
    ).rejects.toThrow('needs an account');
    expect(await begin('gmail-1')).toMatchObject({ channelId: 'gmail-1' });
    await t.mutation(api.googlePush.finishRegistration, {
      internalSecret: SECRET,
      userId: USER,
      channelId: 'gmail-1',
      outcome: 'active',
      expiration: Date.now() + 7 * DAY,
      historyId: '555',
    });
    // A renewal names a new id, but the mailbox row keeps its own.
    expect(await begin('ignored')).toMatchObject({ channelId: 'gmail-1' });
    let all = await rows(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'active', historyId: '555' });
    await t.mutation(api.googlePush.finishRegistration, {
      internalSecret: SECRET,
      userId: USER,
      channelId: 'gmail-1',
      outcome: 'failed',
      error: 'quota',
      retryAfter: 1,
    });
    all = await rows(t);
    expect(all[0]).toMatchObject({ status: 'active', failures: 1, lastError: 'quota' });
    // Another grant cannot use the old watch.
    await begin('ignored', GRANT_B);
    expect((await rows(t))[0]).toMatchObject({ status: 'pending', grantId: GRANT_B });
  });

  test('rows go by channel id, only for their own user', async () => {
    const t = harness();
    await seedRow(t, {});
    await seedRow(t, { channelId: 'other-user', userId: USER_B });
    expect(
      await t.mutation(api.googlePush.removeChannels, {
        internalSecret: SECRET,
        userId: USER,
        channelIds: [CHANNEL, CHANNEL, 'other-user', 'missing'],
      }),
    ).toEqual({ removed: 1 });
    expect((await rows(t)).map((row) => row.channelId)).toEqual(['other-user']);
  });
});

describe('push route lookups', () => {
  test('a Gmail row is not a channel for the channel routes', async () => {
    const t = harness();
    await seedRow(t, { kind: 'gmail', tokenHash: undefined });
    expect(
      await t.query(api.googlePush.channelForPush, { internalSecret: SECRET, channelId: CHANNEL }),
    ).toBeNull();
    expect(
      await t.query(api.googlePush.channelForPush, { internalSecret: SECRET, channelId: 'none' }),
    ).toBeNull();
  });

  test('the message time is written for the first message after a call, then at most every few minutes', async () => {
    const t = harness();
    const ts = Date.now();
    await seedRow(t, { requestedAt: ts - 1000, lastMessageAt: undefined });
    const record = () =>
      t.mutation(api.googlePush.recordChannelMessage, { internalSecret: SECRET, channelId: CHANNEL });
    expect(await record()).toEqual({ recorded: true });
    expect(await record()).toEqual({ recorded: false });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('googlePushChannels').first())!;
      await ctx.db.patch(row._id, { lastMessageAt: Date.now() - PUSH_MESSAGE_WRITE_INTERVAL_MS });
    });
    expect(await record()).toEqual({ recorded: true });
    expect(
      await t.mutation(api.googlePush.recordChannelMessage, { internalSecret: SECRET, channelId: 'none' }),
    ).toEqual({ recorded: false });
  });

  test('a Gmail address finds the connected direct accounts of all users, in either case', async () => {
    const t = harness();
    await seedAccount(t);
    await seedAccount(t, { userId: USER_B, accountId: 'acct_b', email: 'Ann@Example.com', grantId: GRANT_B });
    await seedAccount(t, { userId: 'nylas_user', accountId: 'acct_n', grantId: 'nylas-grant' });
    await seedAccount(t, { userId: 'error_user', accountId: 'acct_e', grantId: 'google:e', status: 'error' });
    const targets = await t.query(api.googlePush.gmailPushTargets, {
      internalSecret: SECRET,
      email: 'Ann@Example.com',
    });
    expect(targets.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: USER, accountId: ACCOUNT },
      { userId: USER_B, accountId: 'acct_b' },
    ]);
    expect(await t.query(api.googlePush.gmailPushTargets, { internalSecret: SECRET, email: ' ' })).toEqual(
      [],
    );
  });

  test('a Gmail push is recorded on the row of its mailbox', async () => {
    const t = harness();
    const args = { internalSecret: SECRET, userId: USER, accountId: ACCOUNT };
    expect(await t.mutation(api.googlePush.recordGmailPush, args)).toEqual({ recorded: false });
    await seedRow(t, { kind: 'gmail', lastMessageAt: undefined });
    expect(await t.mutation(api.googlePush.recordGmailPush, args)).toEqual({ recorded: true });
    expect(await t.mutation(api.googlePush.recordGmailPush, args)).toEqual({ recorded: false });
  });
});

describe('stop plans', () => {
  test('a grant lists its rows and tells when another account shares the mailbox', async () => {
    const t = harness();
    expect(
      await t.query(api.googlePush.stopPlanForGrant, { internalSecret: SECRET, grantId: 'nylas-grant' }),
    ).toBeNull();
    expect(
      await t.query(api.googlePush.stopPlanForGrant, { internalSecret: SECRET, grantId: GRANT }),
    ).toBeNull();
    await seedAccount(t);
    await seedRow(t, { kind: 'gmail', channelId: 'g1', tokenHash: undefined });
    await seedRow(t, {});
    let plan = await t.query(api.googlePush.stopPlanForGrant, { internalSecret: SECRET, grantId: GRANT });
    expect(plan?.userId).toBe(USER);
    expect(plan?.sharedMailbox).toBe(false);
    expect(plan?.channels.map((row: any) => row.channelId).sort()).toEqual([CHANNEL, 'g1'].sort());
    expect(JSON.stringify(plan)).not.toContain(HASH);
    await seedAccount(t, { userId: USER_B, accountId: 'acct_b', email: 'ANN@example.com', grantId: GRANT_B });
    await t.run(async (ctx) => {
      const row = (await ctx.db
        .query('connectedAccounts')
        .withIndex('by_grant', (q) => q.eq('grantId', GRANT_B))
        .first())!;
      await ctx.db.patch(row._id, { email: 'ann@example.com' });
    });
    plan = await t.query(api.googlePush.stopPlanForGrant, { internalSecret: SECRET, grantId: GRANT });
    expect(plan?.sharedMailbox).toBe(true);
  });

  test('a Nylas connection of the address also counts as shared; a grant without an account row counts as shared', async () => {
    const t = harness();
    await seedAccount(t);
    await seedRow(t, { kind: 'gmail', channelId: 'g1', tokenHash: undefined });
    await seedAccount(t, { userId: USER_B, accountId: 'acct_n', grantId: 'nylas-grant-b', status: 'error' });
    let plan = await t.query(api.googlePush.stopPlanForGrant, { internalSecret: SECRET, grantId: GRANT });
    expect(plan?.sharedMailbox).toBe(true);
    await seedRow(t, { kind: 'gmail', channelId: 'orphan', grantId: GRANT_B, tokenHash: undefined });
    plan = await t.query(api.googlePush.stopPlanForGrant, { internalSecret: SECRET, grantId: GRANT_B });
    expect(plan?.sharedMailbox).toBe(true);
  });

  test('a Drive connection lists only its own channels, without the token hash', async () => {
    const t = harness();
    await seedRow(t, { kind: 'drive', channelId: 'd1', connectionId: 'conn_1', accountId: undefined });
    await seedRow(t, { kind: 'drive', channelId: 'd2', connectionId: 'conn_2', accountId: undefined });
    const listed = await t.query(api.googlePush.channelsForConnection, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: 'conn_1',
    });
    expect(listed.map((row: any) => row.channelId)).toEqual(['d1']);
    expect(listed[0].tokenHash).toBeUndefined();
  });
});

describe('renewal plan', () => {
  test('lists direct accounts, their calendars, Drive connections with their page token, and the rows', async () => {
    const t = harness();
    await seedAccount(t);
    await seedAccount(t, { accountId: 'acct_nylas', grantId: 'nylas-grant' });
    await seedAccount(t, { accountId: 'acct_err', grantId: 'google:err', status: 'error' });
    await seedCalendar(t, 'primary@example.com');
    await seedCalendar(t, 'err-cal', 'acct_err');
    await t.run(async (ctx) => {
      const ts = Date.now();
      for (const [connectionId, provider] of [
        ['drive_1', 'google_drive'],
        ['onedrive_1', 'onedrive'],
      ] as const) {
        await ctx.db.insert('cloudFileConnections', {
          userId: USER,
          connectionId,
          provider,
          accountKey: connectionId,
          status: 'connected',
          scopes: [],
          createdAt: ts,
          updatedAt: ts,
        });
      }
      await ctx.db.insert('contentSync', {
        userId: USER,
        connectionId: 'drive_1',
        cursor: { phase: 'changes', token: 'page-9' },
        status: 'ready',
        indexed: 0,
        skipped: 0,
        updatedAt: ts,
      });
    });
    await seedRow(t, {});
    const plan = await t.query(api.googlePush.userPlan, { internalSecret: SECRET, userId: USER });
    expect(plan.accounts.map((row) => row.accountId).sort()).toEqual(['acct_err', ACCOUNT]);
    expect(plan.calendars).toEqual([{ accountId: ACCOUNT, calendarId: 'primary@example.com' }]);
    expect(plan.drives).toEqual([{ connectionId: 'drive_1', status: 'connected', pageToken: 'page-9' }]);
    expect(plan.contentEnabled).toBe(true);
    expect(plan.channels).toHaveLength(1);
    expect(JSON.stringify(plan)).not.toContain(HASH);
  });

  test('each account tells if another connection or a kept Nylas grant has its mailbox', async () => {
    const t = harness();
    await seedAccount(t);
    await seedAccount(t, { accountId: 'acct_switched', email: 'bob@example.com', grantId: GRANT_B });
    await seedAccount(t, { accountId: 'acct_alone', email: 'cy@example.com', grantId: 'google:alone' });
    // Another user's direct connection of ann@: shared, but no Nylas grant.
    await seedAccount(t, { userId: USER_B, accountId: 'acct_b', grantId: 'google:b' });
    await t.run(async (ctx) => {
      await ctx.db.insert('providerGrants', {
        userId: USER,
        accountId: 'acct_switched',
        provider: 'google',
        grantId: GRANT_B,
        email: 'bob@example.com',
        scopes: [],
        previousNylasGrantId: 'nylas-kept',
        createdAt: 1,
        updatedAt: 1,
      } as any);
    });
    const plan = await t.query(api.googlePush.userPlan, { internalSecret: SECRET, userId: USER });
    const byId = Object.fromEntries(plan.accounts.map((row) => [row.accountId, row]));
    expect(byId[ACCOUNT]).toMatchObject({ sharedMailbox: true, nylasMailbox: false });
    expect(byId.acct_switched).toMatchObject({ sharedMailbox: false, nylasMailbox: true });
    expect(byId.acct_alone).toMatchObject({ sharedMailbox: false, nylasMailbox: false });
    // A Nylas connection of the same address, of any user, is a Nylas mailbox.
    await seedAccount(t, {
      userId: 'nylas_user',
      accountId: 'acct_n',
      email: 'cy@example.com',
      grantId: 'nylas-cy',
    });
    const next = await t.query(api.googlePush.userPlan, { internalSecret: SECRET, userId: USER });
    expect(next.accounts.find((row) => row.accountId === 'acct_alone')).toMatchObject({
      sharedMailbox: true,
      nylasMailbox: true,
    });
  });

  test('a user without accounts gets an empty plan; content indexing off is reported', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      await ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'contentPreferences',
        key: 'default',
        doc: { enabled: false, prepare: false },
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('cloudFileConnections', {
        userId: USER,
        connectionId: 'drive_1',
        provider: 'google_drive',
        accountKey: 'k',
        status: 'connected',
        scopes: [],
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const plan = await t.query(api.googlePush.userPlan, { internalSecret: SECRET, userId: USER });
    expect(plan).toEqual({
      accounts: [],
      calendars: [],
      drives: [{ connectionId: 'drive_1', status: 'connected' }],
      contentEnabled: false,
      channels: [],
    });
  });
});

describe('poll health', () => {
  test('the calendar plan marks an account healthy only when each calendar has a live, verified channel', async () => {
    const t = harness();
    expect(
      await t.query(api.googlePush.calendarPollPlan, {
        internalSecret: SECRET,
        userId: USER,
        now: Date.now(),
      }),
    ).toEqual([]);
    await seedAccount(t);
    await seedCalendar(t, 'primary@example.com');
    await seedCalendar(t, 'team@example.com');
    await seedRow(t, { calendarId: 'primary@example.com' });
    await t.run(async (ctx) => {
      await ctx.db.insert('calendarSyncStates', {
        userId: USER,
        accountId: ACCOUNT,
        grantId: GRANT,
        provider: 'google',
        status: 'ready',
        lastSyncedAt: 5,
        lastFullSyncAt: 4,
        windowEnd: 3,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    let plan = await t.query(api.googlePush.calendarPollPlan, {
      internalSecret: SECRET,
      userId: USER,
      now: Date.now(),
    });
    expect(plan).toEqual([
      { accountId: ACCOUNT, healthy: false, state: { lastSyncedAt: 5, lastFullSyncAt: 4, windowEnd: 3 } },
    ]);
    await seedRow(t, { channelId: 'team-channel', calendarId: 'team@example.com' });
    plan = await t.query(api.googlePush.calendarPollPlan, {
      internalSecret: SECRET,
      userId: USER,
      now: Date.now(),
    });
    expect(plan[0].healthy).toBe(true);
  });

  test('a calendar account without a sync state reports no state', async () => {
    const t = harness();
    await seedAccount(t);
    const plan = await t.query(api.googlePush.calendarPollPlan, {
      internalSecret: SECRET,
      userId: USER,
      now: Date.now(),
    });
    expect(plan).toEqual([{ accountId: ACCOUNT, healthy: false, state: null }]);
  });

  test('healthy Gmail accounts have a live watch with a push after the last watch call', async () => {
    const t = harness();
    await seedRow(t, { kind: 'gmail', channelId: 'healthy' });
    await seedRow(t, {
      kind: 'gmail',
      channelId: 'quiet',
      accountId: 'acct_quiet',
      lastMessageAt: undefined,
    });
    await seedRow(t, { kind: 'gmail', channelId: 'pending', accountId: 'acct_pending', status: 'pending' });
    expect(await t.query(internal.googlePush.healthyGmailAccounts, { now: Date.now() })).toEqual([
      `${USER}:${ACCOUNT}`,
    ]);
  });
});

function withAppEnv<T>(fn: (posts: Array<{ url: string; body: any }>) => Promise<T>) {
  const savedUrl = process.env.LAB86_MAIL_PUBLIC_URL;
  const originalFetch = globalThis.fetch;
  const posts: Array<{ url: string; body: any }> = [];
  process.env.LAB86_MAIL_PUBLIC_URL = 'https://mail.example/';
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
  return fn(posts).finally(() => {
    globalThis.fetch = originalFetch;
    if (savedUrl === undefined) delete process.env.LAB86_MAIL_PUBLIC_URL;
    else process.env.LAB86_MAIL_PUBLIC_URL = savedUrl;
  });
}

describe('crons', () => {
  test('renewal targets: direct accounts, Google Drive connections, and users with rows', async () => {
    const t = harness();
    await seedAccount(t);
    await seedAccount(t, { userId: 'nylas_user', accountId: 'n', grantId: 'nylas-grant' });
    await t.run(async (ctx) => {
      for (const [userId, provider] of [
        ['drive_user', 'google_drive'],
        ['onedrive_user', 'onedrive'],
      ] as const) {
        await ctx.db.insert('cloudFileConnections', {
          userId,
          connectionId: `${userId}_conn`,
          provider,
          accountKey: 'k',
          status: 'connected',
          scopes: [],
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    await seedRow(t, { userId: 'rows_user' });
    const targets = await t.query(internal.googlePush.renewalTargets, {});
    expect(targets.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: 'drive_user', hasChannels: false },
      { userId: 'rows_user', hasChannels: true },
      { userId: USER, hasChannels: false },
    ]);
  });

  test('the renewal tick posts each target to the app, and does nothing without the app URL', async () => {
    const t = harness();
    const savedUrl = process.env.LAB86_MAIL_PUBLIC_URL;
    delete process.env.LAB86_MAIL_PUBLIC_URL;
    const original = console.error;
    console.error = () => {};
    try {
      expect(await t.action(internal.googlePush.renewalTick, {})).toEqual({ requested: 0, ok: 0 });
    } finally {
      console.error = original;
      if (savedUrl !== undefined) process.env.LAB86_MAIL_PUBLIC_URL = savedUrl;
    }
    await withAppEnv(async (posts) => {
      expect(await t.action(internal.googlePush.renewalTick, {})).toEqual({ requested: 0, ok: 0 });
      await seedAccount(t);
      expect(await t.action(internal.googlePush.renewalTick, {})).toEqual({ requested: 1, ok: 1 });
      expect(posts).toEqual([
        { url: 'https://mail.example/api/cron/google-push', body: { userId: USER, hasChannels: false } },
      ]);
    });
  });

  /** A time at which the fallback poll of the key is (or is not) due. */
  function timeWhere(due: boolean, key: string) {
    for (let t = 1_800_000_000_000; ; t += 60_000) {
      if (gmailPollDue({ now: t, key, healthy: true }) === due) return t;
    }
  }

  test('the History tick skips a mailbox with healthy push between its fallback ticks', async () => {
    setSystemTime(new Date(timeWhere(false, `${USER}:${ACCOUNT}`)));
    try {
      const t = harness();
      await seedAccount(t);
      await seedAccount(t, { userId: USER_B, accountId: 'acct_b', grantId: GRANT_B });
      await seedRow(t, { kind: 'gmail', channelId: 'healthy' });
      await withAppEnv(async (posts) => {
        expect(await t.action(internal.googleDirect.historyTick, {})).toEqual({
          requested: 1,
          ok: 1,
          deferred: 1,
        });
        expect(posts.map((post) => post.body)).toEqual([{ userId: USER_B, accountId: 'acct_b' }]);
      });
    } finally {
      setSystemTime();
    }
  });

  test('the History tick reads a mailbox with healthy push on its fallback tick', async () => {
    setSystemTime(new Date(timeWhere(true, `${USER}:${ACCOUNT}`)));
    try {
      const t = harness();
      await seedAccount(t);
      await seedRow(t, { kind: 'gmail', channelId: 'healthy' });
      await withAppEnv(async (posts) => {
        expect(await t.action(internal.googleDirect.historyTick, {})).toEqual({ requested: 1, ok: 1 });
        expect(posts.map((post) => post.body)).toEqual([{ userId: USER, accountId: ACCOUNT }]);
      });
    } finally {
      setSystemTime();
    }
  });

  test('the History tick posts nothing when every mailbox waits, and reads a mailbox whose push stopped', async () => {
    setSystemTime(new Date(timeWhere(false, `${USER}:${ACCOUNT}`)));
    try {
      const t = harness();
      await seedAccount(t);
      await seedRow(t, { kind: 'gmail', channelId: 'healthy' });
      await withAppEnv(async (posts) => {
        expect(await t.action(internal.googleDirect.historyTick, {})).toEqual({
          requested: 0,
          ok: 0,
          deferred: 1,
        });
        expect(posts).toEqual([]);
        // The watch expired: the mailbox is read on each tick again.
        await t.run(async (ctx) => {
          const row = (await ctx.db.query('googlePushChannels').first())!;
          await ctx.db.patch(row._id, { expiration: Date.now() - 1 });
        });
        expect(await t.action(internal.googleDirect.historyTick, {})).toEqual({ requested: 1, ok: 1 });
      });
    } finally {
      setSystemTime();
    }
  });
});
