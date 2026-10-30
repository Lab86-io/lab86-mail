import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { EXPORT_TABLES, purgeAccountPass } from '../convex/accounts';
import { obligationView, syncThreadObligations, type ThreadSync } from '../convex/obligations';
import schema from '../convex/schema';
import type { JevAssessment } from '../lib/jev/contract';
import { assessmentFromResponse } from '../lib/jev/mail';
import { mailSourceKey, UNDO_WINDOW_MS } from '../lib/obligations/contract';
import { assessment, NOW, responseFor } from './fixtures/jev';

// Invented people and companies only. The Node app passes the flag; these
// tests drive the Convex side with synthetic mail.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  '../convex/jev.ts': () => import('../convex/jev'),
  '../convex/obligations.ts': () => import('../convex/obligations'),
  '../convex/mailOneTimeCodes.ts': () => import('../convex/mailOneTimeCodes'),
  '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
  '../convex/retention.ts': () => import('../convex/retention'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/boards.ts': () => import('../convex/boards'),
};
const SECRET = 'synthetic-needs-you';
const USER = 'owner';
const scope = { internalSecret: SECRET, userId: USER };
const ACCOUNT = 'acct-a';
const THREAD = 'thread-1';
const CLOCK = NOW + 3_600_000;
const ob = (api as any).obligations;
const jev = (api as any).jev;
const codes = (api as any).mailOneTimeCodes;

let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
beforeEach(() => setSystemTime(new Date(CLOCK)));
afterAll(() => {
  setSystemTime();
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

const harness = () => convexTest(schema, modules);

async function connect(t: TestConvex<typeof schema>, userId = USER, account = ACCOUNT) {
  await t.run(async (ctx) => {
    await ctx.db.insert('connectedAccounts', {
      userId,
      accountId: account,
      email: `${userId}@example.test`,
      provider: 'google',
      grantId: `grant-${account}`,
      status: 'connected',
      scopes: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

async function mail(
  t: TestConvex<typeof schema>,
  id: string,
  body: string,
  options: { from?: string; at?: number; thread?: string; userId?: string; account?: string } = {},
) {
  const userId = options.userId ?? USER;
  const account = options.account ?? ACCOUNT;
  await t.mutation(api.mailCorpus.upsertCorpusBatch, {
    internalSecret: SECRET,
    userId,
    accountId: account,
    grantId: `grant-${account}`,
    provider: 'google',
    threads: [],
    messages: [
      {
        providerMessageId: id,
        providerThreadId: options.thread ?? THREAD,
        subject: 'Budget approval',
        from: options.from ?? 'Maya Chen <maya@university.test>',
        to: `${userId}@example.test`,
        receivedAt: options.at ?? NOW,
        snippet: body,
        textBody: body,
        searchText: body,
        labels: ['INBOX'],
      },
    ],
  });
}

/** One Jev pass: claim, then store the fixture answer with the given choices. */
async function sweep(
  t: TestConvex<typeof schema>,
  choices: Record<string, string | number>,
  needsYou = true,
) {
  const page = await t.mutation(jev.claimPending, { ...scope, limit: 12, needsYou });
  const items = page.items.map((item: any) => {
    const { facts: _facts, ...input } = item;
    return {
      accountId: input.accountId,
      threadId: input.threadId,
      messageId: input.messageId,
      sourceRevision: input.sourceRevision,
      leaseId: input.leaseId,
      assessment: assessmentFromResponse(input, responseFor(input, choices), NOW),
    };
  });
  return t.mutation(jev.storeAssessments, { ...scope, items, ...(needsYou ? { needsYou: true } : {}) });
}

async function rows(t: TestConvex<typeof schema>, userId = USER) {
  return t.run((ctx) =>
    ctx.db
      .query('obligations')
      .withIndex('by_user_account', (q) => q.eq('userId', userId))
      .collect(),
  );
}

describe('Jev hook and the flag', () => {
  test('flag off: no obligation rows and the old return shape', async () => {
    const t = harness();
    await connect(t);
    await mail(t, 'm1', 'Could you confirm the budget by Friday?');
    const result = await sweep(t, { due: 'soon' }, false);
    expect(result).toEqual({ stored: 1 });
    expect(await rows(t)).toEqual([]);
    const flag = await t.run((ctx) => ctx.db.query('userDocs').collect());
    expect(flag.some((row) => row.kind === 'needsYouFlag')).toBe(false);
    expect(await t.withIdentity({ subject: USER }).query(ob.needsYou, {})).toEqual({
      enabled: false,
      timezone: 'UTC',
      items: [],
    });
  });

  test('flag on: the claim records the flag, the store opens a reply that pushes, and the page reads it', async () => {
    const t = harness();
    await connect(t);
    await t.run((ctx) =>
      ctx.db.insert('albatrossNotificationPreferences', {
        userId: USER,
        timezone: 'America/New_York',
        eveningCheckinEnabled: true,
        eveningCheckinLocalTime: '19:00',
        inAppEnabled: true,
        webPushEnabled: false,
        emailFallbackEnabled: true,
        emailFallbackDelayMinutes: 90,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await mail(t, 'm1', 'Hi. Could you confirm the budget by Friday?');
    const result = await sweep(t, { due: 'soon' });
    expect(result.stored).toBe(1);
    expect(result.obligationIds).toHaveLength(1);
    const [row] = await rows(t);
    expect(row).toMatchObject({
      kind: 'reply',
      state: 'open',
      source: 'mail',
      sourceKey: mailSourceKey(ACCOUNT, THREAD),
      title: 'Could you confirm the budget by Friday?',
      asker: 'Maya Chen',
      due: 'soon',
      pushLevel: 'normal',
      messageId: 'm1',
      sourceMessageId: 'm1',
    });
    const snapshot = await t.withIdentity({ subject: USER }).query(ob.needsYou, {});
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.timezone).toBe('America/New_York');
    expect(snapshot.items.map((item: any) => [item.id, item.kind, item.state])).toEqual([
      [String(row._id), 'reply', 'open'],
    ]);
    // The flag turns off on the next claim, and the page goes back.
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: false });
    expect((await t.withIdentity({ subject: USER }).query(ob.needsYou, {})).enabled).toBe(false);
    // Signed out: nothing.
    expect((await t.query(ob.needsYou, {})).enabled).toBe(false);
  });

  test('the flag turning on fills the ledger from stored verdicts, in-app only', async () => {
    const t = harness();
    await connect(t);
    await mail(t, 'm1', 'Could you confirm the budget today?', { at: CLOCK - 60_000 });
    await sweep(t, { due: 'today' }, false);
    expect(await rows(t)).toEqual([]);
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => {});
    const [row] = await rows(t);
    expect(row).toMatchObject({ kind: 'reply', state: 'open', pushLevel: 'normal' });
    expect(row.pushedAt).toBeUndefined();
    // With the flag off, a backfill pass does nothing.
    await t.mutation(jev.claimPending, { ...scope, limit: 1, needsYou: false });
    expect(await t.mutation(internal.jev.backfillObligations, { userId: USER })).toEqual({
      synced: 0,
      done: true,
    });
  });
});

function verdict(patch: Partial<JevAssessment> = {}) {
  return assessment({
    sourceMessageId: 'm1',
    due: 'soon',
    obligations: [
      {
        kind: 'reply',
        evidence: { messageId: 'm1', text: 'Could you confirm the budget by Friday?' },
        probability: 0.97,
      },
    ],
    ...patch,
  });
}
const maya = {
  id: 'm1',
  from: 'Maya Chen <maya@university.test>',
  to: 'owner@example.test',
  body: 'Could you confirm the budget by Friday?',
  date: NOW,
};

async function sync(t: TestConvex<typeof schema>, patch: Partial<ThreadSync> = {}) {
  return t.run((ctx) =>
    syncThreadObligations(ctx, {
      userId: USER,
      accountId: ACCOUNT,
      threadId: THREAD,
      subject: 'Budget approval',
      assessment: verdict(),
      messages: [maya],
      selfAddresses: ['owner@example.test'],
      latestMessageId: 'm1',
      corrections: [],
      preference: null,
      ...patch,
    }),
  );
}

describe('syncThread lifecycle', () => {
  test('open, then a change updates the same row without a second push', async () => {
    const t = harness();
    const [id] = await sync(t);
    expect(id).toBeDefined();
    expect(
      await sync(t, {
        latestMessageId: 'm2',
        messages: [maya, { ...maya, id: 'm2', body: 'Also, can you add the travel line?' }],
        assessment: verdict({
          obligations: [
            {
              kind: 'reply',
              evidence: { messageId: 'm2', text: 'Also, can you add the travel line?' },
              probability: 0.97,
            },
          ],
        }),
      }),
    ).toEqual([]);
    const [row] = await rows(t);
    expect(String(row._id)).toBe(id);
    expect(row).toMatchObject({
      title: 'Also, can you add the travel line?',
      messageId: 'm2',
      sourceMessageId: 'm2',
    });
  });

  test('an in-app item that now passes the push bar pushes once', async () => {
    const t = harness();
    expect(
      await sync(t, {
        assessment: verdict({
          due: 'none',
          obligations: [
            { kind: 'reply', evidence: { messageId: 'm1', text: 'Thoughts?' }, probability: 0.97 },
          ],
        }),
      }),
    ).toEqual([]);
    const ids = await sync(t, { assessment: verdict({ due: 'today' }) });
    expect(ids).toHaveLength(1);
    const backfill = await sync(t, { assessment: verdict({ due: 'today' }), push: false });
    expect(backfill).toEqual([]);
  });

  test('a kind gone from the verdict resolves by evidence, or closes as sent_reply after the own reply', async () => {
    const t = harness();
    await sync(t);
    await sync(t, {
      assessment: verdict({ obligations: [] }),
      latestMessageId: 'm2',
      messages: [maya, { ...maya, id: 'm2' }],
    });
    expect((await rows(t))[0]).toMatchObject({
      state: 'resolved',
      closeReason: 'evidence',
      closedBy: 'source',
    });
    // The kind returns: the row opens again and pushes.
    expect(await sync(t, { latestMessageId: 'm3' })).toHaveLength(1);
    expect((await rows(t))[0].state).toBe('open');
    await sync(t, {
      assessment: verdict({ obligations: [] }),
      latestMessageId: 'm4',
      messages: [maya, { id: 'm4', from: 'Owner <owner@example.test>', body: 'Confirmed.', date: NOW + 1 }],
    });
    expect((await rows(t))[0]).toMatchObject({ state: 'done', closeReason: 'sent_reply' });
  });

  test('a user close stays closed until the sender writes again', async () => {
    const t = harness();
    const [id] = await sync(t);
    await t.run((ctx) =>
      ctx.db.patch(id as Id<'obligations'>, {
        state: 'done',
        closeReason: 'user_done_no_reply',
        closedBy: 'user',
        closedMessageId: 'm1',
        closedAt: CLOCK,
      }),
    );
    expect(await sync(t)).toEqual([]);
    expect((await rows(t))[0].state).toBe('done');
    // A newer message by the user does not reopen it.
    expect(
      await sync(t, {
        latestMessageId: 'm2',
        messages: [maya, { id: 'm2', from: 'owner@example.test', body: 'Soon.', date: NOW + 1 }],
      }),
    ).toEqual([]);
    expect((await rows(t))[0].state).toBe('done');
    // The sender writes again: a new item opens and pushes.
    expect(await sync(t, { latestMessageId: 'm3', messages: [maya, { ...maya, id: 'm3' }] })).toEqual([id]);
    const reopened = (await rows(t))[0];
    expect(reopened.state).toBe('open');
    expect(reopened.closedBy).toBeUndefined();
    expect(reopened.closeReason).toBeUndefined();
  });

  test('a Not mine correction dismisses the thread and keeps it out', async () => {
    const t = harness();
    await sync(t);
    const corrections = [
      {
        id: 'brief-thread-x',
        scope: 'thread' as const,
        match: THREAD,
        accountId: ACCOUNT,
        brief: 'exclude' as const,
      },
    ];
    expect(await sync(t, { corrections, latestMessageId: 'm2' })).toEqual([]);
    expect((await rows(t))[0]).toMatchObject({ state: 'dismissed', closeReason: 'not_mine' });
  });

  test('a snoozed row wakes in-app when its time passed, and stays snoozed before', async () => {
    const t = harness();
    const [id] = await sync(t);
    await t.run((ctx) =>
      ctx.db.patch(id as Id<'obligations'>, { state: 'snoozed', snoozedUntil: CLOCK + 60_000 }),
    );
    expect(await sync(t)).toEqual([]);
    expect((await rows(t))[0].state).toBe('snoozed');
    await t.run((ctx) => ctx.db.patch(id as Id<'obligations'>, { snoozedUntil: CLOCK - 1 }));
    expect(await sync(t, { assessment: verdict({ due: 'none' }) })).toEqual([]);
    const woke = (await rows(t))[0];
    expect(woke.state).toBe('open');
    expect(woke.snoozedUntil).toBeUndefined();
  });

  test('promotions open nothing, and a code row of the thread is left alone', async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert('obligations', {
        userId: USER,
        kind: 'code',
        state: 'open',
        source: 'mail',
        sourceKey: mailSourceKey(ACCOUNT, THREAD),
        accountId: ACCOUNT,
        threadId: THREAD,
        title: 'Sign-in code for Northwind Bank',
        asker: 'Northwind Bank',
        due: 'today',
        probability: 1,
        pushLevel: 'time_sensitive',
        openedAt: CLOCK,
        createdAt: CLOCK,
        updatedAt: CLOCK,
      }),
    );
    expect(await sync(t, { assessment: verdict({ purpose: 'promotion' }) })).toEqual([]);
    expect((await rows(t)).map((row) => [row.kind, row.state])).toEqual([['code', 'open']]);
  });
});

async function recordCode(t: TestConvex<typeof schema>, message: string, needsYou = true, thread = THREAD) {
  return t.mutation(codes.recordCode, {
    ...scope,
    accountId: ACCOUNT,
    providerMessageId: message,
    providerThreadId: thread,
    code: `${message.length}84917`,
    label: 'Northwind Bank',
    issuer: 'Northwind Bank',
    serviceIdentifiers: ['northwind.test'],
    confidence: 0.95,
    receivedAt: CLOCK,
    expiresAt: CLOCK + 600_000,
    ...(needsYou
      ? { needsYou: true, sender: 'Northwind Bank <alerts@northwind.test>', subject: 'Your sign-in code' }
      : {}),
  });
}

describe('codes (S6)', () => {
  test('without the flag a code opens no obligation', async () => {
    const t = harness();
    const result = await recordCode(t, 'c1', false);
    expect(result.obligationId).toBeUndefined();
    expect(await rows(t)).toEqual([]);
  });

  test('a code opens a code row that shows its value; use closes it as code_used', async () => {
    const t = harness();
    await t.mutation(jev.claimPending, { ...scope, needsYou: true });
    const first = await recordCode(t, 'c1');
    expect(first.obligationId).toBeDefined();
    const view = (await t.withIdentity({ subject: USER }).query(ob.needsYou, {})).items[0];
    expect(view).toMatchObject({
      kind: 'code',
      state: 'open',
      pushLevel: 'time_sensitive',
      title: 'Sign-in code for Northwind Bank',
    });
    expect(view.code).toEqual({ value: '284917', issuer: 'Northwind Bank', expiresAt: CLOCK + 600_000 });
    // A new code in the same thread replaces the value on the same row.
    const second = await recordCode(t, 'c22');
    expect(second.obligationId).toBe(first.obligationId);
    // The older code is used: the row does not close.
    await t.mutation(codes.markUsed, { ...scope, codeId: first.codeId });
    expect((await rows(t))[0].state).toBe('open');
    await t.mutation(codes.markUsed, { ...scope, codeId: second.codeId });
    expect((await rows(t))[0]).toMatchObject({ state: 'done', closeReason: 'code_used' });
    // A duplicate redelivery opens nothing new.
    expect((await recordCode(t, 'c22')).created).toBe(false);
  });

  test('expiry reads as expired at once, and the retention sweep closes the row', async () => {
    const t = harness();
    await t.mutation(jev.claimPending, { ...scope, needsYou: true });
    await recordCode(t, 'c1');
    setSystemTime(new Date(CLOCK + 700_000));
    const view = (await t.withIdentity({ subject: USER }).query(ob.needsYou, {})).items[0];
    expect(view).toMatchObject({ state: 'expired', closeReason: 'expired', closedAt: CLOCK + 600_000 });
    expect(view.code).toBeUndefined();
    await t.mutation(internal.retention.sweep, {});
    expect((await rows(t))[0]).toMatchObject({
      state: 'expired',
      closeReason: 'expired',
      closedBy: 'source',
    });
  });

  test('the view of a code row whose code is gone or used reads closed', () => {
    const row = {
      _id: 'o1',
      kind: 'code',
      state: 'open',
      source: 'mail',
      sourceKey: 'mail:a:t',
      title: 'Sign-in code',
      asker: 'Bank',
      due: 'today',
      probability: 1,
      pushLevel: 'time_sensitive',
      codeExpiresAt: CLOCK + 1_000,
      createdAt: 1,
      updatedAt: 1,
    } as any;
    expect(obligationView(row, null, CLOCK)).toMatchObject({ state: 'expired', closedAt: CLOCK });
    expect(obligationView(row, { status: 'used', usedAt: 5 } as any, CLOCK)).toMatchObject({
      state: 'done',
      closeReason: 'code_used',
      closedAt: 5,
    });
    expect(obligationView(row, { status: 'used' } as any, CLOCK).closedAt).toBe(CLOCK);
    expect(obligationView({ ...row, codeExpiresAt: undefined }, undefined, CLOCK).state).toBe('expired');
  });
});

async function openReply(t: TestConvex<typeof schema>) {
  await connect(t);
  await mail(t, 'm1', 'Could you confirm the budget by Friday?');
  await t.mutation(jev.claimPending, { ...scope, needsYou: true });
  const [id] = await sync(t);
  return id;
}

describe('user actions (act)', () => {
  test('done without a sent reply closes as user_done_no_reply; Undo inside the window reopens it', async () => {
    const t = harness();
    const id = await openReply(t);
    const done = await t.mutation(ob.act, { ...scope, id, action: 'done' });
    expect(done).toMatchObject({ ok: true, undoUntil: CLOCK + UNDO_WINDOW_MS });
    expect(done.obligation).toMatchObject({
      state: 'done',
      closeReason: 'user_done_no_reply',
      closedAt: CLOCK,
    });
    expect((await rows(t))[0]).toMatchObject({ closedBy: 'user', closedMessageId: 'm1' });
    expect(await t.mutation(ob.act, { ...scope, id, action: 'done' })).toEqual({
      ok: false,
      error: 'closed',
    });
    const undone = await t.mutation(ob.act, { ...scope, id, action: 'undo' });
    expect(undone).toMatchObject({ ok: true, obligation: { state: 'open' } });
    expect(undone.obligation.closeReason).toBeUndefined();
    expect(await t.mutation(ob.act, { ...scope, id, action: 'undo' })).toEqual({
      ok: false,
      error: 'undo_expired',
    });
  });

  test('done after the user replied in the thread closes as user_done; Undo after the window fails', async () => {
    const t = harness();
    const id = await openReply(t);
    await mail(t, 'm2', 'Confirmed, thanks.', { from: 'Owner <owner@example.test>', at: NOW + 60_000 });
    const done = await t.mutation(ob.act, { ...scope, id, action: 'done' });
    expect(done.obligation.closeReason).toBe('user_done');
    setSystemTime(new Date(CLOCK + UNDO_WINDOW_MS + 1));
    expect(await t.mutation(ob.act, { ...scope, id, action: 'undo' })).toEqual({
      ok: false,
      error: 'undo_expired',
    });
  });

  test('later snoozes in-app; a past or far time is refused; Undo puts it back', async () => {
    const t = harness();
    const id = await openReply(t);
    expect(await t.mutation(ob.act, { ...scope, id, action: 'later', until: CLOCK - 1 })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(
      await t.mutation(ob.act, { ...scope, id, action: 'later', until: CLOCK + 100 * 86_400_000 }),
    ).toEqual({
      ok: false,
      error: 'invalid',
    });
    const later = await t.mutation(ob.act, { ...scope, id, action: 'later', until: CLOCK + 3 * 3_600_000 });
    expect(later.obligation).toMatchObject({ state: 'snoozed', snoozedUntil: CLOCK + 3 * 3_600_000 });
    expect((await t.mutation(ob.act, { ...scope, id, action: 'undo' })).obligation.state).toBe('open');
    // Done on a snoozed row is allowed.
    await t.mutation(ob.act, { ...scope, id, action: 'later', until: CLOCK + 60_000 });
    expect((await t.mutation(ob.act, { ...scope, id, action: 'done' })).obligation.state).toBe('done');
  });

  test('Not mine writes the scoped correction and closes the thread; Undo removes it again', async () => {
    const t = harness();
    const id = await openReply(t);
    await sync(t, {
      assessment: verdict({
        obligations: [
          {
            kind: 'reply',
            evidence: { messageId: 'm1', text: 'Could you confirm the budget by Friday?' },
            probability: 0.97,
          },
          {
            kind: 'action',
            evidence: { messageId: 'm1', text: 'Could you confirm the budget by Friday?' },
            probability: 0.97,
          },
        ],
      }),
    });
    const correction = {
      id: 'brief-thread-abc',
      scope: 'thread',
      match: THREAD,
      accountId: ACCOUNT,
      brief: 'exclude',
    };
    expect(await t.mutation(ob.act, { ...scope, id, action: 'not_mine' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    const result = await t.mutation(ob.act, { ...scope, id, action: 'not_mine', correction });
    expect(result.obligation).toMatchObject({ state: 'dismissed', closeReason: 'not_mine' });
    expect((await rows(t)).map((row) => row.state)).toEqual(['dismissed', 'dismissed']);
    const policy = await t.query(jev.policy, scope);
    expect(policy.corrections).toEqual([correction]);
    await t.mutation(ob.act, { ...scope, id, action: 'undo' });
    expect((await rows(t)).map((row) => row.state)).toEqual(['open', 'open']);
    expect((await t.query(jev.policy, scope)).corrections).toEqual([]);
  });

  test('Not mine on a code needs no correction', async () => {
    const t = harness();
    const { obligationId } = await recordCode(t, 'c1');
    const result = await t.mutation(ob.act, { ...scope, id: obligationId, action: 'not_mine' });
    expect(result.obligation).toMatchObject({ state: 'dismissed', closeReason: 'not_mine' });
  });

  test("another user's id, or a malformed id, is not found", async () => {
    const t = harness();
    const id = await openReply(t);
    expect(await t.mutation(ob.act, { ...scope, userId: 'intruder', id, action: 'done' })).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await t.mutation(ob.act, { ...scope, id: 'nope', action: 'done' })).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await t.query(ob.get, { ...scope, userId: 'intruder', id })).toBeNull();
    await expect(
      t.mutation(ob.act, { internalSecret: 'wrong', userId: USER, id, action: 'done' }),
    ).rejects.toThrow();
  });

  test('a queued reply closes as sent_reply with Undo until it sends; Undo needs the send cancelled first', async () => {
    const t = harness();
    const id = await openReply(t);
    const fireAt = CLOCK + 10_000;
    const sent = await t.mutation(ob.recordReply, { ...scope, id, pendingId: 'outbox:1', fireAt });
    expect(sent).toMatchObject({
      ok: true,
      undoUntil: fireAt,
      obligation: { state: 'done', closeReason: 'sent_reply' },
    });
    expect((await t.query(ob.get, { ...scope, id })).undo).toEqual({ until: fireAt, pendingId: 'outbox:1' });
    expect(await t.mutation(ob.act, { ...scope, id, action: 'undo' })).toEqual({
      ok: false,
      error: 'send_pending',
      pendingId: 'outbox:1',
    });
    expect(
      (await t.mutation(ob.act, { ...scope, id, action: 'undo', sendCancelled: true })).obligation.state,
    ).toBe('open');
    // An instant send has no Undo.
    const instant = await t.mutation(ob.recordReply, { ...scope, id });
    expect(instant.undoUntil).toBeUndefined();
    expect(await t.mutation(ob.recordReply, { ...scope, id })).toEqual({ ok: false, error: 'closed' });
    expect(await t.mutation(ob.recordReply, { ...scope, id: 'nope' })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  test('a saved draft is kept for the current source message only', async () => {
    const t = harness();
    const id = await openReply(t);
    const draft = {
      to: ['maya@university.test'],
      cc: [],
      subject: 'Re: Budget approval',
      body: 'Confirmed.',
    };
    expect(await t.mutation(ob.saveDraft, { ...scope, id, draft })).toEqual({ saved: true });
    expect(await t.mutation(ob.saveDraft, { ...scope, id: 'nope', draft })).toEqual({ saved: false });
    const record = await t.query(ob.get, { ...scope, id });
    expect(record.draft).toEqual(draft);
    expect(record.obligation.draftReady).toBe(true);
    await sync(t, { latestMessageId: 'm2', messages: [maya, { ...maya, id: 'm2' }] });
    const stale = await t.query(ob.get, { ...scope, id });
    expect(stale.draft).toBeNull();
    expect(stale.obligation.draftReady).toBeUndefined();
  });
});

async function setPreference(t: TestConvex<typeof schema>, patch: Record<string, unknown>) {
  await t.run((ctx) =>
    ctx.db.insert('albatrossNotificationPreferences', {
      userId: USER,
      timezone: 'America/New_York',
      eveningCheckinEnabled: true,
      eveningCheckinLocalTime: '19:00',
      inAppEnabled: true,
      webPushEnabled: false,
      emailFallbackEnabled: true,
      emailFallbackDelayMinutes: 90,
      createdAt: NOW,
      updatedAt: NOW,
      ...patch,
    }),
  );
}
// 23:30 in New York: inside quiet hours 22-7.
const LATE = Date.parse('2026-09-22T03:30:00.000Z');
const QUIET_END = Date.parse('2026-09-22T11:00:00.000Z');

describe('push claims (S4)', () => {
  test('a push writes an obligation notification: asker as title, the obligation as body, the thread link', async () => {
    const t = harness();
    const [id] = await sync(t);
    const claim = await t.mutation(ob.claimPush, { ...scope, id, now: CLOCK });
    expect(claim).toMatchObject({
      action: 'push',
      collapseId: id,
      codeAvailable: false,
      timeSensitive: false,
    });
    const notification = await t.run((ctx) =>
      ctx.db.get(claim.notificationId as Id<'albatrossNotifications'>),
    );
    expect(notification).toMatchObject({
      type: 'obligation',
      title: 'Maya Chen',
      body: 'Could you confirm the budget by Friday?',
      entityKind: 'obligation',
      entityId: id,
      deepLink: `/mail/thread?account=${ACCOUNT}&thread=${THREAD}&message=m1`,
      dedupeKey: `obligation:${id}:1`,
    });
    expect((await rows(t))[0]).toMatchObject({ pushedAt: CLOCK, pushCount: 1 });
    expect(await t.mutation(ob.claimPush, { ...scope, id: 'nope' })).toEqual({
      action: 'none',
      reason: 'not_found',
    });
  });

  test('quiet hours hold a normal push; the release pushes it as itself when they end', async () => {
    const t = harness();
    await setPreference(t, { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7 });
    const [id] = await sync(t);
    expect(await t.mutation(ob.claimPush, { ...scope, id, now: LATE })).toEqual({
      action: 'hold',
      reason: 'quiet_hours',
      until: QUIET_END,
    });
    expect(await t.query(ob.dueHeldUsers, { internalSecret: SECRET, now: LATE })).toEqual({ userIds: [] });
    expect(await t.query(ob.dueHeldUsers, { internalSecret: SECRET, now: QUIET_END })).toEqual({
      userIds: [USER],
    });
    expect(await t.mutation(ob.claimHeldPushes, { ...scope, now: LATE + 60_000 })).toEqual({ kind: 'wait' });
    const released = await t.mutation(ob.claimHeldPushes, { ...scope, now: QUIET_END });
    expect(released).toMatchObject({ kind: 'push', push: { collapseId: id } });
    const pushed = (await rows(t))[0];
    expect(pushed.pushHeldUntil).toBeUndefined();
    expect(pushed.pushedAt).toBe(QUIET_END);
  });

  test('the switch off keeps the item in-app; a code past expiry does not push', async () => {
    const t = harness();
    await setPreference(t, { obligationPushEnabled: false });
    const [id] = await sync(t);
    expect(await t.mutation(ob.claimPush, { ...scope, id, now: CLOCK })).toEqual({
      action: 'none',
      reason: 'disabled',
    });
    const { obligationId } = await recordCode(t, 'c1', true, 'thread-code');
    expect(await t.mutation(ob.claimPush, { ...scope, id: obligationId, now: CLOCK + 700_000 })).toEqual({
      action: 'none',
      reason: 'closed',
    });
    // The push switch does not stop a code.
    expect(await t.mutation(ob.claimPush, { ...scope, id: obligationId, now: CLOCK })).toMatchObject({
      action: 'push',
      codeAvailable: true,
      timeSensitive: true,
    });
  });

  test('over the hourly limit the items wait for one summary push, at most one each hour', async () => {
    const t = harness();
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) {
      const [id] = await sync(t, { threadId: `t${index}` });
      ids.push(id);
    }
    for (const id of ids.slice(0, 4))
      expect((await t.mutation(ob.claimPush, { ...scope, id, now: CLOCK })).action).toBe('push');
    const fifth = await t.mutation(ob.claimPush, { ...scope, id: ids[4], now: CLOCK + 60_000 });
    expect(fifth).toEqual({ action: 'hold', reason: 'limit', until: CLOCK + 3_600_000 });
    await t.mutation(ob.claimPush, { ...scope, id: ids[5], now: CLOCK + 120_000 });
    // A held row that closed meanwhile leaves the hold.
    await t.mutation(ob.act, { ...scope, id: ids[5], action: 'done' });
    await t.run(async (ctx) => {
      const row = await ctx.db.get(ids[5] as Id<'obligations'>);
      await ctx.db.patch(row!._id, { pushHeldUntil: CLOCK + 3_600_000, pushHoldReason: 'limit' });
    });
    const summary = await t.mutation(ob.claimHeldPushes, { ...scope, now: CLOCK + 3_600_000 });
    expect(summary).toMatchObject({ kind: 'summary', count: 1 });
    const notification = await t.run((ctx) =>
      ctx.db.get(summary.notificationId as Id<'albatrossNotifications'>),
    );
    expect(notification).toMatchObject({
      type: 'obligation',
      title: 'Needs you',
      body: '1 more thing needs you.',
      deepLink: '/?view=notifications',
    });
    // Another overflow inside the hour of that summary waits for the next hour.
    await t.run((ctx) =>
      ctx.db.patch(ids[6] as Id<'obligations'>, {
        pushHeldUntil: CLOCK + 3_700_000,
        pushHoldReason: 'limit',
      }),
    );
    expect(await t.mutation(ob.claimHeldPushes, { ...scope, now: CLOCK + 3_700_000 })).toEqual({
      kind: 'later',
      until: CLOCK + 7_200_000,
    });
    expect(await t.query(internal.obligations.hasDueHeldPushes, {})).toBe(false);
  });

  test('the digest tick sees a due obligation hold and calls the app', async () => {
    const t = harness();
    const [id] = await sync(t);
    await t.run((ctx) =>
      ctx.db.patch(id as Id<'obligations'>, { pushHeldUntil: CLOCK - 1, pushHoldReason: 'quiet_hours' }),
    );
    expect(await t.query(internal.obligations.hasDueHeldPushes, {})).toBe(true);
    const posts: string[] = [];
    const previousUrl = process.env.LAB86_MAIL_PUBLIC_URL;
    const previousFetch = globalThis.fetch;
    process.env.LAB86_MAIL_PUBLIC_URL = 'https://mail.example.test';
    globalThis.fetch = (async (url: string) => {
      posts.push(String(url));
      return new Response('{}', { status: 202 });
    }) as any;
    try {
      await t.action(internal.albatrossNotifications.mailDigestTick, {});
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.LAB86_MAIL_PUBLIC_URL;
      else process.env.LAB86_MAIL_PUBLIC_URL = previousUrl;
    }
    expect(posts).toEqual(['https://mail.example.test/api/cron/mail-digest']);
  });
});

describe('preferences (S8)', () => {
  test('obligationPushEnabled defaults on, saves, and keeps its value when left out', async () => {
    const t = harness();
    const user = t.withIdentity({ subject: USER });
    expect((await user.query(api.albatrossNotifications.getPreferences, {})).obligationPushEnabled).toBe(
      true,
    );
    const base = {
      timezone: 'UTC',
      eveningCheckinEnabled: true,
      eveningCheckinLocalTime: '19:00',
      inAppEnabled: true,
      webPushEnabled: false,
      emailFallbackEnabled: true,
      emailFallbackDelayMinutes: 90,
    };
    await user.mutation(api.albatrossNotifications.savePreferences, { ...base });
    expect((await user.query(api.albatrossNotifications.getPreferences, {})).obligationPushEnabled).toBe(
      true,
    );
    await user.mutation(api.albatrossNotifications.savePreferences, {
      ...base,
      obligationPushEnabled: false,
    });
    expect((await user.query(api.albatrossNotifications.getPreferences, {})).obligationPushEnabled).toBe(
      false,
    );
    await user.mutation(api.albatrossNotifications.savePreferences, { ...base, inAppEnabled: false });
    expect((await user.query(api.albatrossNotifications.getPreferences, {})).obligationPushEnabled).toBe(
      false,
    );
  });
});

describe('the page query and the cascade', () => {
  test('closed today is in the list; closed before today is not', async () => {
    const t = harness();
    await t.mutation(jev.claimPending, { ...scope, needsYou: true });
    const [today] = await sync(t);
    const [yesterday] = await sync(t, { threadId: 'old' });
    await t.run(async (ctx) => {
      await ctx.db.patch(today as Id<'obligations'>, {
        state: 'resolved',
        closeReason: 'evidence',
        closedAt: CLOCK - 60_000,
      });
      await ctx.db.patch(yesterday as Id<'obligations'>, {
        state: 'resolved',
        closeReason: 'evidence',
        closedAt: CLOCK - 86_400_000,
      });
    });
    const { items } = await t.withIdentity({ subject: USER }).query(ob.needsYou, {});
    expect(items.map((item: any) => item.id)).toEqual([today]);
    expect(items[0]).toMatchObject({ state: 'resolved', closeReason: 'evidence', closedAt: CLOCK - 60_000 });
  });

  test('an account purge removes its obligations; the export includes the table', async () => {
    const t = harness();
    await sync(t);
    await sync(t, { accountId: 'acct-b' });
    await t.run((ctx) => purgeAccountPass(ctx, USER, ACCOUNT));
    expect((await rows(t)).map((row) => row.accountId)).toEqual(['acct-b']);
    expect(EXPORT_TABLES).toContain('obligations');
  });
});
