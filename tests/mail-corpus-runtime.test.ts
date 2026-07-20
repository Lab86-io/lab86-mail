import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
};

const SECRET = 'mail-corpus-runtime-secret';
const USER = 'mail_corpus_runtime_user';
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

const TS = Date.UTC(2026, 6, 20, 9, 0, 0);

function message(overrides: Record<string, unknown> = {}) {
  return {
    providerMessageId: 'message_1',
    providerThreadId: 'thread_1',
    subject: 'Project kickoff',
    from: 'alice@example.com',
    to: 'me@example.com',
    receivedAt: TS,
    snippet: 'Kicking off the giraffe project',
    textBody: 'Kicking off the giraffe project this week.',
    searchText: 'project kickoff giraffe',
    labels: ['INBOX'],
    unread: true,
    ...overrides,
  };
}

async function ingest(t: Harness, messages: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return t.mutation(api.mailCorpus.upsertCorpusBatch, {
    ...scope,
    threads: [],
    messages: messages as never,
    ...extra,
  });
}

describe('sync state machine', () => {
  test('markSyncState upserts and preserves fields a later patch does not mention', async () => {
    const t = newHarness();
    await t.mutation(api.mailCorpus.markSyncState, {
      ...scope,
      status: 'backfilling',
      cursor: 'page_2',
      historyId: 'h1',
    });
    await t.mutation(api.mailCorpus.markSyncState, { ...scope, status: 'ready', corpusReady: true });
    let state = await t.query(api.mailCorpus.getSyncState, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
    });
    expect(state).toMatchObject({ status: 'ready', corpusReady: true, cursor: 'page_2', historyId: 'h1' });
    await t.mutation(api.mailCorpus.markSyncState, { ...scope, clearCursor: true });
    state = await t.query(api.mailCorpus.getSyncState, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
    });
    expect(state?.cursor).toBeUndefined();
  });

  test('listSyncTargets serves all four index paths', async () => {
    const t = newHarness();
    await t.mutation(api.mailCorpus.markSyncState, { ...scope, status: 'ready' });
    await t.mutation(api.mailCorpus.markSyncState, {
      ...scope,
      accountId: 'account_2',
      status: 'backfilling',
    });
    await t.mutation(api.mailCorpus.markSyncState, {
      ...scope,
      userId: 'other_user',
      accountId: 'account_9',
      status: 'ready',
    });
    const all = await t.query(api.mailCorpus.listSyncTargets, { internalSecret: SECRET });
    expect(all).toHaveLength(3);
    const mine = await t.query(api.mailCorpus.listSyncTargets, { internalSecret: SECRET, userId: USER });
    expect(mine).toHaveLength(2);
    const mineReady = await t.query(api.mailCorpus.listSyncTargets, {
      internalSecret: SECRET,
      userId: USER,
      status: 'ready',
    });
    expect(mineReady.map((row) => row.accountId)).toEqual(['account_1']);
    const anyBackfilling = await t.query(api.mailCorpus.listSyncTargets, {
      internalSecret: SECRET,
      status: 'backfilling',
    });
    expect(anyBackfilling.map((row) => row.accountId)).toEqual(['account_2']);
  });

  test('claimCorpusBackfill is a race-safe single-winner claim', async () => {
    const t = newHarness();
    expect(await t.mutation(api.mailCorpus.claimCorpusBackfill, { ...scope })).toEqual({ claimed: true });
    // A second racer inside the active window backs off.
    expect(await t.mutation(api.mailCorpus.claimCorpusBackfill, { ...scope })).toEqual({
      claimed: false,
      reason: 'active',
    });
    // A ready corpus never re-claims.
    await t.mutation(api.mailCorpus.markSyncState, { ...scope, status: 'ready', corpusReady: true });
    expect(await t.mutation(api.mailCorpus.claimCorpusBackfill, { ...scope })).toEqual({
      claimed: false,
      reason: 'ready',
    });
  });

  test('backfill batches move the oldest-indexed horizon monotonically and count messages', async () => {
    const t = newHarness();
    await ingest(t, [message()], { corpusReady: false, cursor: 'next_page' });
    await ingest(
      t,
      [message({ providerMessageId: 'message_0', providerThreadId: 'thread_0', receivedAt: TS - 500_000 })],
      { corpusReady: true },
    );
    const state = await t.query(api.mailCorpus.getSyncState, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
    });
    expect(state).toMatchObject({
      status: 'ready',
      corpusReady: true,
      messagesSynced: 2,
      oldestIndexedAt: TS - 500_000,
    });
    // Ready without a cursor cleared the resume token.
    expect(state?.cursor).toBeUndefined();
  });
});

describe('webhook event queue', () => {
  test('recordWebhookEvent dedupes by event id and markWebhookEventProcessed settles rows', async () => {
    const t = newHarness();
    const first = await t.mutation(api.mailCorpus.recordWebhookEvent, {
      internalSecret: SECRET,
      eventId: 'evt_1',
      type: 'message.created',
      userId: USER,
      payload: { id: 'evt_1' },
    });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const dup = await t.mutation(api.mailCorpus.recordWebhookEvent, {
      internalSecret: SECRET,
      eventId: 'evt_1',
      type: 'message.created',
      payload: {},
    });
    expect(dup).toMatchObject({ ok: true, duplicate: true, id: first.id });

    expect(
      await t.mutation(api.mailCorpus.markWebhookEventProcessed, {
        internalSecret: SECRET,
        eventId: 'evt_missing',
        status: 'processed',
      }),
    ).toEqual({ ok: false, missing: true });
    await t.mutation(api.mailCorpus.markWebhookEventProcessed, {
      internalSecret: SECRET,
      eventId: 'evt_1',
      status: 'error',
      error: 'boom',
    });
    const row = await t.run((ctx) => ctx.db.query('mailWebhookEvents').unique());
    expect(row).toMatchObject({ status: 'error', error: 'boom' });
    expect(row?.processedAt).toBeGreaterThan(0);
  });
});

describe('corpus deletions', () => {
  test('deleteCorpusMessage removes an owned row and decrements the synced count', async () => {
    const t = newHarness();
    await ingest(t, [message()], { corpusReady: true });
    await t.mutation(api.mailCorpus.deleteCorpusMessage, {
      internalSecret: SECRET,
      userId: 'someone_else',
      accountId: scope.accountId,
      providerMessageId: 'message_1',
    });
    expect(await t.run((ctx) => ctx.db.query('mailCorpusMessages').collect())).toHaveLength(1);
    await t.mutation(api.mailCorpus.deleteCorpusMessage, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerMessageId: 'message_1',
    });
    expect(await t.run((ctx) => ctx.db.query('mailCorpusMessages').collect())).toHaveLength(0);
    const state = await t.query(api.mailCorpus.getSyncState, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
    });
    expect(state?.messagesSynced).toBe(0);
  });

  test('deleteCorpusThread removes the thread row and every owned message', async () => {
    const t = newHarness();
    await ingest(t, [message(), message({ providerMessageId: 'message_2', receivedAt: TS + 1_000 })], {
      corpusReady: true,
    });
    const result = await t.mutation(api.mailCorpus.deleteCorpusThread, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerThreadId: 'thread_1',
    });
    expect(result).toEqual({ ok: true, messages: 2 });
    expect(await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('mailCorpusMessages').collect())).toHaveLength(0);
  });
});

describe('corpus reads', () => {
  test('searchCorpusMessages text search applies provider/yearMonth/date filters', async () => {
    const t = newHarness();
    await ingest(t, [
      message(),
      message({
        providerMessageId: 'message_2',
        providerThreadId: 'thread_2',
        subject: 'Giraffe follow-up',
        searchText: 'giraffe follow up',
        receivedAt: TS + 86_400_000,
      }),
    ]);
    const rows = await t.query(api.mailCorpus.searchCorpusMessages, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      query: 'giraffe',
    });
    expect(rows.map((r) => r.providerMessageId)).toEqual(['message_2', 'message_1']);
    const bounded = await t.query(api.mailCorpus.searchCorpusMessages, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      query: 'giraffe',
      before: TS + 1,
    });
    expect(bounded.map((r) => r.providerMessageId)).toEqual(['message_1']);
    const wrongProvider = await t.query(api.mailCorpus.searchCorpusMessages, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      query: 'giraffe',
      provider: 'microsoft',
    });
    expect(wrongProvider).toEqual([]);
  });

  test('searchCorpusMessages without text walks the recency index with in-memory filters', async () => {
    const t = newHarness();
    await ingest(t, [
      message(),
      message({ providerMessageId: 'message_2', providerThreadId: 'thread_2', receivedAt: TS + 1_000 }),
    ]);
    const rows = await t.query(api.mailCorpus.searchCorpusMessages, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      limit: 1,
    });
    expect(rows.map((r) => r.providerMessageId)).toEqual(['message_2']);
    const byMonth = await t.query(api.mailCorpus.searchCorpusMessages, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      yearMonth: '1999-01',
    });
    expect(byMonth).toEqual([]);
  });

  test('countCorpusMessages counts by text and by window', async () => {
    const t = newHarness();
    await ingest(t, [
      message(),
      message({
        providerMessageId: 'message_2',
        providerThreadId: 'thread_2',
        searchText: 'unrelated topic',
      }),
    ]);
    expect(
      await t.query(api.mailCorpus.countCorpusMessages, {
        internalSecret: SECRET,
        userId: USER,
        accountId: scope.accountId,
        query: 'giraffe',
      }),
    ).toEqual({ count: 1, approximate: false });
    expect(
      await t.query(api.mailCorpus.countCorpusMessages, {
        internalSecret: SECRET,
        userId: USER,
        accountId: scope.accountId,
        after: TS - 1,
      }),
    ).toEqual({ count: 2, approximate: false });
  });

  test('listCorpusThreadMessages enforces tenancy in the filter', async () => {
    const t = newHarness();
    await ingest(t, [message()]);
    await ingest(t, [message({ providerMessageId: 'foreign_msg' })]);
    await t.run(async (ctx) => {
      // Simulate a cross-tenant row sharing the thread id on the same account.
      const mine = await ctx.db.query('mailCorpusMessages').collect();
      const { _id, _creationTime, ...copy } = mine[0] as never as Record<string, unknown> & {
        _id: unknown;
        _creationTime: unknown;
      };
      await ctx.db.insert('mailCorpusMessages', {
        ...(copy as never),
        userId: 'intruder',
        providerMessageId: 'intruder_msg',
      });
    });
    const rows = await t.query(api.mailCorpus.listCorpusThreadMessages, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerThreadId: 'thread_1',
    });
    expect(rows.every((row) => row.userId === USER)).toBe(true);
    expect(rows.some((row) => row.providerMessageId === 'intruder_msg')).toBe(false);
  });

  test('getCorpusThreadBundle projects ordered messages and reports body completeness', async () => {
    const t = newHarness();
    expect(
      await t.query(api.mailCorpus.getCorpusThreadBundle, {
        internalSecret: SECRET,
        userId: USER,
        accountId: scope.accountId,
        providerThreadId: 'missing',
      }),
    ).toBeNull();
    await ingest(t, [
      message({ htmlBody: '<p>First</p>' }),
      message({ providerMessageId: 'message_2', receivedAt: TS + 1_000 }),
    ]);
    const bundle = await t.query(api.mailCorpus.getCorpusThreadBundle, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerThreadId: 'thread_1',
    });
    expect(bundle?.messages.map((m) => m._id)).toEqual(['message_1', 'message_2']);
    expect(bundle?.messages[0].htmlBody).toBe('<p>First</p>');
    expect(bundle?.messages[1].htmlBody).toBeNull();
    expect(bundle?.bodiesComplete).toBe(false);
  });

  test('getCorpusThread and listRecentCorpusThreads project client shape', async () => {
    const t = newHarness();
    await ingest(t, [message()]);
    const thread = await t.query(api.mailCorpus.getCorpusThread, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerThreadId: 'thread_1',
    });
    expect(thread).toMatchObject({ _id: 'thread_1', account: 'account_1', subject: 'Project kickoff' });
    const recentAll = await t.query(api.mailCorpus.listRecentCorpusThreads, {
      internalSecret: SECRET,
      userId: USER,
    });
    expect(recentAll).toHaveLength(1);
    const recentScoped = await t.query(api.mailCorpus.listRecentCorpusThreads, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'account_other',
    });
    expect(recentScoped).toEqual([]);
  });

  test('threadBodyExcerpts returns capped bodies keyed by account:thread', async () => {
    const t = newHarness();
    await ingest(t, [message({ textBody: 'B'.repeat(5000) })]);
    const out = await t.query(api.mailCorpus.threadBodyExcerpts, {
      internalSecret: SECRET,
      userId: USER,
      items: [
        { accountId: scope.accountId, providerThreadId: 'thread_1' },
        { accountId: scope.accountId, providerThreadId: 'missing' },
      ],
      maxChars: 300,
    });
    expect(Object.keys(out)).toEqual(['account_1:thread_1']);
    expect(out['account_1:thread_1']).toHaveLength(300);
  });

  test('categoryCountsInternal proxies the shared unread counter', async () => {
    const t = newHarness();
    await ingest(t, [message()]);
    const { counts } = await t.query(api.mailCorpus.categoryCountsInternal, {
      internalSecret: SECRET,
      userId: USER,
    });
    expect(typeof counts.main?.unread).toBe('number');
  });
});

describe('LLM-once queue', () => {
  test('listLlmPending grounds items in the latest message and closes orphans', async () => {
    const t = newHarness();
    await ingest(t, [message()]);
    // Orphan aggregate: pending thread with no message rows.
    await t.run(async (ctx) => {
      const ts = Date.now();
      await ctx.db.insert('mailCorpusThreads', {
        userId: USER,
        accountId: scope.accountId,
        grantId: scope.grantId,
        provider: 'google',
        providerThreadId: 'orphan_thread',
        subject: 'Orphan',
        fromAddress: 'ghost@example.com',
        lastDate: TS,
        snippet: '',
        labels: [],
        unread: true,
        llmPending: true,
        yearMonth: '2026-07',
        createdAt: ts,
        updatedAt: ts,
      });
    });
    const out = await t.mutation(api.mailCorpus.listLlmPending, { internalSecret: SECRET, userId: USER });
    expect(out.moreRemaining).toBe(false);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      providerThreadId: 'thread_1',
      messageId: 'message_1',
      subject: 'Project kickoff',
    });
    const orphan = await t.run(async (ctx) =>
      (await ctx.db.query('mailCorpusThreads').collect()).find((r) => r.providerThreadId === 'orphan_thread'),
    );
    expect(orphan?.llmPending).toBeUndefined();
  });

  test('storeLlmVerdicts persists current verdicts and ignores stale message ids', async () => {
    const t = newHarness();
    await ingest(t, [message()]);
    const stale = await t.mutation(api.mailCorpus.storeLlmVerdicts, {
      internalSecret: SECRET,
      userId: USER,
      items: [
        {
          accountId: scope.accountId,
          providerThreadId: 'thread_1',
          messageId: 'not_latest',
          verdict: { primary: 'orders' },
        },
      ],
    });
    expect(stale).toEqual({ stored: 0 });
    const stored = await t.mutation(api.mailCorpus.storeLlmVerdicts, {
      internalSecret: SECRET,
      userId: USER,
      items: [
        {
          accountId: scope.accountId,
          providerThreadId: 'thread_1',
          messageId: 'message_1',
          verdict: { primary: 'orders', needsAttention: false, reason: 'model verdict' },
        },
      ],
    });
    expect(stored).toEqual({ stored: 1 });
    const row = await t.run((ctx) => ctx.db.query('mailCorpusThreads').unique());
    expect(row).toMatchObject({
      smartPrimary: 'orders',
      llmClassifiedMessageId: 'message_1',
    });
    expect(row?.llmPending).toBeUndefined();

    // A garbage verdict closes the row out without storing anything.
    await t.run((ctx) => ctx.db.patch(row!._id, { llmPending: true, llmCategory: undefined }));
    const closed = await t.mutation(api.mailCorpus.storeLlmVerdicts, {
      internalSecret: SECRET,
      userId: USER,
      items: [{ accountId: scope.accountId, providerThreadId: 'thread_1', messageId: 'message_1' }],
    });
    expect(closed).toEqual({ stored: 0 });
    expect((await t.run((ctx) => ctx.db.query('mailCorpusThreads').unique()))?.llmPending).toBeUndefined();
  });

  test('listSmartCategoryThreads pages the shared category query', async () => {
    const t = newHarness();
    await ingest(t, [message()]);
    const page = await t.query(api.mailCorpus.listSmartCategoryThreads, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      category: 'main',
      limit: 10,
    });
    expect(Array.isArray(page.items)).toBe(true);
  });
});
