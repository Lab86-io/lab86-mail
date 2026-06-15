// Nylas occasionally returns 5xx ("Server Error") for individual resources —
// most visibly when a redelivered webhook backlog references stale rows. These
// are transient, so retry server-side failures a couple times with backoff;
// client errors (4xx) won't improve and are surfaced immediately.

export function nylasErrorStatus(err: any): number | undefined {
  return err?.statusCode ?? err?.status ?? err?.response?.status;
}

export async function withNylasRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = nylasErrorStatus(err);
      // Retry only when it's transient: an explicit 5xx, or an unknown status
      // (the SDK's generic "Server Error" doesn't always expose a code).
      const transient = status === undefined || status >= 500;
      if (!transient || attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}
