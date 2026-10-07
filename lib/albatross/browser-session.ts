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

const BROWSERBASE_API_BASE = 'https://api.browserbase.com/v1';
const BROWSERBASE_TIMEOUT_MS = 30_000;
/** A guided session outlives one step but never a workday. */
const SESSION_TIMEOUT_SECONDS = 3_600;
const PAGE_TEXT_MAX = 6_000;

function browserbaseKey(): string {
  const key =
    process.env.BROWSERBASE_API_KEY || process.env.LAB86_BROWSERBASE_API_KEY || process.env.BB_API_KEY;
  if (!key) throw new Error('Browser sessions are not configured.');
  return key;
}

function browserbaseProjectId(): string | undefined {
  return process.env.BROWSERBASE_PROJECT_ID || process.env.LAB86_BROWSERBASE_PROJECT_ID || undefined;
}

export function browserSessionsConfigured(): boolean {
  return Boolean(
    process.env.BROWSERBASE_API_KEY || process.env.LAB86_BROWSERBASE_API_KEY || process.env.BB_API_KEY,
  );
}

async function browserbaseRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROWSERBASE_TIMEOUT_MS);
  try {
    const response = await fetcher(`${BROWSERBASE_API_BASE}${path}`, {
      method,
      headers: {
        'x-bb-api-key': browserbaseKey(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BrowserbaseRequestError(
        `Browserbase ${path} failed (${response.status}): ${truncateText(text, 200)}`,
        response.status,
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

export class BrowserbaseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BrowserbaseRequestError';
  }
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
  const created = await browserbaseRequest<{ id: string; connectUrl: string }>(
    'POST',
    '/sessions',
    {
      ...(browserbaseProjectId() ? { projectId: browserbaseProjectId() } : {}),
      keepAlive: true,
      timeout: SESSION_TIMEOUT_SECONDS,
      browserSettings: {
        // No recording: a run types personal details into forms, and the user
        // signs in here. Proof is the page text the runner reads, not a replay.
        recordSession: false,
        viewport: { width: 1280, height: 800 },
        ...(options.contextId
          ? { context: { id: options.contextId, persist: options.persist === true } }
          : {}),
      },
    },
    fetcher,
  );
  const debug = await browserbaseRequest<{ debuggerFullscreenUrl: string }>(
    'GET',
    `/sessions/${created.id}/debug`,
    undefined,
    fetcher,
  );
  return {
    sessionId: created.id,
    connectUrl: created.connectUrl,
    liveViewUrl: debug.debuggerFullscreenUrl,
    replayUrl: sessionReplayUrl(created.id),
  };
}

/** A new, empty sign-in context for one user. */
export async function createBrowserContext(fetcher: typeof fetch = fetch): Promise<string> {
  const created = await browserbaseRequest<{ id: string }>(
    'POST',
    '/contexts',
    browserbaseProjectId() ? { projectId: browserbaseProjectId() } : {},
    fetcher,
  );
  if (!created?.id) throw new Error('Browserbase returned no context id.');
  return created.id;
}

/** Delete a sign-in context. A context that is already gone counts as deleted. */
export async function deleteBrowserContext(contextId: string, fetcher: typeof fetch = fetch) {
  try {
    await browserbaseRequest('DELETE', `/contexts/${encodeURIComponent(contextId)}`, undefined, fetcher);
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
  return `wss://connect.browserbase.com?apiKey=${encodeURIComponent(browserbaseKey())}&sessionId=${encodeURIComponent(sessionId)}`;
}

export async function releaseBrowserSession(sessionId: string, fetcher: typeof fetch = fetch) {
  await browserbaseRequest(
    'POST',
    `/sessions/${sessionId}`,
    {
      ...(browserbaseProjectId() ? { projectId: browserbaseProjectId() } : {}),
      status: 'REQUEST_RELEASE',
    },
    fetcher,
  );
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
