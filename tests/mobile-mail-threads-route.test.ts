import { describe, expect, test } from 'bun:test';
import { createMobileMailThreadGet } from '../app/api/mobile/v1/mail/threads/[threadID]/route';
import { createMobileMailThreadsGet } from '../app/api/mobile/v1/mail/threads/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { MailSendCommandSchema, MobileCommandSchema } from '../lib/mobile/v1/contract';
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

function detailRequest(threadID: string, query = '') {
  return new Request(`https://mail.lab86.io/api/mobile/v1/mail/threads/${threadID}${query}`);
}

function detailContext(threadID: string) {
  return { params: Promise.resolve({ threadID }) };
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

describe('GET /api/mobile/v1/mail/threads/{threadID}', () => {
  const toolThread = {
    subject: 'Quarterly invoice',
    summary: 'Vendor sent the Q3 invoice.',
    messages: [
      {
        _id: 'message-1',
        from: 'Billing <billing@vendor.com>',
        to: 'you@lab86.io',
        cc: '',
        bcc: '',
        date: 1_755_000_000_000,
        snippet: 'Your invoice is attached.',
        textBody: 'Invoice attached.',
        htmlBody: '<p>Invoice attached.</p>',
        labels: ['INBOX'],
        unread: true,
        starred: false,
        attachments: [
          { id: 'att-1', filename: 'invoice.pdf', contentType: 'application/pdf', size: 1024 },
          { filename: 'no-id-dropped.bin' },
        ],
      },
    ],
  };

  test('returns the typed thread detail with normalized attachments', async () => {
    const calls: any[] = [];
    const handler = createMobileMailThreadGet({
      requireCurrentUser: async () => user,
      readThread: async (args) => {
        calls.push(args);
        return toolThread;
      },
    });

    const response = await handler(
      detailRequest('thread-1', '?accountID=account-1'),
      detailContext('thread-1'),
    );
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(calls).toEqual([{ account: 'account-1', threadId: 'thread-1' }]);
    expect(body.threadID).toBe('thread-1');
    expect(body.accountID).toBe('account-1');
    expect(body.summary).toBe('Vendor sent the Q3 invoice.');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      id: 'message-1',
      fromEmail: 'billing@vendor.com',
      bodyHTML: '<p>Invoice attached.</p>',
      attachments: [{ id: 'att-1', name: 'invoice.pdf', contentType: 'application/pdf', size: 1024 }],
    });
  });

  test('requires accountID', async () => {
    const handler = createMobileMailThreadGet({
      requireCurrentUser: async () => user,
      readThread: async () => toolThread,
    });

    const response = await handler(detailRequest('thread-1'), detailContext('thread-1'));
    expect(response.status).toBe(400);
  });

  test('surfaces a tool failure as a retryable server error envelope', async () => {
    const handler = createMobileMailThreadGet({
      requireCurrentUser: async () => user,
      readThread: async () => {
        throw new Error('provider unavailable');
      },
    });

    const response = await handler(
      detailRequest('thread-1', '?accountID=account-1'),
      detailContext('thread-1'),
    );
    expect(response.status).toBe(500);
    const body: any = await response.json();
    expect(body.error.retryable).toBe(true);
  });
});

describe('mail.send payload validation', () => {
  const base = { idempotencyKey: 'send-1', kind: 'mail.send', clientCreatedAt: '2026-08-19T09:00:00.000Z' };

  test('a new send requires recipients and a subject', () => {
    expect(() =>
      MailSendCommandSchema.parse({
        ...base,
        payload: { accountID: 'account-1', mode: 'new', bodyText: 'hi' },
      }),
    ).toThrow();
    expect(() =>
      MailSendCommandSchema.parse({
        ...base,
        payload: { accountID: 'account-1', mode: 'new', to: 'sam@example.com', bodyText: 'hi' },
      }),
    ).toThrow(/subject/);
  });

  test('reply modes require the anchor message', () => {
    expect(() =>
      MailSendCommandSchema.parse({
        ...base,
        payload: { accountID: 'account-1', mode: 'reply', bodyText: 'hi' },
      }),
    ).toThrow(/messageID/);
  });

  test('a complete send parses through the discriminated command union', () => {
    const parsed = MobileCommandSchema.parse({
      ...base,
      payload: {
        accountID: 'account-1',
        mode: 'new',
        to: 'sam@example.com',
        subject: 'Hello',
        bodyText: 'Body',
      },
    });
    expect(parsed.kind).toBe('mail.send');
  });
});
