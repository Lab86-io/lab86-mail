import {
  COST_ALARM_WINDOW_MS,
  type CostTotals,
  costAlarmConfig,
  costAlarmDay,
  creditsToUsd,
  emptyCostTotals,
  mergeCostTotals,
  type PeriodCredits,
} from '@/lib/ai/cost-alarm';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { PRODUCT_NAME } from '@/lib/hosted/plans';

// The loop alarm (lib/ai/cost-alarm.ts). The Convex cron calls the
// cost-alarm route each hour, and the route runs runCostAlarm. The alarm
// only sends an email to the owner. It never stops or limits a user.

const alarmApi = api.aiCostAlarm;

/** Pages of active users in one run: 100 users each. */
const MAX_USER_PAGES = 50;
/** Pages of usage events in one exact scan: 1,000 events each. */
const MAX_EVENT_PAGES = 200;
/** Features in the email. */
const TOP_FEATURES = 8;

export interface CostAlarmMessage {
  to: string;
  subject: string;
  text: string;
}

export interface CostAlarmDependencies {
  env: () => Record<string, string | undefined>;
  now: () => number;
  query: typeof convexQuery;
  mutate: typeof convexMutation;
  send: (message: CostAlarmMessage) => Promise<string>;
}

const defaultDependencies: CostAlarmDependencies = {
  env: () => process.env,
  now: () => Date.now(),
  query: convexQuery,
  mutate: convexMutation,
  send: (message) => sendCostAlarmEmail(message),
};

export type CostAlarmRun =
  | { status: 'unconfigured'; missing: 'recipient' | 'email' }
  | { status: 'ran'; checked: number; scanned: number; sent: number; failed: number };

const warned = new Set<string>();

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Test hook: let the next unconfigured run warn again. */
export function resetCostAlarmWarningsForTest() {
  warned.clear();
}

interface ActiveUser {
  userId: string;
  current: PeriodCredits;
  previous: PeriodCredits | null;
}

/** One pass: sample every active user, scan the ones near the threshold, and send. */
export async function runCostAlarm(overrides: Partial<CostAlarmDependencies> = {}): Promise<CostAlarmRun> {
  const deps = { ...defaultDependencies, ...overrides };
  const env = deps.env();
  const config = costAlarmConfig(env);
  if (!config.recipient) {
    warnOnce('recipient', '[cost-alarm] LAB86_OWNER_ALERT_EMAIL is not set, so no cost alarm sends.');
    return { status: 'unconfigured', missing: 'recipient' };
  }
  if (!env.RESEND_API_KEY || !env.LAB86_NOTIFICATION_FROM) {
    warnOnce(
      'email',
      '[cost-alarm] RESEND_API_KEY or LAB86_NOTIFICATION_FROM is not set, so no cost alarm sends.',
    );
    return { status: 'unconfigured', missing: 'email' };
  }
  const now = deps.now();
  const since = now - COST_ALARM_WINDOW_MS;
  const day = costAlarmDay(now);

  // Each active user gets a sample. The upper limit decides who gets a scan.
  const candidates = new Set<string>();
  const checked = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_USER_PAGES; page += 1) {
    const active: { users: ActiveUser[]; cursor: string; isDone: boolean } = await deps.query(
      alarmApi.activeUsage,
      { since, now, cursor },
    );
    if (active.users.length) {
      const sampled = await deps.mutate<
        Array<{ userId: string; upperBoundCredits: number; alertedToday: boolean }>
      >(alarmApi.recordSamples, { now, since, day, users: active.users });
      for (const user of sampled) {
        checked.add(user.userId);
        if (!user.alertedToday && user.upperBoundCredits >= config.thresholdCredits)
          candidates.add(user.userId);
      }
    }
    if (active.isDone) break;
    cursor = active.cursor;
  }

  let sent = 0;
  let failed = 0;
  for (const userId of candidates) {
    let alarm: { totals: CostTotals; partial: boolean } | null = null;
    try {
      const { totals, partial } = await windowTotals(deps, userId, since, now);
      if (totals.credits < config.thresholdCredits) continue;
      const claim = await deps.mutate<{ claimed: boolean }>(alarmApi.claimAlarm, {
        userId,
        day,
        credits: totals.credits,
        now,
      });
      if (claim.claimed) alarm = { totals, partial };
    } catch (error) {
      // One user's read must not stop the alarm for the others.
      failed += 1;
      console.error('[cost-alarm] the usage read failed:', error instanceof Error ? error.message : error);
    }
    if (!alarm) continue;
    const { totals, partial } = alarm;
    try {
      await deps.send({
        to: config.recipient,
        ...costAlarmEmail({ userId, totals, partial, thresholdUsd: config.thresholdUsd, now }),
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error('[cost-alarm] the email did not send:', error instanceof Error ? error.message : error);
      // The next run tries again.
      await deps.mutate(alarmApi.releaseAlarm, { userId, day }).catch(() => undefined);
    }
  }
  return { status: 'ran', checked: checked.size, scanned: candidates.size, sent, failed };
}

/** The exact scan: the user's usage events in the window, less chat and own-key calls. */
async function windowTotals(deps: CostAlarmDependencies, userId: string, since: number, until: number) {
  let totals = emptyCostTotals();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const result: { totals: CostTotals; cursor: string; isDone: boolean } = await deps.query(
      alarmApi.usagePage,
      { userId, since, until, cursor },
    );
    totals = mergeCostTotals(totals, result.totals);
    if (result.isDone) return { totals, partial: false };
    cursor = result.cursor;
  }
  return { totals, partial: true };
}

function usd(credits: number) {
  return `$${creditsToUsd(credits).toFixed(2)}`;
}

function calls(value: number) {
  return `${value.toLocaleString('en-US')} ${value === 1 ? 'call' : 'calls'}`;
}

/** The alarm email: plain text, with no mail content. */
export function costAlarmEmail(input: {
  userId: string;
  totals: CostTotals;
  thresholdUsd: number;
  now: number;
  partial?: boolean;
}): { subject: string; text: string } {
  const tail = input.userId.slice(-6);
  const from = new Date(input.now - COST_ALARM_WINDOW_MS).toISOString().slice(0, 16).replace('T', ' ');
  const to = new Date(input.now).toISOString().slice(0, 16).replace('T', ' ');
  const features = input.totals.features
    .slice(0, TOP_FEATURES)
    .map((entry) => `- ${entry.feature}: ${usd(entry.credits)}, ${calls(entry.calls)}`);
  const lines = [
    `One user's background model cost went above $${input.thresholdUsd.toFixed(2)} in 24 hours.`,
    '',
    `User: ${input.userId}`,
    `Window: ${from} UTC to ${to} UTC`,
    `Background cost: ${usd(input.totals.credits)} for ${calls(input.totals.calls)}`,
    ...(input.partial ? ['The scan stopped at its page limit, so the real cost is higher than this.'] : []),
    '',
    'Top features:',
    ...features,
    '',
    'Chat and own-key calls are not in this count.',
    'Nothing was stopped or limited. This email is an alarm only.',
    'You get a maximum of one alarm for each user in each UTC day.',
  ];
  return {
    subject: `${PRODUCT_NAME} cost alarm: ${tail} used ${usd(input.totals.credits)} in 24 hours`,
    text: lines.join('\n'),
  };
}

/** Sends the alarm through Resend, as the brief and check-in emails do. */
export async function sendCostAlarmEmail(
  message: CostAlarmMessage,
  deps: { fetch: typeof fetch; env: Record<string, string | undefined> } = { fetch, env: process.env },
): Promise<string> {
  const response = await deps.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.env.RESEND_API_KEY || ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: deps.env.LAB86_NOTIFICATION_FROM || '',
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { id?: unknown; message?: unknown };
  if (!response.ok) throw new Error(String(payload?.message || `Resend failed (${response.status})`));
  return String(payload?.id || '');
}
