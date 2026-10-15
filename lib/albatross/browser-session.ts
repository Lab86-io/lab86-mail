/**
 * Shared browser sessions for guided work, on Browserbase.
 *
 * One session is one real browser that the agent and the user share. The
 * agent opens it at the step's page and observes; the user acts inside the
 * embedded live view, especially at every identity wall. Credentials are
 * never requested, stored, or observed on purpose — the user types their own
 * secrets into the site, not into Albatross.
 *
 * Verification reuses the one evidence gate: the page's visible text either
 * satisfies the step's doneWhen or the step stays open. The session replay
 * URL rides along as the evidence url.
 *
 * The step runner drives the same session through lib/albatross/browser-agent.ts:
 * it reads the page as an accessibility snapshot and acts by element ref, and
 * it stops at sign-in, payment, and final submits for the user.
 *
 * Saved sign-ins: each user has one Browserbase context. A session that uses
 * it with persist on keeps the cookies of the sites the user signed in to, so
 * the next session starts signed in. The context holds browser data only;
 * Albatross never receives a password. Forgetting deletes the context.
 */

import { truncateText } from '../shared/text';
import {
  type BrowserbaseCallOptions,
  BrowserbaseRequestError,
  browserbaseConfigured,
  sessionConnectUrl as clientConnectUrl,
  createContext,
  createSession,
  deleteContext,
  deleteDownload,
  listDownloads,
  releaseSession,
  sessionLiveUrls,
} from '../web/browserbase-client';

export { BrowserbaseRequestError };

/** A guided session outlives one step but never a workday. */
const SESSION_TIMEOUT_SECONDS = 3_600;
const PAGE_TEXT_MAX = 6_000;
const NOT_CONFIGURED = 'Browser sessions are not configured.';

function callOptions(fetcher: typeof fetch): BrowserbaseCallOptions {
  return { fetcher, notConfigured: NOT_CONFIGURED };
}

export function browserSessionsConfigured(): boolean {
  return browserbaseConfigured();
}

export interface BrowserSessionInfo {
  sessionId: string;
  connectUrl: string;
  liveViewUrl: string;
  replayUrl: string;
}

export function sessionReplayUrl(sessionId: string) {
  return `https://browserbase.com/sessions/${sessionId}`;
}

export interface BrowserSessionOptions {
  /** The user's saved sign-in context. */
  contextId?: string;
  /** Save the cookies of this session back to the context when it ends. */
  persist?: boolean;
}

/** Create a session and resolve its interactive live view in one call. */
export async function createBrowserSession(
  fetcher: typeof fetch = fetch,
  options: BrowserSessionOptions = {},
): Promise<BrowserSessionInfo> {
  // No recording and no logs (lib/web/browserbase-client.ts SESSION_PRIVACY):
  // a run types personal details and saved passwords into forms, and the user
  // signs in here. Browserbase keeps CDP logs by default, and a value typed
  // with fill() shows in them (docs/research/browserbase-auth-files-2026-10-15.md).
  // Proof is the page text the runner reads, not a replay.
  const created = await createSession(
    {
      keepAlive: true,
      timeout: SESSION_TIMEOUT_SECONDS,
      viewport: { width: 1280, height: 800 },
      ...(options.contextId ? { context: { id: options.contextId, persist: options.persist === true } } : {}),
    },
    callOptions(fetcher),
  );
  const debug = await sessionLiveUrls(created.id, callOptions(fetcher));
  return {
    sessionId: created.id,
    connectUrl: created.connectUrl,
    liveViewUrl: debug.debuggerFullscreenUrl,
    replayUrl: sessionReplayUrl(created.id),
  };
}

/** A new, empty sign-in context for one user. */
export async function createBrowserContext(fetcher: typeof fetch = fetch): Promise<string> {
  return createContext(callOptions(fetcher));
}

/** Delete a sign-in context. A context that is already gone counts as deleted. */
export async function deleteBrowserContext(contextId: string, fetcher: typeof fetch = fetch) {
  try {
    await deleteContext(contextId, callOptions(fetcher));
  } catch (error) {
    if (error instanceof BrowserbaseRequestError && error.status === 404) return;
    throw error;
  }
}

/**
 * The CDP endpoint of an open session. It carries the API key, so it never
 * reaches a client, a log line, or a stored row.
 */
export function sessionConnectUrl(sessionId: string) {
  return clientConnectUrl(sessionId, { notConfigured: NOT_CONFIGURED });
}

/**
 * End the session, then delete the file copies it left in Browserbase storage
 * (a download that no browser_download collected, for example after
 * browser_open on a file address). The copies that count are in Files.
 */
export async function releaseBrowserSession(sessionId: string, fetcher: typeof fetch = fetch) {
  await releaseSession(sessionId, callOptions(fetcher));
  const left = await listDownloads({ sessionId, limit: 100 }, callOptions(fetcher)).catch(() => []);
  await Promise.all(left.map((item) => deleteDownload(item.id, callOptions(fetcher)).catch(() => undefined)));
}

export interface SessionPageState {
  url: string;
  title: string;
  text: string;
}

type CdpConnector = (connectUrl: string) => Promise<{
  page: () => Promise<{
    goto?: (url: string) => Promise<unknown>;
    url: () => string;
    title: () => Promise<string>;
    innerText: () => Promise<string>;
  } | null>;
  close: () => Promise<void>;
}>;

/** playwright-core over CDP, loaded lazily so tests can inject a fake. */
const defaultConnector: CdpConnector = async (connectUrl: string) => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(connectUrl);
  return {
    page: async () => {
      const context = browser.contexts()[0];
      const page = context?.pages().at(-1);
      if (!page) return null;
      return {
        goto: async (url: string) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }),
        url: () => page.url(),
        title: () => page.title(),
        innerText: async () => {
          try {
            return await page.innerText('body', { timeout: 5_000 });
          } catch {
            return '';
          }
        },
      };
    },
    // For a browser reached with connectOverCDP, close() disconnects this
    // client; it does not end the remote session. The session ends only by
    // releaseBrowserSession or its own timeout. No contexts are created here,
    // so nothing of the user's page is torn down either.
    close: () => browser.close(),
  };
};

/** Point the shared browser at the step's page. The user takes it from there. */
export async function navigateSession(
  connectUrl: string,
  url: string,
  connector: CdpConnector = defaultConnector,
): Promise<void> {
  const connection = await connector(connectUrl);
  try {
    const page = await connection.page();
    if (!page?.goto) throw new Error('The shared browser has no open page.');
    await page.goto(url);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** Read what the page currently shows, for the evidence gate to judge. */
export async function readSessionPage(
  connectUrl: string,
  connector: CdpConnector = defaultConnector,
): Promise<SessionPageState> {
  const connection = await connector(connectUrl);
  try {
    const page = await connection.page();
    if (!page) throw new Error('The shared browser has no open page.');
    const [title, text] = await Promise.all([page.title(), page.innerText()]);
    return {
      url: page.url(),
      title: truncateText(title, 300),
      text: truncateText(text.replace(/\s+/g, ' ').trim(), PAGE_TEXT_MAX),
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}
