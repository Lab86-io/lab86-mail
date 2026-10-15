import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';

/**
 * Short Browserbase sessions. playwright-core is mocked at the loader level,
 * so the lazy import in the connector gets this fake and no browser starts.
 */

type Mode = 'page' | 'download' | 'download-failed' | 'download-missing' | 'error';
let mode: Mode = 'page';
const events: unknown[][] = [];
let cdpHandlers: Record<string, (event: any) => void> = {};
let cdpScript: (send: (event: any) => void) => Promise<void> = async () => undefined;

const fakeCdp = {
  send: async (method: string, params?: any) => {
    events.push(['cdp', method, params]);
    if (method === 'Fetch.getResponseBody')
      return { body: Buffer.from('{"ok":true}').toString('base64'), base64Encoded: true };
    return {};
  },
  on: (event: string, handler: (event: any) => void) => {
    cdpHandlers[event] = handler;
  },
  detach: async () => {
    events.push(['cdp', 'detach']);
  },
};

const fakeDownload = (failure: string | null) => ({
  suggestedFilename: () => 'fw9.pdf',
  url: () => 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
  failure: async () => failure,
});

const fakePage: any = {
  waitForEvent: async (name: string, options: unknown) => {
    events.push(['waitForEvent', name, options]);
    if (mode === 'download') return fakeDownload(null);
    if (mode === 'download-failed') return fakeDownload('canceled');
    throw new Error('Timeout 20000ms exceeded');
  },
  goto: async (url: string, options: any) => {
    events.push(['goto', url, options]);
    if (options?.waitUntil === 'commit') {
      await cdpScript((event) => cdpHandlers['Fetch.requestPaused']?.(event));
      return null;
    }
    if (mode.startsWith('download')) throw new Error('page.goto: Download is starting\nCall log: x');
    if (mode === 'error') throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED\nCall log: x');
    return { status: () => 200, headerValue: async () => 'Text/HTML; charset=utf-8' };
  },
  url: () => 'https://example.com/page',
  title: async () => 'Example',
  innerText: async () => {
    throw new Error('detached');
  },
  evaluate: async (fn: (arg: any) => unknown, arg: any) => {
    // The function runs in the browser; here it runs with a stubbed fetch.
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(arg.url.includes('big') ? 'x'.repeat(20) : 'a,b\n1,2', {
        status: 200,
        headers: { 'content-type': 'Text/CSV; charset=utf-8' },
      })) as unknown as typeof fetch;
    try {
      return await fn(arg);
    } finally {
      globalThis.fetch = original;
    }
  },
  context: () => ({ newCDPSession: async () => fakeCdp }),
};

let pages: any[] = [fakePage];
mock.module('playwright-core', () => ({
  chromium: {
    connectOverCDP: async (url: string, options: unknown) => {
      events.push(['connect', url, options]);
      return {
        newBrowserCDPSession: async () => ({
          send: async (method: string, params: unknown) => {
            events.push(['browser-cdp', method, params]);
          },
        }),
        contexts: () => [
          {
            pages: () => pages,
            newPage: async () => {
              events.push(['newPage']);
              return fakePage;
            },
          },
        ],
        close: async () => {
          events.push(['close']);
        },
      };
    },
  },
}));

const session = await import('../lib/web/session');
const {
  __setWebSessionDepsForTest,
  collectDownload,
  DOWNLOAD_BEHAVIOR,
  DownloadError,
  deleteSessionDownloads,
  exactUrlPattern,
  inPageFetch,
  playwrightSessionConnector,
  requestThroughFetchDomain,
  sessionDownloadIds,
  withShortSession,
} = session;

beforeEach(() => {
  events.length = 0;
  mode = 'page';
  pages = [fakePage];
  cdpHandlers = {};
  cdpScript = async () => undefined;
});
afterEach(() => __setWebSessionDepsForTest());

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('playwrightSessionConnector', () => {
  test('connects, sets the download behavior, and reads a page', async () => {
    const connection = await playwrightSessionConnector('wss://connect.example?sessionId=s1');
    expect(events[0]).toEqual(['connect', 'wss://connect.example?sessionId=s1', { timeout: 30_000 }]);
    expect(events[1]).toEqual(['browser-cdp', 'Browser.setDownloadBehavior', DOWNLOAD_BEHAVIOR]);
    expect(DOWNLOAD_BEHAVIOR).toEqual({ behavior: 'allow', downloadPath: 'downloads', eventsEnabled: true });
    expect(await connection.page.open('https://example.com/page')).toEqual({
      kind: 'page',
      url: 'https://example.com/page',
      status: 200,
      contentType: 'text/html',
    });
    expect(await connection.page.title()).toBe('Example');
    expect(await connection.page.text()).toBe('');
    await connection.close();
    expect(events.at(-1)).toEqual(['close']);
  });

  test('an open that starts a download waits for its end', async () => {
    pages = [];
    const connection = await playwrightSessionConnector('wss://c');
    expect(events).toContainEqual(['newPage']);
    mode = 'download';
    expect(await connection.page.open('https://www.irs.gov/pub/irs-pdf/fw9.pdf')).toEqual({
      kind: 'download',
      filename: 'fw9.pdf',
      url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
    });
    mode = 'download-failed';
    await expect(connection.page.open('https://x.example/f.pdf')).rejects.toThrow(
      'The download failed: canceled',
    );
    mode = 'download-missing';
    pages = [fakePage];
    const original = fakePage.goto;
    fakePage.goto = async () => {
      throw new Error('page.goto: Download is starting');
    };
    await expect(connection.page.open('https://x.example/f.pdf')).rejects.toThrow(
      'The download did not start.',
    );
    fakePage.goto = original;
    mode = 'error';
    await expect(connection.page.open('https://nope.example/')).rejects.toThrow(
      'page.goto: net::ERR_NAME_NOT_RESOLVED',
    );
  });

  test('fetchInPage reads the file on the page, and refuses a file over the limit', async () => {
    const connection = await playwrightSessionConnector('wss://c');
    const file = await connection.page.fetchInPage('https://example.com/data.csv', 1_000);
    expect(file.status).toBe(200);
    expect(file.contentType).toBe('text/csv');
    expect(new TextDecoder().decode(file.bytes)).toBe('a,b\n1,2');
    expect(await connection.page.fetchInPage('https://example.com/big.csv', 10)).toMatchObject({
      tooLarge: true,
    });
  });

  test('requestWithHeaders runs through the Fetch domain and detaches', async () => {
    cdpScript = async (emit) => {
      emit({ requestId: 'r1', request: { url: 'https://api.example/v1/me', headers: {} } });
      await tick();
      emit({ requestId: 'r1', responseStatusCode: 200, responseHeaders: [] });
      await tick();
    };
    const connection = await playwrightSessionConnector('wss://c');
    const answer = await connection.page.requestWithHeaders({
      url: 'https://api.example/v1/me',
      method: 'GET',
      headers: { Authorization: 'Bearer test' },
      maxBytes: 100,
    });
    expect(answer).toEqual({ status: 200, headers: {}, body: '{"ok":true}', cut: false });
    expect(events.at(-1)).toEqual(['cdp', 'detach']);
  });
});

describe('inPageFetch', () => {
  test('a declared length over the limit stops before the body', async () => {
    const page = {
      evaluate: async (fn: (arg: any) => unknown, arg: any) => {
        const original = globalThis.fetch;
        globalThis.fetch = (async () =>
          new Response('x', {
            status: 200,
            headers: { 'content-length': '999' },
          })) as unknown as typeof fetch;
        try {
          return await fn(arg);
        } finally {
          globalThis.fetch = original;
        }
      },
    };
    expect(await inPageFetch(page as any, 'https://example.com/f', 10)).toEqual({
      status: 200,
      contentType: '',
      url: 'https://example.com/f',
      tooLarge: true,
    });
  });
});

describe('requestThroughFetchDomain', () => {
  function cdp(script: (emit: (event: any) => void) => Promise<void>, body = '{"a":1}') {
    const sent: Array<[string, any]> = [];
    let handler: (event: any) => void = () => undefined;
    const client = {
      send: async (method: string, params?: any) => {
        sent.push([method, params]);
        if (method === 'Fetch.getResponseBody') return { body, base64Encoded: false };
        return {};
      },
      on: (_event: 'Fetch.requestPaused', next: (event: any) => void) => {
        handler = next;
      },
    };
    const navigate = async () => {
      await script((event) => handler(event));
      throw new Error('net::ERR_ABORTED');
    };
    return { client, sent, navigate };
  }
  const input = {
    url: 'https://api.example/v1/items?q=a*b#frag',
    method: 'GET' as const,
    headers: { Authorization: 'Bearer test-value' },
    maxBytes: 4,
  };

  test('only the request to the address gets the headers; the answer is read and stopped', async () => {
    const { client, sent, navigate } = cdp(async (emit) => {
      emit({ requestId: 'r0', request: { url: 'https://api.example/other', headers: {} } });
      emit({
        requestId: 'r1',
        request: { url: 'https://api.example/v1/items?q=a*b', headers: { Accept: '*/*' } },
      });
      await tick();
      emit({ requestId: 'r2', request: { url: 'https://api.example/v1/items?q=a*b', headers: {} } });
      emit({
        requestId: 'r1',
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      });
      await tick();
    });
    const answer = await requestThroughFetchDomain(client, input, navigate);
    expect(answer).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"a"',
      cut: true,
    });
    expect(sent[0]).toEqual([
      'Fetch.enable',
      {
        patterns: [
          { urlPattern: 'https://api.example/v1/items\\?q=a\\*b', requestStage: 'Request' },
          { urlPattern: 'https://api.example/v1/items\\?q=a\\*b', requestStage: 'Response' },
        ],
      },
    ]);
    expect(sent).toContainEqual(['Fetch.failRequest', { requestId: 'r0', errorReason: 'BlockedByClient' }]);
    expect(sent).toContainEqual([
      'Fetch.continueRequest',
      {
        requestId: 'r1',
        method: 'GET',
        headers: [
          { name: 'Accept', value: '*/*' },
          { name: 'Authorization', value: 'Bearer test-value' },
        ],
      },
    ]);
    expect(sent).toContainEqual(['Fetch.failRequest', { requestId: 'r2', errorReason: 'BlockedByClient' }]);
    expect(sent).toContainEqual(['Fetch.failRequest', { requestId: 'r1', errorReason: 'Aborted' }]);
    expect(sent.at(-1)).toEqual(['Fetch.disable', undefined]);
  });

  test('a redirect is reported with its location and not followed; HEAD reads no body', async () => {
    const redirect = cdp(async (emit) => {
      emit({ requestId: 'r1', request: { url: 'https://api.example/v1/items?q=a*b', headers: {} } });
      await tick();
      emit({
        requestId: 'r1',
        responseStatusCode: 302,
        responseHeaders: [{ name: 'Location', value: '/login' }],
      });
      await tick();
    });
    expect(await requestThroughFetchDomain(redirect.client, input, redirect.navigate)).toEqual({
      status: 302,
      headers: { location: '/login' },
      body: '',
      cut: false,
      location: '/login',
    });
    expect(redirect.sent.some(([method]) => method === 'Fetch.getResponseBody')).toBe(false);
    const head = cdp(async (emit) => {
      emit({ requestId: 'r1', request: { url: 'https://api.example/v1/items?q=a*b', headers: {} } });
      await tick();
      emit({ requestId: 'r1', responseStatusCode: 204 });
      await tick();
    });
    expect(await requestThroughFetchDomain(head.client, { ...input, method: 'HEAD' }, head.navigate)).toEqual(
      {
        status: 204,
        headers: {},
        body: '',
        cut: false,
      },
    );
  });

  test('a network error and a call that never went out are errors', async () => {
    const broken = cdp(async (emit) => {
      emit({ requestId: 'r1', request: { url: 'https://api.example/v1/items?q=a*b', headers: {} } });
      await tick();
      emit({ requestId: 'r1', responseErrorReason: 'ConnectionRefused' });
      await tick();
    });
    await expect(requestThroughFetchDomain(broken.client, input, broken.navigate)).rejects.toThrow(
      'The call failed (ConnectionRefused).',
    );
    const silent = cdp(async () => undefined);
    await expect(requestThroughFetchDomain(silent.client, input, silent.navigate)).rejects.toThrow(
      'The call did not go out.',
    );
    const failing = cdp(async (emit) => {
      emit({ requestId: 'r1', request: { url: 'https://api.example/v1/items?q=a*b', headers: {} } });
      await tick();
    });
    failing.client.send = async (method: string) => {
      if (method === 'Fetch.continueRequest') throw new Error('Target closed\nmore');
      return {};
    };
    await expect(requestThroughFetchDomain(failing.client, input, failing.navigate)).rejects.toThrow(
      'Target closed',
    );
    expect(exactUrlPattern('https://a.test/x?y=*\\')).toBe('https://a.test/x\\?y=\\*\\\\');
  });
});

describe('withShortSession', () => {
  test('creates a private session, runs the task, then disconnects and releases', async () => {
    const calls: unknown[] = [];
    __setWebSessionDepsForTest({
      createSession: async (input) => {
        calls.push(['create', input]);
        return { id: 's1', connectUrl: 'wss://c?sessionId=s1' };
      },
      connect: async (url) => {
        calls.push(['connect', url]);
        return {
          page: {} as any,
          close: async () => {
            calls.push(['close']);
          },
        };
      },
      releaseSession: async (id) => {
        calls.push(['release', id]);
      },
    });
    expect(
      await withShortSession(
        { contextId: 'ctx-1', allowedDomains: ['api.example'], timeoutSeconds: 10 },
        async (_page, id) => id,
      ),
    ).toBe('s1');
    expect(calls).toEqual([
      [
        'create',
        {
          keepAlive: false,
          timeout: 60,
          context: { id: 'ctx-1', persist: false },
          allowedDomains: ['api.example'],
        },
      ],
      ['connect', 'wss://c?sessionId=s1'],
      ['close'],
      ['release', 's1'],
    ]);
    calls.length = 0;
    await expect(
      withShortSession({}, async () => {
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');
    expect(calls.at(0)).toEqual(['create', { keepAlive: false, timeout: 120 }]);
    expect(calls.at(-1)).toEqual(['release', 's1']);
  });

  test('a failed connect still releases the session; an aborted signal starts nothing', async () => {
    const released: string[] = [];
    let created = 0;
    __setWebSessionDepsForTest({
      createSession: async () => {
        created += 1;
        return { id: 's2', connectUrl: 'wss://c' };
      },
      connect: async () => {
        throw new Error('connect failed');
      },
      releaseSession: async (id) => {
        released.push(id);
      },
    });
    await expect(withShortSession({}, async () => 1)).rejects.toThrow('connect failed');
    expect(released).toEqual(['s2']);
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(withShortSession({ signal: controller.signal }, async () => 1)).rejects.toThrow('stopped');
    expect(created).toBe(1);
  });
});

describe('downloads', () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);
  const checksum = createHash('sha256').update(bytes).digest('hex');

  function store(lists: Array<Array<Record<string, unknown>>>, data = bytes) {
    const deleted: string[] = [];
    const slept: number[] = [];
    let round = 0;
    __setWebSessionDepsForTest({
      listDownloads: async () => (lists[Math.min(round++, lists.length - 1)] as any) ?? [],
      downloadBytes: async () => data,
      deleteDownload: async (id) => {
        deleted.push(id);
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    return { deleted, slept };
  }

  test('waits for a new file, prefers the same name, checks it, and deletes the copy', async () => {
    const { deleted, slept } = store([
      [{ id: 'old', size: 9 }],
      [
        { id: 'old', size: 9 },
        { id: 'other', filename: 'b.pdf', size: 5, createdAt: '2026-10-15T10:00:02Z' },
        {
          id: 'new',
          filename: 'fw9.pdf',
          size: 5,
          checksum: checksum.toUpperCase(),
          createdAt: '2026-10-15T10:00:01Z',
        },
      ],
    ]);
    const result = await collectDownload('s1', {
      known: new Set(['old']),
      filename: 'fw9.pdf',
      maxBytes: 100,
      intervalMs: 5,
      timeoutMs: 20,
    });
    expect(result.download.id).toBe('new');
    expect(result.bytes).toEqual(bytes);
    expect(deleted).toEqual(['new']);
    expect(slept).toEqual([5]);
  });

  test('no file, a file over the limit, and a changed file are errors', async () => {
    store([[]]);
    const missing = await collectDownload('s1', { maxBytes: 100, intervalMs: 5, timeoutMs: 15 }).catch(
      (e) => e,
    );
    expect(missing).toBeInstanceOf(DownloadError);
    expect(missing.code).toBe('missing');
    const big = store([[{ id: 'd1', size: 3_000_000 }]]);
    await expect(collectDownload('s1', { maxBytes: 2_097_152 })).rejects.toThrow(
      'The file is larger than 2 MB.',
    );
    expect(big.deleted).toEqual(['d1']);
    store([[{ id: 'd2', size: 1 }]], new Uint8Array(10));
    await expect(collectDownload('s1', { maxBytes: 5 })).rejects.toThrow('larger than');
    const changed = store([[{ id: 'd3', size: 5, checksum: 'abc' }]]);
    const error = await collectDownload('s1', { maxBytes: 100 }).catch((e) => e);
    expect(error.code).toBe('checksum');
    expect(changed.deleted).toEqual(['d3']);
  });

  test('ids of a session, and the delete of all its files', async () => {
    const { deleted } = store([[{ id: 'a' }, { id: 'b' }]]);
    expect([...(await sessionDownloadIds('s1'))]).toEqual(['a', 'b']);
    await deleteSessionDownloads('s1');
    expect(deleted).toEqual(['a', 'b']);
    __setWebSessionDepsForTest({
      listDownloads: async () => {
        throw new Error('down');
      },
    });
    await deleteSessionDownloads('s1');
  });
});
