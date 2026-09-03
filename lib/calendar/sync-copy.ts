// Copy and small pure helpers for the calendar sync sentence. The surface
// shows one line: "Synced 4 minutes ago", "Syncing", "Not synced yet", or an
// error sentence that is also the retry control.

export interface CalendarSyncStateView {
  accountId: string;
  status?: string;
  lastSyncedAt?: number | null;
  updatedAt?: number;
  error?: string;
}

export type CalendarSyncError = { kind: 'failed' } | { kind: 'limited'; retryAt: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

// The relative sentence for the last completed sync.
export function syncedLine(lastSyncedAt: number | null | undefined, nowMs: number): string {
  if (typeof lastSyncedAt !== 'number' || !Number.isFinite(lastSyncedAt) || lastSyncedAt <= 0) {
    return 'Not synced yet';
  }
  const age = Math.max(0, nowMs - lastSyncedAt);
  if (age < MINUTE_MS) return 'Synced just now';
  if (age < HOUR_MS) return `Synced ${plural(Math.floor(age / MINUTE_MS), 'minute')} ago`;
  if (age < DAY_MS) return `Synced ${plural(Math.floor(age / HOUR_MS), 'hour')} ago`;
  return `Synced ${plural(Math.floor(age / DAY_MS), 'day')} ago`;
}

// The sentence after a 429. It counts down in whole minutes, then seconds.
export function retryLine(retryAt: number, nowMs: number): string {
  const wait = Math.max(0, retryAt - nowMs);
  if (wait >= MINUTE_MS) {
    return `Too many syncs. Try again in ${plural(Math.ceil(wait / MINUTE_MS), 'minute')}.`;
  }
  return `Too many syncs. Try again in ${plural(Math.max(1, Math.ceil(wait / 1000)), 'second')}.`;
}

export const SYNC_FAILED_LINE = 'Could not sync. Try again.';
export const SYNCING_LINE = 'Syncing';

// One sentence for the header. Error wins, then the active sync, then the age.
export function syncStatusLine(input: {
  lastSyncedAt: number | null | undefined;
  nowMs: number;
  syncing: boolean;
  error: CalendarSyncError | null;
}): string {
  if (input.error?.kind === 'limited' && input.error.retryAt > input.nowMs) {
    return retryLine(input.error.retryAt, input.nowMs);
  }
  if (input.error?.kind === 'failed') return SYNC_FAILED_LINE;
  if (input.syncing) return SYNCING_LINE;
  return syncedLine(input.lastSyncedAt, input.nowMs);
}

// The time every account was fresh: the oldest completed sync. One account
// without a completed sync makes the answer null. Unauthorized accounts do
// not count. This mirrors the server rule in lib/calendar/resync.ts.
export function oldestSyncedAt(states: readonly CalendarSyncStateView[]): number | null {
  let oldest: number | null = null;
  for (const state of states) {
    if (state.status === 'unauthorized') continue;
    const value = Number(state.lastSyncedAt);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (oldest === null || value < oldest) oldest = value;
  }
  return oldest;
}

// Sync state per account, for the pending-event rule.
export function syncedAtByAccount(states: readonly CalendarSyncStateView[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const state of states) {
    const value = Number(state.lastSyncedAt);
    if (Number.isFinite(value) && value > 0) map.set(state.accountId, value);
  }
  return map;
}

export function anyAccountSyncing(states: readonly CalendarSyncStateView[]): boolean {
  return states.some((state) => state.status === 'syncing');
}

// A mirror row written by the app carries the same fields as a synced row.
// The row is pending until its account completes a sync after the write.
export function isPendingEventRow(
  row: { accountId: string; createdAt?: number },
  syncedAt: Map<string, number>,
): boolean {
  const lastSyncedAt = syncedAt.get(row.accountId);
  if (typeof lastSyncedAt !== 'number') return false;
  return Number(row.createdAt) > lastSyncedAt;
}
