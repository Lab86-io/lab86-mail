import { describe, expect, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import type { NylasAccountRow } from '../lib/nylas/provider';
import { corpusSearch } from '../lib/tools/corpus';
import { getThread, listAccountThreads, searchThreads } from '../lib/tools/mail';
import type { ToolContext } from '../lib/tools/registry';

// ---------------------------------------------------------------------------
// Stage 1 iOS 0.8 parity: senderEmail/fromEmail must ride along on
// list_account_threads, get_thread, and search_threads so native clients can
// look up cached sender photos without re-parsing header strings themselves.
//
// Harness mirrors tests/nylas-provider.test.ts: both the Nylas SDK and the
// Convex HTTP client speak plain HTTP through global fetch, so a single
// URL-routing stub covers every seam these tools touch.
// ---------------------------------------------------------------------------

interface Harness {
  convexCalls: Array<{ path: string; args: Record<string, any> }>;
  onConvex: (path: string, handler: (args: Record<string, any>) => unknown) => void;
  onNylas: (method: string, pathPattern: RegExp, handler: () => { status?: number; json?: unknown }) => void;
}

const ENV_KEYS = ['NYLAS_API_KEY', 'NYLAS_CLIENT_ID', 'NEXT_PUBLIC_CONVEX_URL', 'CONVEX_URL'];

async function withHarness(fn: (h: Harness) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NYLAS_API_KEY = 'test-nylas-key';
  process.env.NYLAS_CLIENT_ID = 'test-nylas-client';
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://convex.lab86-tests.example';
  delete process.env.CONVEX_URL;

  const convexCalls: Harness['convexCalls'] = [];
  const convexHandlers = new Map<string, (args: Record<string, any>) => unknown>();
  const nylasHandlers: Array<{
    method: string;
    pattern: RegExp;
    handler: () => { status?: number; json?: unknown };
  }> = [];

  const harness: Harness = {
    convexCalls,
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
      convexCalls.push({ path, args: callArgs });
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
    const result = route.handler();
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  globalThis.fetch = stub as typeof fetch;
  try {
    await fn(harness);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of saved) {
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

const ctx: ToolContext = { agent: 'ai', userId: 'user_1' };

// Handlers are normally invoked through invokeTool (lib/tools/registry.ts),
// which establishes the ambient AiRequestContext the per-user kv store reads
// (getThreadRecord, upsertThread). Mirror that here so those best-effort
// reads/writes behave the same as in production instead of failing closed on
// a missing context.
function run<T>(fn: () => Promise<T>): Promise<T> {
  return runWithAiRequestContext({ userId: ctx.userId, agent: ctx.agent }, fn);
}

describe('mail tools carry sender identity for native photo lookups', () => {
  test('list_account_threads attaches senderEmail from the corpus fromAddress header', async () => {
    await withHarness(async (h) => {
      h.onConvex('mailCorpus:listRecentCorpusThreads', () => [
        {
          _id: 'thread_a',
          account: 'acct_1',
          subject: 'Budget review',
          fromAddress: '"Bob Smith" <Bob@X.com>',
          lastDate: 1_700_000_000_000,
          snippet: 'numbers',
          labels: ['INBOX'],
          unread: true,
          starred: false,
          cachedAt: 1_700_000_000_000,
        },
      ]);

      const result = await run(() => listAccountThreads.handler({ account: 'acct_1', limit: 80 }, ctx));
      expect(result.threads).toHaveLength(1);
      expect(result.threads[0]).toMatchObject({ _id: 'thread_a', senderEmail: 'bob@x.com' });
    });
  });

  test('list_account_threads leaves senderEmail null when no from header is present', async () => {
    await withHarness(async (h) => {
      h.onConvex('mailCorpus:listRecentCorpusThreads', () => [
        {
          _id: 'thread_b',
          account: 'acct_1',
          subject: 'No sender',
          fromAddress: '',
          lastDate: 1_700_000_000_000,
          snippet: '',
          labels: [],
          unread: false,
          starred: false,
          cachedAt: 1_700_000_000_000,
        },
      ]);

      const result = await run(() => listAccountThreads.handler({ account: 'acct_1', limit: 80 }, ctx));
      expect(result.threads[0].senderEmail).toBeNull();
    });
  });

  test('search_threads attaches senderEmail derived from provider participants', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('mailCorpus:getSyncState', () => null);
      h.onConvex('mailCorpus:claimCorpusBackfill', () => ({ claimed: false }));
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
              participants: [{ email: 'Bob@X.com', name: 'Bob' }],
            },
          ],
        },
      }));

      const result = await run(() =>
        searchThreads.handler({ account: 'acct_1', query: 'quarterly report', max: 5 }, ctx),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ _id: 'thread_native', senderEmail: 'bob@x.com' });
    });
  });

  test('get_thread attaches fromEmail to each message via the provider hydration path', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      // No mailCorpus:getCorpusThreadBundle handler registered — the query
      // fails and mail.ts's `.catch(() => null)` sends this down the
      // provider-hydration path, matching a first-open with nothing cached.
      h.onNylas('GET', /\/v3\/grants\/grant_1\/messages$/, () => ({
        json: {
          request_id: 'req_m',
          data: [
            {
              id: 'msg_1',
              thread_id: 'thread_9',
              subject: 'Plans',
              from: [{ email: 'Ann@Example.com', name: 'Ann' }],
              date: 1_700_000_100,
              body: '<p>first</p>',
            },
          ],
        },
      }));

      const result = await run(() => getThread.handler({ account: 'acct_1', threadId: 'thread_9' }, ctx));
      expect(result.messages).toHaveLength(1);
      expect((result.messages[0] as any).fromEmail).toBe('ann@example.com');
    });
  });

  test('get_thread attaches fromEmail from the corpus bundle fast path', async () => {
    await withHarness(async (h) => {
      h.onConvex('mailCorpus:getCorpusThreadBundle', () => ({
        threadId: 'thread_9',
        subject: 'Plans',
        bodiesComplete: true,
        messages: [
          {
            _id: 'msg_1',
            threadId: 'thread_9',
            account: 'acct_1',
            subject: 'Plans',
            from: '"Ann" <Ann@Example.com>',
            to: '',
            cc: '',
            bcc: '',
            date: 1_700_000_100_000,
            snippet: '',
            textBody: 'first',
            htmlBody: null,
            labels: [],
            unread: false,
            starred: false,
            attachments: [],
            headers: {},
            cachedAt: 1_700_000_100_000,
          },
        ],
      }));

      const result = await run(() => getThread.handler({ account: 'acct_1', threadId: 'thread_9' }, ctx));
      expect(result.messages).toHaveLength(1);
      expect((result.messages[0] as any).fromEmail).toBe('ann@example.com');
    });
  });

  test('corpus_search attaches senderEmail to mail items', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:listConnectedAccounts', () => [account()]);
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('mailCorpus:getSyncState', () => null);
      h.onConvex('mailCorpus:claimCorpusBackfill', () => ({ claimed: false }));
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
              participants: [{ email: 'Bob@X.com', name: 'Bob' }],
            },
          ],
        },
      }));

      const result = await run(() =>
        corpusSearch.handler({ query: 'quarterly report', max: 5, includeConnectedTools: false }, ctx),
      );
      const mailItem = result.items.find((item: any) => item.source === 'mail');
      expect(mailItem).toMatchObject({ _id: 'thread_native', senderEmail: 'bob@x.com' });
    });
  });
});
