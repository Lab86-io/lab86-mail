// When the Daily Brief arrives (FEATURES item 3) and which edition a local day
// calls for (item 9). Pure, so the Convex scheduler, the app server, and the
// tests share one rule. Every hour here is a local hour in the user's zone.

/** The delivery hours the user can pick: 05:00 to 11:00. */
export const BRIEF_DELIVERY_HOURS = [5, 6, 7, 8, 9, 10, 11] as const;
export const DEFAULT_BRIEF_DELIVERY_HOUR = 7;

/**
 * Weekend editions. `light` keeps the lede, the answer lane, the today lane
 * with the calendar, and the week ahead. It leaves out the know (FYI) lane,
 * the waiting list, tasks, connected tools, and areas. `off` writes nothing.
 */
export const BRIEF_WEEKEND_MODES = ['full', 'light', 'off'] as const;
export type BriefWeekendMode = (typeof BRIEF_WEEKEND_MODES)[number];
export const DEFAULT_BRIEF_WEEKEND_MODE: BriefWeekendMode = 'light';

/** A missed delivery hour fires again on each hourly tick for this many hours. */
export const BRIEF_CATCH_UP_HOURS = 4;

export interface BriefSchedule {
  deliveryHour: number;
  weekendMode: BriefWeekendMode;
  /** The Sunday weekly review replaces the Sunday daily edition. */
  weeklyReview: boolean;
}

export const DEFAULT_BRIEF_SCHEDULE: BriefSchedule = {
  deliveryHour: DEFAULT_BRIEF_DELIVERY_HOUR,
  weekendMode: DEFAULT_BRIEF_WEEKEND_MODE,
  weeklyReview: true,
};

export function isBriefDeliveryHour(value: unknown): value is number {
  return typeof value === 'number' && (BRIEF_DELIVERY_HOURS as readonly number[]).includes(value);
}

export function isBriefWeekendMode(value: unknown): value is BriefWeekendMode {
  return typeof value === 'string' && (BRIEF_WEEKEND_MODES as readonly string[]).includes(value);
}

/** The stored preference fields, with the defaults for anything missing or invalid. */
export function normalizeBriefSchedule(
  row:
    | {
        briefDeliveryHour?: unknown;
        briefWeekendMode?: unknown;
        weeklyReviewEnabled?: unknown;
      }
    | null
    | undefined,
): BriefSchedule {
  return {
    deliveryHour: isBriefDeliveryHour(row?.briefDeliveryHour)
      ? row.briefDeliveryHour
      : DEFAULT_BRIEF_DELIVERY_HOUR,
    weekendMode: isBriefWeekendMode(row?.briefWeekendMode)
      ? row.briefWeekendMode
      : DEFAULT_BRIEF_WEEKEND_MODE,
    weeklyReview: row?.weeklyReviewEnabled !== false,
  };
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local weekday (0 = Sunday) in `timezone` at `at`, or null for a bad zone. */
export function localWeekday(timezone: string, at: Date): number | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(at);
    return WEEKDAY_INDEX[name] ?? null;
  } catch {
    return null;
  }
}

export type ScheduledBriefEdition = { kind: 'morning'; light: boolean } | { kind: 'weekly'; light: false };

/**
 * The edition a local weekday calls for, or null when the user turned the
 * day off. Sunday with the weekly review on gets the weekly review only.
 */
export function scheduledEditionFor(
  schedule: BriefSchedule,
  weekday: number | null,
): ScheduledBriefEdition | null {
  if (weekday === 0 && schedule.weeklyReview) return { kind: 'weekly', light: false };
  const weekend = weekday === 0 || weekday === 6;
  if (!weekend) return { kind: 'morning', light: false };
  if (schedule.weekendMode === 'off') return null;
  return { kind: 'morning', light: schedule.weekendMode === 'light' };
}

/** "7:00 AM" for an hour of the day. */
export function briefHourLabel(hour: number): string {
  const twelve = hour % 12 || 12;
  return `${twelve}:00 ${hour < 12 ? 'AM' : 'PM'}`;
}
