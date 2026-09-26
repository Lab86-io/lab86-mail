import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
};

describe('Smart Category verdict freshness', () => {
  test('completed backfills classify changed threads without scheduling a full-mailbox Area reindex', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'backfill-routing-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      await t.mutation(api.mailCorpus.upsertCorpusBatch, {
        internalSecret: 'backfill-routing-secret',
        userId: 'backfill_routing_user',
        accountId: 'account_1',
        grantId: 'grant_1',
        provider: 'google',
        threads: [],
        messages: [
          {
            providerMessageId: 'message_1',
            providerThreadId: 'thread_1',
            subject: 'New historical message',
            from: 'sender@example.com',
            to: 'user@example.com',
            receivedAt: ts,
            snippet: 'Classify only this changed thread.',
            textBody: 'The full body used by the lightweight classifiers.',
            searchText: 'new historical message classify changed thread',
            labels: ['inbox'],
          },
        ],
        corpusReady: true,
      });

      const thread = await t.run((ctx) => ctx.db.query('mailCorpusThreads').first());
      const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
      expect(thread).toMatchObject({
        providerThreadId: 'thread_1',
        latestMessageId: 'message_1',
        llmPending: true,
        areaRoutingPending: true,
      });
      expect(scheduled).toHaveLength(0);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
