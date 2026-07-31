/**
 * Chooses which connected account a Nylas grant belongs to.
 *
 * A grant should map to exactly one account, and for a long time the lookup
 * assumed it by using Convex's `.unique()`. That throws when the index matches
 * more than once — and because `by_grant` is global, the same mailbox connected
 * under a second user was enough to make it throw. It is the first thing every
 * inbound webhook does, so three mailboxes stopped ingesting mail entirely
 * while still reporting healthy.
 *
 * The ambiguity is still a data problem worth cleaning up. It just must not be
 * able to stop mail.
 */
export interface GrantAccountRow {
  status?: string;
  createdAt?: number;
}

export function pickAccountForGrant<T extends GrantAccountRow>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  // A live connection always beats a disconnected leftover, so a stale row can
  // never shadow the account actually receiving mail. Among equals the newest
  // wins, since that is the most recent authorization.
  const connected = rows.filter((row) => row.status === 'connected');
  const candidates = connected.length ? connected : rows;
  return candidates.reduce((newest, row) => ((row.createdAt ?? 0) > (newest.createdAt ?? 0) ? row : newest));
}
