// Direct Google push: the calendar poll back-off. The 15-minute calendar
// cron (/api/cron/calendar-sync) skips an account whose calendars all have a
// live, verified push channel. Such an account still gets a poll when its
// daily full pass is due, and when its last sync is older than
// CALENDAR_PUSH_FALLBACK_POLL_MS (one hour). With LAB86_GOOGLE_CALENDAR_PUSH
// off, nothing changes and no Convex read is added.

import { resolveCalendarWindow } from '@/lib/calendar/sync';
import { api, convexQuery } from '@/lib/hosted/convex';
import { googlePushFlags } from './config';
import { CALENDAR_PUSH_FALLBACK_POLL_MS } from './rules';

type CalendarPollState = { lastSyncedAt?: number; lastFullSyncAt?: number; windowEnd?: number } | null;

interface CalendarPollPlanRow {
  accountId: string;
  healthy: boolean;
  state: CalendarPollState;
}

/** True when the cron poll can skip this account: push brings its changes. */
export function calendarPushPollSkipped({
  healthy,
  state,
  now,
  key,
}: {
  healthy: boolean;
  state: CalendarPollState;
  now: number;
  key: string;
}): boolean {
  if (!healthy || !state) return false;
  // The daily full pass reaches events outside the hot window; push does not replace it.
  if (resolveCalendarWindow('auto', state, now, key) === 'full') return false;
  const last = Number(state.lastSyncedAt) || 0;
  return now - last < CALENDAR_PUSH_FALLBACK_POLL_MS;
}

const defaults = {
  flags: () => googlePushFlags(),
  query: convexQuery,
  now: () => Date.now(),
};
let deps = defaults;

export function __setCalendarPushPollDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

/** The accounts of one user that the calendar cron skips on this run. A failed read skips none. */
export async function calendarPushPollSkips(userId: string): Promise<string[]> {
  if (!deps.flags().calendar) return [];
  try {
    const rows = await deps.query<CalendarPollPlanRow[]>(api.googlePush.calendarPollPlan, { userId });
    const now = deps.now();
    return (rows || [])
      .filter((row) =>
        calendarPushPollSkipped({
          healthy: row.healthy,
          state: row.state,
          now,
          key: `${userId}:${row.accountId}`,
        }),
      )
      .map((row) => row.accountId);
  } catch (err: any) {
    console.warn('[google-push] calendar poll plan failed; every account is polled', err?.message || err);
    return [];
  }
}
