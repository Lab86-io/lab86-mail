import { describe, expect, test } from 'bun:test';
import {
  buildNylasStructuredSearchQueryParams,
  createNylasFolder,
  deleteNylasAccount,
  downloadNylasAttachment,
  getNylasAccount,
  getNylasMessage,
  getNylasScheduledSendStatus,
  getNylasThread,
  listNylasAccounts,
  listNylasLabels,
  listNylasScheduledMessages,
  type NylasAccountRow,
  requireConnectedAccount,
  resolveConnectedAccount,
  searchNylasThreads,
  sendNylasMessage,
  stopNylasScheduledMessage,
  updateNylasMessage,
  updateNylasMessageFolders,
  updateNylasThread,
  updateNylasThreadFoldersWithRetry,
} from '../lib/nylas/provider';

// ---------------------------------------------------------------------------
// Test harness: both the Nylas SDK and the Convex HTTP client speak plain HTTP
// through the global fetch, so a URL-routing fetch stub covers every seam.
// Convex requests land on /api/query and /api/mutation with a {path, args}
// JSON body; everything else is Nylas (/v3/grants/...).
// ---------------------------------------------------------------------------

interface NylasCall {
  method: string;
  url: URL;
  body?: any;
}

interface ConvexCall {
  endpoint: 'query' | 'mutation';
  path: string;
  args: Record<string, any>;
}

interface NylasHandlerResult {
  status?: number;
  json?: unknown;
  text?: string;
}

interface Harness {
  convexCalls: ConvexCall[];
  nylasCalls: NylasCall[];
  onConvex: (path: string, handler: (args: Record<string, any>) => unknown) => void;
  onNylas: (method: string, pathPattern: RegExp, handler: (call: NylasCall) => NylasHandlerResult) => void;
}

const ENV_KEYS = [
  'NYLAS_API_KEY',
  'NYLAS_CLIENT_ID',
  'NEXT_PUBLIC_CONVEX_URL',
  'LAB86_DISABLE_OUTBOUND_SEND',
];

async function withHarness(
  fn: (harness: Harness) => Promise<void>,
  envOverrides: Record<string, string | undefined> = {},
) {
  const originalFetch = globalThis.fetch;
  const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NYLAS_API_KEY = process.env.NYLAS_API_KEY || 'test-nylas-key';
  process.env.NYLAS_CLIENT_ID = process.env.NYLAS_CLIENT_ID || 'test-nylas-client';
  if (!process.env.NEXT_PUBLIC_CONVEX_URL && !process.env.CONVEX_URL) {
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://convex.lab86-tests.example';
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const convexCalls: ConvexCall[] = [];
  const nylasCalls: NylasCall[] = [];
  const convexHandlers = new Map<string, (args: Record<string, any>) => unknown>();
  const nylasHandlers: Array<{
    method: string;
    pattern: RegExp;
    handler: (call: NylasCall) => NylasHandlerResult;
  }> = [];

  const harness: Harness = {
    convexCalls,
    nylasCalls,
    onConvex: (path, handler) => convexHandlers.set(path, handler),
    onNylas: (method, pattern, handler) => nylasHandlers.push({ method, pattern, handler }),
  };

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/query' || url.pathname === '/api/mutation') {
      const { path, args } = JSON.parse(await request.text());
      const callArgs = { ...((args?.[0] as Record<string, any>) || {}) };
      delete callArgs.internalSecret;
      convexCalls.push({
        endpoint: url.pathname === '/api/query' ? 'query' : 'mutation',
        path,
        args: callArgs,
      });
      const handler = convexHandlers.get(path);
      if (!handler) {
        return Response.json({ status: 'error', errorMessage: `no convex handler for ${path}` });
      }
      try {
        const value = await handler(callArgs);
        return Response.json({ status: 'success', value: value ?? null });
      } catch (err: any) {
        return Response.json({ status: 'error', errorMessage: err?.message || 'handler failed' });
      }
    }
    const bodyText = await request.text();
    const call: NylasCall = {
      method: request.method,
      url,
      body: bodyText ? JSON.parse(bodyText) : undefined,
    };
    nylasCalls.push(call);
    const route = nylasHandlers.find(
      (entry) => entry.method === request.method && entry.pattern.test(url.pathname),
    );
    if (!route) {
      return new Response(
        JSON.stringify({
          error: { type: 'not_found', message: `no handler ${request.method} ${url.pathname}` },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    const result = route.handler(call);
    if (result.text !== undefined) return new Response(result.text, { status: result.status ?? 200 });
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  globalThis.fetch = stub as typeof fetch;
  try {
    await fn(harness);
    // Let fire-and-forget work (corpus backfill kicks) drain against the stub
    // instead of leaking onto the restored real fetch.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function account(overrides: Partial<NylasAccountRow> = {}): NylasAccountRow {
  return {
    userId: 'user_1',
    accountId: 'acct_1',
    email: 'ann@example.com',
    provider: 'google',
    status: 'connected',
    displayName: 'Ann',
    grantId: 'grant_1',
    scopes: ['email'],
    ...overrides,
  };
}

function corpusMessage(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct_1',
    provider: 'google',
    providerMessageId: 'msg_a',
    providerThreadId: 'thread_a',
    subject: 'Budget review',
    from: 'Bob <bob@x.com>',
    to: 'ann@example.com',
    receivedAt: 1_700_000_100_000,
    snippet: 'numbers attached',
    searchText: 'budget review numbers attached',
    labels: ['INBOX'],
    unread: true,
    ...overrides,
  };
}

describe('nylas provider accounts', () => {
  test('listNylasAccounts returns [] without a user and normalizes connected rows', async () => {
    await withHarness(async (h) => {
      expect(await listNylasAccounts(undefined)).toEqual([]);
      expect(h.convexCalls).toHaveLength(0);

      h.onConvex('accounts:listConnectedAccounts', () => [
        account(),
        account({ accountId: 'acct_2', email: 'old@example.com', status: 'disconnected' }),
      ]);
      const accounts = await listNylasAccounts('user_1');
      expect(accounts).toEqual([
        {
          accountId: 'acct_1',
          email: 'ann@example.com',
          provider: 'google',
          authed: true,
          primary: false,
          displayName: 'Ann',
          services: ['nylas', 'google'],
        },
      ]);
      expect(h.convexCalls[0]).toMatchObject({
        endpoint: 'query',
        path: 'accounts:listConnectedAccounts',
        args: { userId: 'user_1' },
      });
    });
  });

  test('getNylasAccount resolves exact ids, hides disconnected rows, and falls back to email', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', (args) =>
        args.accountId === 'acct_1'
          ? account()
          : args.accountId === 'acct_gone'
            ? account({ accountId: 'acct_gone', status: 'disconnected' })
            : null,
      );
      h.onConvex('accounts:listConnectedAccounts', () => [account()]);

      expect(await getNylasAccount('user_1', 'acct_1')).toMatchObject({ accountId: 'acct_1' });
      expect(await getNylasAccount('user_1', 'acct_gone')).toBeNull();
      // Loose reference: case-insensitive email resolves through the fallback.
      expect(await getNylasAccount('user_1', 'ANN@EXAMPLE.COM')).toMatchObject({ grantId: 'grant_1' });
      await expect(getNylasAccount(null, 'acct_1')).rejects.toThrow('Sign in required');
    });
  });

  test('resolveConnectedAccount matches by grant id and rejects empty refs', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:listConnectedAccounts', () => [account()]);
      expect(await resolveConnectedAccount('user_1', '  ')).toBeNull();
      expect(await resolveConnectedAccount('user_1', 'grant_1')).toMatchObject({ accountId: 'acct_1' });
      expect(await resolveConnectedAccount('user_1', 'nope@example.com')).toBeNull();
    });
  });

  test('requireConnectedAccount gives actionable errors for every miss shape', async () => {
    await withHarness(async (h) => {
      let rows: NylasAccountRow[] = [account()];
      h.onConvex('accounts:listConnectedAccounts', () => rows);

      expect(await requireConnectedAccount('user_1', 'Ann@Example.com')).toMatchObject({
        accountId: 'acct_1',
      });

      rows = [account({ status: 'disconnected' })];
      await expect(requireConnectedAccount('user_1', 'acct_1')).rejects.toThrow(
        'ann@example.com is disconnected',
      );

      rows = [account()];
      await expect(requireConnectedAccount('user_1', 'stranger@example.com')).rejects.toThrow(
        'Connected accounts: ann@example.com',
      );

      rows = [];
      await expect(requireConnectedAccount('user_1', 'acct_1')).rejects.toThrow(
        'No connected accounts. Connect one in Settings first.',
      );
    });
  });
});

describe('searchNylasThreads', () => {
  test('serves browse queries from the local corpus and groups messages into threads', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('mailCorpus:getSyncState', () => ({ grantId: 'grant_1', corpusReady: true }));
      h.onConvex('mailCorpus:searchCorpusMessages', () => [
        corpusMessage(),
        corpusMessage({
          providerMessageId: 'msg_b',
          providerThreadId: 'thread_a',
          receivedAt: 1_700_000_200_000,
          subject: 'Re: Budget review',
          unread: false,
        }),
        corpusMessage({
          providerMessageId: 'msg_c',
          providerThreadId: 'thread_b',
          receivedAt: 1_699_000_000_000,
          subject: 'Older note',
          unread: false,
        }),
      ]);

      const result = await searchNylasThreads({
        userId: 'user_1',
        account: 'acct_1',
        query: 'in:inbox',
        max: 5,
      });

      expect(result?.searchTier).toBe('local');
      expect(result?.route.tier).toBe('local');
      expect(result?.items.map((item: any) => item._id)).toEqual(['thread_a', 'thread_b']);
      expect(result?.items[0]).toMatchObject({
        subject: 'Re: Budget review',
        unread: true,
        lastDate: 1_700_000_200_000,
      });
      expect(result?.nextPageToken).toBeUndefined();

      const corpusCall = h.convexCalls.find((call) => call.path === 'mailCorpus:searchCorpusMessages');
      expect(corpusCall?.args).toMatchObject({
        userId: 'user_1',
        accountId: 'acct_1',
        provider: 'google',
        query: '',
        limit: 20,
      });
    });
  });

  test('pages browse results with local: cursors and honors them on the next call', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      // Partial corpus + browse query still routes local.
      h.onConvex('mailCorpus:getSyncState', () => ({
        grantId: 'grant_1',
        corpusReady: false,
        oldestIndexedAt: 1_600_000_000_000,
      }));
      h.onConvex('mailCorpus:claimCorpusBackfill', () => ({ claimed: false }));
      h.onConvex('mailCorpus:searchCorpusMessages', () => [
        corpusMessage({ receivedAt: 1_700_000_300_000 }),
        corpusMessage({
          providerMessageId: 'msg_c',
          providerThreadId: 'thread_b',
          receivedAt: 1_699_000_000_000,
        }),
      ]);

      const first = await searchNylasThreads({
        userId: 'user_1',
        account: 'acct_1',
        query: 'in:inbox',
        max: 1,
      });
      expect(first?.route.reason).toBe('partial corpus serves browse views while backfill runs');
      expect(first?.items).toHaveLength(1);
      expect(first?.nextPageToken).toBe(`local:${1_700_000_300_000 - 1}`);

      await searchNylasThreads({
        userId: 'user_1',
        account: 'acct_1',
        query: 'in:inbox',
        max: 1,
        pageToken: first?.nextPageToken,
      });
      const lastCorpusCall = h.convexCalls
        .filter((call) => call.path === 'mailCorpus:searchCorpusMessages')
        .at(-1);
      expect(lastCorpusCall?.args.before).toBe(1_700_000_300_000 - 1);
    });
  });

  test('falls back to the native provider tier when local search throws', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('mailCorpus:getSyncState', () => ({ grantId: 'grant_1', corpusReady: true }));
      h.onConvex('mailCorpus:searchCorpusMessages', () => {
        throw new Error('corpus exploded');
      });
      h.onNylas('GET', /\/v3\/grants\/grant_1\/threads$/, () => ({
        json: {
          request_id: 'req_1',
          data: [
            {
              id: 'thread_native',
              subject: 'From the provider',
              snippet: 'hello',
              unread: true,
              folders: ['INBOX'],
              latest_message_received_date: 1_700_000_000,
              participants: [{ email: 'bob@x.com', name: 'Bob' }],
            },
          ],
          next_cursor: 'cursor_2',
        },
      }));

      const result = await searchNylasThreads({
        userId: 'user_1',
        account: 'acct_1',
        query: 'in:inbox',
        max: 1,
        pageToken: 'local:123',
      });

      expect(result?.searchTier).toBe('native');
      expect(result?.route.reason).toBe('local search failed; provider fallback used');
      expect(result?.fallbackReason).toBe('corpus exploded');
      expect(result?.nextPageToken).toBe('cursor_2');
      expect(result?.items[0]).toMatchObject({
        _id: 'thread_native',
        account: 'acct_1',
        subject: 'From the provider',
        unread: true,
        lastDate: 1_700_000_000_000,
      });

      const providerCall = h.nylasCalls.find((call) => call.url.pathname.endsWith('/threads'));
      expect(providerCall?.url.searchParams.get('search_query_native')).toBe('in:inbox');
      expect(providerCall?.url.searchParams.get('limit')).toBe('1');
      // Local cursors are never forwarded to the provider transport.
      expect(providerCall?.url.searchParams.get('page_token')).toBeNull();
    });
  });

  test('routes text queries to the native tier when the corpus is not ready', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('mailCorpus:getSyncState', () => null);
      h.onConvex('mailCorpus:claimCorpusBackfill', () => ({ claimed: false }));
      h.onNylas('GET', /\/v3\/grants\/grant_1\/threads$/, () => ({
        json: { request_id: 'req_1', data: [], next_cursor: undefined },
      }));

      const result = await searchNylasThreads({
        userId: 'user_1',
        account: 'acct_1',
        query: 'quarterly report',
        max: 3,
      });

      expect(result?.searchTier).toBe('native');
      expect(result?.route.reason).toBe('corpus is not ready for this grant');
      expect(result?.items).toEqual([]);
      const providerCall = h.nylasCalls.find((call) => call.url.pathname.endsWith('/threads'));
      expect(providerCall?.url.searchParams.get('search_query_native')).toBe('quarterly report');
    });
  });

  test('compiles structured params for microsoft and resolves folders on the provider', async () => {
    await withHarness(async (h) => {
      const row = account({ provider: 'microsoft', grantId: 'grant_ms', accountId: 'acct_ms' });
      h.onConvex('accounts:getConnectedAccount', () => row);
      h.onConvex('mailCorpus:getSyncState', () => null);
      h.onConvex('mailCorpus:claimCorpusBackfill', () => ({ claimed: false }));
      h.onNylas('GET', /\/v3\/grants\/grant_ms\/folders$/, () => ({
        json: {
          request_id: 'req_f',
          data: [{ id: 'folder_9', name: 'Archive', attributes: ['\\Archive'] }],
        },
      }));
      h.onNylas('GET', /\/v3\/grants\/grant_ms\/threads$/, () => ({
        json: { request_id: 'req_t', data: [] },
      }));

      const result = await searchNylasThreads({
        userId: 'user_1',
        account: 'acct_ms',
        query: 'in:archive from:bob@x.com',
        max: 4,
      });

      expect(result?.searchTier).toBe('structured');
      const providerCall = h.nylasCalls.find((call) => call.url.pathname.endsWith('/threads'));
      expect(providerCall?.url.searchParams.get('in')).toBe('folder_9');
      expect(providerCall?.url.searchParams.get('from')).toBe('bob@x.com');
      expect(providerCall?.url.searchParams.get('limit')).toBe('4');
    });
  });

  test('keeps structured search unscoped when the provider folder cannot be resolved', async () => {
    await withHarness(async (h) => {
      const row = account({ provider: 'imap', grantId: 'grant_imap', accountId: 'acct_imap' });
      h.onConvex('accounts:getConnectedAccount', () => row);
      h.onConvex('mailCorpus:getSyncState', () => null);
      h.onConvex('mailCorpus:claimCorpusBackfill', () => ({ claimed: false }));
      h.onNylas('GET', /\/v3\/grants\/grant_imap\/folders$/, () => ({
        json: { request_id: 'req_f', data: [] },
      }));
      h.onNylas('GET', /\/v3\/grants\/grant_imap\/threads$/, () => ({
        json: { request_id: 'req_t', data: [] },
      }));

      const result = await searchNylasThreads({
        userId: 'user_1',
        account: 'acct_imap',
        query: 'in:archive from:bob@x.com',
        max: 4,
      });

      expect(result?.dropped).toContainEqual({
        clause: { type: 'folder', value: 'ARCHIVE' },
        reason: 'folder not found on provider; results are unscoped',
      });
      const providerCall = h.nylasCalls.find((call) => call.url.pathname.endsWith('/threads'));
      expect(providerCall?.url.searchParams.get('in')).toBeNull();
    });
  });

  test('returns null when the account cannot be resolved', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => null);
      h.onConvex('accounts:listConnectedAccounts', () => []);
      expect(await searchNylasThreads({ userId: 'user_1', account: 'ghost', query: 'x', max: 2 })).toBeNull();
    });
  });
});

describe('thread and message reads', () => {
  test('getNylasThread lists messages for the thread and sorts them by date', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages$/, () => ({
        json: {
          request_id: 'req_m',
          data: [
            {
              id: 'msg_2',
              thread_id: 'thread_9',
              subject: 'Re: Plans',
              from: [{ email: 'bob@x.com', name: 'Bob' }],
              date: 1_700_000_200,
              body: '<p>later</p>',
            },
            {
              id: 'msg_1',
              thread_id: 'thread_9',
              subject: 'Plans',
              from: [{ email: 'ann@example.com' }],
              date: 1_700_000_100,
              body: '<p>first</p>',
            },
          ],
        },
      }));

      const thread = await getNylasThread({ userId: 'user_1', account: 'acct_1', threadId: 'thread_9' });
      expect(thread?.subject).toBe('Plans');
      expect(thread?.messages.map((message) => message._id)).toEqual(['msg_1', 'msg_2']);
      expect(thread?.messages[1]).toMatchObject({
        from: 'Bob <bob@x.com>',
        date: 1_700_000_200_000,
        textBody: 'later',
      });

      const call = h.nylasCalls[0];
      expect(call.url.searchParams.get('thread_id')).toBe('thread_9');
      expect(call.url.searchParams.get('limit')).toBe('200');
    });
  });

  test('getNylasMessage normalizes a single message', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/msg_5$/, () => ({
        json: {
          request_id: 'req_m',
          data: {
            id: 'msg_5',
            thread_id: 'thread_5',
            subject: 'Invoice',
            from: [{ email: 'billing@x.com' }],
            to: [{ email: 'ann@example.com', name: 'Ann' }],
            date: 1_700_000_400,
            body: '<b>due soon</b>',
            folders: ['INBOX'],
            unread: true,
            attachments: [{ id: 'att_1', filename: 'invoice.pdf', content_type: 'application/pdf', size: 9 }],
          },
        },
      }));

      const message = await getNylasMessage({ userId: 'user_1', account: 'acct_1', id: 'msg_5' });
      expect(message).toMatchObject({
        _id: 'msg_5',
        threadId: 'thread_5',
        account: 'acct_1',
        from: 'billing@x.com',
        to: 'Ann <ann@example.com>',
        textBody: 'due soon',
        labels: ['INBOX'],
        unread: true,
      });
      expect(message?.attachments).toEqual([
        { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 9, attachmentId: 'att_1' },
      ]);
    });
  });
});

describe('folders and labels', () => {
  test('listNylasLabels normalizes system and user folders', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/folders$/, () => ({
        json: {
          request_id: 'req_f',
          data: [
            { id: 'INBOX', name: 'Inbox', system_folder: true, total_count: 5 },
            { id: 'Label_1', name: 'Projects' },
          ],
        },
      }));

      const result = await listNylasLabels('user_1', 'acct_1');
      expect(result?.labels).toEqual([
        { id: 'INBOX', name: 'Inbox', type: 'system', messagesTotal: 5, threadsTotal: 5 },
        { id: 'Label_1', name: 'Projects', type: 'user', messagesTotal: undefined, threadsTotal: undefined },
      ]);
    });
  });

  test('createNylasFolder reuses an existing folder case-insensitively', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/folders$/, () => ({
        json: { request_id: 'req_f', data: [{ id: 'Label_7', name: 'projects' }] },
      }));

      const folder = await createNylasFolder({ userId: 'user_1', account: 'acct_1', name: 'Projects' });
      expect(folder).toMatchObject({ id: 'Label_7', name: 'projects' });
      expect(h.nylasCalls.filter((call) => call.method === 'POST')).toHaveLength(0);
    });
  });

  test('createNylasFolder creates when missing and posts the requested name', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/folders$/, () => ({
        json: { request_id: 'req_f', data: [] },
      }));
      h.onNylas('POST', /\/v3\/grants\/grant_1\/folders$/, (call) => ({
        json: { request_id: 'req_c', data: { id: 'Label_8', name: call.body.name } },
      }));

      const folder = await createNylasFolder({ userId: 'user_1', account: 'acct_1', name: 'Receipts' });
      expect(folder).toMatchObject({ id: 'Label_8', name: 'Receipts', type: 'user' });
      const create = h.nylasCalls.find((call) => call.method === 'POST');
      expect(create?.body).toEqual({ name: 'Receipts' });
    });
  });

  test('createNylasFolder resolves 409 conflicts by re-reading the folder list', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      let listCalls = 0;
      h.onNylas('GET', /\/v3\/grants\/grant_1\/folders$/, () => {
        listCalls += 1;
        return {
          json: {
            request_id: 'req_f',
            data: listCalls > 1 ? [{ id: 'Label_9', name: 'Dup' }] : [],
          },
        };
      });
      h.onNylas('POST', /\/v3\/grants\/grant_1\/folders$/, () => ({
        status: 409,
        json: { request_id: 'req_c', error: { type: 'conflict', message: 'Conflict' } },
      }));

      const folder = await createNylasFolder({ userId: 'user_1', account: 'acct_1', name: 'Dup' });
      expect(folder).toMatchObject({ id: 'Label_9', name: 'Dup' });
    });
  });

  test('createNylasFolder retries a rate-limited create before succeeding', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/folders$/, () => ({
        json: { request_id: 'req_f', data: [] },
      }));
      let attempts = 0;
      h.onNylas('POST', /\/v3\/grants\/grant_1\/folders$/, () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: 429,
            json: { request_id: 'req_c', error: { type: 'rate_limit', message: 'Too many requests' } },
          };
        }
        return { json: { request_id: 'req_c', data: { id: 'Label_10', name: 'Slow' } } };
      });

      const folder = await createNylasFolder({ userId: 'user_1', account: 'acct_1', name: 'Slow' });
      expect(folder).toMatchObject({ id: 'Label_10' });
      expect(attempts).toBe(2);
    });
  }, 10_000);
});

describe('thread and message updates', () => {
  test('updateNylasThread and updateNylasMessage send the flag patch to Nylas', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/threads\/thread_1$/, () => ({
        json: { request_id: 'req_u', data: { id: 'thread_1' } },
      }));
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/messages\/msg_1$/, () => ({
        json: { request_id: 'req_u', data: { id: 'msg_1' } },
      }));

      expect(
        await updateNylasThread({
          userId: 'user_1',
          account: 'acct_1',
          threadId: 'thread_1',
          unread: false,
          starred: true,
        }),
      ).toEqual({ ok: true });
      expect(
        await updateNylasMessage({
          userId: 'user_1',
          account: 'acct_1',
          messageId: 'msg_1',
          folders: ['INBOX', 'Label_2'],
        }),
      ).toEqual({ ok: true });

      const threadUpdate = h.nylasCalls.find((call) => call.url.pathname.endsWith('/threads/thread_1'));
      expect(threadUpdate?.body).toEqual({ unread: false, starred: true });
      const messageUpdate = h.nylasCalls.find((call) => call.url.pathname.endsWith('/messages/msg_1'));
      expect(messageUpdate?.body).toEqual({ folders: ['INBOX', 'Label_2'] });
    });
  });

  test('updateNylasMessageFolders applies add/remove deltas against current folders', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/msg_1$/, () => ({
        json: { request_id: 'req_m', data: { id: 'msg_1', folders: ['INBOX', 'Label_old'] } },
      }));
      h.onNylas('GET', /\/v3\/grants\/grant_1\/folders$/, () => ({
        json: { request_id: 'req_f', data: [{ id: 'Label_old', name: 'Old Label' }] },
      }));
      h.onNylas('POST', /\/v3\/grants\/grant_1\/folders$/, (call) => ({
        json: { request_id: 'req_c', data: { id: 'Label_new', name: call.body.name } },
      }));
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/messages\/msg_1$/, () => ({
        json: { request_id: 'req_u', data: { id: 'msg_1' } },
      }));

      const result = await updateNylasMessageFolders({
        userId: 'user_1',
        account: 'acct_1',
        messageId: 'msg_1',
        add: ['Projects', 'ARCHIVE'],
        remove: ['Old Label'],
        createMissing: true,
      });

      expect(result).toEqual({ ok: true });
      const update = h.nylasCalls.find((call) => call.method === 'PUT');
      // Old Label removed by resolved id, Projects created, ARCHIVE passed as a
      // system folder id without creating anything.
      expect(update?.body).toEqual({ folders: ['INBOX', 'Label_new', 'ARCHIVE'] });
    });
  });

  test('updateNylasThreadFoldersWithRetry retries the whole operation on 429', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      let findAttempts = 0;
      h.onNylas('GET', /\/v3\/grants\/grant_1\/threads\/thread_2$/, () => {
        findAttempts += 1;
        if (findAttempts === 1) {
          return {
            status: 429,
            json: { request_id: 'req_t', error: { type: 'rate_limit', message: 'Too many requests' } },
          };
        }
        return { json: { request_id: 'req_t', data: { id: 'thread_2', folders: ['INBOX'] } } };
      });
      h.onNylas('GET', /\/v3\/grants\/grant_1\/folders$/, () => ({
        json: { request_id: 'req_f', data: [{ id: 'Label_done', name: 'Done' }] },
      }));
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/threads\/thread_2$/, () => ({
        json: { request_id: 'req_u', data: { id: 'thread_2' } },
      }));

      const result = await updateNylasThreadFoldersWithRetry({
        userId: 'user_1',
        account: 'acct_1',
        threadId: 'thread_2',
        add: ['Done'],
      });

      expect(result).toEqual({ ok: true });
      expect(findAttempts).toBe(2);
      const update = h.nylasCalls.find((call) => call.method === 'PUT');
      expect(update?.body).toEqual({ folders: ['INBOX', 'Label_done'] });
    });
  }, 10_000);
});

describe('sending mail', () => {
  test('refuses to send while outbound sending is disabled', async () => {
    await withHarness(
      async () => {
        await expect(
          sendNylasMessage({
            userId: 'user_1',
            account: 'acct_1',
            to: 'bob@x.com',
            subject: 'hi',
            body: 'hello',
          }),
        ).rejects.toThrow('Outbound sending is temporarily disabled.');
      },
      { LAB86_DISABLE_OUTBOUND_SEND: '1' },
    );
  });

  test('sends plaintext mail with parsed recipient lists', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('POST', /\/v3\/grants\/grant_1\/messages\/send$/, () => ({
        json: {
          request_id: 'req_s',
          data: { id: 'msg_sent', subject: 'hi', date: 1_700_000_500 },
        },
      }));

      const sent = await sendNylasMessage({
        userId: 'user_1',
        account: 'acct_1',
        to: '"Ann Smith" <ann@x.com>, bob@y.com',
        subject: 'hi',
        body: 'hello there',
      });

      expect(sent).toMatchObject({ _id: 'msg_sent', subject: 'hi' });
      expect((sent as any).scheduleId).toBeUndefined();
      const send = h.nylasCalls.find((call) => call.url.pathname.endsWith('/messages/send'));
      expect(send?.body).toMatchObject({
        to: [{ name: 'Ann Smith', email: 'ann@x.com' }, { email: 'bob@y.com' }],
        cc: [],
        bcc: [],
        subject: 'hi',
        body: 'hello there',
        is_plaintext: true,
      });
      expect(send?.body.send_at).toBeUndefined();
    });
  });

  test('clamps stale send_at values into the future and surfaces scheduleId', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('POST', /\/v3\/grants\/grant_1\/messages\/send$/, () => ({
        json: {
          request_id: 'req_s',
          data: { id: 'msg_sched', subject: 'later', schedule_id: 'sched_1' },
        },
      }));

      const before = Math.floor(Date.now() / 1000);
      const sent = await sendNylasMessage({
        userId: 'user_1',
        account: 'acct_1',
        to: 'bob@y.com',
        subject: 'later',
        body: 'text',
        html: '<p>rich</p>',
        sendAt: Date.now() - 60_000,
        useDraft: true,
      });

      expect((sent as any).scheduleId).toBe('sched_1');
      const send = h.nylasCalls.find((call) => call.url.pathname.endsWith('/messages/send'));
      expect(send?.body.send_at).toBeGreaterThanOrEqual(before + 9);
      expect(send?.body).toMatchObject({ body: '<p>rich</p>', is_plaintext: false, use_draft: true });
    });
  });

  test('scheduled message helpers hit the schedules endpoints and map statuses', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/schedules$/, () => ({
        json: { request_id: 'req_l', data: [{ schedule_id: 'sched_1' }] },
      }));
      const codes: Record<string, string> = {
        sched_ok: 'SUCESS',
        sched_fail: 'failed',
        sched_cancel: 'cancelled',
        sched_wait: 'pending',
      };
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages\/schedules\/[^/]+$/, (call) => {
        const scheduleId = call.url.pathname.split('/').at(-1) || '';
        return {
          json: { request_id: 'req_g', data: { status: { code: codes[scheduleId] } } },
        };
      });
      h.onNylas('DELETE', /\/v3\/grants\/grant_1\/messages\/schedules\/sched_1$/, () => ({
        json: { request_id: 'req_d', data: { message: 'cancelled' } },
      }));

      expect(await listNylasScheduledMessages({ userId: 'user_1', account: 'acct_1' })).toEqual([
        { scheduleId: 'sched_1' },
      ]);
      const status = (scheduleId: string) =>
        getNylasScheduledSendStatus({ userId: 'user_1', account: 'acct_1', scheduleId });
      expect(await status('sched_ok')).toBe('sent');
      expect(await status('sched_fail')).toBe('failed');
      expect(await status('sched_cancel')).toBe('cancelled');
      expect(await status('sched_wait')).toBe('pending');
      expect(
        await stopNylasScheduledMessage({ userId: 'user_1', account: 'acct_1', scheduleId: 'sched_1' }),
      ).toEqual({ message: 'cancelled' });
    });
  });
});

describe('attachments and account deletion', () => {
  test('downloadNylasAttachment streams the attachment body', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onNylas('GET', /\/v3\/grants\/grant_1\/attachments\/att_1\/download$/, () => ({
        text: 'file-bytes',
      }));

      const stream = await downloadNylasAttachment({
        userId: 'user_1',
        account: 'acct_1',
        messageId: 'msg_1',
        attachmentId: 'att_1',
      });
      expect(await new Response(stream as ReadableStream).text()).toBe('file-bytes');
      const call = h.nylasCalls[0];
      expect(call.url.searchParams.get('message_id')).toBe('msg_1');
    });
  });

  test('deleteNylasAccount removes the Convex row first, then best-effort destroys the grant', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:deleteConnectedAccount', () => ({ ok: true }));
      h.onNylas('DELETE', /\/v3\/grants\/grant_del$/, () => ({
        status: 500,
        json: { request_id: 'req_d', error: { type: 'server_error', message: 'boom' } },
      }));

      // Grant destroy failures are swallowed: the Convex row is already gone.
      expect(await deleteNylasAccount('user_1', 'acct_1', 'grant_del')).toEqual({ ok: true });
      expect(h.convexCalls[0]).toMatchObject({
        endpoint: 'mutation',
        path: 'accounts:deleteConnectedAccount',
        args: { userId: 'user_1', accountId: 'acct_1' },
      });
      expect(h.nylasCalls.some((call) => call.method === 'DELETE')).toBe(true);

      // Without a grant id there is no Nylas call at all.
      h.nylasCalls.length = 0;
      expect(await deleteNylasAccount('user_1', 'acct_1')).toEqual({ ok: true });
      expect(h.nylasCalls).toHaveLength(0);
    });
  });

  test('deleteNylasAccount surfaces Convex failures before touching the grant', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:deleteConnectedAccount', () => {
        throw new Error('convex down');
      });
      await expect(deleteNylasAccount('user_1', 'acct_1', 'grant_del')).rejects.toThrow('convex down');
      expect(h.nylasCalls).toHaveLength(0);
    });
  });
});

describe('buildNylasStructuredSearchQueryParams', () => {
  test('compiles structured filters without any transport', () => {
    const params = buildNylasStructuredSearchQueryParams({
      query: 'from:ann@x.com is:unread has:attachment in:inbox',
      max: 200,
      pageToken: 'cursor_9',
    });
    expect(params).toMatchObject({
      limit: 80,
      page_token: 'cursor_9',
      from: 'ann@x.com',
      unread: true,
      has_attachment: true,
      in: 'INBOX',
    });
  });
});
