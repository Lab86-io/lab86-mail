import { describe, expect, test } from 'bun:test';
import { createMobileMailThreadsGet } from '../app/api/mobile/v1/mail/threads/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { mailThreadSummaryFromCorpus } from '../lib/mobile/v1/mail-reads';

const user = {
  userId: 'user_mail_reads',
  email: 'owner@example.com',
  name: 'Owner',
  source: 'clerk' as const,
};

const corpusItem = {
  _id: 'thread-1',
  account: 'account-1',
  subject: 'Quarterly invoice',
  fromAddress: 'Billing <billing@vendor.com>',
  lastDate: 1_755_000_000_000,
  snippet: 'Your invoice is attached.',
  labels: ['INBOX', 'UNREAD'],
  unread: true,
  starred: false,
  messageCount: 3,
  smartCategory: { primary: 'finance', confidence: 0.9 },
};

function listRequest(query = '') {
  return new Request(`https://mail.lab86.io/api/mobile/v1/mail/threads${query}`);
}

describe('mailThreadSummaryFromCorpus', () => {
  test('maps a corpus row into the strict summary shape', () => {
    expect(mailThreadSummaryFromCorpus(corpusItem)).toEqual({
      id: 'thread-1',
      accountID: 'account-1',
      subject: 'Quarterly invoice',
      fromHeader: 'Billing <billing@vendor.com>',
      senderEmail: 'billing@vendor.com',
      snippet: 'Your invoice is attached.',
      lastMessageAt: 1_755_000_000_000,
      unread: true,
      starred: false,
      labels: ['INBOX', 'UNREAD'],
      messageCount: 3,
      smartCategory: 'finance',
    });
  });

  test('defends against sparse rows instead of leaking undefined', () => {
    const mapped = mailThreadSummaryFromCorpus({ _id: 'thread-2', account: 'account-1' });
    expect(mapped.subject).toBe('(no subject)');
    expect(mapped.senderEmail).toBeUndefined();
    expect(mapped.lastMessageAt).toBe(0);
    expect(mapped.labels).toEqual([]);
    expect(mapped.smartCategory).toBeUndefined();
  });
});

describe('GET /api/mobile/v1/mail/threads', () => {
  test('pages the recent corpus and exposes a numeric cursor', async () => {
    const calls: any[] = [];
    const handler = createMobileMailThreadsGet({
      requireCurrentUser: async () => user,
      pageRecent: async (args) => {
        calls.push(args);
        return { items: [corpusItem], nextBefore: 1_754_000_000_000 };
      },
      pageCategory: async () => {
        throw new Error('category path must not run without a category');
      },
    });

    const response = await handler(listRequest('?accountID=account-1&limit=25'));
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(calls).toEqual([{ userId: user.userId, accountId: 'account-1', limit: 25, before: undefined }]);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('thread-1');
    expect(body.nextCursor).toBe('1754000000000');
    expect(body.hasMore).toBe(true);
    expect(typeof body.serverTime).toBe('string');
  });

  test('routes a category listing through the smart-category query with the cursor', async () => {
    const calls: any[] = [];
    const handler = createMobileMailThreadsGet({
      requireCurrentUser: async () => user,
      pageRecent: async () => {
        throw new Error('recent path must not run with a category');
      },
      pageCategory: async (args) => {
        calls.push(args);
        return { items: [], nextBefore: undefined };
      },
    });

    const response = await handler(listRequest('?category=finance&cursor=1754000000000'));
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(calls).toEqual([
      {
        userId: user.userId,
        accountId: undefined,
        category: 'finance',
        limit: 50,
        before: 1_754_000_000_000,
      },
    ]);
    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeUndefined();
  });

  test('treats a null page watermark as the last page', async () => {
    const handler = createMobileMailThreadsGet({
      requireCurrentUser: async () => user,
      pageRecent: async () => ({ items: [corpusItem], nextBefore: null }),
      pageCategory: async () => ({ items: [] }),
    });

    const response = await handler(listRequest(''));
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeUndefined();
  });

  test('never hands out a zero or negative watermark as a cursor', async () => {
    const handler = createMobileMailThreadsGet({
      requireCurrentUser: async () => user,
      pageRecent: async () => ({ items: [corpusItem], nextBefore: 0 }),
      pageCategory: async () => ({ items: [] }),
    });

    const body: any = await (await handler(listRequest(''))).json();
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeUndefined();
  });

  test('rejects a malformed cursor as invalid input, not a server error', async () => {
    const handler = createMobileMailThreadsGet({
      requireCurrentUser: async () => user,
      pageRecent: async () => ({ items: [] }),
      pageCategory: async () => ({ items: [] }),
    });

    const response = await handler(listRequest('?cursor=not-a-number'));
    expect(response.status).toBe(400);
    const body: any = await response.json();
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  test('clamps the limit into the 1..100 contract range', async () => {
    const limits: number[] = [];
    const handler = createMobileMailThreadsGet({
      requireCurrentUser: async () => user,
      pageRecent: async (args) => {
        limits.push(args.limit);
        return { items: [] };
      },
      pageCategory: async () => ({ items: [] }),
    });

    await handler(listRequest('?limit=1000'));
    await handler(listRequest('?limit=0'));
    await handler(listRequest('?limit=abc'));
    expect(limits).toEqual([100, 1, 50]);
  });

  test('maps auth failure onto the shared 401 envelope', async () => {
    const handler = createMobileMailThreadsGet({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in.');
      },
      pageRecent: async () => ({ items: [] }),
      pageCategory: async () => ({ items: [] }),
    });

    const response = await handler(listRequest());
    expect(response.status).toBe(401);
  });
});
