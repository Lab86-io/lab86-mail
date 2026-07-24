import { emailFromHeader } from '../shared/format';

export interface SenderPhotoRowLike {
  account?: string | null;
  from?: string | null;
  fromAddress?: string | null;
}

// Groups the visible rows' sender emails by their REAL account (falling back
// to `fallbackAccount` for rows that don't carry one — e.g. legacy caches),
// capped to the first `limit` rows for perf. Each account only needs one
// `resolve_photos` call for its own senders instead of one call resolving
// every row against a single account (which returns wrong/missing photos for
// any row from a different mailbox in the unified ALL_ACCOUNTS view).
export function groupSenderEmailsByAccount(
  rows: SenderPhotoRowLike[],
  fallbackAccount: string,
  limit = 48,
): Record<string, string[]> {
  const groups = new Map<string, Set<string>>();
  for (const row of rows.slice(0, limit)) {
    const account = row.account || fallbackAccount;
    if (!account) continue;
    const email = emailFromHeader(row.from || row.fromAddress);
    if (!email) continue;
    if (!groups.has(account)) groups.set(account, new Set());
    groups.get(account)?.add(email);
  }
  const out: Record<string, string[]> = {};
  for (const [account, emails] of groups) out[account] = [...emails].sort();
  return out;
}
