// The Snoozed list (MUT-1 follow-up). Snooze archives a thread and a cron
// brings it back, so no search or label finds snoozed mail. The list reads the
// active snooze rows instead (mailCorpus.listSnoozedThreads).

export interface SnoozedThreadRow {
  id: string;
  account: string;
  accountEmail: string | null;
  threadId: string;
  messageId: string | null;
  untilTs: number;
  snoozedAt: number;
  subject: string;
  fromAddress: string;
  snippet: string;
  lastDate: number | null;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** When a snoozed thread comes back: "Back today at 5:00 PM", "Back Fri, Oct 2 at 9:00 AM". */
export function snoozeReturnLabel(untilTs: number, now: Date = new Date(), locale?: string) {
  if (!Number.isFinite(untilTs) || untilTs <= now.getTime()) return 'Due back now';
  const at = new Date(untilTs);
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const today = startOfDay(now);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const day = startOfDay(at);
  if (day === today) return `Back today at ${time}`;
  if (day === tomorrow) return `Back tomorrow at ${time}`;
  const date = at.toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `Back ${date} at ${time}`;
}

/** Cancels the snooze and moves the thread back to the inbox now. */
export function unsnoozeSnoozedThread<T>(
  row: Pick<SnoozedThreadRow, 'account' | 'threadId'>,
  call: (name: string, args: Record<string, unknown>) => Promise<T>,
) {
  return call('unsnooze_thread', { account: row.account, threadId: row.threadId });
}
