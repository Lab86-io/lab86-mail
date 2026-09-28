import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { DEFAULT_JEV_PREFERENCES } from '../lib/jev/contract';
import { assessmentFromResponse } from '../lib/jev/mail';
import { NOW, responseFor } from './fixtures/jev';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  '../convex/jev.ts': () => import('../convex/jev'),
};
const secret = 'synthetic-jev-test';
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
  // The claim gate reads the clock (60-day window). A fixed clock keeps the
  // fixture mail recent on every date the suite runs.
  setSystemTime(new Date(NOW + 3_600_000));
});
afterAll(() => {
  setSystemTime();
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});
const ref = (api as any).jev;
const scope = { internalSecret: secret, userId: 'owner' };
async function seed(
  t: TestConvex<typeof schema>,
  account = 'a',
  userId = 'owner',
  id = 't',
  body = 'Please confirm the budget.',
) {
  await t.run(async (ctx) => {
    if (
      !(await ctx.db
        .query('connectedAccounts')
        .withIndex('by_user_account', (q) => q.eq('userId', userId).eq('accountId', account))
        .unique())
    )
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
  await t.mutation(api.mailCorpus.upsertCorpusBatch, {
    ...scope,
    userId,
    accountId: account,
    grantId: `grant-${account}`,
    provider: 'google',
    threads: [],
    messages: [
      {
        providerMessageId: `m-${id}`,
        providerThreadId: id,
        subject: 'Budget approval',
        from: 'maya@example.test',
        to: `${userId}@example.test`,
        receivedAt: NOW,
        snippet: body,
        textBody: body,
        searchText: `budget approval ${body}`,
        headers: { 'list-id': '<test.list>' },
        labels: ['INBOX'],
      },
    ],
  });
}
async function claim(t: TestConvex<typeof schema>) {
  return t.mutation(ref.claimPending, { ...scope, limit: 12 });
}
async function save(t: TestConvex<typeof schema>, input: any, patch: any = {}) {
  return t.mutation(ref.storeAssessments, {
    ...scope,
    items: [
      {
        accountId: input.accountId,
        threadId: input.threadId,
        messageId: input.messageId,
        sourceRevision: input.sourceRevision,
        leaseId: input.leaseId,
        assessment: assessmentFromResponse(input, responseFor(input), NOW),
        ...patch,
      },
    ],
  });
}
async function row(t: TestConvex<typeof schema>, account = 'a', id = 't') {
  return t.run((ctx) =>
    ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_account_thread', (q) =>
        q.eq('userId', 'owner').eq('accountId', account).eq('providerThreadId', id),
      )
      .unique(),
  );
}

describe('Jev persisted state and tenancy', () => {
  test('a row synced before latestMessageId existed is claimed once and its result is saved', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const before = await row(t);
    await t.run((ctx) => ctx.db.patch(before!._id, { latestMessageId: undefined, llmPending: true }));
    const page = await claim(t);
    expect(page.items).toHaveLength(1);
    expect((await row(t))?.latestMessageId).toBe(page.items[0].messageId);
    expect((await save(t, page.items[0])).stored).toBe(1);
    const after = await row(t);
    expect(after?.llmPending).toBeUndefined();
    expect(after?.jev?.sourceMessageId).toBe(page.items[0].messageId);
    expect((await claim(t)).items).toHaveLength(0);
  });
  test('claiming cannot replace the corpus revision when its newest message is not synced', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const before = await row(t);
    await t.run((ctx) => ctx.db.patch(before!._id, { latestMessageId: 'not-yet-synced' }));
    expect((await claim(t)).items).toEqual([]);
    expect((await row(t))?.latestMessageId).toBe('not-yet-synced');
  });
  test('requires internal authorization and isolates user/account collisions', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await seed(t, 'b');
    await seed(t, 'foreign', 'other');
    await expect(t.query(ref.settings, { userId: 'owner', internalSecret: 'wrong' })).rejects.toThrow();
    const page = await claim(t);
    expect(page.items).toHaveLength(2);
    expect(new Set(page.items.map((i: any) => i.accountId))).toEqual(new Set(['a', 'b']));
    for (const item of page.items) expect((await save(t, item)).stored).toBe(1);
    const own = await t.query(ref.threadAssessments, {
      ...scope,
      threads: [
        { accountId: 'a', threadId: 't' },
        { accountId: 'b', threadId: 't' },
        { accountId: 'foreign', threadId: 't' },
      ],
    });
    expect(own).toHaveLength(2);
    expect(own.every((i: any) => i.jev.obligations[0].kind === 'reply')).toBe(true);
    expect((await t.query(ref.settings, scope)).counts).toEqual({
      accepted: 2,
      uncertain: 0,
      pending: 0,
      unavailable: 0,
    });
    const scoped = await t.query(api.mailCorpus.listSmartCategoryThreads, {
      ...scope,
      accountId: 'b',
      category: 'needs_reply',
      limit: 10,
    });
    expect(scoped.items.map((i: any) => i.account)).toEqual(['b']);
  });
  test('leases prevent duplicate evaluation and stale lease results cannot overwrite a newer message', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const input = (await claim(t)).items[0];
    expect((await claim(t)).items).toEqual([]);
    expect((await save(t, input, { leaseId: 'wrong' })).stored).toBe(0);
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      ...scope,
      accountId: 'a',
      grantId: 'grant-a',
      provider: 'google',
      threads: [],
      messages: [
        {
          providerMessageId: 'm-new',
          providerThreadId: 't',
          subject: 'Budget approval',
          from: 'owner@example.test',
          to: 'maya@example.test',
          receivedAt: NOW + 1,
          snippet: 'Approved.',
          textBody: 'Approved.',
          searchText: 'budget approved',
          labels: ['SENT'],
        },
      ],
    });
    expect((await save(t, input)).stored).toBe(0);
    expect((await row(t))?.jevLeaseId).toBeUndefined();
    const next = (await claim(t)).items[0];
    expect(next.messageId).toBe('m-new');
    expect(next.messages).toHaveLength(2);
  });
  test('new body content invalidates the same message assessment; read-only resync preserves it', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const input = (await claim(t)).items[0];
    await save(t, input);
    await seed(t);
    expect((await row(t))?.jev?.sourceRevision).toBe(input.sourceRevision);
    await seed(t, 'a', 'owner', 't', 'All done, no reply needed.');
    expect((await row(t))?.jev).toBeUndefined();
    expect((await row(t))?.jevNeedsReply).toBe(false);
    expect((await row(t))?.llmPending).toBe(true);
    const next = (await claim(t)).items[0];
    expect(next.sourceRevision).not.toBe(input.sourceRevision);
    expect((await save(t, input)).stored).toBe(0);
  });
  test('source watermark and exact evidence are checked inside the saving transaction', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    let input = (await claim(t)).items[0];
    await t.run(async (ctx) => {
      const m = await ctx.db.query('mailCorpusMessages').first();
      await ctx.db.patch(m!._id, { textBody: 'Hydrated body has changed.' });
    });
    expect((await save(t, input)).stored).toBe(0);
    expect((await row(t))?.llmPending).toBe(true);
    input = (await claim(t)).items[0];
    const bad = assessmentFromResponse(input, responseFor(input));
    bad.obligations[0].evidence.text = 'Invented quote';
    expect((await save(t, input, { assessment: bad })).stored).toBe(0);
    expect((await row(t))?.jevStatus).toBe('unavailable');
    expect((await claim(t)).items).toEqual([]);
  });
  test('an emoji across the body and header cuts still claims valid JSON and saves its evidence', async () => {
    const t = convexTest(schema, modules);
    const emoji = '\u{1F600}';
    // The emoji takes code units 2399 and 2400, so a plain cut at 2400 splits it.
    await seed(t, 'a', 'owner', 't', `${'x'.repeat(2399)}${emoji} Please confirm the budget.`);
    await seed(t, 'a', 'owner', 'plain');
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query('mailCorpusMessages')
        .filter((q) => q.eq(q.field('providerThreadId'), 't'))
        .first();
      await ctx.db.patch(m!._id, { headers: { 'list-id': `${'y'.repeat(499)}${emoji}` } });
    });
    const page = await claim(t);
    expect(page.items).toHaveLength(2);
    const json = JSON.stringify(page);
    // JSON.stringify escapes only lone surrogates; a whole emoji stays literal.
    expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(page);
    const input = parsed.items.find((item: any) => item.threadId === 't');
    const [message] = input.messages;
    expect(message.body).toBe('x'.repeat(2399));
    expect(message.headers['list-id']).toBe('y'.repeat(499));
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(JSON.stringify(parsed.items.map((item: any) => item.messages)))).toBe(false);
    expect(lone.test(message.body)).toBe(false);
    expect(lone.test(message.headers['list-id'])).toBe(false);
    // The evidence check uses the same safe cut, so the assessment is stored.
    expect((await save(t, input)).stored).toBe(1);
    expect((await row(t))?.jev?.obligations[0].evidence.text).toBe('x'.repeat(2399));
  });
  test('three unavailable attempts stop retries; reprocessing explicitly reopens them', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const input = (await claim(t)).items[0];
      expect(input).toBeDefined();
      await save(t, input, { assessment: undefined, error: 'offline' });
      expect((await row(t))?.jevAttempts).toBe(attempt);
      await t.run(async (ctx) => {
        const r = await ctx.db.query('mailCorpusThreads').first();
        await ctx.db.patch(r!._id, { jevRetryAt: 0 });
      });
    }
    expect((await claim(t)).items).toEqual([]);
    await t.mutation((internal as any).jev.queueUser, { userId: 'owner' });
    expect((await claim(t)).items).toHaveLength(1);
  });
  test('corrections persist per user and stale settings saves cannot erase newer changes', async () => {
    const t = convexTest(schema, modules);
    const initial = await t.query(ref.policy, scope);
    expect(initial.preferences.briefPromotions).toBe(false);
    const state = await t.mutation(ref.saveSettings, {
      ...scope,
      revision: 0,
      preferences: { ...DEFAULT_JEV_PREFERENCES, enabled: false },
      corrections: [{ id: '1', scope: 'sender', match: 'athletics@university.test', brief: 'exclude' }],
    });
    await expect(
      t.mutation(ref.saveSettings, {
        ...scope,
        revision: 0,
        preferences: DEFAULT_JEV_PREFERENCES,
        corrections: [],
      }),
    ).rejects.toThrow('JEV_SETTINGS_CONFLICT');
    expect((await t.query(ref.policy, scope)).corrections).toHaveLength(1);
    expect((await t.query(ref.policy, { ...scope, userId: 'other' })).corrections).toEqual([]);
    await seed(t);
    expect((await claim(t)).items).toEqual([]);
    const enabled = await t.mutation(ref.saveSettings, {
      ...scope,
      revision: state.revision,
      preferences: DEFAULT_JEV_PREFERENCES,
      corrections: [],
    });
    expect(enabled.revision).toBeGreaterThan(state.revision);
    expect((await claim(t)).items).toHaveLength(1);
  });
  test('retains original obligation evidence outside the recent-message window', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const first = (await claim(t)).items[0];
    await save(t, first);
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      ...scope,
      accountId: 'a',
      grantId: 'grant-a',
      provider: 'google',
      threads: [],
      messages: Array.from({ length: 20 }, (_, i) => ({
        providerMessageId: `later-${i}`,
        providerThreadId: 't',
        subject: 'FYI',
        from: 'maya@example.test',
        to: 'owner@example.test',
        receivedAt: NOW + i + 1,
        snippet: 'An additional update.',
        textBody: 'An additional update.',
        searchText: 'additional update',
        labels: ['INBOX'],
      })),
    });
    const next = (await claim(t)).items[0];
    expect(next.contextComplete).toBe(false);
    expect(next.messages.some((m: any) => m.id === 'm-t')).toBe(true);
    expect(next.messages.length).toBeLessThanOrEqual(19);
  });
  test('deduplicates material changes by source message, independently of later replies', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const input = (await claim(t)).items[0];
    const assessment = assessmentFromResponse(
      input,
      responseFor(input, { change: 0.99, change_evidence: 'm0' }),
    );
    await save(t, input, { assessment });
    await t.mutation(ref.markBriefItems, {
      ...scope,
      items: [{ accountId: 'a', threadId: 't', sourceRevision: input.sourceRevision }],
    });
    expect((await row(t))?.jevLastBriefChangeId).toBe('m-t');
    const prev = (await row(t))?.jevLastBriefRevision;
    await t.mutation(ref.markBriefItems, {
      ...scope,
      items: [{ accountId: 'a', threadId: 't', sourceRevision: 'stale' }],
    });
    expect((await row(t))?.jevLastBriefRevision).toBe(prev);
  });
});

test('relevance pagination reaches scoped date matches and retains a continuation after clipping', async () => {
  const t = convexTest(schema, modules);
  await seed(t, 'a', 'owner', 'first');
  await seed(t, 'a', 'owner', 'second');
  await seed(t, 'b', 'owner', 'other-account');
  await seed(t, 'foreign', 'other', 'foreign-user');
  await t.run(async (ctx) => {
    const first = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_account_message', (q) => q.eq('accountId', 'a').eq('providerMessageId', 'm-first'))
      .unique();
    await ctx.db.patch(first!._id, { receivedAt: NOW - 1000 });
  });
  const page1 = await t.query(api.mailCorpus.searchCorpusMessagesPage, {
    ...scope,
    accountId: 'a',
    query: 'budget',
    limit: 1,
  });
  expect(page1.items).toHaveLength(1);
  expect(page1.nextCursor).toBeDefined();
  const page2 = await t.query(api.mailCorpus.searchCorpusMessagesPage, {
    ...scope,
    accountId: 'a',
    query: 'budget',
    limit: 1,
    cursor: page1.nextCursor,
  });
  expect(page2.items).toHaveLength(1);
  expect(page2.items[0].providerMessageId).not.toBe(page1.items[0].providerMessageId);
  expect(
    [...page1.items, ...page2.items].every((item) => item.accountId === 'a' && item.userId === 'owner'),
  ).toBe(true);
  const dated = await t.query(api.mailCorpus.searchCorpusMessagesPage, {
    ...scope,
    accountId: 'a',
    query: 'budget',
    after: NOW - 1500,
    before: NOW - 500,
    limit: 1,
  });
  expect(dated.items.map((item) => item.providerMessageId)).toEqual(['m-first']);
});

test('metadata sync retains hydrated body boundaries, recipients and full-text evidence', async () => {
  const t = convexTest(schema, modules);
  await seed(
    t,
    'a',
    'owner',
    't',
    'FYI\n> Can you confirm the older request?\nAttached is the irreplaceable-reference.',
  );
  const input = (await claim(t)).items[0];
  expect(input.messages[0].body).toContain('\n>');
  await save(t, input);
  await t.mutation(api.mailCorpus.upsertCorpusBatch, {
    ...scope,
    accountId: 'a',
    grantId: 'grant-a',
    provider: 'google',
    threads: [],
    messages: [
      {
        providerMessageId: 'm-t',
        providerThreadId: 't',
        subject: 'Budget approval',
        from: 'maya@example.test',
        to: 'owner@example.test',
        receivedAt: NOW,
        snippet: 'Short',
        searchText: 'budget short',
        labels: ['INBOX'],
        unread: false,
      },
    ],
  });
  const message = await t.run((ctx) => ctx.db.query('mailCorpusMessages').first());
  // The body lives in its own table after the split (IO-1).
  const body = await t.run((ctx) => ctx.db.query('mailCorpusBodies').first());
  expect(message?.textBody).toBeUndefined();
  expect(body?.textBody).toContain('\n>');
  expect(message?.searchText).toContain('irreplaceable-reference');
  expect((await row(t))?.jev?.sourceRevision).toBe(input.sourceRevision);
});

test('metadata refresh cannot reopen a permanently failed Jev attempt into an undrainable queue', async () => {
  const t = convexTest(schema, modules);
  await seed(t);
  await t.run(async (ctx) => {
    const r = await ctx.db.query('mailCorpusThreads').first();
    await ctx.db.patch(r!._id, { jevAttempts: 3, jevStatus: 'unavailable', llmPending: undefined });
  });
  await seed(t);
  expect((await row(t))?.llmPending).toBeUndefined();
  await seed(t, 'a', 'owner', 't', 'New actual content.');
  expect((await row(t))?.llmPending).toBe(true);
});

test('Jev user discovery visits later connected accounts and retains an independent recurring cursor', async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 0; i < 54; i++)
      await ctx.db.insert('connectedAccounts', {
        userId: `user-${i}`,
        accountId: `account-${i}`,
        grantId: `grant-${i}`,
        email: `${i}@example.test`,
        provider: 'google',
        scopes: [],
        status: i < 52 ? 'connected' : 'disconnected',
        createdAt: 1,
        updatedAt: 1,
      });
  });
  const a = await t.mutation((internal as any).jev.usersWithMail, {});
  const b = await t.mutation((internal as any).jev.usersWithMail, {});
  const c = await t.mutation((internal as any).jev.usersWithMail, {});
  expect(a).toHaveLength(24);
  expect(b).toHaveLength(24);
  expect(c).toHaveLength(4);
  expect(new Set([...a, ...b, ...c]).size).toBe(52);
  expect(await t.mutation((internal as any).jev.usersWithMail, {})).toEqual(a);
});

test('reordered metadata preserves classification, and search pages omit HTML while retaining deep matches', async () => {
  const t = convexTest(schema, modules);
  await seed(t);
  const input = (await claim(t)).items[0];
  await save(t, input);
  const message = await t.run((ctx) => ctx.db.query('mailCorpusMessages').first());
  await t.run((ctx) => ctx.db.patch(message!._id, { headers: { a: '1', b: '2' }, cc: 'copy@example.test' }));
  await t.mutation(api.mailCorpus.upsertCorpusBatch, {
    ...scope,
    accountId: 'a',
    grantId: 'grant-a',
    provider: 'google',
    threads: [],
    messages: [
      {
        providerMessageId: 'm-t',
        providerThreadId: 't',
        subject: 'Budget approval',
        from: 'maya@example.test',
        to: 'owner@example.test',
        receivedAt: NOW,
        snippet: 'Please confirm the budget.',
        searchText: 'budget',
        labels: ['INBOX'],
        headers: { b: '2', a: '1' },
      },
    ],
  });
  expect((await row(t))?.jev?.sourceRevision).toBe(input.sourceRevision);
  const refreshed = await t.run((ctx) => ctx.db.get(message!._id));
  expect(refreshed?.searchText).toContain('copy@example.test');
  await t.run((ctx) =>
    ctx.db.patch(message!._id, {
      htmlBody: 'x'.repeat(200_000),
      textBody: `${'x'.repeat(20_000)} budget approval matters`,
      searchText: 'budget approval matters',
    }),
  );
  const result = await t.query(api.mailCorpus.searchCorpusMessagesPage, {
    ...scope,
    accountId: 'a',
    query: 'budget',
  });
  expect(result.items[0].textBody).toContain('budget approval matters');
  expect(result.items[0].textBody!.length).toBeLessThanOrEqual(1600);
  expect((result.items[0] as any).htmlBody).toBeUndefined();
});

describe('Jev spends model calls only on live, recent mail', () => {
  const DAY = 86_400_000;
  async function patchThread(t: TestConvex<typeof schema>, id: string, patch: any, account = 'a') {
    const target = await row(t, account, id);
    await t.run((ctx) => ctx.db.patch(target!._id, patch));
  }
  // Convex drops undefined fields, so a cleared flag is an absent key.
  function expectOffQueue(thread: any, jevStatus: string, jevError?: string) {
    expect(thread.llmPending).toBeUndefined();
    expect(thread.jevStatus).toBe(jevStatus);
    expect(thread.jevError).toBe(jevError);
  }
  // Each page schedules the next one with a zero delay. Let each timer fire,
  // then wait for the page, until no scheduled page remains.
  async function drainScheduled(t: TestConvex<typeof schema>) {
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await t.finishInProgressScheduledFunctions();
      const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
      if (!jobs.some((job) => job.state.kind === 'pending' || job.state.kind === 'inProgress')) return;
    }
    throw new Error('Scheduled pages did not finish.');
  }
  async function setAccountStatus(t: TestConvex<typeof schema>, account: string, status: 'error') {
    await t.run(async (ctx) => {
      const found = await ctx.db
        .query('connectedAccounts')
        .withIndex('by_user_account', (q) => q.eq('userId', 'owner').eq('accountId', account))
        .unique();
      await ctx.db.patch(found!._id, { status });
    });
  }

  test('the claim takes dead-account, old, and spam or trash rows off the queue with no model input', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'a', 'owner', 'live');
    await seed(t, 'a', 'owner', 'old');
    await seed(t, 'a', 'owner', 'junk');
    await seed(t, 'a', 'owner', 'bin');
    await seed(t, 'dead', 'owner', 'gone');
    await setAccountStatus(t, 'dead', 'error');
    await patchThread(t, 'old', { lastDate: NOW - 61 * DAY });
    // Provider-neutral roles: an iCloud junk folder id ends in `:Junk`.
    await patchThread(t, 'junk', { labels: ['v0:abc:Junk'] });
    await patchThread(t, 'bin', { labels: ['TRASH'] });
    const page = await claim(t);
    expect(page.items.map((item: any) => item.threadId)).toEqual(['live']);
    expect(page.moreRemaining).toBe(true);
    const reasons = {
      old: 'Mail older than 60 days is not classified.',
      junk: 'Spam and trash are not classified.',
      bin: 'Spam and trash are not classified.',
    };
    for (const [id, error] of Object.entries(reasons))
      expectOffQueue(await row(t, 'a', id), 'unavailable', error);
    expectOffQueue(await row(t, 'dead', 'gone'), 'unavailable', 'The account is not connected.');
    expect((await claim(t)).items).toEqual([]);
  });

  test('a queue whose first 120 rows are all gated still reaches a live row', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'a', 'owner', 'live');
    await t.run(async (ctx) => {
      // Newer rows of a dead account sort first in the descending claim read.
      for (let i = 0; i < 125; i++)
        await ctx.db.insert('mailCorpusThreads', {
          userId: 'owner',
          accountId: 'dead',
          grantId: 'grant-dead',
          provider: 'google',
          providerThreadId: `dead-${i}`,
          subject: 'Old mailbox',
          fromAddress: 'sender@example.test',
          lastDate: NOW + 1 + i,
          snippet: '',
          labels: ['INBOX'],
          unread: false,
          llmPending: true,
          yearMonth: '2026-09',
          createdAt: NOW,
          updatedAt: NOW,
        });
    });
    const first = await claim(t);
    expect(first.items).toEqual([]);
    expect(first.moreRemaining).toBe(true);
    const second = await claim(t);
    expect(second.items.map((item: any) => item.threadId)).toEqual(['live']);
    const pending = await t.run((ctx) =>
      ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_llm_pending', (q) => q.eq('userId', 'owner').eq('llmPending', true))
        .collect(),
    );
    expect(pending.map((thread) => thread.providerThreadId)).toEqual(['live']);
  });

  test('a verdict for the same revision settles a queue flag; reprocessing still forces a pass', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const input = (await claim(t)).items[0];
    await save(t, input);
    await patchThread(t, 't', { llmPending: true, jevStatus: 'pending' });
    const page = await claim(t);
    expect(page.items).toEqual([]);
    expectOffQueue(await row(t), 'accepted');
    await t.mutation((internal as any).jev.queueUser, { userId: 'owner' });
    expect((await claim(t)).items).toHaveLength(1);
  });

  test('a stale revision result counts an attempt and stops the loop after three', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const input = (await claim(t)).items[0];
      expect(input).toBeDefined();
      // The body changes while the model runs, so the result is stale.
      await t.run(async (ctx) => {
        const message = await ctx.db.query('mailCorpusMessages').first();
        await ctx.db.patch(message!._id, { textBody: `Revised body ${attempt}.` });
      });
      expect((await save(t, input)).stored).toBe(0);
      expect((await row(t))?.jevAttempts).toBe(attempt);
    }
    expectOffQueue(await row(t), 'unavailable', 'Message content changed during classification.');
    expect((await claim(t)).items).toEqual([]);
  });

  test('the queue cleanup counts on a dry run, then clears gated rows for every user once', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const clerkUserId of ['owner', 'other'])
        await ctx.db.insert('users', {
          clerkUserId,
          email: `${clerkUserId}@example.test`,
          createdAt: 0,
          updatedAt: 0,
        });
    });
    await seed(t, 'a', 'owner', 'live');
    await seed(t, 'a', 'owner', 'old');
    await seed(t, 'a', 'owner', 'junk');
    await seed(t, 'dead', 'owner', 'gone');
    await seed(t, 'x', 'other', 'foreign');
    await setAccountStatus(t, 'dead', 'error');
    await patchThread(t, 'old', { lastDate: NOW - 61 * DAY });
    await patchThread(t, 'junk', { labels: ['SPAM'] });
    await t.run(async (ctx) => {
      const account = await ctx.db
        .query('connectedAccounts')
        .withIndex('by_user_account', (q) => q.eq('userId', 'other').eq('accountId', 'x'))
        .unique();
      await ctx.db.patch(account!._id, { status: 'error' });
    });
    const cleanup = (internal as any).jev.clearIneligiblePending;
    const dry = await t.mutation(cleanup, { dryRun: true, userId: 'owner' });
    expect(dry).toEqual({ scanned: 4, cleared: { account: 1, age: 1, spam: 1 }, done: true });
    expect((await row(t, 'dead', 'gone'))?.llmPending).toBe(true);

    // Pages of two rows: the pass schedules the next page, then the next user.
    const first = await t.mutation(cleanup, { limit: 2 });
    expect(first.done).toBe(false);
    await drainScheduled(t);
    const pending = await t.run((ctx) =>
      ctx.db
        .query('mailCorpusThreads')
        .filter((q) => q.eq(q.field('llmPending'), true))
        .collect(),
    );
    expect(pending.map((thread) => thread.providerThreadId)).toEqual(['live']);
    expect(await row(t, 'dead', 'gone')).toMatchObject({ jevError: 'The account is not connected.' });
    const again = await t.mutation(cleanup, {});
    expect(again.cleared).toEqual({ account: 0, age: 0, spam: 0 });
  });
});
