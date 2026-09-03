import { api, convexQuery } from '@/lib/hosted/convex';
import { type CalendarSyncResult, syncAllCalendarAccounts, syncCalendarAccount } from './sync';

const calendarApi = (api as any).calendarData;

// One entry point for every user-triggered calendar resync: the HTTP route,
// the mobile `calendar.resync` command, and the `calendar_sync_now` tool.
// The reason decides two things: whether the debounce applies, and whether
// the sync claim is forced.

// Reasons a client can send over HTTP or the mobile command.
export const CALENDAR_RESYNC_CLIENT_REASONS = ['view_open', 'pull', 'manual_http'] as const;
export type CalendarResyncClientReason = (typeof CALENDAR_RESYNC_CLIENT_REASONS)[number];

// Reasons the server adds for its own callers.
export type CalendarResyncReason = CalendarResyncClientReason | 'manual_tool';

// A `view_open` resync is skipped when the last sync finished less than this
// long ago.
export const VIEW_OPEN_RESYNC_DEBOUNCE_MS = 2 * 60_000;

export interface CalendarSyncStateSummary {
  accountId: string;
  status?: string;
  lastSyncedAt?: number | null;
}

export interface CalendarResyncDecision {
  start: boolean;
  force: boolean;
  skippedReason?: 'fresh';
}

export interface CalendarResyncOutcome {
  started: boolean;
  lastSyncedAt: number | null;
  skippedReason?: 'fresh';
  results?: CalendarSyncResult[];
}

export function parseCalendarResyncReason(value: unknown): CalendarResyncClientReason | null {
  if (typeof value !== 'string') return null;
  return (CALENDAR_RESYNC_CLIENT_REASONS as readonly string[]).includes(value)
    ? (value as CalendarResyncClientReason)
    : null;
}

// `view_open` is a passive signal and must not use the manual rate limit.
export function consumesCalendarResyncRateLimit(reason: CalendarResyncReason): boolean {
  return reason !== 'view_open';
}

// The time all requested accounts were fresh. One account without a completed
// sync makes the answer null, so the debounce lets the sync run.
export function latestCalendarSyncedAt(states: CalendarSyncStateSummary[]): number | null {
  let oldest: number | null = null;
  for (const state of states) {
    if (state.status === 'unauthorized') continue;
    const value = Number(state.lastSyncedAt);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (oldest === null || value < oldest) oldest = value;
  }
  return oldest;
}

export function decideCalendarResync({
  reason,
  lastSyncedAt,
  nowMs,
  debounceMs = VIEW_OPEN_RESYNC_DEBOUNCE_MS,
}: {
  reason: CalendarResyncReason;
  lastSyncedAt: number | null;
  nowMs: number;
  debounceMs?: number;
}): CalendarResyncDecision {
  if (reason !== 'view_open') return { start: true, force: true };
  if (lastSyncedAt !== null && nowMs - lastSyncedAt < debounceMs) {
    return { start: false, force: false, skippedReason: 'fresh' };
  }
  // A passive open does not override an active claim or an unauthorized
  // account.
  return { start: true, force: false };
}

export interface CalendarResyncDependencies {
  readSyncStates: (userId: string) => Promise<CalendarSyncStateSummary[]>;
  syncAccount: typeof syncCalendarAccount;
  syncAll: typeof syncAllCalendarAccounts;
  now: () => number;
  reportError: (message: string, error: unknown) => void;
}

const defaultDependencies: CalendarResyncDependencies = {
  async readSyncStates(userId) {
    const rows = await convexQuery<any[] | null>(calendarApi.getSyncStates, { userId }).catch(() => null);
    return (rows || []).map((row) => ({
      accountId: String(row.accountId),
      status: typeof row.status === 'string' ? row.status : undefined,
      lastSyncedAt: typeof row.lastSyncedAt === 'number' ? row.lastSyncedAt : null,
    }));
  },
  syncAccount: syncCalendarAccount,
  syncAll: syncAllCalendarAccounts,
  now: () => Date.now(),
  reportError: (message, error) => console.error(message, (error as any)?.message || error),
};

export interface StartCalendarResyncInput {
  userId: string;
  accountId?: string;
  reason: CalendarResyncReason;
  // When true, the call waits for the sync and returns its results.
  wait?: boolean;
}

export async function startCalendarResync(
  input: StartCalendarResyncInput,
  deps: CalendarResyncDependencies = defaultDependencies,
): Promise<CalendarResyncOutcome> {
  const states = await deps.readSyncStates(input.userId);
  const scoped = input.accountId ? states.filter((state) => state.accountId === input.accountId) : states;
  const lastSyncedAt = latestCalendarSyncedAt(scoped);
  const decision = decideCalendarResync({ reason: input.reason, lastSyncedAt, nowMs: deps.now() });
  if (!decision.start) {
    return { started: false, lastSyncedAt, skippedReason: decision.skippedReason };
  }
  const run = () =>
    input.accountId
      ? deps
          .syncAccount({
            userId: input.userId,
            accountId: input.accountId,
            force: decision.force,
            reason: input.reason,
          })
          .then((result) => [result])
      : deps.syncAll(input.userId, { force: decision.force, reason: input.reason });
  if (input.wait) {
    const results = await run();
    return { started: true, lastSyncedAt, results };
  }
  void run().catch((error) => {
    deps.reportError(
      `[calendar] resync (${input.reason}) failed for ${input.accountId || 'all accounts'}:`,
      error,
    );
  });
  return { started: true, lastSyncedAt };
}
