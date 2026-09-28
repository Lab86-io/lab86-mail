import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest, type TestConvex } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  __resetPreparationClockForTest,
  CONTENT_MAIL_RESUME_MS,
  CONTENT_MAIL_WINDOW_MS,
  mailWatermark,
  PREPARE_IDLE_MS,
  runContentCycle,
} from '../lib/content/sync';

// IO-1 (K2): the content cycle reads only the mail threads that changed after
// its watermark, never the whole corpus.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  '../convex/content.ts': () => import('../convex/content'),
};
const SECRET = 'content-mail-changes-secret';
const USER = 'content_user';
const NOW = Date.UTC(2026, 8, 20, 9, 0, 0);
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

async function connect(t: TestConvex<typeof schema>, accountId: string, status: 'connected' | 'error') {
  await t.run((ctx) =>
    ctx.db.insert('connectedAccounts', {
      userId: USER,
      accountId,
      email: `${accountId}@example.test`,
      provider: 'google',
      grantId: `grant-${accountId}`,
      status,
      scopes: [],
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

async function ingest(t: TestConvex<typeof schema>, accountId: string, threadId: string, extra = {}) {
  await t.mutation(api.mailCorpus.upsertCorpusBatch, {
    internalSecret: SECRET,
    userId: USER,
    accountId,
    grantId: `grant-${accountId}`,
    provider: 'google',
    threads: [],
    messages: [
      {
        providerMessageId: `${threadId}-m`,
        providerThreadId: threadId,
        subject: `Subject ${threadId}`,
        from: 'sender@example.test',
        to: `${accountId}@example.test`,
        receivedAt: NOW,
        snippet: 'Snippet',
        textBody: `Full body of ${threadId}`,
        htmlBody: `<p>${threadId}</p>`,
        searchText: 'x',
        labels: ['INBOX'],
        attachments: [{ id: 'file-1', filename: 'plan.pdf', size: 10 }],
        ...extra,
      },
    ],
  });
}

const changes = (
  t: TestConvex<typeof schema>,
  after: { updatedAt: number; creationTime: number },
  limit?: number,
) =>
  t.query(api.content.mailChanges, {
    internalSecret: SECRET,
    userId: USER,
    after,
    sinceLastDate: NOW - CONTENT_MAIL_WINDOW_MS,
    limit,
  });

describe('the mail change feed', () => {
  test('reads each changed thread once, with its full body text, and skips dead, spam and old mail', async () => {
    const t = convexTest(schema, modules);
    await connect(t, 'live', 'connected');
    await connect(t, 'dead', 'error');
    await ingest(t, 'live', 't1');
    await ingest(t, 'dead', 'd1');
    await ingest(t, 'live', 'spam', { labels: ['SPAM'] });
    await ingest(t, 'live', 'old', { receivedAt: NOW - CONTENT_MAIL_WINDOW_MS - 1 });
    const page = await changes(t, { updatedAt: 0, creationTime: 0 });
    expect(page.items.map((item: any) => item.externalId)).toEqual(['t1']);
    expect(page.items[0]).toMatchObject({
      source: 'mail',
      connectionId: 'live',
      title: 'Subject t1',
      text: 'sender@example.test\nSubject t1\nFull body of t1',
      partial: false,
    });
    expect(page.attachments).toEqual([
      expect.objectContaining({ connectionId: 'live', messageId: 't1-m', attachmentId: 'file-1' }),
    ]);
    expect(page.more).toBe(false);
    // Nothing changed after the watermark: the next page is empty.
    const next = await changes(t, page.watermark);
    expect(next.items).toEqual([]);
    expect(next.watermark).toEqual(page.watermark);
  });

  test('a group of threads with the same change time is read across pages', async () => {
    const t = convexTest(schema, modules);
    await connect(t, 'live', 'connected');
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'live',
      grantId: 'grant-live',
      provider: 'google',
      threads: [],
      messages: ['a', 'b', 'c'].map((id) => ({
        providerMessageId: `${id}-m`,
        providerThreadId: id,
        subject: id,
        from: 'sender@example.test',
        to: 'live@example.test',
        receivedAt: NOW,
        snippet: 'Snippet',
        textBody: id,
        searchText: id,
        labels: ['INBOX'],
      })),
    });
    const seen: string[] = [];
    let after = { updatedAt: 0, creationTime: 0 };
    for (let pass = 0; pass < 5; pass++) {
      const page = await changes(t, after, 2);
      seen.push(...page.items.map((item: any) => item.externalId));
      after = page.watermark;
      if (!page.more) break;
    }
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  test('a changed thread comes back after the watermark', async () => {
    const t = convexTest(schema, modules);
    await connect(t, 'live', 'connected');
    await ingest(t, 'live', 't1');
    const first = await changes(t, { updatedAt: 0, creationTime: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await ingest(t, 'live', 't1', { unread: true });
    const second = await changes(t, first.watermark);
    expect(second.items.map((item: any) => item.externalId)).toEqual(['t1']);
  });
});

describe('the content cycle', () => {
  beforeEach(() => __resetPreparationClockForTest());

  test('the watermark starts at the mail window for a new user and near now for an indexed user', () => {
    expect(mailWatermark(undefined, NOW)).toEqual({
      updatedAt: NOW - CONTENT_MAIL_WINDOW_MS,
      creationTime: 0,
    });
    expect(mailWatermark({ page: 'old-walk-cursor' }, NOW)).toEqual({
      updatedAt: NOW - CONTENT_MAIL_RESUME_MS,
      creationTime: 0,
    });
    expect(mailWatermark({ mail: { updatedAt: 5, creationTime: 6 } }, NOW)).toEqual({
      updatedAt: 5,
      creationTime: 6,
    });
  });

  function cycleDeps(changed: number) {
    const writes: any[] = [];
    const queries: any[] = [];
    let preparations = 0;
    const deps: any = {
      convexMutation: async (ref: any, args: any) => {
        const name = getFunctionName(ref);
        writes.push({ name, ...args });
        if (name.endsWith(':claimSync')) return { lease: 'lease', cursor: { page: 'old' } };
        if (name.endsWith(':claimItems')) return [];
        if (name.endsWith(':upsert')) return { changed };
        return {};
      },
      convexQuery: async (ref: any, args: any) => {
        const name = getFunctionName(ref);
        queries.push({ name, ...args });
        if (name.endsWith(':workCandidates')) return [];
        if (name.endsWith(':mailChanges'))
          return {
            items: changed
              ? [{ source: 'mail', connectionId: 'a', externalId: 't', title: 'T', text: 'x' }]
              : [],
            attachments: [],
            watermark: { updatedAt: 9, creationTime: 10 },
            more: false,
          };
        return { items: [], attachments: [], cursor: null };
      },
      syncCloudContent: async () => {},
      syncMailAttachments: async () => {},
      syncMcpContent: async () => {},
      loadJevPolicy: async () => ({ preferences: { enabled: true } }),
      prepareBriefWork: async () => {
        preparations++;
      },
    };
    return { deps, writes, queries, preparations: () => preparations };
  }

  test('mail reads the change feed and saves the new watermark', async () => {
    const run = cycleDeps(1);
    await runContentCycle('owner', run.deps);
    const feed = run.queries.find((query) => query.name.endsWith(':mailChanges'));
    expect(feed.after.creationTime).toBe(0);
    expect(run.queries.some((query) => query.name.endsWith(':localPage') && query.source === 'mail')).toBe(
      false,
    );
    const finish = run.writes.find(
      (write) => write.name.endsWith(':finishSync') && write.connectionId === '__mail',
    );
    expect(finish).toMatchObject({ cursor: { mail: { updatedAt: 9, creationTime: 10 } }, status: 'ready' });
  });

  test('the preparation claim runs after a change, else at most once each idle period', async () => {
    const busy = cycleDeps(1);
    await runContentCycle('owner', busy.deps);
    await runContentCycle('owner', busy.deps);
    expect(busy.preparations()).toBe(2);
    __resetPreparationClockForTest();
    const idle = cycleDeps(0);
    await runContentCycle('owner', idle.deps);
    await runContentCycle('owner', idle.deps);
    expect(idle.preparations()).toBe(1);
    expect(PREPARE_IDLE_MS).toBe(30 * 60_000);
  });
});
