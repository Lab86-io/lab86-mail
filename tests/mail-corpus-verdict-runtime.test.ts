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
          from: 'sender@example.com',
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

      const pending = await t.mutation(api.mailCorpus.listLlmPending, {
        internalSecret: 'smart-pending-repair-secret',
        userId: 'smart_pending_user',
        limit: 10,
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        providerThreadId: 'thread_legacy',
        messageId: 'message_canonical',
        bodyText: 'This exact body belongs to the canonical message.',
      });
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
});
