import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api } from '../convex/_generated/api';
import { nextWebhookAttemptAt, WEBHOOK_MAX_ATTEMPTS } from '../convex/mailCorpus';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
};
const SECRET = 'account-health-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const connect = (t: TestConvex<typeof schema>, grantId = 'grant_1') =>
  t.mutation((api as any).accounts.upsertConnectedAccount, {
    internalSecret: SECRET,
    userId: 'user_1',
    email: 'Ann@Example.com',
    provider: 'google',
    grantId,
    scopes: ['email'],
  });

describe('account health state (SYNC-2, CAL-8)', () => {
  test('a dead grant moves connected accounts to reconnect, and a reconnect clears it', async () => {
    const t = convexTest(schema, convexModules);
    await connect(t);
    await t.run(async (ctx) => {
      const state = await ctx.db.query('mailSyncStates').first();
      await ctx.db.patch(state!._id, { status: 'error', error: 'No grant found', corpusReady: true });
    });
    const marked = await t.mutation((api as any).accounts.markGrantReconnectNeeded, {
      internalSecret: SECRET,
      grantId: 'grant_1',
      reason: 'Reconnect needed: the mailbox sign-in expired',
    });
    expect(marked).toEqual({ updated: 1 });
    let row = await t.run((ctx) => ctx.db.query('connectedAccounts').first());
    expect(row).toMatchObject({ status: 'error', error: 'Reconnect needed: the mailbox sign-in expired' });
    // A second event for the same grant changes nothing.
    expect(
      await t.mutation((api as any).accounts.markGrantReconnectNeeded, {
        internalSecret: SECRET,
        grantId: 'grant_1',
        reason: 'Reconnect needed: again',
      }),
    ).toEqual({ updated: 0 });

    await connect(t);
    row = await t.run((ctx) => ctx.db.query('connectedAccounts').first());
    expect(row?.status).toBe('connected');
    expect(row?.error).toBeUndefined();
    const state = await t.run((ctx) => ctx.db.query('mailSyncStates').first());
    expect(state).toMatchObject({ status: 'ready', corpusReady: true });
    expect(state?.error).toBeUndefined();
  });
});

describe('durable webhook retry (SYNC-3)', () => {
  test('errors back off, stuck events are found, and the cap parks an event', async () => {
    const t = convexTest(schema, convexModules);
    for (const eventId of ['evt_err', 'evt_stuck', 'evt_new']) {
      await t.mutation(api.mailCorpus.recordWebhookEvent, {
        internalSecret: SECRET,
        eventId,
        type: 'message.updated',
        grantId: 'grant_1',
        payload: { id: eventId },
      });
    }
    await t.run(async (ctx) => {
      const stuck = await ctx.db
        .query('mailWebhookEvents')
        .withIndex('by_event', (q) => q.eq('eventId', 'evt_stuck'))
        .unique();
      await ctx.db.patch(stuck!._id, { receivedAt: Date.now() - 60 * 60_000 });
    });
    const failed = await t.mutation(api.mailCorpus.markWebhookEventProcessed, {
      internalSecret: SECRET,
      eventId: 'evt_err',
      status: 'error',
      error: 'Too many requests',
    });
    expect(failed).toMatchObject({ ok: true, attempts: 1, abandoned: false });
    // Still inside its backoff: only the stuck event is due.
    let due = await t.query((api as any).mailCorpus.listRetryableWebhookEvents, { internalSecret: SECRET });
    expect(due.map((row: any) => row.eventId)).toEqual(['evt_stuck']);

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('mailWebhookEvents')
        .withIndex('by_event', (q) => q.eq('eventId', 'evt_err'))
        .unique();
      await ctx.db.patch(row!._id, { nextAttemptAt: Date.now() - 1 });
    });
    due = await t.query((api as any).mailCorpus.listRetryableWebhookEvents, { internalSecret: SECRET });
    expect(due.map((row: any) => row.eventId)).toEqual(['evt_err', 'evt_stuck']);
    expect(due[0]).toMatchObject({ attempts: 1, grantId: 'grant_1', payload: { id: 'evt_err' } });

    for (let i = 1; i < WEBHOOK_MAX_ATTEMPTS; i += 1) {
      await t.mutation(api.mailCorpus.markWebhookEventProcessed, {
        internalSecret: SECRET,
        eventId: 'evt_err',
        status: 'error',
      });
    }
    const parked = await t.run((ctx) =>
      ctx.db
        .query('mailWebhookEvents')
        .withIndex('by_event', (q) => q.eq('eventId', 'evt_err'))
        .unique(),
    );
    expect(parked).toMatchObject({ attempts: WEBHOOK_MAX_ATTEMPTS, retryAbandoned: true });
    due = await t.query((api as any).mailCorpus.listRetryableWebhookEvents, { internalSecret: SECRET });
    expect(due.map((row: any) => row.eventId)).toEqual(['evt_stuck']);

    await t.mutation(api.mailCorpus.markWebhookEventProcessed, {
      internalSecret: SECRET,
      eventId: 'evt_stuck',
      status: 'processed',
    });
    due = await t.query((api as any).mailCorpus.listRetryableWebhookEvents, { internalSecret: SECRET });
    expect(due).toEqual([]);
  });

  test('the backoff doubles and is capped', () => {
    expect(nextWebhookAttemptAt(1, 0)).toBe(2 * 60_000);
    expect(nextWebhookAttemptAt(2, 0)).toBe(4 * 60_000);
    expect(nextWebhookAttemptAt(20, 0)).toBe(6 * 60 * 60_000);
  });
});

describe('snooze records (MUT-1)', () => {
  test('one active snooze per thread, due listing, cancel, and settle with retries', async () => {
    const t = convexTest(schema, convexModules);
    const base = {
      internalSecret: SECRET,
      userId: 'user_1',
      accountId: 'acct_1',
      threadId: 't1',
      messageId: 'm1',
    };
    await t.mutation((api as any).mailCorpus.createSnooze, { ...base, untilTs: Date.now() + 3_600_000 });
    await t.mutation((api as any).mailCorpus.createSnooze, { ...base, untilTs: Date.now() - 1_000 });
    const rows = await t.run((ctx) => ctx.db.query('mailSnoozes').collect());
    expect(rows.map((row) => row.status).sort()).toEqual(['active', 'cancelled']);

    let due = await t.query((api as any).mailCorpus.listDueSnoozes, { internalSecret: SECRET });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ userId: 'user_1', accountId: 'acct_1', threadId: 't1', attempts: 0 });

    for (let i = 0; i < 4; i += 1) {
      const out = await t.mutation((api as any).mailCorpus.settleSnooze, {
        internalSecret: SECRET,
        id: due[0].id,
        ok: false,
        error: 'provider down',
      });
      expect(out.status).toBe('active');
    }
    expect(
      await t.mutation((api as any).mailCorpus.settleSnooze, {
        internalSecret: SECRET,
        id: due[0].id,
        ok: false,
      }),
    ).toMatchObject({ status: 'failed' });

    await t.mutation((api as any).mailCorpus.createSnooze, {
      ...base,
      threadId: 't2',
      untilTs: Date.now() - 1,
    });
    due = await t.query((api as any).mailCorpus.listDueSnoozes, { internalSecret: SECRET });
    expect(due.map((row: any) => row.threadId)).toEqual(['t2']);
    expect(
      await t.mutation((api as any).mailCorpus.settleSnooze, {
        internalSecret: SECRET,
        id: due[0].id,
        ok: true,
      }),
    ).toMatchObject({ status: 'restored' });
    expect(
      await t.mutation((api as any).mailCorpus.settleSnooze, {
        internalSecret: SECRET,
        id: due[0].id,
        ok: true,
      }),
    ).toEqual({ ok: false });

    await t.mutation((api as any).mailCorpus.createSnooze, {
      ...base,
      threadId: 't3',
      untilTs: Date.now() + 1,
    });
    const byMessage = await t.mutation((api as any).mailCorpus.cancelSnooze, {
      internalSecret: SECRET,
      userId: 'user_1',
      accountId: 'acct_1',
      messageId: 'm1',
    });
    expect(byMessage.threadIds).toEqual(['t3']);
    const byThread = await t.mutation((api as any).mailCorpus.cancelSnooze, {
      internalSecret: SECRET,
      userId: 'user_1',
      accountId: 'acct_1',
      threadId: 't3',
    });
    expect(byThread.threadIds).toEqual([]);
    const none = await t.mutation((api as any).mailCorpus.cancelSnooze, {
      internalSecret: SECRET,
      userId: 'user_1',
      accountId: 'acct_1',
    });
    expect(none.threadIds).toEqual([]);
  });
});
