// Short Browserbase sessions for one web task: a file pull, pages that need
// JavaScript or a sign-in, and an API call with a saved key.
//
// Rules (docs/research/browserbase-auth-files-2026-10-15.md section 5.1):
// - Every session keeps no CDP logs and no video (browserbase-client.ts).
// - A session with the user's saved sign-ins reads them and never saves back.
// - The request goes from the Browserbase browser. Never `context.request`:
//   it sends the request from our server, with the browser's cookies.
// - A file comes to our server through the Downloads API, or, for a file the
//   page shows, through an in-page fetch() on the same site.
// - Each session is released when the task ends, also after an error.

import { createHash } from 'node:crypto';
import { api, convexQuery } from '../hosted/convex';
import {
  type BrowserbaseCallOptions,
  createSession,
  deleteDownload,
  downloadBytes,
  listDownloads,
  releaseSession,
  type SessionDownload,
} from './browserbase-client';

const NAVIGATION_TIMEOUT_MS = 25_000;
const DOWNLOAD_EVENT_TIMEOUT_MS = 20_000;

/** What an open gave: a page, or a file download that the browser started. */
export type OpenResult =
  | { kind: 'page'; url: string; status: number | null; contentType: string }
  | { kind: 'download'; filename: string; url: string };

export interface InPageFile {
  status: number;
  contentType: string;
  url: string;
  bytes?: Uint8Array;
  tooLarge?: boolean;
}

export interface SessionResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  cut: boolean;
  /** Set when the site answered with a redirect; the redirect is not followed with the header. */
  location?: string;
}

export interface SessionPage {
  open(url: string): Promise<OpenResult>;
  title(): Promise<string>;
  text(): Promise<string>;
  /** fetch() inside the page, with the page's cookies. Same site only. */
  fetchInPage(url: string, maxBytes: number): Promise<InPageFile>;
  /** Open one address with extra headers on that one request only. */
  requestWithHeaders(input: {
    url: string;
    method: 'GET' | 'HEAD';
    headers: Record<string, string>;
    maxBytes: number;
  }): Promise<SessionResponse>;
}

export interface SessionConnection {
  page: SessionPage;
  close(): Promise<void>;
}

export type SessionConnector = (connectUrl: string) => Promise<SessionConnection>;

function firstLine(error: unknown) {
  return String((error as Error)?.message || error).split('\n')[0];
}

/**
 * Downloads go to Browserbase storage only after this call: Playwright sets
 * its own download path when it connects, and then no file is kept.
 */
export const DOWNLOAD_BEHAVIOR = {
  behavior: 'allow',
  downloadPath: 'downloads',
  eventsEnabled: true,
} as const;

interface EvaluatingPage {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

/**
 * fetch() inside the page, on the page's site and with its cookies. The
 * request goes from the Browserbase browser; the bytes come back over CDP.
 */
export async function inPageFetch(page: EvaluatingPage, url: string, maxBytes: number): Promise<InPageFile> {
  const result = await page.evaluate(
    async ({ url: target, maxBytes: limit }: { url: string; maxBytes: number }) => {
      const response = await fetch(target, { credentials: 'include' });
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > limit)
        return { status: response.status, contentType, url: response.url, tooLarge: true };
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > limit)
        return { status: response.status, contentType, url: response.url, tooLarge: true };
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return { status: response.status, contentType, url: response.url, base64: btoa(binary) };
    },
    { url, maxBytes },
  );
  return {
    status: result.status,
    contentType: String(result.contentType || '').toLowerCase(),
    url: result.url || url,
    ...('tooLarge' in result && result.tooLarge ? { tooLarge: true } : {}),
    ...('base64' in result && typeof result.base64 === 'string'
      ? { bytes: new Uint8Array(Buffer.from(result.base64, 'base64')) }
      : {}),
  };
}

/** The CDP calls requestThroughFetchDomain makes (a Playwright CDPSession). */
export interface FetchDomainSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: 'Fetch.requestPaused', handler: (event: any) => void): unknown;
}

/** A CDP Fetch URL pattern for exactly this address ('*', '?', and '\\' are special). */
export function exactUrlPattern(url: string) {
  return url.replace(/[\\*?]/g, (char) => `\\${char}`);
}

/**
 * One request with extra headers, through the CDP Fetch domain:
 * - Request stage: the one request to the address gets the headers.
 * - Response stage: the server reads the answer and stops it there. A 3xx
 *   answer is not followed, so no redirect hop gets the headers. (A live test
 *   showed that Playwright's route.continue headers do reach the next hop.)
 */
export async function requestThroughFetchDomain(
  cdp: FetchDomainSession,
  input: { url: string; method: 'GET' | 'HEAD'; headers: Record<string, string>; maxBytes: number },
  navigate: () => Promise<unknown>,
): Promise<SessionResponse> {
  const target = new URL(input.url);
  target.hash = '';
  const address = target.toString();
  let sent = false;
  let answer: SessionResponse | null = null;
  let failure: string | null = null;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  cdp.on('Fetch.requestPaused', (event) => {
    void (async () => {
      const requestId = event.requestId;
      if (event.responseStatusCode === undefined && event.responseErrorReason === undefined) {
        // Request stage. Only the first request to the address gets the headers.
        if (sent || event.request?.url !== address) {
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
          return;
        }
        sent = true;
        const merged: Record<string, string> = { ...(event.request?.headers || {}), ...input.headers };
        await cdp.send('Fetch.continueRequest', {
          requestId,
          method: input.method,
          headers: Object.entries(merged).map(([name, value]) => ({ name, value: String(value) })),
        });
        return;
      }
      if (event.responseErrorReason) {
        failure = `The call failed (${event.responseErrorReason}).`;
        await cdp.send('Fetch.continueRequest', { requestId });
        finish();
        return;
      }
      const status = Number(event.responseStatusCode);
      const headers: Record<string, string> = {};
      for (const header of event.responseHeaders || [])
        headers[String(header.name).toLowerCase()] = String(header.value);
      let body = '';
      let cut = false;
      if (input.method !== 'HEAD' && (status < 300 || status >= 400)) {
        const read = await cdp.send('Fetch.getResponseBody', { requestId }).catch(() => null);
        if (read) {
          const bytes = read.base64Encoded
            ? Buffer.from(read.body, 'base64')
            : Buffer.from(String(read.body));
          cut = bytes.byteLength > input.maxBytes;
          body = new TextDecoder().decode(cut ? bytes.subarray(0, input.maxBytes) : bytes);
        }
      }
      answer = {
        status,
        headers,
        body,
        cut,
        ...(status >= 300 && status < 400 ? { location: headers.location || '' } : {}),
      };
      // The answer is read. Stop it here: a redirect is not followed, and no page script runs.
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
      finish();
    })().catch((error) => {
      failure = firstLine(error);
      finish();
    });
  });
  const pattern = exactUrlPattern(address);
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: pattern, requestStage: 'Request' },
      { urlPattern: pattern, requestStage: 'Response' },
    ],
  });
  try {
    const navigation = navigate().catch(() => null);
    await Promise.race([done, navigation.then(() => new Promise((resolve) => setTimeout(resolve, 1_000)))]);
  } finally {
    await cdp.send('Fetch.disable').catch(() => undefined);
  }
  const result = answer as SessionResponse | null;
  if (result) return result;
  throw new Error(failure || (sent ? 'The API did not answer.' : 'The call did not go out.'));
}

/** playwright-core over CDP, loaded lazily so tests can load a fake module. */
export const playwrightSessionConnector: SessionConnector = async (connectUrl) => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: 30_000 });
  try {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', DOWNLOAD_BEHAVIOR);
  } catch {
    // Without it a download is not kept; an open then reports no file.
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  const sessionPage: SessionPage = {
    open: async (url) => {
      const download = page
        .waitForEvent('download', { timeout: DOWNLOAD_EVENT_TIMEOUT_MS })
        .catch(() => null);
      let response: Awaited<ReturnType<typeof page.goto>> = null;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      } catch (error) {
        if (!/download is starting/i.test(firstLine(error))) throw new Error(firstLine(error));
        const started = await download;
        if (!started) throw new Error('The download did not start.');
        // failure() waits for the end of the download; null means it is complete.
        const failure = await started.failure();
        if (failure) throw new Error(`The download failed: ${failure}`);
        return { kind: 'download', filename: started.suggestedFilename(), url: started.url() };
      }
      return {
        kind: 'page',
        url: page.url(),
        status: response?.status() ?? null,
        contentType: ((await response?.headerValue('content-type')) || '').split(';')[0].trim().toLowerCase(),
      };
    },
    title: () => page.title(),
    text: async () => page.innerText('body', { timeout: 5_000 }).catch(() => ''),
    fetchInPage: (url, maxBytes) => inPageFetch(page, url, maxBytes),
    requestWithHeaders: async (input) => {
      const cdp = await page.context().newCDPSession(page);
      try {
        return await requestThroughFetchDomain(cdp, input, () =>
          page.goto(input.url, { waitUntil: 'commit', timeout: 15_000 }),
        );
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    },
  };
  return {
    page: sessionPage,
    // For a browser reached with connectOverCDP, close() disconnects this
    // client only. The session ends by release.
    close: () => browser.close(),
  };
};

/**
 * The user's saved sign-ins (lib/albatross/browser-contexts.ts), or null.
 * A short session only reads them; it never creates or saves a context.
 */
export async function savedSignInContextId(userId: string): Promise<string | null> {
  const saved = await convexQuery<{ contextId?: string } | null>(api.albatrossStepRuns.browserContext, {
    userId,
  });
  return saved?.contextId || null;
}

export interface ShortSessionInput {
  /** The user's saved sign-ins, read only. */
  contextId?: string | null;
  allowedDomains?: string[];
  /** Seconds. Browserbase bills a minimum of one minute. */
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

const sessionDefaults = {
  createSession: (input: Parameters<typeof createSession>[0], options?: BrowserbaseCallOptions) =>
    createSession(input, options),
  releaseSession: (sessionId: string, options?: BrowserbaseCallOptions) => releaseSession(sessionId, options),
  connect: playwrightSessionConnector,
  listDownloads: (input: Parameters<typeof listDownloads>[0], options?: BrowserbaseCallOptions) =>
    listDownloads(input, options),
  downloadBytes: (id: string, options?: BrowserbaseCallOptions) => downloadBytes(id, options),
  deleteDownload: (id: string, options?: BrowserbaseCallOptions) => deleteDownload(id, options),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
let sessionDeps = sessionDefaults;
export function __setWebSessionDepsForTest(overrides: Partial<typeof sessionDefaults> = {}) {
  sessionDeps = { ...sessionDefaults, ...overrides };
}

/**
 * Open a short session, run the task, then disconnect and release it. The
 * task gets the page and the session id (for the Downloads API).
 */
export async function withShortSession<T>(
  input: ShortSessionInput,
  task: (page: SessionPage, sessionId: string) => Promise<T>,
): Promise<T> {
  input.signal?.throwIfAborted();
  const session = await sessionDeps.createSession(
    {
      keepAlive: false,
      timeout: Math.max(60, input.timeoutSeconds ?? 120),
      ...(input.contextId ? { context: { id: input.contextId, persist: false } } : {}),
      ...(input.allowedDomains?.length ? { allowedDomains: input.allowedDomains } : {}),
    },
    { signal: input.signal },
  );
  let connection: SessionConnection | null = null;
  try {
    connection = await sessionDeps.connect(session.connectUrl);
    return await task(connection.page, session.id);
  } finally {
    await connection?.close().catch(() => undefined);
    await sessionDeps.releaseSession(session.id, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}

/** The ids of the files that a session holds now. */
export async function sessionDownloadIds(sessionId: string): Promise<Set<string>> {
  const items = await sessionDeps.listDownloads({ sessionId, limit: 100 });
  return new Set(items.map((item) => item.id));
}

export class DownloadError extends Error {
  constructor(
    readonly code: 'missing' | 'size' | 'checksum',
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface CollectedDownload {
  download: SessionDownload;
  bytes: Uint8Array;
}

/**
 * The new file of a session, through the Downloads API: poll until a file
 * that is not in `known` shows (large files show late), get its bytes, check
 * the size and the SHA-256, then delete the Browserbase copy.
 */
export async function collectDownload(
  sessionId: string,
  options: {
    known?: Set<string>;
    filename?: string;
    maxBytes: number;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<CollectedDownload> {
  const known = options.known ?? new Set<string>();
  const intervalMs = options.intervalMs ?? 2_000;
  const rounds = Math.max(1, Math.ceil((options.timeoutMs ?? 20_000) / intervalMs));
  let found: SessionDownload | null = null;
  for (let round = 0; round < rounds && !found; round += 1) {
    if (round) await sessionDeps.sleep(intervalMs);
    const fresh = (await sessionDeps.listDownloads({ sessionId, limit: 100 })).filter(
      (item) => !known.has(item.id) && Number(item.size) > 0,
    );
    found =
      fresh.find((item) => options.filename && item.filename === options.filename) ??
      fresh.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] ??
      null;
  }
  if (!found) throw new DownloadError('missing', 'The browser started no file download.');
  try {
    if (Number(found.size) > options.maxBytes)
      throw new DownloadError(
        'size',
        `The file is larger than ${Math.round(options.maxBytes / 1_048_576)} MB.`,
      );
    const bytes = await sessionDeps.downloadBytes(found.id);
    if (bytes.byteLength > options.maxBytes)
      throw new DownloadError(
        'size',
        `The file is larger than ${Math.round(options.maxBytes / 1_048_576)} MB.`,
      );
    if (found.checksum && found.checksum.toLowerCase() !== createHash('sha256').update(bytes).digest('hex'))
      throw new DownloadError('checksum', 'The file changed on the way. Try again.');
    return { download: found, bytes };
  } finally {
    // The copy in Files is the one that counts; Browserbase keeps no copy.
    await sessionDeps.deleteDownload(found.id).catch(() => undefined);
  }
}

/** Delete every file of a session (a short session that ends). */
export async function deleteSessionDownloads(sessionId: string) {
  const items = await sessionDeps.listDownloads({ sessionId, limit: 100 }).catch(() => []);
  await Promise.all(items.map((item) => sessionDeps.deleteDownload(item.id).catch(() => undefined)));
}
