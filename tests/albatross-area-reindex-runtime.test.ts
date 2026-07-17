import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
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

  test('does not route a domain-shaped non-identity fact during reindex', async () => {
    const t = convexTest(schema, convexModules);
    const userId = 'fact_kind_user';
    const ts = Date.now();
    const runId = await t.run(async (ctx) => {
      const areaId = await ctx.db.insert('areas', {
        userId,
        name: 'Example project',
        kind: 'project',
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      });
      await ctx.db.insert('areaFacts', {
        userId,
        areaId,
        kind: 'note',
        value: 'example.com',
        status: 'verified',
        sourceRefs: [],
        confirmationRefs: [
          { kind: 'userConfirmation', id: 'confirmation_1', confirmedAt: ts, confirmedBy: userId },
        ],
        createdAt: ts,
        updatedAt: ts,
        verifiedAt: ts,
      });
      await ctx.db.insert('areaFacts', {
        userId,
        areaId,
        kind: 'domain',
        value: 'sender@example.com',
        status: 'verified',
        sourceRefs: [],
        confirmationRefs: [
          { kind: 'userConfirmation', id: 'confirmation_2', confirmedAt: ts, confirmedBy: userId },
        ],
        createdAt: ts,
        updatedAt: ts,
        verifiedAt: ts,
      });
      await ctx.db.insert('mailCorpusThreads', {
        userId,
        accountId: 'account_1',
        grantId: 'grant_1',
        provider: 'google',
        providerThreadId: 'note_domain_thread',
        subject: 'Unrelated message',
        fromAddress: 'sender@example.com',
        lastDate: ts,
        snippet: 'A note value must not become a sender rule.',
        labels: ['inbox'],
        unread: false,
        yearMonth: '2026-07',
        createdAt: ts,
        updatedAt: ts,
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
        createdAt: ts,
        updatedAt: ts,
      });
    });

    const result = await t.mutation(internal.albatross.reindexUserAreaArtifacts, { userId, runId });
    expect(result).toMatchObject({ scanned: 1, inserted: 0, matched: 0, skipped: 1, done: true });
    expect(await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect())).toEqual([]);
  });

  test('reopens both classifiers when the canonical latest message advances during an Area verdict', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'area-verdict-race-secret';
    try {
      const t = convexTest(schema, convexModules);
      const userId = 'area_verdict_race_user';
      const ts = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert('mailCorpusThreads', {
          userId,
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerThreadId: 'thread_1',
          subject: 'Older aggregate',
          fromAddress: 'sender@example.com',
          lastDate: ts,
          snippet: 'Older message',
          labels: ['inbox'],
          unread: true,
          latestMessageId: 'message_1',
          llmCategory: { primary: 'updates' },
          llmClassifiedAt: ts,
          llmClassifiedMessageId: 'message_1',
          areaClassifierVersion: 1,
          areaClassifiedAt: ts,
          yearMonth: '2026-07',
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mailCorpusMessages', {
          userId,
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google',
          providerMessageId: 'message_2',
          providerThreadId: 'thread_1',
          subject: 'New canonical message',
          from: 'sender@example.com',
          to: 'user@example.com',
          receivedAt: ts + 1,
          snippet: 'Newer message',
          textBody: 'The message that arrived while classification was in flight.',
          searchText: 'new canonical message',
          labels: ['inbox'],
          yearMonth: '2026-07',
          createdAt: ts + 1,
          updatedAt: ts + 1,
        });
      });

      const result = await t.mutation(api.albatross.recordAreaVerdicts, {
        internalSecret: 'area-verdict-race-secret',
        userId,
        classifierVersion: 1,
        verdicts: [{ artifactId: 'thread_1', accountId: 'account_1', messageId: 'message_1', links: [] }],
      });
      expect(result).toMatchObject({ classified: 0, skipped: 1 });
      const thread = await t.run((ctx) => ctx.db.query('mailCorpusThreads').first());
      expect(thread).toMatchObject({
        latestMessageId: 'message_2',
        llmPending: true,
        areaRoutingPending: true,
      });
      expect(thread?.llmCategory).toBeUndefined();
      expect(thread?.llmClassifiedAt).toBeUndefined();
      expect(thread?.llmClassifiedMessageId).toBeUndefined();
      expect(thread?.areaClassifierVersion).toBeUndefined();
      expect(thread?.areaClassifiedAt).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('repairs stale classifier attribution even when the thread watermark already advanced', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'area-attribution-race-secret';
    try {
      const t = convexTest(schema, convexModules);
      const userId = 'area_attribution_race_user';
      const ts = Date.now();
      await t.run(async (ctx) => {
        const base = {
          userId,
          accountId: 'account_1',
          grantId: 'grant_1',
          provider: 'google' as const,
          subject: 'Already advanced',
          fromAddress: 'sender@example.com',
          lastDate: ts,
          snippet: 'The aggregate already points at message two.',
          labels: ['inbox'],
          unread: true,
          latestMessageId: 'message_2',
          yearMonth: '2026-07',
          createdAt: ts,
          updatedAt: ts,
        };
        await ctx.db.insert('mailCorpusThreads', {
          ...base,
          providerThreadId: 'stale_thread',
          llmCategory: { primary: 'updates' },
          llmClassifiedAt: ts,
          llmClassifiedMessageId: 'message_1',
          areaClassifierVersion: 1,
          areaClassifiedAt: ts,
          areaClassifiedMessageId: 'message_1',
        });
        await ctx.db.insert('mailCorpusThreads', {
          ...base,
          providerThreadId: 'current_thread',
          llmCategory: { primary: 'updates' },
          llmClassifiedAt: ts,
          llmClassifiedMessageId: 'message_2',
          areaClassifierVersion: 1,
          areaClassifiedAt: ts,
          areaClassifiedMessageId: 'message_2',
        });
      });

      const result = await t.mutation(api.albatross.recordAreaVerdicts, {
        internalSecret: 'area-attribution-race-secret',
        userId,
        classifierVersion: 1,
        verdicts: [
          { artifactId: 'stale_thread', accountId: 'account_1', messageId: 'message_1', links: [] },
          { artifactId: 'current_thread', accountId: 'account_1', messageId: 'message_1', links: [] },
        ],
      });
      expect(result).toMatchObject({ classified: 0, skipped: 2 });
      const threads = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
      const stale = threads.find((row) => row.providerThreadId === 'stale_thread');
      const current = threads.find((row) => row.providerThreadId === 'current_thread');
      expect(stale).toMatchObject({ llmPending: true, areaRoutingPending: true });
      expect(stale?.llmCategory).toBeUndefined();
      expect(stale?.llmClassifiedMessageId).toBeUndefined();
      expect(stale?.areaClassifierVersion).toBeUndefined();
      expect(stale?.areaClassifiedMessageId).toBeUndefined();
      expect(current).toMatchObject({
        llmClassifiedMessageId: 'message_2',
        areaClassifierVersion: 1,
        areaClassifiedMessageId: 'message_2',
      });
      expect(current?.llmPending).toBeUndefined();
      expect(current?.areaRoutingPending).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
