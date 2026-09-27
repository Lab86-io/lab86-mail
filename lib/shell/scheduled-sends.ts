/**
 * The mail nav's Scheduled view. `list_scheduled` returns the provider's
 * scheduled sends for one mailbox: an id, a status, and a close time. This
 * file reads every connected mailbox and keeps the sends that are still
 * waiting, so the user can cancel them.
 */
export type ScheduledSendState = 'pending' | 'sent' | 'failed' | 'cancelled';

export type ScheduledSendRow = {
  account: string;
  accountLabel: string;
  scheduleId: string;
  state: ScheduledSendState;
  /** Epoch ms of the send, when the provider gives one. */
  at: number | null;
};

export type ScheduledSendsResult = { rows: ScheduledSendRow[]; failedAccounts: string[] };

export function scheduledSendState(code: unknown): ScheduledSendState {
  const text = String(code || '').toLowerCase();
  if (/succ?ess|sent/.test(text)) return 'sent';
  if (/fail|error/.test(text)) return 'failed';
  if (/cancel/.test(text)) return 'cancelled';
  return 'pending';
}

function epochMs(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  // The provider sends epoch seconds; accept milliseconds too.
  return n < 1e12 ? n * 1000 : n;
}

export function normalizeScheduledSend(
  raw: any,
  account: { account: string; label: string },
): ScheduledSendRow | null {
  const id = raw?.scheduleId ?? raw?.schedule_id ?? raw?.id;
  if (id === undefined || id === null || id === '') return null;
  return {
    account: account.account,
    accountLabel: account.label,
    scheduleId: String(id),
    state: scheduledSendState(raw?.status?.code ?? raw?.status),
    at: epochMs(raw?.closeTime ?? raw?.close_time ?? raw?.sendAt ?? raw?.send_at),
  };
}

export async function loadScheduledSends(
  accounts: Array<{ account: string; label: string }>,
  list: (account: string) => Promise<{ scheduled: unknown[] }>,
): Promise<ScheduledSendsResult> {
  const result: ScheduledSendsResult = { rows: [], failedAccounts: [] };
  await Promise.all(
    accounts.map(async (account) => {
      try {
        const { scheduled } = await list(account.account);
        for (const raw of scheduled || []) {
          const row = normalizeScheduledSend(raw, account);
          if (row && row.state === 'pending') result.rows.push(row);
        }
      } catch {
        result.failedAccounts.push(account.label);
      }
    }),
  );
  result.rows.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));
  return result;
}
