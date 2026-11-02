import {
  MAX_SPEED_ROWS_PER_WRITE,
  mergeSpeedBuckets,
  type SpeedRollup,
  speedDay,
  speedRollupOf,
} from './speed';

// The web route holds speed samples here and writes them to Convex at most
// once a minute. The number of Convex calls does not grow with users or page
// events, and the shared daily rows do not conflict. A restart loses at most
// one minute of samples, which is acceptable for this data.

export const SPEED_FLUSH_MS = 60_000;

export interface SpeedSample {
  metric: string;
  surface: string;
  formFactor: string;
  value: number;
}

export interface SpeedBufferDeps {
  write: (rows: SpeedRollup[]) => Promise<unknown>;
  now: () => number;
  schedule: (run: () => void, ms: number) => void;
  flushMs?: number;
  onError?: (error: unknown) => void;
}

export function createSpeedBuffer(deps: SpeedBufferDeps) {
  const rows = new Map<string, SpeedRollup>();
  let scheduled = false;

  const merge = (row: SpeedRollup) => {
    const key = `${row.day}|${row.metric}|${row.surface}|${row.formFactor}`;
    const existing = rows.get(key);
    rows.set(
      key,
      existing
        ? {
            ...existing,
            count: existing.count + row.count,
            sum: existing.sum + row.sum,
            buckets: mergeSpeedBuckets(existing.buckets, row.buckets),
          }
        : row,
    );
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    deps.schedule(() => {
      scheduled = false;
      void flush();
    }, deps.flushMs ?? SPEED_FLUSH_MS);
  };

  async function flush() {
    if (!rows.size) return 0;
    const batch = [...rows.entries()].slice(0, MAX_SPEED_ROWS_PER_WRITE);
    for (const [key] of batch) rows.delete(key);
    try {
      await deps.write(batch.map(([, row]) => row));
    } catch (error) {
      // The rows are sums, so a later write can carry them. The key set is
      // small and fixed for each day, so this cannot grow without a limit.
      for (const [, row] of batch) merge(row);
      deps.onError?.(error);
    }
    if (rows.size) schedule();
    return batch.length;
  }

  return {
    add(samples: readonly SpeedSample[]) {
      const day = speedDay(deps.now());
      for (const sample of samples) merge(speedRollupOf({ day, ...sample }, sample.value));
      if (samples.length) schedule();
    },
    flush,
    /** Test hook. */
    pendingRows: () => rows.size,
  };
}

/** A per-process limit for each user. It costs no Convex call, unlike the shared rate limit. */
export function createBeaconLimiter(options: { limit: number; windowMs: number; maxUsers?: number }) {
  const maxUsers = options.maxUsers ?? 2_000;
  const windows = new Map<string, { start: number; count: number }>();
  return (userId: string, now: number) => {
    const current = windows.get(userId);
    if (!current || now - current.start >= options.windowMs) {
      if (!current && windows.size >= maxUsers) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
      windows.set(userId, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= options.limit;
  };
}
