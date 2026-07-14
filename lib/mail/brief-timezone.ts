import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';

// The Daily Brief's dateline, weather geocoding, and calendar formatting all
// hang off one timezone. The request context carries what the trigger sent —
// the browser header (which correctly tracks travel) or the cron's calendar
// guess — and when it is a real zone it wins. Only when the context is missing
// or unusable (UTC/GMT filler, garbage) do the user's synced calendars fill it
// in, and nothing here ever invents a default city or zone.

interface CalendarTimezoneRow {
  timezone?: string | null;
  isPrimary?: boolean | null;
}

/** True for a real, Intl-resolvable IANA zone that actually localizes
 * (UTC/GMT/Etc zones are provider filler, not a user's place). */
export function isUsableTimezone(tz: string | null | undefined): boolean {
  const value = String(tz || '').trim();
  if (!value || /^(UTC|GMT|Etc\/)/i.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The most plausible user timezone across their synced calendars: usable
 * zones only, votes counted per calendar with primaries weighted heavier. */
export function pickCalendarTimezone(calendars: CalendarTimezoneRow[]): string | null {
  const votes = new Map<string, number>();
  for (const calendar of calendars || []) {
    const tz = String(calendar?.timezone || '').trim();
    if (!isUsableTimezone(tz)) continue;
    votes.set(tz, (votes.get(tz) || 0) + (calendar.isPrimary ? 2 : 1));
  }
  let best: string | null = null;
  let bestVotes = 0;
  for (const [tz, count] of votes) {
    if (count > bestVotes) {
      best = tz;
      bestVotes = count;
    }
  }
  return best;
}

async function listCalendarTimezones(userId: string): Promise<CalendarTimezoneRow[]> {
  if (!isConvexConfigured()) return [];
  const calendars = await convexQuery<CalendarTimezoneRow[]>((api as any).calendarData.listCalendars, {
    userId,
  });
  return Array.isArray(calendars) ? calendars : [];
}

/** Resolve the timezone a brief should be composed in: a usable context
 * (browser/cron) value wins — it tracks where the user actually is right now,
 * including travel. Calendar consensus only fills a missing/unusable context;
 * otherwise undefined (callers render UTC times and skip anything
 * place-derived rather than guessing a city). */
export async function resolveBriefTimezone(
  userId: string | null | undefined,
  contextTimezone: string | undefined,
  deps: { listCalendars?: (userId: string) => Promise<CalendarTimezoneRow[]> } = {},
): Promise<string | undefined> {
  if (isUsableTimezone(contextTimezone)) return contextTimezone;
  if (!userId) return undefined;
  try {
    const calendars = await (deps.listCalendars ?? listCalendarTimezones)(userId);
    return pickCalendarTimezone(calendars) ?? undefined;
  } catch (err) {
    console.warn('[brief-timezone] calendar timezone lookup failed; brief runs without one:', err);
    return undefined;
  }
}
