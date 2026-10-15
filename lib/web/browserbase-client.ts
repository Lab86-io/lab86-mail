// The one Browserbase client (docs/albatross-goal-runs.md G5, research:
// docs/research/browserbase-auth-files-2026-10-15.md section 5).
//
// Albatross reaches the web only through Browserbase: Search, Fetch, or a
// session. This module owns every REST call to Browserbase and is the only
// reader of the key. Each session keeps no CDP logs and no video, because a
// run types saved values into pages and a user signs in through Live View.
// The connect URL holds the key, so it never leaves the server.

import { truncateText } from '../shared/text';

export const BROWSERBASE_API_BASE = 'https://api.browserbase.com/v1';
const CONNECT_BASE = 'wss://connect.browserbase.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_429_RETRIES = 2;

/** Every session: no video and no CDP logs (a value typed with fill() shows in the logs). */
export const SESSION_PRIVACY = { recordSession: false, logSession: false } as const;

export function browserbaseApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.BROWSERBASE_API_KEY || env.LAB86_BROWSERBASE_API_KEY || env.BB_API_KEY || '';
}

export function browserbaseProjectId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.BROWSERBASE_PROJECT_ID || env.LAB86_BROWSERBASE_PROJECT_ID || undefined;
}

export function browserbaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(browserbaseApiKey(env));
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

export class BrowserbaseNotConfigured extends Error {
  constructor(message = 'BROWSERBASE_API_KEY is not configured.') {
    super(message);
    this.name = 'BrowserbaseNotConfigured';
  }
}

export interface BrowserbaseCallOptions {
  /** Test seam. Production uses the global fetch. */
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The error message when no key is set. */
  notConfigured?: string;
}

interface RequestInput {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  accept?: string;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header >= 0 && response.headers.has('retry-after'))
    return Math.min(header * 1_000, 2_000);
  return Math.min(400 * attempt, 2_000);
}

async function request(input: RequestInput, options: BrowserbaseCallOptions = {}): Promise<Response> {
  const key = browserbaseApiKey();
  if (!key) throw new BrowserbaseNotConfigured(options.notConfigured);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(`${BROWSERBASE_API_BASE}${input.path}`, {
        method: input.method,
        headers: {
          'x-bb-api-key': key,
          ...(input.body ? { 'content-type': 'application/json' } : {}),
          ...(input.accept ? { accept: input.accept } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        signal,
      });
    } catch (error) {
      if (timeout.aborted)
        throw new Error(`Browserbase ${pathOnly(input.path)} timed out after ${timeoutMs}ms`);
      throw error;
    }
    if (response.status === 429 && attempt <= MAX_429_RETRIES) {
      await response.body?.cancel().catch(() => undefined);
      await wait(retryDelayMs(response, attempt));
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BrowserbaseRequestError(
        `Browserbase ${pathOnly(input.path)} failed (${response.status}): ${truncateText(text, 200)}`,
        response.status,
      );
    }
    return response;
  }
}

function pathOnly(path: string) {
  return path.split('?')[0];
}

async function requestJson<T>(input: RequestInput, options?: BrowserbaseCallOptions): Promise<T> {
  const response = await request(input, options);
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// --- Search -----------------------------------------------------------------

/** One search result. Browserbase Search gives no snippet and no page text. */
export interface BrowserbaseSearchResult {
  id?: string;
  url: string;
  title?: string;
  author?: string;
  publishedDate?: string;
  image?: string;
  favicon?: string;
}

export async function browserbaseSearch(
  input: { query: string; numResults?: number },
  options?: BrowserbaseCallOptions,
): Promise<BrowserbaseSearchResult[]> {
  const json = await requestJson<{ results?: unknown[]; data?: unknown[] }>(
    {
      method: 'POST',
      path: '/search',
      body: { query: input.query.slice(0, 200), numResults: input.numResults ?? 10 },
    },
    { timeoutMs: 45_000, ...options },
  );
  const rows = Array.isArray(json.results) ? json.results : Array.isArray(json.data) ? json.data : [];
  return rows.filter(
    (row): row is BrowserbaseSearchResult =>
      Boolean(row) && typeof (row as BrowserbaseSearchResult).url === 'string',
  );
}

// --- Fetch ------------------------------------------------------------------

export interface BrowserbaseFetchResult {
  /** The status of the site's answer (Browserbase itself answered 200). */
  statusCode: number;
  headers: Record<string, string>;
  content: string;
  contentType: string;
  /** `base64` for a binary body in raw format. */
  encoding?: string;
}

/**
 * Fetch API: no JavaScript, max body 5 MB, max 60 s. `markdown` is Fetch
 * Extract and answers 400 for a body it cannot convert (a PDF, for example).
 */
export async function browserbaseFetch(
  input: { url: string; format: 'raw' | 'markdown'; allowRedirects?: boolean },
  options?: BrowserbaseCallOptions,
): Promise<BrowserbaseFetchResult> {
  const json = await requestJson<any>(
    {
      method: 'POST',
      path: '/fetch',
      body: { url: input.url, allowRedirects: input.allowRedirects ?? true, format: input.format },
    },
    { timeoutMs: 65_000, ...options },
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(json?.headers || {}))
    headers[name.toLowerCase()] = String(value);
  return {
    statusCode: Number(json?.statusCode) || 200,
    headers,
    content: String(json?.content ?? json?.markdown ?? json?.text ?? json?.data?.content ?? ''),
    contentType: String(json?.contentType || headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase(),
    ...(json?.encoding ? { encoding: String(json.encoding) } : {}),
  };
}

// --- Sessions -----------------------------------------------------------------

export interface CreateSessionInput {
  keepAlive?: boolean;
  /** Seconds, 60 to 21,600. */
  timeout?: number;
  /** The user's saved sign-ins. persist false reads them without saving. */
  context?: { id: string; persist: boolean };
  /** Main-frame navigation only to these domains (experimental at Browserbase). */
  allowedDomains?: string[];
  viewport?: { width: number; height: number };
}

export interface CreatedSession {
  id: string;
  connectUrl: string;
}

export async function createSession(
  input: CreateSessionInput,
  options?: BrowserbaseCallOptions,
): Promise<CreatedSession> {
  const projectId = browserbaseProjectId();
  const created = await requestJson<{ id?: string; connectUrl?: string }>(
    {
      method: 'POST',
      path: '/sessions',
      body: {
        ...(projectId ? { projectId } : {}),
        keepAlive: input.keepAlive ?? false,
        ...(input.timeout ? { timeout: input.timeout } : {}),
        browserSettings: {
          ...SESSION_PRIVACY,
          ...(input.viewport ? { viewport: input.viewport } : {}),
          ...(input.context ? { context: { id: input.context.id, persist: input.context.persist } } : {}),
          ...(input.allowedDomains?.length ? { allowedDomains: input.allowedDomains } : {}),
        },
      },
    },
    options,
  );
  if (!created?.id) throw new Error('Browserbase returned no session id.');
  return { id: created.id, connectUrl: created.connectUrl || sessionConnectUrl(created.id) };
}

export async function sessionLiveUrls(
  sessionId: string,
  options?: BrowserbaseCallOptions,
): Promise<{ debuggerFullscreenUrl: string }> {
  return requestJson({ method: 'GET', path: `/sessions/${encodeURIComponent(sessionId)}/debug` }, options);
}

export async function releaseSession(sessionId: string, options?: BrowserbaseCallOptions) {
  const projectId = browserbaseProjectId();
  await request(
    {
      method: 'POST',
      path: `/sessions/${encodeURIComponent(sessionId)}`,
      body: { ...(projectId ? { projectId } : {}), status: 'REQUEST_RELEASE' },
    },
    options,
  );
}

/** The CDP endpoint of a session. It holds the key: server only, never logged or stored. */
export function sessionConnectUrl(sessionId: string, options: { notConfigured?: string } = {}) {
  const key = browserbaseApiKey();
  if (!key) throw new BrowserbaseNotConfigured(options.notConfigured);
  return `${CONNECT_BASE}?apiKey=${encodeURIComponent(key)}&sessionId=${encodeURIComponent(sessionId)}`;
}

/** The session id in a connect URL, or null. */
export function sessionIdFromConnectUrl(connectUrl: string): string | null {
  try {
    return new URL(connectUrl).searchParams.get('sessionId');
  } catch {
    return null;
  }
}

// --- Contexts -----------------------------------------------------------------

export async function createContext(options?: BrowserbaseCallOptions): Promise<string> {
  const projectId = browserbaseProjectId();
  const created = await requestJson<{ id?: string }>(
    { method: 'POST', path: '/contexts', body: projectId ? { projectId } : {} },
    options,
  );
  if (!created?.id) throw new Error('Browserbase returned no context id.');
  return created.id;
}

export async function deleteContext(contextId: string, options?: BrowserbaseCallOptions) {
  await request({ method: 'DELETE', path: `/contexts/${encodeURIComponent(contextId)}` }, options);
}

// --- Downloads ----------------------------------------------------------------

/** One file that a session downloaded. `checksum` is the SHA-256 of the bytes. */
export interface SessionDownload {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  size: number;
  checksum?: string;
  createdAt?: string;
}

export async function listDownloads(
  input: { sessionId: string; limit?: number },
  options?: BrowserbaseCallOptions,
): Promise<SessionDownload[]> {
  const query = new URLSearchParams({
    sessionId: input.sessionId,
    limit: String(Math.min(Math.max(input.limit ?? 50, 1), 100)),
  });
  const json = await requestJson<{ downloads?: SessionDownload[] }>(
    { method: 'GET', path: `/downloads?${query.toString()}` },
    options,
  );
  return (json.downloads || []).filter((item) => item && typeof item.id === 'string');
}

export async function downloadBytes(
  downloadId: string,
  options?: BrowserbaseCallOptions,
): Promise<Uint8Array> {
  const response = await request(
    {
      method: 'GET',
      path: `/downloads/${encodeURIComponent(downloadId)}`,
      accept: 'application/octet-stream',
    },
    { timeoutMs: 60_000, ...options },
  );
  return new Uint8Array(await response.arrayBuffer());
}

export async function deleteDownload(downloadId: string, options?: BrowserbaseCallOptions) {
  await request({ method: 'DELETE', path: `/downloads/${encodeURIComponent(downloadId)}` }, options);
}
