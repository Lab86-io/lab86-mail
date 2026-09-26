import { emailFromHeader, shortFrom } from '../shared/format';

// Sender cleanup (FEATURES item 13). The list ranks the senders whose mail the
// user does not read or that the classifier filed as Noise, promotion, or
// newsletter, so a few taps unsubscribe or block the loudest ones. Pure: the
// Convex query (mailCorpus.senderCleanupCandidates) runs it over the recent
// corpus, and the tests run it directly.

/** Only the headers the product reads are kept on corpus messages. */
export const KEPT_MESSAGE_HEADERS = [
  'list-id',
  'list-unsubscribe',
  'list-unsubscribe-post',
  'precedence',
  'auto-submitted',
  'x-campaign-id',
  'x-mailer-campaign',
] as const;

/** Keeps the list and bulk headers, lowercased, each clipped to 1000 characters. */
export function keptMessageHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    const key = name.toLowerCase();
    if (!(KEPT_MESSAGE_HEADERS as readonly string[]).includes(key)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    kept[key] = value.trim().slice(0, 1000);
  }
  return Object.keys(kept).length ? kept : undefined;
}

export interface CleanupThreadInput {
  accountId: string;
  providerThreadId: string;
  fromAddress: string;
  subject?: string;
  lastDate: number;
  unread?: boolean;
  labels?: string[];
  smartPrimary?: string | null;
  jev?: { purpose?: string } | null;
}

export interface SenderCleanupRow {
  sender: string;
  name: string;
  threads: number;
  unread: number;
  inInbox: number;
  lowValue: number;
  lastDate: number;
  accounts: string[];
  /** The newest thread, used to find the unsubscribe headers. */
  latest: { accountId: string; threadId: string; subject: string };
  reason: string;
}

const LOW_VALUE_PURPOSES = new Set(['promotion', 'newsletter']);

export function isLowValueThread(thread: CleanupThreadInput) {
  return thread.smartPrimary === 'noise' || LOW_VALUE_PURPOSES.has(String(thread.jev?.purpose || ''));
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function cleanupReason(row: Pick<SenderCleanupRow, 'threads' | 'unread' | 'lowValue'>) {
  const parts = [plural(row.threads, 'thread')];
  if (row.unread) parts.push(row.unread === row.threads ? 'none opened' : `${row.unread} unopened`);
  if (row.lowValue === row.threads) parts.push('all sorted as Noise or promotions');
  else if (row.lowValue) parts.push(`${row.lowValue} sorted as Noise or promotions`);
  return parts.join(', ');
}

/**
 * Groups recent threads by sender and ranks the low-value senders: most
 * low-value threads first, then most unopened. The user's own addresses and
 * senders with fewer than two threads are left out.
 */
export function rankSendersForCleanup(
  threads: CleanupThreadInput[],
  options: { selfEmails?: string[]; limit?: number } = {},
): SenderCleanupRow[] {
  const self = new Set((options.selfEmails || []).map((email) => email.toLowerCase()));
  const groups = new Map<string, SenderCleanupRow>();
  for (const thread of threads) {
    const sender = emailFromHeader(thread.fromAddress);
    if (!sender || self.has(sender)) continue;
    const labels = thread.labels || [];
    if (labels.includes('SENT') || labels.includes('DRAFT')) continue;
    let row = groups.get(sender);
    if (!row) {
      row = {
        sender,
        name: shortFrom(thread.fromAddress) || sender,
        threads: 0,
        unread: 0,
        inInbox: 0,
        lowValue: 0,
        lastDate: 0,
        accounts: [],
        latest: {
          accountId: thread.accountId,
          threadId: thread.providerThreadId,
          subject: thread.subject || '',
        },
        reason: '',
      };
      groups.set(sender, row);
    }
    row.threads += 1;
    if (thread.unread) row.unread += 1;
    if (labels.includes('INBOX')) row.inInbox += 1;
    if (isLowValueThread(thread)) row.lowValue += 1;
    if (!row.accounts.includes(thread.accountId)) row.accounts.push(thread.accountId);
    if (thread.lastDate > row.lastDate) {
      row.lastDate = thread.lastDate;
      row.latest = {
        accountId: thread.accountId,
        threadId: thread.providerThreadId,
        subject: thread.subject || '',
      };
    }
  }
  return [...groups.values()]
    .filter((row) => row.threads >= 2 && row.lowValue >= 1)
    .sort(
      (a, b) =>
        b.lowValue - a.lowValue || b.unread - a.unread || b.threads - a.threads || b.lastDate - a.lastDate,
    )
    .slice(0, Math.max(1, options.limit ?? 40))
    .map((row) => ({ ...row, reason: cleanupReason(row) }));
}
