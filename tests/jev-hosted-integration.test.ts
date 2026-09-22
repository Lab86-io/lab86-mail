import { expect, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  getLatestDailyReport,
  saveDailyReport,
  setDailyReportReaderForTest,
} from '../lib/store/daily-reports';
import { listSmartCategory } from '../lib/tools/mail';
import { policy, report } from './fixtures/jev';

async function transport(
  run: (calls: any[]) => Promise<void>,
  options: { failure?: string; empty?: boolean; sync?: any } = {},
) {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const previousNylas = [process.env.NYLAS_API_KEY, process.env.NYLAS_CLIENT_ID];
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://jev-tests.example';
  process.env.NYLAS_API_KEY = 'synthetic-key';
  process.env.NYLAS_CLIENT_ID = 'synthetic-client';
  const calls: any[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v3/')) {
      calls.push({ path: 'provider', args: { pageToken: url.searchParams.get('page_token') } });
      return Response.json({
        request_id: 'synthetic-request',
        data: Array.from({ length: Number(url.searchParams.get('limit') || 60) }, (_, index) => ({
          id: `provider-thread-${index}`,
          subject: 'Personal conversation',
          participants: [{ email: 'friend@example.test' }],
          folders: ['INBOX'],
        })),
        next_cursor: 'provider-next',
      });
    }
    const body = JSON.parse(await request.text());
    const args = body.args[0];
    calls.push({ path: body.path, args });
    if (body.path === options.failure) {
      return Response.json({ status: 'error', errorMessage: 'corpus unavailable' });
    }
    const value =
      body.path === 'mailCorpus:listSmartCategoryThreads'
        ? {
            items: options.empty || args.cursor ? [] : [{ _id: 't', account: 'a' }],
            nextCursor: options.empty || args.cursor ? undefined : 'continuation',
          }
        : body.path === 'jev:policy'
          ? { ...policy, preferences: { ...policy.preferences, enabled: false } }
          : body.path === 'mailCorpus:getSyncState'
            ? (options.sync ?? null)
            : body.path === 'accounts:getConnectedAccount'
              ? {
                  userId: 'synthetic-jev-owner',
                  accountId: 'a',
                  grantId: 'synthetic-grant',
                  email: 'owner@example.test',
                  provider: 'google',
                  status: 'connected',
                }
              : body.path === 'mailCorpus:claimCorpusBackfill'
                ? { claimed: false }
                : body.path === 'userData:listDocs'
                  ? []
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
    for (const [index, key] of ['NYLAS_API_KEY', 'NYLAS_CLIENT_ID'].entries()) {
      if (previousNylas[index] === undefined) delete process.env[key];
      else process.env[key] = previousNylas[index];
    }
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

test('category corpus failures stay retryable and never reach provider mail', async () => {
  await transport(
    async (calls) => {
      for (const category of ['needs_action', 'main'] as const) {
        for (const pageToken of [undefined, 'jev:continuation']) {
          await expect(
            listSmartCategory.handler(
              { account: 'a', category, max: 20, pageToken },
              { userId: 'synthetic-jev-owner', agent: 'codex' },
            ),
          ).rejects.toThrow('corpus unavailable');
        }
      }
      expect(calls.some((c) => c.path === 'accounts:getConnectedAccount' || c.path === 'provider')).toBe(
        false,
      );
    },
    { failure: 'mailCorpus:listSmartCategoryThreads' },
  );
});

test('an unavailable sync-state read cannot authorize provider fallback', async () => {
  await transport(
    async (calls) => {
      await expect(
        listSmartCategory.handler(
          { account: 'a', category: 'main', max: 20 },
          { userId: 'synthetic-jev-owner', agent: 'codex' },
        ),
      ).rejects.toThrow('corpus unavailable');
      expect(calls.some((c) => c.path === 'accounts:getConnectedAccount')).toBe(false);
    },
    { empty: true, failure: 'mailCorpus:getSyncState' },
  );
});

test('attention views reject provider tokens instead of changing search tiers', async () => {
  await transport(async (calls) => {
    await expect(
      listSmartCategory.handler(
        { account: 'a', category: 'needs_action', max: 20, pageToken: 'provider-page' },
        { userId: 'synthetic-jev-owner', agent: 'codex' },
      ),
    ).rejects.toThrow('Invalid attention-view cursor');
    expect(calls).toEqual([]);
  });
});

test('category reads require an authenticated, configured corpus', async () => {
  await transport(async (calls) => {
    const args = { account: 'a', category: 'needs_action' as const, max: 20 };
    await expect(listSmartCategory.handler(args, { userId: null, agent: 'codex' })).rejects.toThrow(
      'Sign in required',
    );
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    const serverUrl = process.env.CONVEX_URL;
    delete process.env.NEXT_PUBLIC_CONVEX_URL;
    delete process.env.CONVEX_URL;
    try {
      await expect(
        listSmartCategory.handler(args, { userId: 'synthetic-jev-owner', agent: 'codex' }),
      ).rejects.toThrow('Mail index is not available');
    } finally {
      process.env.NEXT_PUBLIC_CONVEX_URL = url;
      if (serverUrl !== undefined) process.env.CONVEX_URL = serverUrl;
    }
    expect(calls).toEqual([]);
  });
});

test('provider pagination returns to the corpus once an account has synced rows', async () => {
  await transport(
    async (calls) => {
      const result = await listSmartCategory.handler(
        { account: 'a', category: 'main', max: 20, pageToken: 'provider-page' },
        { userId: 'synthetic-jev-owner', agent: 'codex' },
      );
      expect(result.items).toEqual([]);
      expect(calls.some((c) => c.path === 'accounts:getConnectedAccount')).toBe(false);
    },
    { empty: true, sync: { messagesSynced: 1, corpusReady: false } },
  );
});

test('new-account fallback preserves provider tokens but never forwards corpus cursors', async () => {
  await transport(
    async (calls) => {
      await runWithAiRequestContext({ userId: 'synthetic-jev-owner', agent: 'ai' }, async () => {
        const ctx = { userId: 'synthetic-jev-owner', agent: 'codex' as const };
        for (const pageToken of ['jev:continuation', 'local:123']) {
          const page = await listSmartCategory.handler(
            { account: 'a', category: 'main', max: 20, pageToken },
            ctx,
          );
          expect(page.items).toEqual([]);
        }
        expect(calls.some((c) => c.path === 'provider')).toBe(false);
        for (const pageToken of [undefined, 'provider-page']) {
          const page = await listSmartCategory.handler(
            { account: 'a', category: 'main', max: 20, pageToken },
            ctx,
          );
          expect(page.nextPageToken).toBe('provider-next');
        }
        expect(calls.filter((c) => c.path === 'provider').map((c) => c.args.pageToken)).toEqual([
          null,
          'provider-page',
        ]);
      });
    },
    { empty: true },
  );
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
