import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  classificationFreshnessPatch,
  classifyCorpusThread,
  computeCategoryUnreadCounts,
  queryCategoryThreads,
} from '../convex/smart';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/smart.ts': () => import('../convex/smart'),
};

const SECRET = 'smart-runtime-secret';
const USER = 'smart_runtime_user';
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

let seq = 0;

async function seedThread(t: Harness, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const ts = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('mailCorpusThreads', {
      userId: USER,
      accountId: 'account_1',
      grantId: 'grant_1',
      provider: 'google' as const,
      providerThreadId: `thread_${seq}`,
      subject: 'Lunch tomorrow?',
      fromAddress: 'Alice <alice@example.com>',
      lastDate: ts,
      snippet: 'Want to grab lunch?',
      labels: ['INBOX'],
      unread: true,
      yearMonth: '2026-07',
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    }),
  );
}

async function seedRule(t: Harness, doc: Record<string, unknown>) {
  const ts = Date.now();
  return t.run((ctx) =>
    ctx.db.insert('userDocs', {
      userId: USER,
      kind: 'smartRule',
      key: String(doc._id),
      doc: { enabled: true, ...doc },
      createdAt: ts,
      updatedAt: ts,
    }),
  );
}

describe('classifyCorpusThread precedence', () => {
  const baseRow = {
    providerThreadId: 'thread_x',
    subject: 'Your order shipped',
    fromAddress: 'shop@store.com',
    snippet: 'Tracking inside',
    labels: [],
    unread: true,
  };

  test('a current LLM verdict wins over deterministic but attention follows live unread', () => {
    const row = {
      ...baseRow,
      unread: false,
      latestMessageId: 'm2',
      llmClassifiedMessageId: 'm2',
      llmCategory: { primary: 'orders', needsAttention: true, reason: 'model said so' },
    };
    const patch = classifyCorpusThread(row, {});
    expect(patch.smartPrimary).toBe('orders');
    expect(patch.smartCategory.needsAttention).toBe(false);
    expect(patch.llmPending).toBeUndefined();
  });

  test('a stale LLM verdict is discarded and the model pass reopens', () => {
    const row = {
      ...baseRow,
      latestMessageId: 'm3',
      llmClassifiedMessageId: 'm2',
      llmCategory: { primary: 'orders', needsAttention: true },
    };
    const patch = classifyCorpusThread(row, {});
    expect(patch.llmPending).toBe(true);
    expect(patch.smartCategory.model).not.toBe('llm');
  });

  test('user rules beat a current LLM verdict', () => {
    const row = {
      ...baseRow,
      latestMessageId: 'm2',
      llmClassifiedMessageId: 'm2',
      llmCategory: { primary: 'main', needsAttention: true },
    };
    const patch = classifyCorpusThread(row, {
      rules: [
        {
          _id: 'rule_noise',
          name: 'Mute store',
          enabled: true,
          scope: 'sender',
          match: 'shop@store.com',
          effect: 'always_noise',
        },
      ] as never,
    });
    expect(patch.smartPrimary).toBe('noise');
    expect(patch.smartCategory.model).toBe('user_rule');
  });

  test('classificationFreshnessPatch resets verdicts only when the latest message changed', () => {
    expect(classificationFreshnessPatch('m1', 'm1')).toEqual({});
    const reset = classificationFreshnessPatch('m1', 'm2');
    expect(reset).toMatchObject({ llmCategory: undefined, areaRoutingPending: true });
  });
});

describe('classifyBacklog sweep', () => {
  test('classifies unclassified rows using the latest message body and reports done', async () => {
    const t = newHarness();
    await seedThread(t, { providerThreadId: 'backlog_1' });
    await seedThread(t, { providerThreadId: 'backlog_2', fromAddress: 'no-reply@promo.com' });
    await t.run(async (ctx) => {
      const ts = Date.now();
      await ctx.db.insert('mailCorpusMessages', {
        userId: USER,
        accountId: 'account_1',
        grantId: 'grant_1',
        provider: 'google',
        providerMessageId: 'msg_backlog_1',
        providerThreadId: 'backlog_1',
        subject: 'Lunch tomorrow?',
        from: 'alice@example.com',
        to: 'me@example.com',
        receivedAt: ts,
        snippet: 'Want to grab lunch?',
        textBody: 'Want to grab lunch at noon tomorrow?',
        searchText: 'lunch tomorrow noon',
        labels: ['INBOX'],
        yearMonth: '2026-07',
        createdAt: ts,
        updatedAt: ts,
      });
    });
    const result = await t.mutation(internal.smart.classifyBacklog, {});
    expect(result).toEqual({ classified: 2, done: true });
    const rows = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
    for (const row of rows) {
      expect(typeof row.smartPrimary).toBe('string');
      expect(row.classifiedAt).toBeGreaterThan(0);
    }
    // A follow-up sweep has nothing left to do.
    expect(await t.mutation(internal.smart.classifyBacklog, {})).toEqual({ classified: 0, done: true });
  });
});

describe('reclassifyMatchingThreads', () => {
  test('requires the internal secret and skips blank matches', async () => {
    const t = newHarness();
    await expect(
      t.mutation(api.smart.reclassifyMatchingThreads, {
        internalSecret: 'wrong',
        userId: USER,
        scope: 'sender',
        match: 'x@y.com',
      }),
    ).rejects.toThrow(/Invalid Convex internal secret/);
    expect(
      await t.mutation(api.smart.reclassifyMatchingThreads, {
        internalSecret: SECRET,
        userId: USER,
        scope: 'sender',
        match: '   ',
      }),
    ).toEqual({ patched: 0 });
  });

  test('immediately flips only the rows the new rule matches', async () => {
    const t = newHarness();
    await seedThread(t, { providerThreadId: 'muted', fromAddress: 'Spam Bot <spam@promo.com>' });
    await seedThread(t, { providerThreadId: 'kept', fromAddress: 'Alice <alice@example.com>' });
    await seedRule(t, {
      _id: 'rule_mute',
      name: 'Mute promo',
      scope: 'sender',
      match: 'spam@promo.com',
      effect: 'always_noise',
    });
    const result = await t.mutation(api.smart.reclassifyMatchingThreads, {
      internalSecret: SECRET,
      userId: USER,
      scope: 'sender',
      match: 'spam@promo.com',
    });
    expect(result).toEqual({ patched: 1 });
    const muted = await t.run(async (ctx) =>
      (await ctx.db.query('mailCorpusThreads').collect()).find((r) => r.providerThreadId === 'muted'),
    );
    expect(muted?.smartPrimary).toBe('noise');
    expect(muted?.smartCategory?.model).toBe('user_rule');
  });

  test('covers domain, subject regex, header, and thread scopes', async () => {
    const t = newHarness();
    await seedThread(t, {
      providerThreadId: 'scoped',
      fromAddress: 'billing@vendor.io',
      subject: 'Invoice #42 due',
    });
    const call = (scope: string, match: string) =>
      t.mutation(api.smart.reclassifyMatchingThreads, { internalSecret: SECRET, userId: USER, scope, match });
    expect(await call('domain', 'vendor.io')).toEqual({ patched: 1 });
    expect(await call('subject_pattern', 'invoice #\\d+')).toEqual({ patched: 1 });
    expect(await call('header', 'invoice')).toEqual({ patched: 1 });
    expect(await call('thread', 'scoped')).toEqual({ patched: 1 });
    expect(await call('thread', 'other')).toEqual({ patched: 0 });
    expect(await call('unknown_scope', 'whatever')).toEqual({ patched: 0 });
    // Invalid regex must not throw — substring matching still applies.
    expect(await call('subject_pattern', '((((')).toEqual({ patched: 0 });
  });
});

describe('reclassifyUserThreads pages', () => {
  test('reclassifies the whole user corpus in one small page', async () => {
    const t = newHarness();
    await seedThread(t, { providerThreadId: 'sweep_1' });
    await seedThread(t, { providerThreadId: 'sweep_2' });
    const result = await t.mutation(internal.smart.reclassifyUserThreads, { userId: USER });
    expect(result).toEqual({ reclassified: 2, done: true });
    const rows = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
    expect(rows.every((row) => typeof row.smartPrimary === 'string')).toBe(true);
  });
});

describe('computeCategoryUnreadCounts', () => {
  test('counts unread per category with needs_reply and secondary promotion from Main', async () => {
    const t = newHarness();
    await seedThread(t, {
      providerThreadId: 'main_reply',
      smartPrimary: 'main',
      smartCategory: { primary: 'main', secondary: ['needs_reply'], needsAttention: true },
    });
    await seedThread(t, {
      providerThreadId: 'main_order',
      smartPrimary: 'main',
      smartCategory: { primary: 'main', secondary: ['orders'], needsAttention: false },
    });
    await seedThread(t, {
      providerThreadId: 'noise_read',
      unread: false,
      smartPrimary: 'noise',
      smartCategory: { primary: 'noise' },
    });
    await seedThread(t, {
      providerThreadId: 'custom_hit',
      smartPrimary: 'review',
      smartCategory: { primary: 'review', needsAttention: false },
      smartCustomKeys: ['receipts'],
    });
    const counts = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER));
    expect(counts.main).toEqual({ unread: 2, attention: true });
    expect(counts.needs_reply).toEqual({ unread: 1, attention: true });
    expect(counts.orders).toEqual({ unread: 1, attention: false });
    expect(counts.noise).toEqual({ unread: 0, attention: false });
    expect(counts.review).toEqual({ unread: 1, attention: false });
    expect(counts['custom:receipts']).toEqual({ unread: 1, attention: false });

    // Account scoping drops rows from other accounts entirely.
    const scoped = await t.run((ctx) => computeCategoryUnreadCounts(ctx, USER, ['account_other']));
    expect(scoped.main).toEqual({ unread: 0, attention: false });
    expect(scoped['custom:receipts']).toBeUndefined();
  });
});

describe('queryCategoryThreads', () => {
  test('lists a primary category, promotes secondary hits, and classifies backlog rows in memory', async () => {
    const t = newHarness();
    await seedThread(t, {
      providerThreadId: 'orders_native',
      smartPrimary: 'orders',
      smartCategory: { primary: 'orders' },
      lastDate: 3_000,
    });
    await seedThread(t, {
      providerThreadId: 'orders_via_main',
      smartPrimary: 'main',
      smartCategory: { primary: 'main', secondary: ['orders'] },
      lastDate: 2_000,
    });
    // Pre-migration row: no verdict stored; must be classified in memory.
    await seedThread(t, {
      providerThreadId: 'backlog_row',
      subject: 'Quick question',
      lastDate: 1_000,
    });
    const page = await t.run((ctx) =>
      queryCategoryThreads(ctx, { userId: USER, category: 'orders', limit: 10 }),
    );
    expect(page.items.map((item: { _id: string }) => item._id)).toEqual(['orders_native', 'orders_via_main']);
    expect(page.nextBefore).toBeUndefined();

    const main = await t.run((ctx) =>
      queryCategoryThreads(ctx, { userId: USER, category: 'main', limit: 10 }),
    );
    expect(main.items.some((item: { _id: string }) => item._id === 'orders_via_main')).toBe(true);
  });

  test('custom label categories filter the recency window and paginate by lastDate', async () => {
    const t = newHarness();
    for (let i = 0; i < 3; i += 1) {
      await seedThread(t, {
        providerThreadId: `labeled_${i}`,
        smartPrimary: 'main',
        smartCategory: { primary: 'main', customLabels: ['receipts'] },
        smartCustomKeys: ['receipts'],
        lastDate: 1_000 + i,
      });
    }
    await seedThread(t, {
      providerThreadId: 'unlabeled',
      smartPrimary: 'main',
      smartCategory: { primary: 'main' },
      lastDate: 5_000,
    });
    const page = await t.run((ctx) =>
      queryCategoryThreads(ctx, { userId: USER, category: 'custom:receipts', limit: 2 }),
    );
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item: { _id: string }) => item._id.startsWith('labeled_'))).toBe(true);
    expect(page.nextBefore).toBe(Number(page.items[1].lastDate));
    const next = await t.run((ctx) =>
      queryCategoryThreads(ctx, {
        userId: USER,
        category: 'custom:receipts',
        limit: 2,
        before: page.nextBefore,
      }),
    );
    expect(next.items.map((item: { _id: string }) => item._id)).toEqual(['labeled_0']);
  });
});
