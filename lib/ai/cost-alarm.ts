import { AI_CREDIT_VALUE_USD, isAiChatFeature } from './budget';

// The loop alarm. When one user's background model cost passes a threshold
// (default $5) in 24 hours, the owner gets one email for that user in that
// UTC day. The alarm never stops or limits the user. It is there to catch a
// runaway loop, like the ones PR #294 fixed: the Jev re-claim loop, work on
// dead accounts, and the content re-index.
//
// Pure module: convex/aiCostAlarm.ts and lib/notifications/cost-alarm.ts
// both import it, so it must not import server code.
//
// Each hourly run is cheap. It reads one period row and one watch row for
// each user with hosted model use in the window, and stores a sample of the
// month's credits. The month's credits now, less the newest sample from 24
// hours ago or before, is an upper limit of the window's cost. Only a user
// whose upper limit passes the threshold gets the exact scan of the usage
// events, which leaves out chat and own-key calls.

export const COST_ALARM_WINDOW_MS = 24 * 3_600_000;
export const COST_ALARM_DEFAULT_USD = 5;
/** The samples that one watch row keeps: a little more than a day of hourly runs. */
export const COST_SAMPLE_LIMIT = 30;

export interface CostAlarmConfig {
  /** LAB86_OWNER_ALERT_EMAIL. No address, no alarm. */
  recipient: string | null;
  /** LAB86_COST_ALARM_USD, default $5. */
  thresholdUsd: number;
  thresholdCredits: number;
}

export function costAlarmConfig(env: Record<string, string | undefined> = process.env): CostAlarmConfig {
  const recipient = (env.LAB86_OWNER_ALERT_EMAIL || '').trim() || null;
  const parsed = Number(env.LAB86_COST_ALARM_USD);
  const thresholdUsd =
    env.LAB86_COST_ALARM_USD && Number.isFinite(parsed) && parsed > 0 ? parsed : COST_ALARM_DEFAULT_USD;
  return { recipient, thresholdUsd, thresholdCredits: usdToCredits(thresholdUsd) };
}

export function usdToCredits(usd: number) {
  return usd / AI_CREDIT_VALUE_USD;
}

export function creditsToUsd(credits: number) {
  return credits * AI_CREDIT_VALUE_USD;
}

/**
 * Only background calls that Lab86 pays for count. Chat (`agent`, `chat`)
 * is left out, and an own-key call costs Lab86 nothing.
 */
export function countsTowardCostAlarm(event: { feature: string; source: string }) {
  return event.source === 'lab86' && !isAiChatFeature(event.feature);
}

export interface FeatureCost {
  feature: string;
  credits: number;
  calls: number;
}

export interface CostTotals {
  credits: number;
  calls: number;
  /** The most expensive first. */
  features: FeatureCost[];
}

export function emptyCostTotals(): CostTotals {
  return { credits: 0, calls: 0, features: [] };
}

/** Adds the events that count toward the alarm. */
export function addUsageEvents(
  totals: CostTotals,
  events: Array<{ feature: string; source: string; estimatedCredits: number }>,
): CostTotals {
  return mergeCostTotals(totals, {
    credits: 0,
    calls: 0,
    features: events.filter(countsTowardCostAlarm).map((event) => ({
      feature: event.feature,
      credits: Math.max(0, Number(event.estimatedCredits) || 0),
      calls: 1,
    })),
  });
}

export function mergeCostTotals(a: CostTotals, b: CostTotals): CostTotals {
  const byFeature = new Map<string, FeatureCost>();
  for (const entry of [...a.features, ...b.features]) {
    const previous = byFeature.get(entry.feature) ?? { feature: entry.feature, credits: 0, calls: 0 };
    byFeature.set(entry.feature, {
      feature: entry.feature,
      credits: previous.credits + entry.credits,
      calls: previous.calls + entry.calls,
    });
  }
  const features = [...byFeature.values()].sort(
    (x, y) => y.credits - x.credits || y.calls - x.calls || x.feature.localeCompare(y.feature),
  );
  return {
    credits: features.reduce((sum, entry) => sum + entry.credits, 0),
    calls: features.reduce((sum, entry) => sum + entry.calls, 0),
    features,
  };
}

/** The UTC day of a time, "2026-09-27". One alarm for each user in each such day. */
export function costAlarmDay(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The usage period of a time, "2026-09". The same as currentPeriod in convex/lib.ts. */
export function usagePeriod(ts: number) {
  const date = new Date(ts);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function previousUsagePeriod(period: string) {
  const [year, month] = period.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** The hosted credits of one month for one user, from aiUsagePeriods. */
export interface PeriodCredits {
  period: string;
  credits: number;
}

export interface CostSample extends PeriodCredits {
  at: number;
}

/**
 * An upper limit of the hosted credits a user spent since `since`, chat
 * included. The baseline is the newest sample at or before `since`. With no
 * baseline, the limit is all of this month, plus all of last month when the
 * window starts in last month.
 */
export function windowUpperBound(input: {
  samples: CostSample[];
  since: number;
  current: PeriodCredits;
  previous: PeriodCredits | null;
}) {
  const baseline = input.samples
    .filter((sample) => sample.at <= input.since)
    .reduce<CostSample | null>(
      (newest, sample) => (!newest || sample.at > newest.at ? sample : newest),
      null,
    );
  const spentSinceBaseline = (row: PeriodCredits) =>
    row.credits - (baseline?.period === row.period ? Math.min(baseline.credits, row.credits) : 0);
  let bound = spentSinceBaseline(input.current);
  const windowStartsLastMonth = usagePeriod(input.since) !== input.current.period;
  if (windowStartsLastMonth && input.previous) bound += spentSinceBaseline(input.previous);
  return Math.max(0, bound);
}

/**
 * The samples to store after a run: the new one, the newer samples, and the
 * newest one at or before `since`, which the next run can use as baseline.
 */
export function keepSamples(samples: CostSample[], sample: CostSample, since: number) {
  const all = [...samples.filter((entry) => entry.at !== sample.at), sample].sort((a, b) => a.at - b.at);
  const baseline = all.filter((entry) => entry.at <= since).at(-1);
  const recent = all.filter((entry) => entry.at > since).slice(-(COST_SAMPLE_LIMIT - 1));
  return baseline ? [baseline, ...recent] : recent;
}
