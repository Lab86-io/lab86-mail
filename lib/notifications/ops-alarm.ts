import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { PRODUCT_NAME } from '@/lib/hosted/plans';
import { OPS_POLICY, type OpsBucketRow, type OpsNotice, type OpsNoticeType } from '@/lib/ops/health';
import { type CostAlarmMessage, sendCostAlarmEmail } from './cost-alarm';

// The failure alarm (lib/ops/health.ts, docs/ops-signals.md). The Convex cron
// calls the ops-health route each 15 minutes, and the route runs runOpsAlarm.
// The alarm only sends an email to the owner. It uses the mail path of the
// cost alarm and has the same two settings: no address, no alarm.

const alarmApi = api.opsHealth;

export interface OpsAlarmDependencies {
  env: () => Record<string, string | undefined>;
  now: () => number;
  query: typeof convexQuery;
  mutate: typeof convexMutation;
  send: (message: CostAlarmMessage) => Promise<string>;
}

const defaultDependencies: OpsAlarmDependencies = {
  env: () => process.env,
  now: () => Date.now(),
  query: convexQuery,
  mutate: convexMutation,
  send: (message) => sendCostAlarmEmail(message),
};

export type OpsAlarmRun =
  | { status: 'unconfigured'; missing: 'recipient' | 'email' }
  | { status: 'ran'; rows: number; notices: number; sent: number; failed: number };

const warned = new Set<string>();

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Test hook: let the next unconfigured run warn again. */
export function resetOpsAlarmWarningsForTest() {
  warned.clear();
}

/**
 * One pass. All state is in Convex: a process that restarts between two runs
 * sends nothing new. A mail that fails gives its claim back, so the next run
 * tries again.
 */
export async function runOpsAlarm(overrides: Partial<OpsAlarmDependencies> = {}): Promise<OpsAlarmRun> {
  const deps = { ...defaultDependencies, ...overrides };
  const env = deps.env();
  const recipient = (env.LAB86_OWNER_ALERT_EMAIL || '').trim();
  if (!recipient) {
    warnOnce('recipient', '[ops-alarm] LAB86_OWNER_ALERT_EMAIL is not set, so no failure alarm sends.');
    return { status: 'unconfigured', missing: 'recipient' };
  }
  if (!env.RESEND_API_KEY || !env.LAB86_NOTIFICATION_FROM) {
    warnOnce(
      'email',
      '[ops-alarm] RESEND_API_KEY or LAB86_NOTIFICATION_FROM is not set, so no failure alarm sends.',
    );
    return { status: 'unconfigured', missing: 'email' };
  }
  const now = deps.now();
  const rows = await deps.query<OpsBucketRow[]>(alarmApi.windowRows, { now });
  const { notices } = await deps.mutate<{ notices: OpsNotice[] }>(alarmApi.evaluate, { now, rows });
  if (!notices.length) return { status: 'ran', rows: rows.length, notices: 0, sent: 0, failed: 0 };

  // One mail for each type in one run: a disabled key fails every group at
  // the same time, and that is one fact for the owner, not five.
  let sent = 0;
  let failed = 0;
  for (const type of ['opened', 'recovered'] as const) {
    const group = notices.filter((notice) => notice.type === type);
    if (!group.length) continue;
    const refs = group.map(({ kind, type: noticeType }) => ({ kind, type: noticeType }));
    try {
      await deps.send({ to: recipient, ...opsAlarmEmail(type, group, now) });
      await deps.mutate(alarmApi.settleNotices, { now, notices: refs });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error('[ops-alarm] the email did not send:', error instanceof Error ? error.message : error);
      await deps.mutate(alarmApi.releaseNotices, { now, notices: refs }).catch(() => undefined);
    }
  }
  return { status: 'ran', rows: rows.length, notices: notices.length, sent, failed };
}

function utcMinute(ts: number) {
  return `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function hoursSince(from: number, now: number) {
  return Math.max(1, Math.floor((now - from) / 3_600_000));
}

function noticeLine(notice: OpsNotice, now: number) {
  const label = OPS_POLICY[notice.kind].label;
  const calls = notice.ok + notice.failed;
  const errorClass = notice.errorClass ? ` Last error class: ${notice.errorClass}.` : '';
  if (notice.reason === 'failure_rate')
    return `- ${label}: ${Math.round((notice.failed / Math.max(1, calls)) * 100)}% failed (${notice.failed} of ${calls}) in the last 2 hours.${errorClass}`;
  const silence = notice.lastOkAt
    ? `no successful call for ${hoursSince(notice.lastOkAt, now)} hours`
    : 'no successful call in the saved hours';
  return `- ${label}: ${silence}, and ${notice.failed} failed in the last 2 hours.${errorClass}`;
}

function incidentLength(openedAt: number, now: number) {
  const minutes = Math.max(1, Math.round((now - openedAt) / 60_000));
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/** The alarm email: plain text, with counts and error classes only. No user, no mail content. */
export function opsAlarmEmail(
  type: OpsNoticeType,
  notices: readonly OpsNotice[],
  now: number,
): { subject: string; text: string } {
  const labels = notices.map((notice) => OPS_POLICY[notice.kind].label).join(', ');
  if (type === 'recovered')
    return {
      subject: `${PRODUCT_NAME} recovered: ${labels}`,
      text: [
        'These groups work again:',
        '',
        ...notices.map(
          (notice) =>
            `- ${OPS_POLICY[notice.kind].label}: open for ${incidentLength(notice.openedAt, now)}, since ${utcMinute(notice.openedAt)}.`,
        ),
        '',
        'You get one more mail if a group fails again.',
      ].join('\n'),
    };
  const auth = notices.some((notice) => notice.errorClass === 'auth');
  return {
    subject: `${PRODUCT_NAME} failure alarm: ${labels}`,
    text: [
      'These groups pass the failure limit:',
      '',
      ...notices.map((notice) => noticeLine(notice, now)),
      '',
      ...(auth
        ? ['The class "auth" often means that a provider key is disabled. Check the key first.', '']
        : []),
      `Checked at ${utcMinute(now)}.`,
      'Run scripts/ops-report.ts for more data (docs/ops-signals.md).',
      'You get this mail once for each incident, and one more when the group recovers.',
    ].join('\n'),
  };
}
