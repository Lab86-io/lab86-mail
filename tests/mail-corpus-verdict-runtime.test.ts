import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
};

describe('Smart Category verdict freshness', () => {
  test('repairs a pending legacy thread from its canonical latest message before enqueueing', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'smart-pending-repair-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert('mailCorpusThreads', {
          userId: 'smart_pending_user',
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerThreadId: 'thread_legacy',
          subject: 'Legacy aggregate',
          fromAddress: 'sender@example.com',
          lastDate: ts,
          snippet: 'Missing its message watermark',
          labels: ['inbox'],
          unread: true,
          llmPending: true,
          yearMonth: '2026-07',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mailCorpusMessages', {
          userId: 'smart_pending_user',
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerMessageId: 'message_canonical',
          providerThreadId: 'thread_legacy',
          subject: 'Canonical message',
          from: 'new-sender@example.com',
          to: 'user@example.com',
          receivedAt: ts,
          snippet: 'Grounded body',
          textBody: 'This exact body belongs to the canonical message.',
          searchText: 'canonical message grounded body',
          labels: ['inbox'],
          yearMonth: '2026-07',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mailCorpusThreads', {
          userId: 'smart_pending_user',
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerThreadId: 'thread_without_message',
          subject: 'Orphaned legacy aggregate',
          fromAddress: 'sender@example.com',
          lastDate: ts - 1,
          snippet: 'No canonical message exists.',
          labels: ['inbox'],
          unread: false,
          llmPending: true,
          yearMonth: '2026-07',
          createdAt: ts,
          updatedAt: ts,
        });
      });

      const page = await t.mutation(api.mailCorpus.listLlmPending, {
        internalSecret: 'smart-pending-repair-secret',
        userId: 'smart_pending_user',
        limit: 10,
      });
      const pending = page.items;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        providerThreadId: 'thread_legacy',
        messageId: 'message_canonical',
        subject: 'Canonical message',
        fromAddress: 'new-sender@example.com',
        snippet: 'Grounded body',
        lastDate: ts,
        bodyText: 'This exact body belongs to the canonical message.',
      });
      expect(page.moreRemaining).toBe(false);
      const threads = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
      const thread = threads.find((row) => row.providerThreadId === 'thread_legacy');
      const orphan = threads.find((row) => row.providerThreadId === 'thread_without_message');
      expect(thread).toMatchObject({
        latestMessageId: 'message_canonical',
        llmPending: true,
        areaRoutingPending: true,
      });
      expect(orphan).toBeDefined();
      expect(orphan?.llmPending).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('continues past a full requested batch of orphan aggregates', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'smart-orphan-backlog-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      await t.run(async (ctx) => {
        for (let index = 0; index < 60; index += 1) {
          await ctx.db.insert('mailCorpusThreads', {
            userId: 'smart_orphan_user',
            accountId: 'account_1',
            grantId: 'grant_1',
            provider: 'google',
            providerThreadId: `orphan_${index}`,
            subject: 'Orphan',
            fromAddress: 'orphan@example.com',
            lastDate: ts + index + 1,
            snippet: '',
            labels: [],
            unread: false,
            llmPending: true,
            yearMonth: '2026-07',
            createdAt: ts,
            updatedAt: ts,
          });
        }
        await ctx.db.insert('mailCorpusThreads', {
          userId: 'smart_orphan_user',
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerThreadId: 'grounded_after_orphans',
          subject: 'Stale aggregate subject',
          fromAddress: 'stale@example.com',
          lastDate: ts,
          snippet: 'Stale aggregate snippet',
          labels: [],
          unread: false,
          llmPending: true,
          yearMonth: '2026-07',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mailCorpusMessages', {
          userId: 'smart_orphan_user',
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerMessageId: 'grounded_message',
          providerThreadId: 'grounded_after_orphans',
          subject: 'Grounded subject',
          from: 'grounded@example.com',
          to: 'user@example.com',
          receivedAt: ts,
          snippet: 'Grounded snippet',
          textBody: 'Grounded body',
          searchText: 'grounded body',
          labels: ['inbox'],
          yearMonth: '2026-07',
          createdAt: ts,
          updatedAt: ts,
        });
      });

      const page = await t.mutation(api.mailCorpus.listLlmPending, {
        internalSecret: 'smart-orphan-backlog-secret',
        userId: 'smart_orphan_user',
        limit: 60,
      });
      expect(page).toMatchObject({ moreRemaining: false });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        providerThreadId: 'grounded_after_orphans',
        subject: 'Grounded subject',
        fromAddress: 'grounded@example.com',
      });
      const orphans = await t.run((ctx) =>
        ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_llm_pending', (q) => q.eq('userId', 'smart_orphan_user').eq('llmPending', true))
          .collect(),
      );
      expect(orphans.map((row) => row.providerThreadId)).toEqual(['grounded_after_orphans']);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('returns an empty continuation page when bounded orphan repair has more source rows', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'smart-empty-continuation-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      await t.run(async (ctx) => {
        for (let index = 0; index < 121; index += 1) {
          await ctx.db.insert('mailCorpusThreads', {
            userId: 'smart_empty_page_user',
            accountId: 'account_1',
            grantId: 'grant_1',
            provider: 'google',
            providerThreadId: `empty_orphan_${index}`,
            subject: 'Orphan',
            fromAddress: 'orphan@example.com',
            lastDate: ts + index + 1,
            snippet: '',
            labels: [],
            unread: false,
            llmPending: true,
            yearMonth: '2026-07',
            createdAt: ts,
            updatedAt: ts,
          });
        }
      });
      const page = await t.mutation(api.mailCorpus.listLlmPending, {
        internalSecret: 'smart-empty-continuation-secret',
        userId: 'smart_empty_page_user',
        limit: 1,
      });
      expect(page).toEqual({ items: [], moreRemaining: true });
      const remaining = await t.run((ctx) =>
        ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_llm_pending', (q) =>
            q.eq('userId', 'smart_empty_page_user').eq('llmPending', true),
          )
          .collect(),
      );
      expect(remaining).toHaveLength(1);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('uses the same stable latest message when received timestamps tie', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'smart-tie-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      const message = (providerMessageId: string, subject: string) => ({
        providerMessageId,
        providerThreadId: 'tied_thread',
        subject,
        from: `${providerMessageId}@example.com`,
        to: 'user@example.com',
        receivedAt: ts,
        snippet: subject,
        textBody: `${subject} body`,
        searchText: `${subject} body`,
        labels: ['inbox'],
      });
      const args = {
        internalSecret: 'smart-tie-secret',
        userId: 'smart_tie_user',
        accountId: 'account_1',
        grantId: 'grant_1',
        provider: 'google' as const,
        threads: [],
        messages: [message('message_z', 'First inserted'), message('message_a', 'Second inserted')],
      };
      await t.mutation(api.mailCorpus.upsertCorpusBatch, args);
      const firstThread = await t.run((ctx) => ctx.db.query('mailCorpusThreads').first());
      const firstPage = await t.mutation(api.mailCorpus.listLlmPending, {
        internalSecret: 'smart-tie-secret',
        userId: 'smart_tie_user',
        limit: 10,
      });
      expect(firstThread).toMatchObject({
        latestMessageId: 'message_a',
        subject: 'Second inserted',
      });
      expect(firstPage.items[0]).toMatchObject({
        messageId: 'message_a',
        subject: 'Second inserted',
      });

      await t.mutation(api.mailCorpus.upsertCorpusBatch, {
        ...args,
        messages: [...args.messages].reverse(),
      });
      const recomputed = await t.run((ctx) => ctx.db.query('mailCorpusThreads').first());
      expect(recomputed).toMatchObject({
        latestMessageId: 'message_a',
        subject: 'Second inserted',
      });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('does not stamp a stale verdict as current after a newer message wins the race', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'smart-verdict-race-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      await t.run((ctx) =>
        ctx.db.insert('mailCorpusThreads', {
          userId: 'smart_verdict_user',
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerThreadId: 'thread_1',
          subject: 'Current thread',
          fromAddress: 'sender@example.com',
          lastDate: ts,
          snippet: 'Current message',
          labels: ['inbox'],
          unread: true,
          latestMessageId: 'message_2',
          llmPending: true,
          yearMonth: '2026-07',
          createdAt: ts,
          updatedAt: ts,
        }),
      );

      const result = await t.mutation(api.mailCorpus.storeLlmVerdicts, {
        internalSecret: 'smart-verdict-race-secret',
        userId: 'smart_verdict_user',
        items: [
          {
            accountId: 'account_1',
            providerThreadId: 'thread_1',
            messageId: 'message_1',
            verdict: { primary: 'finance_admin', confidence: 0.99 },
          },
        ],
      });

      expect(result).toEqual({ stored: 0 });
      const thread = await t.run((ctx) => ctx.db.query('mailCorpusThreads').first());
      expect(thread).toMatchObject({ latestMessageId: 'message_2', llmPending: true });
      expect(thread?.llmCategory).toBeUndefined();
      expect(thread?.llmClassifiedMessageId).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('applies a current verdict before merging and clears a stale category on no verdict', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'smart-verdict-merge-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      const staleCategory = {
        primary: 'finance_admin',
        secondary: [],
        customLabels: [],
        ruleHits: [],
        confidence: 0.99,
        needsAttention: false,
        model: 'nano',
      };
      await t.run(async (ctx) => {
        for (const providerThreadId of ['with_verdict', 'without_verdict']) {
          await ctx.db.insert('mailCorpusThreads', {
            userId: 'smart_merge_user',
            accountId: 'account_1',
            grantId: 'grant_1',
            provider: 'google',
            providerThreadId,
            subject: 'Your verification code is 123456',
            fromAddress: 'security@example.com',
            lastDate: ts,
            snippet: 'Use 123456 to sign in.',
            labels: ['inbox'],
            unread: true,
            latestMessageId: 'message_2',
            llmCategory: staleCategory,
            llmClassifiedMessageId: 'message_1',
            llmPending: true,
            yearMonth: '2026-07',
            createdAt: ts,
            updatedAt: ts,
          });
        }
      });

      const result = await t.mutation(api.mailCorpus.storeLlmVerdicts, {
        internalSecret: 'smart-verdict-merge-secret',
        userId: 'smart_merge_user',
        items: [
          {
            accountId: 'account_1',
            providerThreadId: 'with_verdict',
            messageId: 'message_2',
            verdict: { ...staleCategory, primary: 'updates' },
          },
          {
            accountId: 'account_1',
            providerThreadId: 'without_verdict',
            messageId: 'message_2',
          },
        ],
      });
      expect(result).toEqual({ stored: 1 });
      const rows = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
      const accepted = rows.find((row) => row.providerThreadId === 'with_verdict');
      const noVerdict = rows.find((row) => row.providerThreadId === 'without_verdict');
      expect(accepted).toMatchObject({
        smartPrimary: 'updates',
        llmClassifiedMessageId: 'message_2',
      });
      expect(accepted?.llmPending).toBeUndefined();
      expect(accepted?.llmCategory?.primary).toBe('updates');
      expect(noVerdict).toMatchObject({ llmClassifiedMessageId: 'message_2' });
      expect(noVerdict?.llmPending).toBeUndefined();
      expect(noVerdict?.llmCategory).toBeUndefined();
      expect(noVerdict?.smartPrimary).not.toBe('finance_admin');
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
