export function requireInternalSecret(secret?: string) {
  const expected = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  if (!expected) {
    throw new Error('Missing Convex internal secret.');
  }
  if (secret !== expected) {
    throw new Error('Invalid Convex internal secret.');
  }
}

export function now() {
  return Date.now();
}

export function currentPeriod(ts = Date.now()) {
  const date = new Date(ts);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Fan out internal-secret-gated POSTs from a cron action with bounded
// concurrency and a per-call timeout, so one hung target can't stall the run
// and a large fleet can't overrun the cron cadence. Returns the count of 2xx.
export async function fanOutInternalPost(
  url: string,
  secret: string,
  bodies: Array<Record<string, unknown>>,
  opts: { concurrency?: number; timeoutMs?: number; label?: string } = {},
): Promise<number> {
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const label = opts.label ?? 'cron';
  let ok = 0;
  const post = async (body: Record<string, unknown>) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lab86-internal-secret': secret },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) ok += 1;
      else console.error(`[${label}] app returned ${res.status} for ${JSON.stringify(body)}`);
    } catch (err) {
      console.error(`[${label}] fetch failed for ${JSON.stringify(body)}:`, err);
    } finally {
      clearTimeout(timer);
    }
  };
  for (let i = 0; i < bodies.length; i += concurrency) {
    await Promise.all(bodies.slice(i, i + concurrency).map(post));
  }
  return ok;
}
