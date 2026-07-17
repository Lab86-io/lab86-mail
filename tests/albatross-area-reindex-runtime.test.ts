import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
};

describe('Area reindex runtime traversal', () => {
  test('scans mail older than the former recent-only window', async () => {
    const t = convexTest(schema, convexModules);
    const userId = 'full_history_user';
    const oldDate = Date.UTC(2000, 0, 1);
    const runId = await t.run(async (ctx) => {
      await ctx.db.insert('mailCorpusThreads', {
        userId,
        accountId: 'account_1',
        grantId: 'grant_1',
        provider: 'google',
        providerThreadId: 'old_thread',
        subject: 'Historical mail',
        fromAddress: 'sender@example.com',
        lastDate: oldDate,
        snippet: 'This must remain eligible for full-history traversal.',
        labels: ['inbox'],
        unread: false,
        yearMonth: '2000-01',
        createdAt: oldDate,
        updatedAt: oldDate,
      });
      return ctx.db.insert('areaReindexRuns', {
        userId,
        status: 'queued',
        scanned: 0,
        inserted: 0,
        matched: 0,
        retired: 0,
        skipped: 0,
        pages: 0,
        createdAt: oldDate,
        updatedAt: oldDate,
      });
    });

    const result = await t.mutation(internal.albatross.reindexUserAreaArtifacts, { userId, runId });
    expect(result).toMatchObject({ scanned: 1, skipped: 1, done: true });

    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run).toMatchObject({ status: 'done', scanned: 1, skipped: 1, pages: 1 });
  });
});
