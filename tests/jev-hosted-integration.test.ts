import { expect, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  getLatestDailyReport,
  saveDailyReport,
  setDailyReportReaderForTest,
} from '../lib/store/daily-reports';
import { listSmartCategory } from '../lib/tools/mail';
import { policy, report } from './fixtures/jev';

async function transport(run: (calls: any[]) => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://jev-tests.example';
  const calls: any[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text());
    const args = body.args[0];
    calls.push({ path: body.path, args });
    const value =
      body.path === 'mailCorpus:listSmartCategoryThreads'
        ? {
            items: args.cursor ? [] : [{ _id: 't', account: 'a' }],
            nextCursor: args.cursor ? undefined : 'continuation',
          }
        : body.path === 'jev:policy'
          ? { ...policy, preferences: { ...policy.preferences, enabled: false } }
          : null;
    return Response.json({ status: 'success', value });
  }) as typeof fetch;
  try {
    await run(calls);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = previousUrl;
  }
}

test('ready editions mark surfaced revisions only after their durable report write', async () => {
  await transport(async (calls) => {
    await runWithAiRequestContext({ userId: 'synthetic-jev-owner', agent: 'ai' }, async () => {
      await saveDailyReport({ ...report(), artifactStatus: 'rendered' });
    });
    const mark = calls.findIndex((c) => c.path === 'jev:markBriefItems');
    const save = calls.findIndex((c) => c.path === 'userData:upsertDoc');
    expect(save).toBeGreaterThanOrEqual(0);
    expect(mark).toBeGreaterThan(save);
    expect(calls[mark].args.userId).toBe('synthetic-jev-owner');
    expect(calls[mark].args.items).toHaveLength(1);
  });
});

test('attention-view tool carries scoped Jev cursors and never falls back to provider mail for an empty view', async () => {
  await transport(async (calls) => {
    const ctx = { userId: 'synthetic-jev-owner', agent: 'codex' as const };
    const first = await listSmartCategory.handler({ account: 'a', category: 'needs_action', max: 20 }, ctx);
    expect(first.items).toHaveLength(1);
    expect(first.nextPageToken).toBe('jev:continuation');
    const second = await listSmartCategory.handler(
      { account: 'a', category: 'needs_action', max: 20, pageToken: first.nextPageToken },
      ctx,
    );
    expect(second.items).toEqual([]);
    expect(second.nextPageToken).toBeUndefined();
    const reads = calls.filter((c) => c.path === 'mailCorpus:listSmartCategoryThreads');
    expect(reads[1].args).toMatchObject({
      userId: 'synthetic-jev-owner',
      accountId: 'a',
      category: 'needs_action',
      cursor: 'continuation',
    });
    await listSmartCategory.handler(
      { account: 'a', category: 'needs_action', max: 20, pageToken: 'jev:123456789' },
      ctx,
    );
    const numeric = calls.filter((c) => c.path === 'mailCorpus:listSmartCategoryThreads').at(-1);
    expect(numeric.args.cursor).toBe('123456789');
    expect(numeric.args.before).toBeUndefined();
  });
});

test('an unavailable current assessment leaves the saved edition readable', async () => {
  const saved = { ...report(), generatedAt: Date.now() };
  setDailyReportReaderForTest({
    configured: () => true,
    loadPolicy: async () => {
      throw new Error('unavailable');
    },
    query: (async () => ({ page: [saved], isDone: true, continueCursor: '' })) as any,
  });
  try {
    await runWithAiRequestContext({ userId: 'synthetic-jev-owner', agent: 'ai' }, async () => {
      expect((await getLatestDailyReport())?.sections.answer).toHaveLength(1);
    });
  } finally {
    setDailyReportReaderForTest();
  }
});
