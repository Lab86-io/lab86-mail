// The horizon of one Work: now, later, or someday.
//
// A horizon keeps Work without a cost. Dormant Work stays out of Today, the
// conductor does not move it, and no review asks about it. A daily wake
// returns it with one calm line. This module is pure so every platform
// receives the same decision.

import { z } from 'zod';
import { truncateText } from '../shared/text';
import { parseIsoInTimezone } from '../shared/timezones';

export type HorizonKind = 'now' | 'later' | 'someday';

export interface WorkHorizon {
  kind: HorizonKind;
  /** Epoch ms. The Work is dormant while now < notBefore. */
  notBefore?: number;
  /** Epoch ms. A soft target date. Shown, never enforced. */
  by?: number;
  /** The user's own words, for example "after the wedding". */
  label?: string;
  /** Set once when the wake nudge fired. */
  wokeAt?: number;
}

export interface HorizonWorkLike {
  horizon?: WorkHorizon | null;
}

export const HORIZON_KINDS = ['now', 'later', 'someday'] as const;

export const workHorizonSchema = z
  .object({
    kind: z.enum(HORIZON_KINDS),
    notBefore: z.number().int().nonnegative().optional(),
    by: z.number().int().nonnegative().optional(),
    label: z.string().trim().min(1).max(120).optional(),
    wokeAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const DAY_MS = 24 * 60 * 60_000;

/**
 * Dormant Work is kept, not carried. A future `notBefore` sleeps until that
 * day. "Someday" sleeps until the user moves it. "Later" without a date also
 * sleeps: the user asked for quiet, and nobody can wake it on a date it does
 * not have.
 */
export function isDormant(work: HorizonWorkLike | null | undefined, nowMs: number): boolean {
  const horizon = work?.horizon;
  if (!horizon) return false;
  if (typeof horizon.notBefore === 'number' && horizon.notBefore > nowMs) return true;
  if (horizon.kind === 'someday') return true;
  if (horizon.kind === 'later' && typeof horizon.notBefore !== 'number') return true;
  return false;
}

/** Wake is due when the sleep date passed and no wake fired yet. */
export function wakeIsDue(work: HorizonWorkLike | null | undefined, nowMs: number): boolean {
  const horizon = work?.horizon;
  if (!horizon || typeof horizon.notBefore !== 'number') return false;
  if (horizon.wokeAt) return false;
  return horizon.notBefore <= nowMs;
}

/** The horizon after a wake. The kind moves to "now" and the wake is recorded once. */
export function wokenHorizon(horizon: WorkHorizon, nowMs: number): WorkHorizon {
  return { ...horizon, kind: 'now', wokeAt: horizon.wokeAt ?? nowMs };
}

/** The copy of the wake notification. Exactly one line. */
export function wakeLine(title: string): string {
  return `${title.trim() || 'Something you kept'} is back. Ready when you are.`;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function sameDay(left: number, right: number): boolean {
  return startOfDay(left) === startOfDay(right);
}

/** "Friday" inside the coming week, "Nov 1" inside the year, then "Nov 1, 2027". */
export function shortDate(ms: number, nowMs: number, locale = 'en-US'): string {
  const date = new Date(ms);
  if (sameDay(ms, nowMs)) return 'today';
  if (sameDay(ms, nowMs + DAY_MS)) return 'tomorrow';
  const daysAhead = (startOfDay(ms) - startOfDay(nowMs)) / DAY_MS;
  if (daysAhead > 1 && daysAhead < 7) return date.toLocaleDateString(locale, { weekday: 'long' });
  if (date.getFullYear() === new Date(nowMs).getFullYear()) {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sentenceCase(value: string): string {
  const clean = value.trim();
  return clean ? clean[0].toUpperCase() + clean.slice(1) : clean;
}

/**
 * One short line for the UI. Null when there is nothing to say: Work on the
 * "now" horizon with no target date reads as plain Work.
 */
export function horizonLine(
  horizon: WorkHorizon | null | undefined,
  nowMs: number,
  locale = 'en-US',
): string | null {
  if (!horizon) return null;
  if (horizon.kind === 'someday') return 'Someday';
  if (typeof horizon.notBefore === 'number' && horizon.notBefore > nowMs) {
    return `Back on ${shortDate(horizon.notBefore, nowMs, locale)}`;
  }
  if (horizon.kind === 'later') {
    if (typeof horizon.notBefore === 'number') return 'Back now';
    return horizon.label ? sentenceCase(horizon.label) : 'Later';
  }
  if (typeof horizon.by === 'number') {
    return `By ${shortDate(horizon.by, nowMs, locale)}`;
  }
  return null;
}

/**
 * The "Later" shelf: dormant Work in wake order. Work without a wake date
 * sits at the far end, newest change first.
 */
export function laterShelf<T extends HorizonWorkLike & { updatedAt?: number }>(
  rows: T[],
  nowMs: number,
): T[] {
  return rows
    .filter((row) => isDormant(row, nowMs))
    .sort((a, b) => {
      const left = a.horizon?.notBefore;
      const right = b.horizon?.notBefore;
      if (typeof left === 'number' && typeof right === 'number') return left - right;
      if (typeof left === 'number') return -1;
      if (typeof right === 'number') return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

// Deterministic phrase parse. This is the fallback when the capture model
// gives no horizon, and the oracle the tests hold the model to.

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  few: 3,
};

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTH_PATTERN =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_PATTERN =
  '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)';
const UNIT_PATTERN = '(day|week|month|year)s?';
const COUNT_PATTERN =
  '(\\d{1,3}|a couple of|a few|couple of|few|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

function monthIndex(token: string): number {
  const prefix = token.slice(0, 3).toLowerCase();
  return MONTHS.findIndex((month) => month.startsWith(prefix));
}

function weekdayIndex(token: string): number {
  const prefix = token.slice(0, 3).toLowerCase();
  return WEEKDAYS.findIndex((day) => day.startsWith(prefix));
}

function countValue(token: string): number {
  const clean = token
    .trim()
    .toLowerCase()
    .replace(/^an?\s+/, '')
    .replace(/\s+of$/, '');
  if (/^\d+$/.test(clean)) return Number(clean);
  return NUMBER_WORDS[clean] ?? 1;
}

/**
 * Calendar arithmetic for horizon dates. With a timezone, "Monday" and
 * "November" are midnight in the user's zone, not the server's (WRK-19).
 * Without one, the process-local clock is used, as before.
 */
export interface HorizonClock {
  /** The calendar day of an instant: month is 0-based, weekday 0 is Sunday. */
  today(ms: number): { year: number; month: number; day: number; weekday: number };
  /** Midnight of a calendar day. Month and day may overflow, like `Date`. */
  midnight(year: number, month: number, day: number): number;
}

const LOCAL_CLOCK: HorizonClock = {
  today(ms) {
    const date = new Date(ms);
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), weekday: date.getDay() };
  },
  midnight(year, month, day) {
    return new Date(year, month, day, 0, 0, 0, 0).getTime();
  },
};

export function horizonClock(timezone?: string | null): HorizonClock {
  if (!timezone) return LOCAL_CLOCK;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return LOCAL_CLOCK;
  }
  return {
    today(ms) {
      const parts = format.formatToParts(new Date(ms));
      const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
      const year = get('year');
      const month = get('month') - 1;
      const day = get('day');
      return { year, month, day, weekday: new Date(Date.UTC(year, month, day)).getUTCDay() };
    },
    midnight(year, month, day) {
      const iso = new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
      return parseIsoInTimezone(`${iso}T00:00:00`, timezone, 'horizon');
    },
  };
}

function clockStartOfDay(clock: HorizonClock, ms: number): number {
  const today = clock.today(ms);
  return clock.midnight(today.year, today.month, today.day);
}

/** The next date with this month (and day). A month already passed rolls to next year. */
function nextMonthDate(nowMs: number, month: number, day = 1, clock: HorizonClock = LOCAL_CLOCK): number {
  const { year } = clock.today(nowMs);
  const target = clock.midnight(year, month, day);
  if (target <= clockStartOfDay(clock, nowMs)) return clock.midnight(year + 1, month, day);
  return target;
}

/** The next occurrence of this weekday, never today. */
function nextWeekday(nowMs: number, weekday: number, clock: HorizonClock = LOCAL_CLOCK): number {
  const today = clock.today(nowMs);
  const delta = (weekday - today.weekday + 7) % 7 || 7;
  return clock.midnight(today.year, today.month, today.day + delta);
}

function addUnits(nowMs: number, count: number, unit: string, clock: HorizonClock = LOCAL_CLOCK): number {
  const today = clock.today(nowMs);
  if (unit === 'day') return clock.midnight(today.year, today.month, today.day + count);
  if (unit === 'week') return clock.midnight(today.year, today.month, today.day + count * 7);
  if (unit === 'month') return clock.midnight(today.year, today.month + count, today.day);
  return clock.midnight(today.year + count, today.month, today.day);
}

function firstOfNextMonth(nowMs: number, clock: HorizonClock = LOCAL_CLOCK): number {
  const today = clock.today(nowMs);
  return clock.midnight(today.year, today.month + 1, 1);
}

function firstOfNextYear(nowMs: number, clock: HorizonClock = LOCAL_CLOCK): number {
  return clock.midnight(clock.today(nowMs).year + 1, 0, 1);
}

function nextMonday(nowMs: number, clock: HorizonClock = LOCAL_CLOCK): number {
  return nextWeekday(nowMs, 1, clock);
}

interface DateHit {
  at: number;
  label: string;
}

/** A date phrase after a preposition: month, month + day, weekday, "next week", "tomorrow". */
function parseDatePhrase(text: string, nowMs: number, clock: HorizonClock = LOCAL_CLOCK): DateHit | null {
  const monthDay = text.match(new RegExp(`^${MONTH_PATTERN}(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?\\b`, 'i'));
  if (monthDay) {
    const month = monthIndex(monthDay[1]);
    const day = monthDay[2] ? Math.min(Math.max(Number(monthDay[2]), 1), 31) : 1;
    return { at: nextMonthDate(nowMs, month, day, clock), label: monthDay[0] };
  }
  const weekday = text.match(new RegExp(`^(?:next\\s+)?${WEEKDAY_PATTERN}\\b`, 'i'));
  if (weekday) {
    return { at: nextWeekday(nowMs, weekdayIndex(weekday[1]), clock), label: weekday[0] };
  }
  if (/^tomorrow\b/i.test(text)) return { at: addUnits(nowMs, 1, 'day', clock), label: 'tomorrow' };
  if (/^next\s+week\b/i.test(text)) return { at: nextMonday(nowMs, clock), label: 'next week' };
  if (/^next\s+month\b/i.test(text)) return { at: firstOfNextMonth(nowMs, clock), label: 'next month' };
  if (/^next\s+year\b/i.test(text)) return { at: firstOfNextYear(nowMs, clock), label: 'next year' };
  const relative = text.match(new RegExp(`^(?:in\\s+)?${COUNT_PATTERN}\\s+${UNIT_PATTERN}\\b`, 'i'));
  if (relative) {
    return {
      at: addUnits(nowMs, countValue(relative[1]), relative[2].toLowerCase(), clock),
      label: relative[0],
    };
  }
  return null;
}

/**
 * Parse common horizon phrases. The result is null when the text carries no
 * horizon. A phrase with a date sets `notBefore` or `by`. A phrase without a
 * date ("after Thanksgiving") keeps only the label, so the Work sleeps until
 * the user sets a date.
 */
export function parseHorizonHint(text: string, nowMs: number, timezone?: string | null): WorkHorizon | null {
  const clock = horizonClock(timezone);
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();

  if (/\b(someday|some day|one day|eventually|no rush|whenever)\b/.test(lower)) {
    const match = lower.match(/\b(someday|some day|one day|eventually|no rush|whenever)\b/);
    return { kind: 'someday', label: match?.[1] };
  }

  let result: WorkHorizon | null = null;

  // Sleep phrases. Every hit is tried in order, so a filler "from the office"
  // earlier in the sentence cannot hide a real "not before November".
  const sleepPattern = /\b(not before|not until|no earlier than|starting|from|after)\s+(.+)$/g;
  for (let sleep = sleepPattern.exec(lower); sleep; sleep = sleepPattern.exec(lower)) {
    const preposition = sleep[1];
    const rest = sleep[2];
    const hit = parseDatePhrase(rest, nowMs, clock);
    if (hit) {
      result = { kind: 'later', notBefore: hit.at, label: `${preposition} ${hit.label}` };
      break;
    }
    // A named moment without a date ("after Thanksgiving"). Keep the user's
    // words only. The phrase must be short and must end the sentence, so
    // "after work call the dentist" stays plain Work.
    const phrase = rest.replace(/[.!?,;].*$/, '').trim();
    const words = phrase ? phrase.split(' ') : [];
    const endsSentence = phrase.length === rest.replace(/[.!?]\s*$/, '').trim().length;
    if (preposition === 'not before' || preposition === 'not until') {
      if (phrase) {
        result = { kind: 'later', label: `${preposition} ${truncateText(phrase, 80)}` };
        break;
      }
    } else if (preposition === 'after' && words.length >= 1 && words.length <= 3 && endsSentence) {
      result = { kind: 'later', label: `after ${truncateText(phrase, 80)}` };
      break;
    }
    sleepPattern.lastIndex = sleep.index! + preposition.length;
  }

  if (!result) {
    const relative = lower.match(new RegExp(`\\bin\\s+${COUNT_PATTERN}\\s+${UNIT_PATTERN}\\b`));
    const inMonth = lower.match(new RegExp(`\\bin\\s+${MONTH_PATTERN}\\b`));
    const next = lower.match(/\bnext\s+(week|month|year)\b/);
    if (relative) {
      result = {
        kind: 'later',
        notBefore: addUnits(nowMs, countValue(relative[1]), relative[2], clock),
        label: relative[0],
      };
    } else if (inMonth) {
      result = {
        kind: 'later',
        notBefore: nextMonthDate(nowMs, monthIndex(inMonth[1]), 1, clock),
        label: inMonth[0],
      };
    } else if (next) {
      const unit = next[1];
      const at =
        unit === 'week'
          ? nextMonday(nowMs, clock)
          : unit === 'month'
            ? firstOfNextMonth(nowMs, clock)
            : firstOfNextYear(nowMs, clock);
      result = { kind: 'later', notBefore: at, label: `next ${unit}` };
    }
  }

  // "not before" is a sleep, never a target.
  const due = lower.match(/\b(?:by|(?<!not\s)before|due)\s+(.+)$/);
  if (due) {
    const hit = parseDatePhrase(due[1], nowMs, clock);
    if (hit) {
      if (result) {
        if (typeof result.notBefore !== 'number' || hit.at >= result.notBefore) result.by = hit.at;
      } else {
        result = { kind: 'now', by: hit.at, label: `by ${hit.label}` };
      }
    }
  }

  return result;
}
