// Shared fetch stub for hosted-path tests. The Nylas SDK and the Convex HTTP
// client both speak plain HTTP through global fetch, so one URL router covers
// every seam. Mirrors the harness in tests/tool-mail-identity.test.ts.
import type { NylasAccountRow } from '../../lib/nylas/provider';

export interface HttpHarness {
  convexCalls: Array<{ path: string; args: Record<string, any> }>;
  nylasCalls: Array<{ method: string; path: string; search: string; body: any; contentType: string }>;
  onConvex: (path: string, handler: (args: Record<string, any>) => unknown) => void;
  onNylas: (
    method: string,
    pathPattern: RegExp,
    handler: (call: { path: string; search: URLSearchParams; body: any }) => {
      status?: number;
      json?: unknown;
      raw?: BodyInit;
      headers?: Record<string, string>;
    },
  ) => void;
}

const ENV_KEYS = ['NYLAS_API_KEY', 'NYLAS_CLIENT_ID', 'NEXT_PUBLIC_CONVEX_URL', 'CONVEX_URL'];

export async function withHttpHarness(fn: (h: HttpHarness) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NYLAS_API_KEY = 'test-nylas-key';
  process.env.NYLAS_CLIENT_ID = 'test-nylas-client';
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://convex.lab86-tests.example';
  delete process.env.CONVEX_URL;

  const convexHandlers = new Map<string, (args: Record<string, any>) => unknown>();
  const nylasHandlers: Array<{ method: string; pattern: RegExp; handler: any }> = [];
  const harness: HttpHarness = {
    convexCalls: [],
    nylasCalls: [],
    onConvex: (path, handler) => convexHandlers.set(path, handler),
    onNylas: (method, pattern, handler) => nylasHandlers.push({ method, pattern, handler }),
  };

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    if (url.pathname === '/api/query' || url.pathname === '/api/mutation' || url.pathname === '/api/action') {
      const { path, args } = JSON.parse(text);
      const callArgs = { ...((args?.[0] as Record<string, any>) || {}) };
      delete callArgs.internalSecret;
      harness.convexCalls.push({ path, args: callArgs });
      const handler = convexHandlers.get(path);
      if (!handler) return Response.json({ status: 'error', errorMessage: `no convex handler for ${path}` });
      try {
        return Response.json({ status: 'success', value: (await handler(callArgs)) ?? null });
      } catch (err: any) {
        return Response.json({ status: 'error', errorMessage: err?.message || 'handler failed' });
      }
    }
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {}
    harness.nylasCalls.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      body,
      contentType: request.headers.get('content-type') || '',
    });
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
    const result = route.handler({ path: url.pathname, search: url.searchParams, body });
    if (result.raw !== undefined) return new Response(result.raw, { status: result.status ?? 200 });
    return new Response(JSON.stringify(result.json ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers || {}) },
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

export function accountRow(overrides: Partial<NylasAccountRow> = {}): NylasAccountRow {
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

export function corpusMessage(overrides: Record<string, any> = {}) {
  return {
    _id: 'msg_1',
    threadId: 'thread_1',
    account: 'acct_1',
    subject: 'Plans',
    from: 'Bob <bob@example.com>',
    to: 'Ann <ann@example.com>',
    cc: '',
    bcc: '',
    date: 1_700_000_000_000,
    snippet: '',
    textBody: 'hello',
    htmlBody: null,
    labels: ['INBOX'],
    unread: false,
    starred: false,
    attachments: [],
    headers: {},
    cachedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function nylasMessage(overrides: Record<string, any> = {}) {
  return {
    id: 'msg_n',
    grant_id: 'grant_1',
    thread_id: 'thread_1',
    subject: 'Plans',
    from: [{ name: 'Bob', email: 'bob@example.com' }],
    to: [{ name: 'Ann', email: 'ann@example.com' }],
    date: 1_700_000_000,
    snippet: 'hello',
    body: 'hello',
    folders: ['INBOX'],
    unread: false,
    starred: false,
    ...overrides,
  };
}
