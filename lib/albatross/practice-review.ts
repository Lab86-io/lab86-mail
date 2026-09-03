// The practice review, from the numbers alone.
//
// A practice logs a value over time. The trend, the streak of weeks with a
// log, and the one-sentence weekly review all come from the entries. No model
// call. The clients draw the trend; this module writes the words.

export interface MetricEntryLike {
  at: number;
  value: number;
}

export interface MetricLike {
  name: string;
  unit: string;
  target?: number;
  direction?: 'down' | 'up';
}

export interface MetricSummary {
  latest: number | null;
  latestAt: number | null;
  count: number;
  /** Distinct weeks with at least one log, over the last 12 weeks. */
  weeksWithEntry: number;
}

export const METRIC_SUMMARY_WEEKS = 12;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;

function sorted(entries: MetricEntryLike[]) {
  return [...entries].filter((entry) => Number.isFinite(entry.value)).sort((a, b) => a.at - b.at);
}

/** Week bucket relative to now: 0 is the current week, 1 is the week before. */
function weekIndex(at: number, nowMs: number) {
  return Math.floor(Math.max(0, nowMs - at) / WEEK_MS);
}

/** Distinct weeks with a log inside the last `weeks` weeks. */
export function weeksWithEntry(entries: MetricEntryLike[], nowMs: number, weeks = METRIC_SUMMARY_WEEKS) {
  const seen = new Set<number>();
  for (const entry of entries) {
    if (entry.at > nowMs) continue;
    const index = weekIndex(entry.at, nowMs);
    if (index < weeks) seen.add(index);
  }
  return seen.size;
}

export function metricSummary(entries: MetricEntryLike[], nowMs: number): MetricSummary {
  const rows = sorted(entries);
  const latest = rows[rows.length - 1];
  return {
    latest: latest ? latest.value : null,
    latestAt: latest ? latest.at : null,
    count: rows.length,
    weeksWithEntry: weeksWithEntry(rows, nowMs),
  };
}

/** A number with at most one decimal, and no trailing zero. */
export function formatMetricValue(value: number, unit = ''): string {
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return unit ? `${text} ${unit}` : text;
}

function spanWords(fromMs: number, toMs: number): string {
  const days = Math.max(1, Math.round((toMs - fromMs) / DAY_MS));
  if (days < 7) return days === 1 ? 'one day' : `${days} days`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? 'one week' : `${weeks} weeks`;
}

/**
 * One sentence on the change, and one on the streak. For example:
 * "Down 2.4 lb over 3 weeks. 5 of the last 6 weeks have a log."
 */
export function practiceReviewLine(
  entries: MetricEntryLike[],
  metric: MetricLike | null,
  nowMs: number,
): string {
  const rows = sorted(entries).filter((entry) => entry.at <= nowMs);
  if (rows.length === 0) return 'Log the first number to start the trend.';
  if (rows.length === 1) return 'One log so far. Add the next when you want.';
  const unit = metric?.unit || '';
  const first = rows[0];
  const last = rows[rows.length - 1];
  const change = last.value - first.value;
  const span = spanWords(first.at, last.at);
  const trend =
    Math.abs(change) < 0.05
      ? `No change over ${span}.`
      : `${change < 0 ? 'Down' : 'Up'} ${formatMetricValue(change, unit)} over ${span}.`;

  const windowWeeks = Math.min(METRIC_SUMMARY_WEEKS, weekIndex(first.at, nowMs) + 1);
  const logged = weeksWithEntry(rows, nowMs, windowWeeks);
  const streak =
    windowWeeks <= 1
      ? `${rows.length} logs this week.`
      : logged === windowWeeks
        ? `Every one of the last ${windowWeeks} weeks has a log.`
        : `${logged} of the last ${windowWeeks} weeks have a log.`;

  const target = metric && typeof metric.target === 'number' ? metric.target : null;
  if (target === null) return `${trend} ${streak}`;
  const gap = target - last.value;
  const reached =
    metric?.direction === 'down'
      ? last.value <= target
      : metric?.direction === 'up'
        ? last.value >= target
        : gap === 0;
  const targetLine = reached ? 'At the target.' : `${formatMetricValue(gap, unit)} to the target.`;
  return `${trend} ${streak} ${targetLine}`;
}
