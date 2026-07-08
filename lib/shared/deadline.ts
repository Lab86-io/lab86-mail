/** Turn an indefinite hang into a caught error: an awaited call that never
 * resolves would otherwise leave its pipeline's persisted status wedged in a
 * non-terminal state (the same class of failure a mid-flight deploy causes —
 * see the plan-reconcile cron and the Daily Brief settle-on-read migration).
 * Wrapping unbounded LLM/network calls in a deadline routes hangs into the
 * existing error paths, which settle the stored document terminally. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
