import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { computeCategoryUnreadCounts, queryCategoryThreads } from '../convex/smart';
import { SMART_CLASSIFIER_VERSION } from '../lib/mail/smart-categories';

// CLS-13: a custom label view and its badge read the membership table, so
// they cover the whole mailbox and not only a recent window.

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/smart.ts': () => import('../convex/smart'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
};

const SECRET = 'label-membership-secret';
const USER = 'label_membership_user';
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

async function seedLabel(t: Harness, id: string, name: string, enabled = true) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) => q.eq('userId', USER).eq('kind', 'smartLabel').eq('key', id))
      .unique();
    const doc = { _id: id, name, enabled, sidebarVisible: true, positiveExamples: [], negativeExamples: [] };
    if (existing) await ctx.db.patch(existing._id, { doc, updatedAt: Date.now() });
    else
      await ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'smartLabel',
        key: id,
        doc,
        createdAt: 1,
        updatedAt: 1,
      });
  });
}

// One message per thread; the subject decides the label hit.
async function ingest(
  t: Harness,
  threadId: string,
  receivedAt: number,
  subject: string,
  over: Record<string, unknown> = {},
) {
  await t.mutation(api.mailCorpus.upsertCorpusBatch, {
    ...scope,
    threads: [],
    messages: [
      {
        providerMessageId: `${threadId}_m_${receivedAt}`,
        providerThreadId: threadId,
        subject,
        from: 'Alice <alice@example.com>',
        to: 'me@example.com',
        receivedAt,
        snippet: subject,
        textBody: subject,
        searchText: subject,
        labels: ['INBOX'],
        unread: true,
        ...over,
      } as never,
    ],
  });
}

async function members(t: Harness, threadId?: string) {
  const rows = await t.run((ctx) => ctx.db.query('mailLabelMembership').collect());
  return rows
    .filter((row) => !threadId || row.providerThreadId === threadId)
    .map((row) => ({
      thread: row.providerThreadId,
      label: row.labelKey,
      unread: row.unread,
      at: row.lastDate,
    }))
    .sort((a, b) => a.thread.localeCompare(b.thread) || a.label.localeCompare(b.label));
}

async function allPages(t: Harness, category: string, limit: number, accountIds?: string[]) {
  const ids: string[] = [];
  let before: number | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = await t.run((ctx) =>
      queryCategoryThreads(ctx, { userId: USER, accountIds, category, limit, before }),
    );
    ids.push(...page.items.map((item: { _id: string }) => item._id));
    if (page.nextBefore === undefined) return ids;
    before = page.nextBefore;
  }
  throw new Error('paging did not stop');
}

describe('label membership writes (CLS-13)', () => {
  test('ingest writes one row for each label hit, and a new message moves it', async () => {
    const t = newHarness();
    await seedLabel(t, 'receipts', 'Receipts');
    await seedLabel(t, 'travel', 'Travel');
    await ingest(t, 'both', 1_000, 'Travel receipts for March');
    await ingest(t, 'none', 2_000, 'Lunch tomorrow?');
    expect(await members(t)).toEqual([
      { thread: 'both', label: 'receipts', unread: true, at: 1_000 },
      { thread: 'both', label: 'travel', unread: true, at: 1_000 },
    ]);
    // A later read message: the thread keeps its hits and takes the new time.
    await ingest(t, 'both', 3_000, 'Travel receipts for March', { unread: false });
    expect((await members(t, 'both')).map((row) => row.at)).toEqual([3_000, 3_000]);
  });

  test('a relabel moves membership with the verdict, and a read thread leaves the badge', async () => {
    const t = newHarness();
    await seedLabel(t, 'receipts', 'Receipts');
    await ingest(t, 'relabel', 1_000, 'Receipts for March');
    expect(await members(t)).toEqual([{ thread: 'relabel', label: 'receipts', unread: true, at: 1_000 }]);

    // The label changes: a new label matches and the old one is turned off.
    await seedLabel(t, 'receipts', 'Receipts', false);
    await seedLabel(t, 'march', 'March');
    await t.mutation(internal.smart.reclassifyUserThreads, { userId: USER });
    expect(await members(t)).toEqual([{ thread: 'relabel', label: 'march', unread: true, at: 1_000 }]);
    expect(await allPages(t, 'custom:receipts', 10)).toEqual([]);
    expect(await allPages(t, 'custom:march', 10)).toEqual(['relabel']);

    let counts = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER));
    expect(counts['custom:march']?.unread).toBe(1);
    // The same message, now read.
    await ingest(t, 'relabel', 1_000, 'Receipts for March', { unread: false });
    expect(await members(t)).toEqual([{ thread: 'relabel', label: 'march', unread: false, at: 1_000 }]);
    counts = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER));
    expect(counts['custom:march']).toBeUndefined();
  });

  test('a later verdict change updates the attention flag on membership and the badge', async () => {
    const t = newHarness();
    await seedLabel(t, 'receipts', 'Receipts');
    await ingest(t, 'model', 1_000, 'Receipts for March');
    const attention = async () =>
      (await t.run((ctx) => ctx.db.query('mailLabelMembership').collect())).map((row) =>
        Boolean(row.needsAttention),
      );
    expect(await attention()).toEqual([true]);
    // A user rule that mutes the sender gives the thread a new verdict with no
    // attention; the reclassify write must carry that onto the membership row.
    const ts = Date.now();
    await t.run((ctx) =>
      ctx.db.insert('userDocs', {
        userId: USER,
        kind: 'smartRule',
        key: 'mute_alice',
        doc: {
          _id: 'mute_alice',
          name: 'Mute Alice',
          enabled: true,
          scope: 'sender',
          match: 'alice@example.com',
          effect: 'always_noise',
          createdAt: 1,
        },
        createdAt: ts,
        updatedAt: ts,
      }),
    );
    await t.mutation(api.smart.reclassifyMatchingThreads, {
      internalSecret: SECRET,
      userId: USER,
      scope: 'sender',
      match: 'alice@example.com',
    });
    expect(await attention()).toEqual([false]);
    const counts = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER));
    expect(counts['custom:receipts']).toEqual({ unread: 1, attention: false });
  });

  test('deleting a thread removes its membership rows and the view drops it', async () => {
    const t = newHarness();
    await seedLabel(t, 'receipts', 'Receipts');
    await ingest(t, 'gone', 1_000, 'Receipts for March');
    await ingest(t, 'kept', 2_000, 'Receipts for April');
    await t.mutation(api.mailCorpus.deleteCorpusThread, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'account_1',
      providerThreadId: 'gone',
    });
    expect((await members(t)).map((row) => row.thread)).toEqual(['kept']);
    expect(await allPages(t, 'custom:receipts', 10)).toEqual(['kept']);
  });

  test('the backlog sweep writes membership for rows from an older classifier', async () => {
    const t = newHarness();
    await seedLabel(t, 'receipts', 'Receipts');
    await t.run((ctx) =>
      ctx.db.insert('mailCorpusThreads', {
        userId: USER,
        accountId: 'account_1',
        grantId: 'grant_1',
        provider: 'google',
        providerThreadId: 'old_row',
        subject: 'Receipts for March',
        fromAddress: 'Alice <alice@example.com>',
        lastDate: 1_000,
        snippet: 'Receipts for March',
        labels: ['INBOX'],
        unread: true,
        smartPrimary: 'main',
        smartCategory: { primary: 'main', secondary: [], customLabels: ['receipts'] },
        smartCustomKeys: ['receipts'],
        smartClassifierVersion: SMART_CLASSIFIER_VERSION - 1,
        yearMonth: '2026-07',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(await members(t)).toEqual([]);
    // Until the sweep reaches the row, the recent window still shows it.
    expect(await allPages(t, 'custom:receipts', 10)).toEqual(['old_row']);
    expect((await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER)))['custom:receipts']?.unread).toBe(1);

    expect(await t.mutation(internal.smart.classifyBacklog, {})).toEqual({ classified: 1, done: true });
    expect(await members(t)).toEqual([{ thread: 'old_row', label: 'receipts', unread: true, at: 1_000 }]);
    const row = await t.run(async (ctx) => (await ctx.db.query('mailCorpusThreads').collect())[0]);
    expect(row?.smartClassifierVersion).toBe(SMART_CLASSIFIER_VERSION);
    // Membership and the window do not count the same thread twice.
    expect((await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER)))['custom:receipts']?.unread).toBe(1);
  });
});

describe('label views page through the whole mailbox (CLS-13)', () => {
  test('a limit-2 view reaches a labeled thread far older than the recent window', async () => {
    const t = newHarness();
    await seedLabel(t, 'receipts', 'Receipts');
    await ingest(t, 'labeled_old', 1_000, 'Receipts for January');
    for (let i = 0; i < 14; i += 1) await ingest(t, `plain_${i}`, 2_000 + i * 10, `Lunch plan ${i}`);
    await ingest(t, 'labeled_mid', 1_500, 'Receipts for February');
    await ingest(t, 'labeled_new_a', 3_000, 'Receipts for March');
    await ingest(t, 'labeled_new_b', 3_100, 'Receipts for April');

    const first = await t.run((ctx) =>
      queryCategoryThreads(ctx, { userId: USER, category: 'custom:receipts', limit: 2 }),
    );
    expect(first.items.map((item: { _id: string }) => item._id)).toEqual(['labeled_new_b', 'labeled_new_a']);
    expect(first.nextBefore).toBe(3_000);
    // The old window read limit * 6 = 12 recent rows and never reached these.
    expect(await allPages(t, 'custom:receipts', 2)).toEqual([
      'labeled_new_b',
      'labeled_new_a',
      'labeled_mid',
      'labeled_old',
    ]);
    expect(await allPages(t, 'custom:receipts', 2, ['account_1'])).toEqual([
      'labeled_new_b',
      'labeled_new_a',
      'labeled_mid',
      'labeled_old',
    ]);
    expect(await allPages(t, 'custom:receipts', 2, ['account_other'])).toEqual([]);

    // The internal-secret listing that tools and native use pages the same way.
    const tool = await t.query(api.mailCorpus.listSmartCategoryThreads, {
      internalSecret: SECRET,
      userId: USER,
      category: 'custom:receipts',
      limit: 3,
      before: 3_000,
    });
    expect(tool.items.map((item: { _id: string }) => item._id)).toEqual(['labeled_mid', 'labeled_old']);
    expect(tool.nextBefore).toBeUndefined();
  });

  test('a page holds every thread that shares its boundary time', async () => {
    const t = newHarness();
    await seedLabel(t, 'receipts', 'Receipts');
    await ingest(t, 'tie_a', 2_000, 'Receipts A');
    await ingest(t, 'tie_b', 2_000, 'Receipts B');
    await ingest(t, 'tie_c', 2_000, 'Receipts C');
    await ingest(t, 'older', 1_000, 'Receipts D');
    const page = await t.run((ctx) =>
      queryCategoryThreads(ctx, { userId: USER, category: 'custom:receipts', limit: 1 }),
    );
    expect(page.items.map((item: { _id: string }) => item._id).sort()).toEqual(['tie_a', 'tie_b', 'tie_c']);
    expect(page.nextBefore).toBe(2_000);
    expect(await allPages(t, 'custom:receipts', 1, ['account_1'])).toHaveLength(4);
  });

  test('the unread badge counts labeled mail outside the 300 newest threads', async () => {
    const t = newHarness();
    await seedLabel(t, 'receipts', 'Receipts');
    await ingest(t, 'deep', 1_000, 'Receipts for January');
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i += 1)
        await ctx.db.insert('mailCorpusThreads', {
          userId: USER,
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerThreadId: `recent_${i}`,
          subject: 'Lunch',
          fromAddress: 'bob@example.com',
          lastDate: 5_000 + i,
          snippet: '',
          labels: ['INBOX'],
          unread: true,
          smartPrimary: 'main',
          smartCategory: { primary: 'main', secondary: [], customLabels: [] },
          smartCustomKeys: [],
          smartClassifierVersion: SMART_CLASSIFIER_VERSION,
          yearMonth: '2026-07',
          createdAt: 1,
          updatedAt: 1,
        });
    });
    const counts = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER));
    expect(counts['custom:receipts']?.unread).toBe(1);
    const scoped = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER, ['account_1']));
    expect(scoped['custom:receipts']?.unread).toBe(1);
    const other = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER, ['account_other']));
    expect(other['custom:receipts']).toBeUndefined();
  });
});
