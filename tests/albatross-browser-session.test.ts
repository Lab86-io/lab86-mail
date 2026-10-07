import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  BrowserbaseRequestError,
  browserSessionsConfigured,
  createBrowserContext,
  createBrowserSession,
  deleteBrowserContext,
  navigateSession,
  readSessionPage,
  releaseBrowserSession,
  sessionConnectUrl,
  sessionReplayUrl,
} from '../lib/albatross/browser-session';

const originalKey = process.env.BROWSERBASE_API_KEY;

beforeEach(() => {
  process.env.BROWSERBASE_API_KEY = 'bb-test-key';
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.BROWSERBASE_API_KEY;
  else process.env.BROWSERBASE_API_KEY = originalKey;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('browser session REST client', () => {
  test('configured only when a key is present', () => {
    expect(browserSessionsConfigured()).toBe(true);
    delete process.env.BROWSERBASE_API_KEY;
    expect(browserSessionsConfigured()).toBe(false);
  });

  test('create opens a keep-alive session without a recording and resolves the live view', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = mock(async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/sessions')) {
        return jsonResponse({ id: 'bb-1', connectUrl: 'wss://connect.example/bb-1' });
      }
      return jsonResponse({ debuggerFullscreenUrl: 'https://live.example/bb-1' });
    });
    const session = await createBrowserSession(fetcher as any);
    expect(session).toEqual({
      sessionId: 'bb-1',
      connectUrl: 'wss://connect.example/bb-1',
      liveViewUrl: 'https://live.example/bb-1',
      replayUrl: 'https://browserbase.com/sessions/bb-1',
    });
    const createCall = calls[0];
    expect(createCall.url).toBe('https://api.browserbase.com/v1/sessions');
    const body = JSON.parse(String(createCall.init?.body));
    expect(body).toMatchObject({
      keepAlive: true,
      timeout: 3_600,
      // Runs type personal details and users sign in here: no recording.
      browserSettings: { recordSession: false },
    });
    expect((createCall.init?.headers as any)['x-bb-api-key']).toBe('bb-test-key');
    expect(calls[1].url).toBe('https://api.browserbase.com/v1/sessions/bb-1/debug');
  });

  test('a failed API call surfaces status and body, never silence', async () => {
    const fetcher = mock(async () => new Response('key invalid', { status: 401 }));
    await expect(createBrowserSession(fetcher as any)).rejects.toThrow(
      'Browserbase /sessions failed (401): key invalid',
    );
  });

  test('a missing key refuses before any network call', async () => {
    delete process.env.BROWSERBASE_API_KEY;
    const fetcher = mock(async () => jsonResponse({}));
    await expect(createBrowserSession(fetcher as any)).rejects.toThrow(
      'Browser sessions are not configured.',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('release requests the session release', async () => {
    const calls: string[] = [];
    const fetcher = mock(async (url: any, init?: any) => {
      calls.push(`${String(url)} ${JSON.parse(String(init?.body)).status}`);
      return jsonResponse({});
    });
    await releaseBrowserSession('bb-9', fetcher as any);
    expect(calls).toEqual(['https://api.browserbase.com/v1/sessions/bb-9 REQUEST_RELEASE']);
  });

  test('a session with saved sign-ins carries the context and its persist flag', async () => {
    const bodies: any[] = [];
    const fetcher = mock(async (url: any, init?: any) => {
      if (String(url).endsWith('/sessions')) {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: 'bb-2', connectUrl: 'wss://connect.example/bb-2' });
      }
      return jsonResponse({ debuggerFullscreenUrl: 'https://live.example/bb-2' });
    });
    await createBrowserSession(fetcher as any, { contextId: 'ctx-1', persist: true });
    await createBrowserSession(fetcher as any, { contextId: 'ctx-1' });
    expect(bodies[0].browserSettings.context).toEqual({ id: 'ctx-1', persist: true });
    expect(bodies[1].browserSettings.context).toEqual({ id: 'ctx-1', persist: false });
  });

  test('contexts are created and deleted; a context that is gone counts as deleted', async () => {
    const calls: string[] = [];
    const fetcher = mock(async (url: any, init?: any) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'POST') return jsonResponse({ id: 'ctx-9' });
      if (String(url).endsWith('/gone')) return new Response('missing', { status: 404 });
      if (String(url).endsWith('/broken')) return new Response('boom', { status: 500 });
      return new Response(null, { status: 204 });
    });
    expect(await createBrowserContext(fetcher as any)).toBe('ctx-9');
    await deleteBrowserContext('ctx-9', fetcher as any);
    await deleteBrowserContext('gone', fetcher as any);
    const failed = await deleteBrowserContext('broken', fetcher as any).catch((error) => error);
    expect(failed).toBeInstanceOf(BrowserbaseRequestError);
    expect(failed.status).toBe(500);
    expect(calls).toEqual([
      'POST https://api.browserbase.com/v1/contexts',
      'DELETE https://api.browserbase.com/v1/contexts/ctx-9',
      'DELETE https://api.browserbase.com/v1/contexts/gone',
      'DELETE https://api.browserbase.com/v1/contexts/broken',
    ]);
    const empty = mock(async () => jsonResponse({}));
    await expect(createBrowserContext(empty as any)).rejects.toThrow('Browserbase returned no context id.');
  });

  test('the connect url carries the key and the session id, encoded', () => {
    expect(sessionConnectUrl('bb 1')).toBe(
      'wss://connect.browserbase.com?apiKey=bb-test-key&sessionId=bb%201',
    );
  });

  test('replay url is the public session record', () => {
    expect(sessionReplayUrl('abc')).toBe('https://browserbase.com/sessions/abc');
  });
});

function fakeConnector(
  page: {
    goto?: (url: string) => Promise<unknown>;
    url: () => string;
    title: () => Promise<string>;
    innerText: () => Promise<string>;
  } | null,
) {
  const close = mock(async () => undefined);
  const connector = mock(async () => ({
    page: async () => page,
    close,
  }));
  return { connector, close };
}

describe('session page access over CDP', () => {
  test('navigate points the open page at the step url and closes the handle', async () => {
    const goto = mock(async () => undefined);
    const { connector, close } = fakeConnector({
      goto,
      url: () => 'about:blank',
      title: async () => '',
      innerText: async () => '',
    });
    await navigateSession('wss://connect.example', 'https://county.example/form', connector as any);
    expect(goto).toHaveBeenCalledWith('https://county.example/form');
    expect(close).toHaveBeenCalled();
  });

  test('navigate with no open page fails loudly and still closes', async () => {
    const { connector, close } = fakeConnector(null);
    await expect(
      navigateSession('wss://connect.example', 'https://x.example', connector as any),
    ).rejects.toThrow('The shared browser has no open page.');
    expect(close).toHaveBeenCalled();
  });

  test('read returns bounded, whitespace-collapsed page state', async () => {
    const { connector } = fakeConnector({
      url: () => 'https://county.example/confirmation',
      title: async () => 'Application received',
      innerText: async () => '  Your \n\n reference   number is AB-1234.  ',
    });
    const state = await readSessionPage('wss://connect.example', connector as any);
    expect(state).toEqual({
      url: 'https://county.example/confirmation',
      title: 'Application received',
      text: 'Your reference number is AB-1234.',
    });
  });

  test('read with no open page fails loudly', async () => {
    const { connector } = fakeConnector(null);
    await expect(readSessionPage('wss://connect.example', connector as any)).rejects.toThrow(
      'The shared browser has no open page.',
    );
  });
});
