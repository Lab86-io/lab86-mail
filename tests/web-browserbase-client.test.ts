import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BROWSERBASE_API_BASE,
  BrowserbaseNotConfigured,
  BrowserbaseRequestError,
  browserbaseApiKey,
  browserbaseConfigured,
  browserbaseFetch,
  browserbaseProjectId,
  browserbaseSearch,
  createContext,
  createSession,
  deleteContext,
  deleteDownload,
  downloadBytes,
  listDownloads,
  releaseSession,
  SESSION_PRIVACY,
  sessionConnectUrl,
  sessionIdFromConnectUrl,
  sessionLiveUrls,
} from '../lib/web/browserbase-client';
import { testEnv } from './tools/env';

const saved = {
  key: process.env.BROWSERBASE_API_KEY,
  project: process.env.BROWSERBASE_PROJECT_ID,
};

beforeEach(() => {
  process.env.BROWSERBASE_API_KEY = 'bb-test-key';
  process.env.BROWSERBASE_PROJECT_ID = 'proj-1';
});

afterEach(() => {
  for (const [name, value] of [
    ['BROWSERBASE_API_KEY', saved.key],
    ['BROWSERBASE_PROJECT_ID', saved.project],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function recorder(answer: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (url: any, init?: any) => {
    const call: Call = {
      url: String(url),
      method: init?.method,
      headers: init?.headers || {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetcher };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('configuration', () => {
  test('the key and the project come from the first set name', () => {
    expect(browserbaseApiKey(testEnv({ LAB86_BROWSERBASE_API_KEY: 'b', BB_API_KEY: 'c' }))).toBe('b');
    expect(browserbaseApiKey(testEnv({ BB_API_KEY: 'c' }))).toBe('c');
    expect(browserbaseApiKey(testEnv({}))).toBe('');
    expect(browserbaseConfigured(testEnv({}))).toBe(false);
    expect(browserbaseProjectId(testEnv({ LAB86_BROWSERBASE_PROJECT_ID: 'p2' }))).toBe('p2');
    expect(browserbaseProjectId(testEnv({}))).toBeUndefined();
  });

  test('no key: a clear error before any network call', async () => {
    delete process.env.BROWSERBASE_API_KEY;
    const { calls, fetcher } = recorder(() => json({}));
    await expect(browserbaseSearch({ query: 'x' }, { fetcher })).rejects.toBeInstanceOf(
      BrowserbaseNotConfigured,
    );
    await expect(createSession({}, { fetcher, notConfigured: 'Not set up.' })).rejects.toThrow('Not set up.');
    expect(() => sessionConnectUrl('s1')).toThrow('BROWSERBASE_API_KEY is not configured.');
    expect(calls).toEqual([]);
  });
});

describe('requests', () => {
  test('search sends the key, cuts the query, and keeps only rows with a url', async () => {
    const { calls, fetcher } = recorder(() =>
      json({ results: [{ url: 'https://a.test', title: 'A' }, { title: 'no url' }, null] }),
    );
    const rows = await browserbaseSearch({ query: 'q'.repeat(250), numResults: 3 }, { fetcher });
    expect(rows).toEqual([{ url: 'https://a.test', title: 'A' }]);
    expect(calls[0].url).toBe(`${BROWSERBASE_API_BASE}/search`);
    expect(calls[0].headers['x-bb-api-key']).toBe('bb-test-key');
    expect(calls[0].body).toEqual({ query: 'q'.repeat(200), numResults: 3 });
    const legacy = recorder(() => json({ data: [{ url: 'https://b.test' }] }));
    expect(await browserbaseSearch({ query: 'q' }, { fetcher: legacy.fetcher })).toEqual([
      { url: 'https://b.test' },
    ]);
    expect(legacy.calls[0].body.numResults).toBe(10);
    const none = recorder(() => json({}));
    expect(await browserbaseSearch({ query: 'q' }, { fetcher: none.fetcher })).toEqual([]);
  });

  test('fetch gives the site status, lower-case headers, and the content type without parameters', async () => {
    const { calls, fetcher } = recorder(() =>
      json({
        statusCode: 200,
        headers: { 'Content-Type': 'application/pdf; x=1', 'Content-Length': '5' },
        content: 'JVBERi0=',
        contentType: 'Application/PDF; charset=binary',
        encoding: 'base64',
      }),
    );
    const result = await browserbaseFetch({ url: 'https://irs.example/f.pdf', format: 'raw' }, { fetcher });
    expect(result).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'application/pdf; x=1', 'content-length': '5' },
      content: 'JVBERi0=',
      contentType: 'application/pdf',
      encoding: 'base64',
    });
    expect(calls[0].body).toEqual({ url: 'https://irs.example/f.pdf', allowRedirects: true, format: 'raw' });
    const sparse = recorder(() => json({ markdown: '# Hi', headers: { 'content-type': 'text/html' } }));
    expect(
      await browserbaseFetch({ url: 'https://a.test', format: 'markdown' }, { fetcher: sparse.fetcher }),
    ).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      content: '# Hi',
      contentType: 'text/html',
    });
  });

  test('an error answer keeps the status and the body; the path has no query', async () => {
    const { fetcher } = recorder(() => new Response('cannot convert', { status: 400 }));
    const error = await browserbaseFetch({ url: 'https://a.test', format: 'markdown' }, { fetcher }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(BrowserbaseRequestError);
    expect(error.status).toBe(400);
    expect(error.message).toBe('Browserbase /fetch failed (400): cannot convert');
    const list = recorder(() => new Response('nope', { status: 500 }));
    await expect(listDownloads({ sessionId: 's1' }, { fetcher: list.fetcher })).rejects.toThrow(
      'Browserbase /downloads failed (500): nope',
    );
  });

  test('429 is tried again, at most two times', async () => {
    const { calls, fetcher } = recorder((_call, index) =>
      index < 2
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
        : json({ results: [] }),
    );
    expect(await browserbaseSearch({ query: 'q' }, { fetcher })).toEqual([]);
    expect(calls.length).toBe(3);
    const always = recorder(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
    );
    const error = await browserbaseSearch({ query: 'q' }, { fetcher: always.fetcher }).catch((e) => e);
    expect(error.status).toBe(429);
    expect(always.calls.length).toBe(3);
  });

  test('a time limit gives a plain message; a caller abort stays an abort', async () => {
    const hang = (async (_url: any, init?: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })) as typeof fetch;
    await expect(browserbaseSearch({ query: 'q' }, { fetcher: hang, timeoutMs: 5 })).rejects.toThrow(
      'Browserbase /search timed out after 5ms',
    );
    const controller = new AbortController();
    const pending = browserbaseSearch({ query: 'q' }, { fetcher: hang, signal: controller.signal });
    controller.abort(new Error('stopped by the user'));
    await expect(pending).rejects.toThrow('stopped by the user');
  });
});

describe('sessions, contexts, and downloads', () => {
  test('every session keeps no logs and no video; context, domains, and viewport are optional', async () => {
    const { calls, fetcher } = recorder(() => json({ id: 'bb-1', connectUrl: 'wss://connect.example/bb-1' }));
    expect(await createSession({}, { fetcher })).toEqual({
      id: 'bb-1',
      connectUrl: 'wss://connect.example/bb-1',
    });
    expect(calls[0].body).toEqual({
      projectId: 'proj-1',
      keepAlive: false,
      browserSettings: SESSION_PRIVACY,
    });
    expect(SESSION_PRIVACY).toEqual({ recordSession: false, logSession: false });
    await createSession(
      {
        keepAlive: true,
        timeout: 90,
        context: { id: 'ctx-1', persist: false },
        allowedDomains: ['api.example'],
        viewport: { width: 10, height: 20 },
      },
      { fetcher },
    );
    expect(calls[1].body).toEqual({
      projectId: 'proj-1',
      keepAlive: true,
      timeout: 90,
      browserSettings: {
        recordSession: false,
        logSession: false,
        viewport: { width: 10, height: 20 },
        context: { id: 'ctx-1', persist: false },
        allowedDomains: ['api.example'],
      },
    });
  });

  test('a session with no connect url gets the built one; no id is an error', async () => {
    delete process.env.BROWSERBASE_PROJECT_ID;
    const { calls, fetcher } = recorder(() => json({ id: 'bb 2' }));
    const created = await createSession({}, { fetcher });
    expect(created.connectUrl).toBe('wss://connect.browserbase.com?apiKey=bb-test-key&sessionId=bb%202');
    expect(calls[0].body.projectId).toBeUndefined();
    expect(sessionIdFromConnectUrl(created.connectUrl)).toBe('bb 2');
    expect(sessionIdFromConnectUrl('not a url')).toBeNull();
    const empty = recorder(() => json({}));
    await expect(createSession({}, { fetcher: empty.fetcher })).rejects.toThrow(
      'Browserbase returned no session id.',
    );
  });

  test('live urls, release, and contexts use their paths', async () => {
    const { calls, fetcher } = recorder((call) =>
      call.url.endsWith('/debug')
        ? json({ debuggerFullscreenUrl: 'https://live.example' })
        : call.url.endsWith('/contexts')
          ? json({ id: 'ctx-9' })
          : new Response(null, { status: 204 }),
    );
    expect(await sessionLiveUrls('bb-1', { fetcher })).toEqual({
      debuggerFullscreenUrl: 'https://live.example',
    });
    await releaseSession('bb-1', { fetcher });
    expect(await createContext({ fetcher })).toBe('ctx-9');
    await deleteContext('ctx-9', { fetcher });
    expect(calls.map((call) => `${call.method} ${call.url.replace(BROWSERBASE_API_BASE, '')}`)).toEqual([
      'GET /sessions/bb-1/debug',
      'POST /sessions/bb-1',
      'POST /contexts',
      'DELETE /contexts/ctx-9',
    ]);
    expect(calls[1].body).toEqual({ projectId: 'proj-1', status: 'REQUEST_RELEASE' });
    expect(calls[2].body).toEqual({ projectId: 'proj-1' });
    const empty = recorder(() => json({}));
    await expect(createContext({ fetcher: empty.fetcher })).rejects.toThrow(
      'Browserbase returned no context id.',
    );
  });

  test('downloads: list by session, bytes as octet-stream, delete', async () => {
    const { calls, fetcher } = recorder((call) => {
      if (call.url.includes('/downloads?'))
        return json({
          downloads: [
            { id: 'd1', sessionId: 's1', filename: 'a.pdf', mimeType: 'application/pdf', size: 3 },
            {},
          ],
        });
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    expect(
      (await listDownloads({ sessionId: 's1', limit: 500 }, { fetcher })).map((item) => item.id),
    ).toEqual(['d1']);
    expect(await downloadBytes('d1', { fetcher })).toEqual(new Uint8Array([1, 2, 3]));
    await deleteDownload('d1', { fetcher });
    expect(calls[0].url).toBe(`${BROWSERBASE_API_BASE}/downloads?sessionId=s1&limit=100`);
    expect(calls[1].headers.accept).toBe('application/octet-stream');
    expect(calls[2].method).toBe('DELETE');
    const none = recorder(() => json({}));
    expect(await listDownloads({ sessionId: 's1', limit: 0 }, { fetcher: none.fetcher })).toEqual([]);
    expect(none.calls[0].url).toContain('limit=1');
  });
});
