import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  browserSessionsConfigured,
  createBrowserSession,
  navigateSession,
  readSessionPage,
  releaseBrowserSession,
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

  test('create opens a keep-alive recorded session and resolves the live view', async () => {
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
      browserSettings: { recordSession: true },
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

  test('replay url is the public session record', () => {
    expect(sessionReplayUrl('abc')).toBe('https://browserbase.com/sessions/abc');
  });
});

function fakeConnector(page: {
  goto?: (url: string) => Promise<unknown>;
  url: () => string;
  title: () => Promise<string>;
  innerText: () => Promise<string>;
} | null) {
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
