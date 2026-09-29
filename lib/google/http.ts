// Direct Google transport: the one HTTP client for Gmail, Calendar, and
// People API calls. Every adapter method goes through `googleFetch` or
// `googleJson`, so authorization, retries, and error shape stay in one place.
//
// Errors carry `statusCode`, the field that `nylasErrorStatus()` and the
// grant-health code already read, so callers need no change.

import { GoogleApiError } from './errors';
import { getGoogleAccessToken, invalidateGoogleAccessToken } from './tokens';

export { GoogleApiError };

export interface GoogleRequestInit extends Omit<RequestInit, 'body'> {
  /** A JSON body. Sets the content type. */
  json?: unknown;
  body?: RequestInit['body'];
  /** Attempts for 429 and 5xx answers, default 4. */
  attempts?: number;
  /**
   * Retry 5xx answers too (default true). A send turns this off: Gmail can
   * deliver a message and still answer 5xx, and a retry would send it twice.
   */
  retryServerErrors?: boolean;
  /**
   * The time limit of each attempt, with its body read, in ms (default
   * GOOGLE_REQUEST_TIMEOUT_MS). A `signal` of the caller replaces it.
   */
  timeoutMs?: number;
}

/** The time limit of one request. A request that hangs cannot hold a route or a History pass. */
export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;
/** The longest wait for a Retry-After value. A longer value from Google waits this long. */
export const GOOGLE_MAX_RETRY_AFTER_MS = 30_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaults = {
  fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as FetchLike,
  getGoogleAccessToken,
  invalidateGoogleAccessToken,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

let deps = defaults;

export function __setGoogleHttpDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

function retryable(status: number, serverErrors: boolean) {
  return status === 429 || (serverErrors && status >= 500);
}

// Gmail and Calendar answer a rate limit with 403 and one of these reasons.
// Callers read a 403 as a missing scope, so a rate-limit 403 is retried and,
// when the attempts run out, reported as 429.
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/**
 * The wait that a Retry-After value asks for, in ms: delay seconds or an
 * HTTP date (RFC 9110, 10.2.3). Null for no value, a bad value, or a time
 * that is not in the future.
 */
export function retryAfterMs(value: string | null, now: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) > 0 ? Number(text) * 1000 : null;
  const at = Date.parse(text);
  return Number.isFinite(at) && at > now ? at - now : null;
}

function backoff(attempt: number, response: Response) {
  const wait = retryAfterMs(response.headers.get('retry-after'), deps.now());
  return wait !== null
    ? Math.min(wait, GOOGLE_MAX_RETRY_AFTER_MS)
    : Math.min(8000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
}

async function errorFrom(response: Response): Promise<GoogleApiError> {
  let message = `Google API request failed with status ${response.status}.`;
  let reason: string | undefined;
  try {
    const body: any = await response.json();
    const error = body?.error;
    if (typeof error === 'string') {
      reason = error;
      message = body?.error_description || error;
    } else if (error) {
      message = error.message || message;
      reason = error.errors?.[0]?.reason || error.status;
    }
  } catch {
    // Keep the default message: the body was not JSON.
  }
  return new GoogleApiError(response.status, message, reason);
}

/** One authorized request. Refreshes the token once on 401. Retries 429, 5xx, and rate-limit 403. */
export async function googleFetch(
  grantId: string,
  url: string,
  init: GoogleRequestInit = {},
): Promise<Response> {
  const {
    json,
    attempts = 4,
    retryServerErrors = true,
    timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS,
    headers,
    ...rest
  } = init;
  let refreshed = false;
  for (let attempt = 1; ; attempt += 1) {
    const token = await deps.getGoogleAccessToken(grantId);
    const requestHeaders = new Headers(headers);
    requestHeaders.set('authorization', `Bearer ${token}`);
    if (json !== undefined) requestHeaders.set('content-type', 'application/json');
    const response = await deps.fetch(url, {
      ...rest,
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
      headers: requestHeaders,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    if (response.ok) return response;
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      deps.invalidateGoogleAccessToken(grantId);
      continue;
    }
    if (retryable(response.status, retryServerErrors) && attempt < attempts) {
      await deps.sleep(backoff(attempt, response));
      continue;
    }
    const error = await errorFrom(response);
    if (response.status === 403 && error.reason && RATE_LIMIT_REASONS.has(error.reason)) {
      if (attempt < attempts) {
        await deps.sleep(backoff(attempt, response));
        continue;
      }
      throw new GoogleApiError(429, error.message, error.reason);
    }
    throw error;
  }
}

export async function googleJson<T>(grantId: string, url: string, init: GoogleRequestInit = {}): Promise<T> {
  const response = await googleFetch(grantId, url, init);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const PEOPLE_API = 'https://people.googleapis.com/v1';

/** Builds a URL with query parameters. Skips undefined values; repeats arrays. */
export function googleUrl(base: string, params: Record<string, unknown> = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}
