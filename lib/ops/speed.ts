// Speed data (docs/ops-signals.md): one daily row for each metric, surface,
// and form factor, with a fixed histogram. A row holds counts only: no user,
// no URL, no thread. Pure module: Convex, the app route, and the browser all
// import it.

export const WEB_SPEED_METRICS = [
  'TTFB',
  'FCP',
  'LCP',
  'INP',
  'CLS',
  'surface_load',
  'surface_switch',
] as const;
export type WebSpeedMetric = (typeof WEB_SPEED_METRICS)[number];

/** The surfaces that call markSurfaceReady, and `app` for page metrics outside them. */
export const WEB_SPEED_SURFACES = ['today', 'albatrosses', 'thread', 'mail', 'needs_you', 'app'] as const;
export type WebSpeedSurface = (typeof WEB_SPEED_SURFACES)[number];
export type MarkedSurface = Exclude<WebSpeedSurface, 'app'>;

export const WEB_FORM_FACTORS = ['phone', 'tablet', 'desktop'] as const;
export type WebFormFactor = (typeof WEB_FORM_FACTORS)[number];

/** Metrics that Convex writes itself when a run ends. The web route rejects these names. */
export const RUN_SPEED_METRICS = ['run_queue', 'run_first_visible', 'run_longest_silence'] as const;
export type RunSpeedMetric = (typeof RUN_SPEED_METRICS)[number];
export const RUN_SPEED_SURFACE = 'run';
export const RUN_SPEED_FORM_FACTOR = 'server';

/** The largest value that a sample can have: 10 minutes. CLS is stored as CLS × 1000. */
export const MAX_SPEED_VALUE = 600_000;

/**
 * The upper limit of each bucket, in milliseconds. A last bucket holds the
 * rest. Rows store only the counts, so a change to this list needs new metric
 * names: old rows would read wrong.
 */
export const SPEED_BUCKET_BOUNDS = [
  25, 50, 100, 150, 200, 300, 400, 500, 750, 1_000, 1_500, 2_000, 2_500, 3_000, 4_000, 5_000, 7_500, 10_000,
  15_000, 20_000, 30_000, 60_000, 120_000, 300_000,
] as const;
export const SPEED_BUCKET_COUNT = SPEED_BUCKET_BOUNDS.length + 1;

/** The events of one browser batch, and the body limit of the route. A full batch is about 3.5 KiB. */
export const MAX_WEB_METRIC_EVENTS = 60;
export const MAX_WEB_METRICS_BYTES = 8 * 1024;

/** A limit on one flush, and on the rows of one Convex mutation. */
export const MAX_SPEED_ROWS_PER_WRITE = 200;
/** Rows older than this are removed by the retention sweep. */
export const SPEED_RETENTION_DAYS = 90;

export interface SpeedKey {
  day: string;
  metric: string;
  surface: string;
  formFactor: string;
}

export interface SpeedRollup extends SpeedKey {
  count: number;
  sum: number;
  buckets: number[];
}

export function speedDay(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The day that is `days` before the day of `ts`. */
export function speedDayBefore(ts: number, days: number) {
  return speedDay(ts - days * 86_400_000);
}

export function speedBucketIndex(value: number) {
  const index = SPEED_BUCKET_BOUNDS.findIndex((bound) => value <= bound);
  return index === -1 ? SPEED_BUCKET_BOUNDS.length : index;
}

export function emptySpeedBuckets() {
  return new Array<number>(SPEED_BUCKET_COUNT).fill(0);
}

/** One sample as a rollup row. It copies only the key fields, so the row matches the table. */
export function speedRollupOf(key: SpeedKey, value: number): SpeedRollup {
  const clamped = Math.min(MAX_SPEED_VALUE, Math.max(0, value));
  const buckets = emptySpeedBuckets();
  buckets[speedBucketIndex(clamped)] = 1;
  return {
    day: key.day,
    metric: key.metric,
    surface: key.surface,
    formFactor: key.formFactor,
    count: 1,
    sum: clamped,
    buckets,
  };
}

export function mergeSpeedBuckets(a: readonly number[], b: readonly number[]) {
  return emptySpeedBuckets().map((_, index) => (a[index] ?? 0) + (b[index] ?? 0));
}

export function isWebSpeedName(metric: string, surface: string, formFactor: string) {
  return (
    (WEB_SPEED_METRICS as readonly string[]).includes(metric) &&
    (WEB_SPEED_SURFACES as readonly string[]).includes(surface) &&
    (WEB_FORM_FACTORS as readonly string[]).includes(formFactor)
  );
}

export function isRunSpeedName(metric: string, surface: string, formFactor: string) {
  return (
    (RUN_SPEED_METRICS as readonly string[]).includes(metric) &&
    surface === RUN_SPEED_SURFACE &&
    formFactor === RUN_SPEED_FORM_FACTOR
  );
}

/**
 * A percentile from the histogram, with a straight line inside the bucket. The
 * last bucket has no upper limit, so it reads as the top limit of the list.
 */
export function speedPercentile(buckets: readonly number[], p: number): number | null {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  const target = Math.max(1, Math.ceil(p * total));
  let seen = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    const count = buckets[index] ?? 0;
    if (seen + count >= target) {
      const lower = index === 0 ? 0 : (SPEED_BUCKET_BOUNDS[index - 1] ?? MAX_SPEED_VALUE);
      const upper = SPEED_BUCKET_BOUNDS[index] ?? lower;
      return Math.round(lower + ((upper - lower) * (target - seen)) / count);
    }
    seen += count;
  }
  return SPEED_BUCKET_BOUNDS.at(-1) ?? null;
}

export interface RunLatencyInput {
  createdAt: number;
  startedAt?: number;
  finishedAt: number;
  log: ReadonlyArray<{ at: number }>;
  /** Set by the runner when the run has one. Older rows and other runs read the first log line. */
  firstVisibleAt?: unknown;
  /** The log keeps this many lines. A full log lost its first lines. */
  logLimit: number;
}

/**
 * Queue time, time to the first visible progress, and the longest gap with
 * no progress. When the log lost its first lines, the gap before the oldest
 * line that remains is unknown, so it does not count.
 */
export function runLatencySamples(run: RunLatencyInput) {
  const samples: Array<{ metric: RunSpeedMetric; value: number }> = [];
  if (run.startedAt !== undefined)
    samples.push({ metric: 'run_queue', value: run.startedAt - run.createdAt });
  const logAt = run.log.map((line) => line.at).sort((a, b) => a - b);
  const truncated = run.log.length >= run.logLimit;
  const firstVisible =
    typeof run.firstVisibleAt === 'number' ? run.firstVisibleAt : truncated ? undefined : logAt[0];
  if (firstVisible !== undefined)
    samples.push({ metric: 'run_first_visible', value: firstVisible - run.createdAt });
  if (run.startedAt !== undefined) {
    const points = [...(truncated ? [] : [run.startedAt]), ...logAt, run.finishedAt];
    let longest = 0;
    for (let index = 1; index < points.length; index += 1)
      longest = Math.max(longest, (points[index] ?? 0) - (points[index - 1] ?? 0));
    samples.push({ metric: 'run_longest_silence', value: longest });
  }
  return samples.filter((sample) => Number.isFinite(sample.value) && sample.value >= 0);
}
