import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import { DEAD_ACCOUNT_PURGE_AFTER_MS, deadSince, isPurgeDue } from '../convex/deadAccounts';
import schema from '../convex/schema';
import { ABSENT_BODY_PART, bodyPartHash, joinBodyHash } from '../lib/mail/corpus-body';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/correspondents.ts': () => import('../convex/correspondents'),
  '../convex/deadAccounts.ts': () => import('../convex/deadAccounts'),
};
const SECRET = 'dead-account-secret';
const USER = 'user_dead';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1);
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});
afterEach(() => setSystemTime());

type T = TestConvex<typeof schema>;

const connect = (t: T, grantId = 'grant_1', email = 'ann@example.com') =>
  t.mutation(api.accounts.upsertConnectedAccount, {
    internalSecret: SECRET,
    userId: USER,
    email,
    provider: 'google',
    grantId,
    scopes: ['email'],
  });

const markDead = (t: T, grantId = 'grant_1') =>
  t.mutation(api.accounts.markGrantReconnectNeeded, {
    internalSecret: SECRET,
    grantId,
    reason: 'Reconnect needed: the mailbox sign-in expired',
  });

async function seedCorpus(t: T, accountId: string, messages = 3) {
  await t.run(async (ctx) => {
    const base = { userId: USER, accountId, grantId: 'grant_x', provider: 'google' as const };
    for (let i = 0; i < messages; i++)
      await ctx.db.insert('mailCorpusMessages', {
        ...base,
        providerMessageId: `${accountId}-m${i}`,
        providerThreadId: `${accountId}-t`,
        subject: 's',
        from: 'a@example.com',
        to: 'me@example.com',
        receivedAt: T0,
        snippet: 's',
        searchText: 's',
        labels: ['INBOX'],
        yearMonth: '2026-06',
        createdAt: T0,
        updatedAt: T0,
      });
    await ctx.db.insert('mailCorpusThreads', {
      ...base,
      providerThreadId: `${accountId}-t`,
      subject: 's',
      fromAddress: 'a@example.com',
      lastDate: T0,
      snippet: 's',
      labels: ['INBOX'],
      unread: false,
      yearMonth: '2026-06',
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.db.insert('mailLabelMembership', {
      userId: USER,
      accountId,
      providerThreadId: `${accountId}-t`,
      labelKey: 'custom:x',
      lastDate: T0,
      unread: false,
    });
    await ctx.db.insert('calendarEvents', {
      ...base,
      providerEventId: `${accountId}-e`,
      providerCalendarId: 'cal',
      title: 'x',
      startAt: T0,
      endAt: T0 + 1,
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.db.insert('calendars', {
      ...base,
      providerCalendarId: 'cal',
      name: 'Cal',
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.db.insert('calendarSyncStates', { ...base, status: 'ready', createdAt: T0, updatedAt: T0 });
    await ctx.db.insert('mailWebhookEvents', {
      eventId: `${accountId}-w`,
      type: 'message.created',
      userId: USER,
      accountId,
      payload: {},
      status: 'error',
      receivedAt: T0,
    });
    const content = await ctx.db.insert('contentItems', {
      userId: USER,
      key: `mail:${accountId}:t`,
      connectionId: accountId,
      source: 'mail',
      externalId: 't',
      title: 'x',
      text: 'x',
      version: 'v',
      modifiedAt: T0,
      indexedAt: T0,
      partial: false,
      deleted: false,
      status: 'ready',
      attempts: 0,
      nextAttemptAt: 0,
    });
    await ctx.db.insert('contentChunks', {
      userId: USER,
      itemId: content,
      version: 'v',
      text: 'x',
      embedding: new Array(1536).fill(0),
    });
  });
}

async function countFor(t: T, accountId: string) {
  return t.run(async (ctx) => {
    const tables = [
      'mailCorpusMessages',
      'mailCorpusThreads',
      'mailLabelMembership',
      'calendarEvents',
      'calendars',
      'calendarSyncStates',
      'mailSyncStates',
      'mailWebhookEvents',
    ] as const;
    const counts: Record<string, number> = {};
    for (const table of tables)
      counts[table] = (await (ctx.db.query(table) as any).collect()).filter(
        (row: any) => row.accountId === accountId,
      ).length;
    counts.contentItems = (await ctx.db.query('contentItems').collect()).filter(
      (row) => row.connectionId === accountId,
    ).length;
    counts.contentChunks = (await ctx.db.query('contentChunks').collect()).length;
    return counts;
  });
}

// Each purge pass schedules the next one with a real timer, so the drain
// waits one tick before each wave of scheduled work.
async function drain(t: T) {
  for (let wave = 0; wave < 20; wave++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

describe('dead-account bookkeeping', () => {
  test('errorSince is set when the account goes to error, and a reconnect clears it', async () => {
    const t = convexTest(schema, convexModules);
    setSystemTime(new Date(T0));
    await connect(t);
    await markDead(t);
    let row = await t.run((ctx) => ctx.db.query('connectedAccounts').first());
    expect(row).toMatchObject({ status: 'error', errorSince: T0, errorSinceSource: 'status_change' });
    setSystemTime(new Date(T0 + DAY));
    await connect(t);
    row = await t.run((ctx) => ctx.db.query('connectedAccounts').first());
    expect(row?.status).toBe('connected');
    expect(row?.errorSince).toBeUndefined();
    expect(row?.errorSinceSource).toBeUndefined();
    expect(row?.corpusPurgedAt).toBeUndefined();
  });

  test('isPurgeDue and deadSince read errorSince, then updatedAt', () => {
    const ts = T0 + DEAD_ACCOUNT_PURGE_AFTER_MS;
    expect(deadSince({ errorSince: 5, updatedAt: 9 })).toBe(5);
    expect(deadSince({ updatedAt: 9 })).toBe(9);
    expect(isPurgeDue({ status: 'error', errorSince: T0, updatedAt: ts }, ts)).toBe(true);
    expect(isPurgeDue({ status: 'error', updatedAt: T0 + 1 }, ts)).toBe(false);
    expect(isPurgeDue({ status: 'error', errorSince: T0, updatedAt: ts, corpusPurgedAt: 1 }, ts)).toBe(false);
    expect(isPurgeDue({ status: 'connected', errorSince: T0, updatedAt: ts }, ts)).toBe(false);
  });
});

describe('dead-account purge', () => {
  test('dry run lists due accounts, the tick purges them, and live accounts stay', async () => {
    const t = convexTest(schema, convexModules);
    setSystemTime(new Date(T0));
    await connect(t, 'grant_1', 'dead@example.com');
    await connect(t, 'grant_2', 'live@example.com');
    await markDead(t, 'grant_1');
    await seedCorpus(t, 'grant_1', 45);
    await seedCorpus(t, 'grant_2');
    const later = T0 + DEAD_ACCOUNT_PURGE_AFTER_MS + DAY;

    const report = await t.query(internal.deadAccounts.deadAccountReport, { now: later });
    expect(report.accounts).toHaveLength(1);
    expect(report.accounts[0]).toMatchObject({
      accountId: 'grant_1',
      purgeDue: true,
      errorSinceKnown: true,
      deadDays: 31,
      counts: { mailCorpusMessages: 45, mailCorpusThreads: 1, calendarEvents: 1, contentItems: 1 },
    });
    // The body table exists; this account has no body rows yet.
    expect(report.accounts[0].counts.mailCorpusBodies).toBe(0);

    const dry = await t.mutation(internal.deadAccounts.purgeDeadAccountsTick, { now: later, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, scheduled: 0, accounts: [{ accountId: 'grant_1' }] });
    expect((await countFor(t, 'grant_1')).mailCorpusMessages).toBe(45);

    expect(await t.mutation(internal.deadAccounts.purgeDeadAccountsTick, { now: later })).toMatchObject({
      scheduled: 1,
    });
    await drain(t);
    expect(await countFor(t, 'grant_1')).toEqual({
      mailCorpusMessages: 0,
      mailCorpusThreads: 0,
      mailLabelMembership: 0,
      calendarEvents: 0,
      calendars: 0,
      calendarSyncStates: 0,
      mailSyncStates: 0,
      mailWebhookEvents: 0,
      contentItems: 0,
      contentChunks: 1,
    });
    const live = await countFor(t, 'grant_2');
    expect(live).toMatchObject({
      mailCorpusMessages: 3,
      mailSyncStates: 1,
      calendarEvents: 1,
      contentItems: 1,
    });
    const dead = await t.run((ctx) =>
      ctx.db
        .query('connectedAccounts')
        .withIndex('by_user_account', (q) => q.eq('userId', USER).eq('accountId', 'grant_1'))
        .unique(),
    );
    expect(dead?.status).toBe('error');
    expect(dead?.corpusPurgedAt).toBeNumber();
    // A purged account is not purged again.
    expect(await t.mutation(internal.deadAccounts.purgeDeadAccountsTick, { now: later })).toMatchObject({
      scheduled: 0,
    });
  });

  test('a reconnect after the purge starts a fresh backfill', async () => {
    const t = convexTest(schema, convexModules);
    setSystemTime(new Date(T0));
    await connect(t);
    await t.run(async (ctx) => {
      const state = await ctx.db.query('mailSyncStates').first();
      await ctx.db.patch(state!._id, { status: 'ready', corpusReady: true });
    });
    await markDead(t);
    await seedCorpus(t, 'grant_1');
    await t.mutation(internal.deadAccounts.purgeDeadAccountBatch, { userId: USER, accountId: 'grant_1' });
    await drain(t);
    // Same grant id: without the purge, the ready corpus would stay ready.
    await connect(t);
    const state = await t.run((ctx) => ctx.db.query('mailSyncStates').first());
    expect(state).toMatchObject({ status: 'idle', corpusReady: false });
    const row = await t.run((ctx) => ctx.db.query('connectedAccounts').first());
    expect(row?.corpusPurgedAt).toBeUndefined();
  });

  test('a purge pass stops when the account is live again', async () => {
    const t = convexTest(schema, convexModules);
    await connect(t);
    await seedCorpus(t, 'grant_1');
    expect(
      await t.mutation(internal.deadAccounts.purgeDeadAccountBatch, { userId: USER, accountId: 'grant_1' }),
    ).toEqual({ deleted: 0, stopped: 'not_dead' });
    expect((await countFor(t, 'grant_1')).mailCorpusMessages).toBe(3);
  });

  test('backfillErrorSince uses the last good mail sync, capped by updatedAt', async () => {
    const t = convexTest(schema, convexModules);
    await connect(t, 'grant_1', 'a@example.com');
    await connect(t, 'grant_2', 'b@example.com');
    const lastGood = T0 - 90 * DAY;
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('connectedAccounts').collect())
        await ctx.db.patch(row._id, { status: 'error', updatedAt: T0 });
      const state = await ctx.db
        .query('mailSyncStates')
        .withIndex('by_user_account', (q) => q.eq('userId', USER).eq('accountId', 'grant_1'))
        .unique();
      await ctx.db.patch(state!._id, { lastIncrementalSyncAt: lastGood, lastBackfillAt: lastGood - DAY });
      const other = await ctx.db
        .query('mailSyncStates')
        .withIndex('by_user_account', (q) => q.eq('userId', USER).eq('accountId', 'grant_2'))
        .unique();
      await ctx.db.delete(other!._id);
    });
    const dry = await t.mutation(internal.deadAccounts.backfillErrorSince, { dryRun: true });
    expect(dry.updated).toBe(0);
    expect(dry.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: 'grant_1', errorSince: lastGood, source: 'last_mail_sync' }),
        expect.objectContaining({ accountId: 'grant_2', errorSince: T0, source: 'updated_at' }),
      ]),
    );
    expect(await t.mutation(internal.deadAccounts.backfillErrorSince, {})).toMatchObject({ updated: 2 });
    const sources = await t.run(async (ctx) =>
      (await ctx.db.query('connectedAccounts').collect()).map((row) => [row.accountId, row.errorSinceSource]),
    );
    expect(sources.sort()).toEqual([
      ['grant_1', 'last_mail_sync'],
      ['grant_2', 'updated_at'],
    ]);
    expect(await t.mutation(internal.deadAccounts.backfillErrorSince, {})).toMatchObject({ updated: 0 });
    const due = await t.mutation(internal.deadAccounts.purgeDeadAccountsTick, { now: T0, dryRun: true });
    expect(due.accounts.map((row: { accountId: string }) => row.accountId)).toEqual(['grant_1']);
  });

  test('a purge chain stops when the error period changes', async () => {
    const t = convexTest(schema, convexModules);
    setSystemTime(new Date(T0));
    await connect(t);
    await markDead(t);
    await seedCorpus(t, 'grant_1', 45);
    // The first pass pins the current period and deletes one page.
    const first = await t.mutation(internal.deadAccounts.purgeDeadAccountBatch, {
      userId: USER,
      accountId: 'grant_1',
    });
    expect(first).toMatchObject({ done: false });
    // One pass takes a page that the byte room of message rows sets.
    const left = (await countFor(t, 'grant_1')).mailCorpusMessages;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(45);
    // The account reconnects and fails again before the next pass runs.
    setSystemTime(new Date(T0 + 2 * DAY));
    await connect(t);
    await markDead(t);
    await drain(t);
    expect((await countFor(t, 'grant_1')).mailCorpusMessages).toBe(left);
    const row = await t.run((ctx) => ctx.db.query('connectedAccounts').first());
    expect(row).toMatchObject({ status: 'error', errorSince: T0 + 2 * DAY });
    expect(row?.corpusPurgedAt).toBeUndefined();
    // A pass for an old period stops at once.
    expect(
      await t.mutation(internal.deadAccounts.purgeDeadAccountBatch, {
        userId: USER,
        accountId: 'grant_1',
        errorSince: T0,
      }),
    ).toEqual({ deleted: 0, stopped: 'error_period_changed' });
    // A row from before errorSince existed is period null: a new error sets it.
    expect(
      await t.mutation(internal.deadAccounts.purgeDeadAccountBatch, {
        userId: USER,
        accountId: 'grant_1',
        errorSince: null,
      }),
    ).toEqual({ deleted: 0, stopped: 'error_period_changed' });
  });

  async function insertErrorAccounts(t: T, count: number, fields: Record<string, unknown> = {}) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++)
        await ctx.db.insert('connectedAccounts', {
          userId: USER,
          accountId: `bulk_${i}`,
          email: `bulk${i}@example.com`,
          provider: 'google',
          grantId: `bulk_grant_${i}`,
          status: 'error',
          scopes: [],
          createdAt: T0,
          updatedAt: T0,
          ...fields,
        } as never);
    });
  }

  test('the tick and the backfill read every account in error, page by page', async () => {
    const t = convexTest(schema, convexModules);
    setSystemTime(new Date(T0));
    await insertErrorAccounts(t, 120);
    await connect(t, 'grant_live', 'live@example.com');
    const later = T0 + DEAD_ACCOUNT_PURGE_AFTER_MS + DAY;

    const dry = await t.mutation(internal.deadAccounts.purgeDeadAccountsTick, { now: later, dryRun: true });
    expect(dry.accounts).toHaveLength(100);
    expect(dry.isDone).toBe(false);
    const dryRest = await t.mutation(internal.deadAccounts.purgeDeadAccountsTick, {
      now: later,
      dryRun: true,
      cursor: dry.continueCursor,
    });
    expect(dryRest.accounts).toHaveLength(20);
    expect(dryRest).toMatchObject({ isDone: true, continueCursor: null });

    const backfillDry = await t.mutation(internal.deadAccounts.backfillErrorSince, { dryRun: true });
    expect(backfillDry.accounts).toHaveLength(50);
    expect(backfillDry.isDone).toBe(false);
    expect(await t.mutation(internal.deadAccounts.backfillErrorSince, {})).toMatchObject({ updated: 50 });
    await drain(t);
    const rows = await t.run((ctx) => ctx.db.query('connectedAccounts').collect());
    const bulk = rows.filter((row) => row.accountId.startsWith('bulk_'));
    expect(bulk.every((row) => row.errorSince === T0 && row.errorSinceSource === 'updated_at')).toBe(true);
    // The backfill does not touch an account that is not in error.
    const live = rows.find((row) => row.accountId === 'grant_live');
    expect(live?.errorSince).toBeUndefined();
    expect(live?.errorSinceSource).toBeUndefined();

    expect(await t.mutation(internal.deadAccounts.purgeDeadAccountsTick, { now: later })).toMatchObject({
      scheduled: 100,
      isDone: false,
    });
    await drain(t);
    const purged = await t.run(
      async (ctx) =>
        (await ctx.db.query('connectedAccounts').collect()).filter((row) => row.corpusPurgedAt).length,
    );
    expect(purged).toBe(120);
  });

  test('the report pages its accounts and counts bodies without reading them', async () => {
    const t = convexTest(schema, convexModules);
    setSystemTime(new Date(T0));
    await insertErrorAccounts(t, 3);
    const withBody = joinBodyHash({ text: bodyPartHash('Hello'), html: ABSENT_BODY_PART });
    const noBody = joinBodyHash({ text: ABSENT_BODY_PART, html: ABSENT_BODY_PART });
    await t.run(async (ctx) => {
      for (const [index, bodyHash] of [withBody, withBody, noBody, undefined].entries())
        await ctx.db.insert('mailCorpusMessages', {
          userId: USER,
          accountId: 'bulk_0',
          grantId: 'bulk_grant_0',
          provider: 'google',
          providerMessageId: `m${index}`,
          providerThreadId: 't',
          subject: 's',
          from: 'a@example.com',
          to: 'me@example.com',
          receivedAt: T0,
          snippet: 's',
          searchText: 's',
          labels: ['INBOX'],
          yearMonth: '2026-06',
          createdAt: T0,
          updatedAt: T0,
          ...(bodyHash ? { bodyHash } : {}),
        });
    });
    const first = await t.query(internal.deadAccounts.deadAccountReport, { now: T0, numItems: 2 });
    expect(first.accounts).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const bulk0 = first.accounts.find((row: { accountId: string }) => row.accountId === 'bulk_0');
    expect(bulk0?.counts).toMatchObject({ mailCorpusMessages: 4, mailCorpusBodies: 2 });
    expect(bulk0).toMatchObject({ errorSinceKnown: false, errorSinceSource: null });
    const rest = await t.query(internal.deadAccounts.deadAccountReport, {
      now: T0,
      numItems: 50,
      cursor: first.continueCursor,
    });
    expect(rest.accounts).toHaveLength(1);
    expect(rest).toMatchObject({ isDone: true, continueCursor: null });
    // The default page is small.
    expect((await t.query(internal.deadAccounts.deadAccountReport, { now: T0 })).accounts).toHaveLength(2);
  });
});
