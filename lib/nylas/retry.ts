// Nylas occasionally returns 5xx ("Server Error") for individual resources —
// most visibly when a redelivered webhook backlog references stale rows. These
// are transient, so retry server-side failures a couple times with backoff.
// A 429 is also transient: it waits for the Retry-After delay (bounded). Other
// client errors (4xx) won't improve and are surfaced immediately.

export function nylasErrorStatus(err: any): number | undefined {
  return err?.statusCode ?? err?.status ?? err?.response?.status;
}

export function isNylasResponseParseError(err: any): boolean {
  const message = String(err?.message || err || '');
  return /invalid json response|could not parse response|unexpected end of json|unexpected token/i.test(
    message,
  );
}

export function describeNylasError(err: any, fallback = 'provider error'): string {
  // Preserve primitive thrown values (e.g. a thrown string) before the fallback,
  // matching isNylasResponseParseError's normalization.
  const message = err?.message
    ? String(err.message)
    : err != null && typeof err !== 'object'
      ? String(err)
      : fallback;
  const status = nylasErrorStatus(err);
  const requestId = err?.requestId;
  const flowId = err?.flowId;
  const parts = [status ? `HTTP ${status}` : '', message]
    .filter(Boolean)
    .join(': ')
    .replace(/\s+/g, ' ')
    .trim();
  const trace = [requestId ? `request ${requestId}` : '', flowId ? `flow ${flowId}` : '']
    .filter(Boolean)
    .join(', ');
  return trace ? `${parts} (${trace})` : parts || fallback;
}

/** A 429, from the status code or from the SDK's error text. */
export function isNylasRateLimited(err: any): boolean {
  return nylasErrorStatus(err) === 429 || /too many requests/i.test(String(err?.message || ''));
}

/**
 * The server's Retry-After delay in milliseconds (delta seconds or an HTTP
 * date), or undefined when the error carries no usable header.
 */
export function retryAfterMs(err: any, now = Date.now()): number | undefined {
  const headers = err?.headers ?? err?.response?.headers;
  const raw =
    typeof headers?.get === 'function'
      ? headers.get('retry-after')
      : (headers?.['retry-after'] ?? headers?.['Retry-After']);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** A 429 waits at least this long and never longer than the cap. */
export const RATE_LIMIT_MIN_DELAY_MS = 500;
export const RATE_LIMIT_MAX_DELAY_MS = 15_000;
/** A 429 gets at least this many retries, whatever the caller asked for. */
const RATE_LIMIT_MIN_RETRIES = 3;

/**
 * Backoff for one failed attempt. A 429 honors Retry-After inside a bounded
 * window; other transient errors use the given exponential base.
 */
export function nylasRetryDelayMs(err: any, attempt: number, baseDelayMs = 250): number {
  if (isNylasRateLimited(err)) {
    const fallback = Math.max(RATE_LIMIT_MIN_DELAY_MS, 1_000 * 2 ** attempt);
    const wanted = retryAfterMs(err) ?? fallback;
    return Math.min(RATE_LIMIT_MAX_DELAY_MS, Math.max(RATE_LIMIT_MIN_DELAY_MS, wanted));
  }
  return baseDelayMs * 2 ** attempt;
}

type RetryOptions = { sleep?: (ms: number) => Promise<unknown> };

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withNylasRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  { sleep = defaultSleep }: RetryOptions = {},
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = nylasErrorStatus(err);
      const rateLimited = isNylasRateLimited(err);
      // Retry only when it's transient: a 429, an explicit 5xx, or an unknown
      // status (the SDK's generic "Server Error" doesn't always expose a code).
      const transient = rateLimited || status === undefined || status >= 500;
      const budget = rateLimited ? Math.max(retries, RATE_LIMIT_MIN_RETRIES) : retries;
      if (!transient || attempt >= budget) break;
      await sleep(nylasRetryDelayMs(err, attempt));
    }
  }
  throw lastError;
}
