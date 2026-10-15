import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * browser_download: the runner's browser keeps downloads (download behavior
 * set on connect), and the Downloads API brings the file into Files.
 * playwright-core is mocked at the loader level; no browser starts.
 */

const events: unknown[][] = [];
let downloadState: 'none' | 'ok' | 'failed' = 'ok';
let gotoMode: 'download' | 'page' = 'download';

const fakeDownload = () => ({
  suggestedFilename: () => 'pay-2026-09.pdf',
  url: () => 'https://pay.example/doc/42?token=abc',
  failure: async () => (downloadState === 'failed' ? 'network' : null),
});

const page: any = {
  url: () => 'https://pay.example/statements',
  waitForEvent: async (name: string, options: unknown) => {
    events.push(['waitForEvent', name, options]);
    if (downloadState === 'none') return new Promise(() => undefined);
    return fakeDownload();
  },
  goto: async (url: string) => {
    events.push(['goto', url]);
    if (gotoMode === 'download') throw new Error('page.goto: Download is starting\nlog');
  },
  locator: (selector: string) => ({
    click: async () => {
      events.push(['click', selector]);
      if (selector.includes('e9')) throw new Error('Element is not visible\nlog');
    },
  }),
  waitForLoadState: async () => undefined,
  evaluate: async (fn: (arg: any) => unknown, arg: any) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('a,b', {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })) as unknown as typeof fetch;
    try {
      return await fn(arg);
    } finally {
      globalThis.fetch = original;
    }
  },
};

mock.module('playwright-core', () => ({
  chromium: {
    connectOverCDP: async () => ({
      newBrowserCDPSession: async () => ({
        send: async (method: string, params: unknown) => {
          events.push(['cdp', method, params]);
        },
      }),
      contexts: () => [{ pages: () => [page], newPage: async () => page }],
      close: async () => undefined,
    }),
  },
}));

const { AgentBrowser, BrowserHandoffRequired, playwrightAgentConnector } = await import(
  '../lib/albatross/browser-agent'
);
const { buildRunnerTools } = await import('../lib/albatross/step-run-tools');
const { runWithAiRequestContext } = await import('../lib/ai/context');
const { __setFilePullDepsForTest } = await import('../lib/web/file-pull');

const SNAPSHOT = [
  '- link "Download PDF" [ref=e4]',
  '- button "Submit payment" [ref=e5]',
  '- link "Hidden" [ref=e9]',
].join('\n');
const PDF = new Uint8Array(Buffer.from('%PDF-1.7 pay'));

beforeEach(() => {
  events.length = 0;
  downloadState = 'ok';
  gotoMode = 'download';
});
afterEach(() => __setFilePullDepsForTest());

async function connectedBrowser() {
  const connection = await playwrightAgentConnector('wss://connect.browserbase.com?apiKey=k&sessionId=bb-7');
  const agentPage = (await connection.page())!;
  agentPage.snapshot = async () => SNAPSHOT;
  agentPage.title = async () => 'Statements';
  const browser = new AgentBrowser(agentPage, null);
  await browser.snapshot();
  return { browser, agentPage };
}

describe('the connector keeps downloads', () => {
  test('connect sets the download behavior; the page knows its session', async () => {
    const { browser } = await connectedBrowser();
    expect(events[0]).toEqual([
      'cdp',
      'Browser.setDownloadBehavior',
      { behavior: 'allow', downloadPath: 'downloads', eventsEnabled: true },
    ]);
    expect(browser.sessionId()).toBe('bb-7');
  });

  test('a click on a download link waits for the end of the download', async () => {
    const { browser } = await connectedBrowser();
    gotoMode = 'page';
    expect(await browser.download({ ref: 'e4' })).toEqual({
      via: 'download',
      filename: 'pay-2026-09.pdf',
      sourceUrl: 'https://pay.example/doc/42?token=abc',
    });
    expect(events).toContainEqual(['click', 'aria-ref=e4']);
    downloadState = 'failed';
    await expect(browser.download({ ref: 'e4' })).rejects.toThrow('The download failed: network');
    downloadState = 'ok';
    await expect(browser.download({ ref: 'e9' })).rejects.toThrow('Element is not visible');
  });

  test('a file address starts a download; with none, the page file comes from the page', async () => {
    const { browser } = await connectedBrowser();
    expect(await browser.download({ url: 'https://pay.example/doc/42' })).toMatchObject({ via: 'download' });
    gotoMode = 'page';
    downloadState = 'none';
    const shown = await browser.download({});
    expect(shown.via).toBe('page');
    if (shown.via === 'page') {
      expect(shown.sourceUrl).toBe('https://pay.example/statements');
      expect(new TextDecoder().decode(shown.file.bytes)).toBe('a,b');
    }
  });

  test('browser_open on a file address says to use browser_download', async () => {
    const { browser } = await connectedBrowser();
    await expect(browser.open('https://pay.example/doc/42.pdf')).rejects.toThrow(
      'This address is a file, not a page. Save it with browser_download and url.',
    );
  });
});

function fakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: async () => undefined,
    url: () => 'https://pay.example/statements',
    title: async () => 'Statements',
    snapshot: async () => SNAPSHOT,
    click: async () => undefined,
    fill: async () => undefined,
    select: async () => undefined,
    press: async () => undefined,
    back: async () => undefined,
    wait: async () => undefined,
    inputKind: async () => null,
    text: async () => '',
    ...overrides,
  } as any;
}

describe('AgentBrowser.download rules', () => {
  test('a ref that commits the user is refused; an unknown ref is refused', async () => {
    const browser = new AgentBrowser(
      fakePage({ downloadFrom: async () => null, fetchInPage: async () => ({}) }),
    );
    await browser.snapshot();
    await expect(browser.download({ ref: 'e5' })).rejects.toBeInstanceOf(BrowserHandoffRequired);
    await expect(browser.download({ ref: 'e77' })).rejects.toThrow('not in the latest snapshot');
    await expect(browser.download({ ref: 'e4' })).rejects.toThrow('The click started no download.');
  });

  test('a page without download support, a private address, and other open errors', async () => {
    const plain = new AgentBrowser(fakePage());
    expect(plain.sessionId()).toBeNull();
    await expect(plain.download({ url: 'https://a.test/x.pdf' })).rejects.toThrow(
      'This browser cannot save files.',
    );
    const browser = new AgentBrowser(
      fakePage({ downloadFrom: async () => null, fetchInPage: async () => ({}) }),
    );
    await expect(browser.download({ url: 'http://192.168.0.1/x.pdf' })).rejects.toThrow(
      'Only files on public http and https sites can be saved.',
    );
    const blob = new AgentBrowser(
      fakePage({
        downloadFrom: async () => ({ filename: 'a.csv', url: 'blob:https://pay.example/1' }),
        fetchInPage: async () => ({}),
      }),
    );
    expect(await blob.download({ url: 'https://pay.example/export' })).toEqual({
      via: 'download',
      filename: 'a.csv',
      sourceUrl: 'https://pay.example/export',
    });
    const failing = new AgentBrowser(
      fakePage({
        goto: async () => {
          throw new Error('net::ERR_NAME_NOT_RESOLVED');
        },
      }),
    );
    await expect(failing.open('https://nope.example/')).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
  });
});

describe('the browser_download runner tool', () => {
  function host(page: any) {
    const artifacts: unknown[] = [];
    const logs: string[] = [];
    const browser = new AgentBrowser(page);
    return {
      artifacts,
      logs,
      browser,
      host: {
        log: async (line: string) => {
          logs.push(line);
        },
        artifact: async (artifact: unknown) => {
          artifacts.push(artifact);
        },
        browser: async () => browser,
        browserStatus: async () => undefined,
        enqueueApproval: async () => 'a',
        finish: () => undefined,
        browserAvailable: true,
      },
    };
  }

  test('saves the file, records a file artifact, and logs the host', async () => {
    __setFilePullDepsForTest({
      sessionDownloadIds: async () => new Set(),
      collectDownload: (async () => ({
        download: {
          id: 'd',
          sessionId: 'bb-7',
          filename: 'pay.pdf',
          mimeType: 'application/pdf',
          size: PDF.length,
        },
        bytes: PDF,
      })) as any,
      saveFileBytes: (async (input: any) => ({
        fileId: 'file-9',
        title: input.name,
        openPath: '/?view=files&file=file-9',
        size: input.bytes.byteLength,
        contentType: input.contentType,
        sha256: 'abc',
        sourceUrl: input.sourceUrl,
      })) as any,
    });
    const run = host(
      fakePage({
        sessionId: () => 'bb-7',
        downloadFrom: async () => ({ filename: 'pay.pdf', url: 'https://pay.example/doc/42?token=abc' }),
        fetchInPage: async () => ({}),
      }),
    );
    await run.browser.snapshot();
    const tools = buildRunnerTools({}, run.host as any);
    const result = await runWithAiRequestContext({ userId: 'user-1' }, () =>
      tools.browser_download.execute({ ref: 'e4', name: 'September pay' }),
    );
    expect(result).toEqual({
      ok: true,
      fileId: 'file-9',
      title: 'September pay.pdf',
      openPath: '/?view=files&file=file-9',
      size: PDF.length,
      contentType: 'application/pdf',
      sourceUrl: 'https://pay.example/doc/42',
      sha256: 'abc',
    });
    expect(run.artifacts).toEqual([
      { kind: 'file', id: 'file-9', title: 'September pay.pdf', url: '/?view=files&file=file-9' },
    ]);
    expect(run.logs).toEqual(['Saved September pay.pdf from pay.example.']);
  });

  test('no user, a handoff, and an error each give a plain result', async () => {
    const run = host(
      fakePage({ sessionId: () => 'bb-7', downloadFrom: async () => null, fetchInPage: async () => ({}) }),
    );
    const tools = buildRunnerTools({}, run.host as any);
    expect(await tools.browser_download.execute({ ref: 'e4' })).toEqual({
      ok: false,
      message: 'Sign in required to save a file.',
    });
    __setFilePullDepsForTest({ sessionDownloadIds: async () => new Set() });
    await run.browser.snapshot();
    const handoff = await runWithAiRequestContext({ userId: 'u' }, () =>
      tools.browser_download.execute({ ref: 'e5' }),
    );
    expect(handoff).toMatchObject({ ok: false, status: 'needs_user', reason: 'final_action' });
    const failed = await runWithAiRequestContext({ userId: 'u' }, () =>
      tools.browser_download.execute({ ref: 'e4' }),
    );
    expect(failed).toEqual({
      ok: false,
      message:
        'The click started no download. Find the link to the file, or call browser_download with its url.',
    });
  });
});
