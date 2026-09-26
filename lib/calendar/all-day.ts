// One rule for all-day dates, shared by the web grid, the Brief, the tools,
// and the write path.
//
// Sync stores an all-day row as the UTC midnight of its calendar date, with an
// exclusive end (a one-day event on 2026-09-26 is 2026-09-26T00:00Z →
// 2026-09-27T00:00Z). That instant is NOT the local start of the day: in New
// York it is 20:00 the day before. A reader must take the date from the UTC
// parts and then build the local midnight of that date. It must never read the
// stored instant in a local zone.

import { parseIsoInTimezone } from '@/lib/shared/timezones';

export const ALL_DAY_MS = 86_400_000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// "YYYY-MM-DD" of a stored all-day instant, from its UTC parts.
export function allDayDateKey(storedMs: number): string {
  return new Date(storedMs).toISOString().slice(0, 10);
}

// The stored instant (UTC midnight) of a "YYYY-MM-DD" date.
export function storedAllDayMs(dateKey: string): number {
  const match = DATE_ONLY_RE.exec(dateKey.trim());
  if (!match) throw new Error(`Invalid date: ${dateKey}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// Local midnight, in the runtime's zone, of a stored all-day instant. The web
// grid runs in the browser's zone, so this is the value it must display.
export function allDayLocalDate(storedMs: number): Date {
  const date = new Date(storedMs);
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// The web grid shows an all-day row from local midnight of its first date to
// the last moment of its last date, so a one-day event starts and ends on the
// same local date and never spills into the next day.
export function allDayDisplayRange(startAt: number, endAt: number): { start: Date; end: Date } {
  const start = allDayLocalDate(startAt);
  const endExclusive = allDayLocalDate(Math.max(endAt, startAt + ALL_DAY_MS));
  return { start, end: new Date(endExclusive.getTime() - 1) };
}

// The reverse for writes from the web grid: local dates to date-only strings
// with an exclusive end. An end at exactly local midnight is exclusive; any
// other end includes its day.
export function allDayWriteDates(start: Date, end: Date): { startIso: string; endIso: string } {
  const startKey = localDateKey(start);
  const lastDay = end.getTime() > start.getTime() && isLocalMidnight(end) ? new Date(end.getTime() - 1) : end;
  let endExclusive = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
  if (localDateKey(endExclusive) <= startKey) {
    endExclusive = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  }
  return { startIso: startKey, endIso: localDateKey(endExclusive) };
}

function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isLocalMidnight(date: Date): boolean {
  return (
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0 &&
    date.getMilliseconds() === 0
  );
}

// The calendar date ("YYYY-MM-DD") on which an instant falls in a zone.
export function dateKeyInZone(ms: number, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Converts an all-day write range to the stored convention (UTC-midnight
// start, exclusive UTC-midnight end), in the user's zone.
// - A UTC-midnight instant is already a stored date. Clients send date-only
//   strings ("2026-09-26"), and the tools parse those to local midnight, which
//   is also handled below.
// - Any other instant is read in the user's zone: the start takes the date on
//   which it falls. An end at exactly local midnight is exclusive; an end later
//   in a day includes that day.
// - An end on or before the start makes a one-day event.
export function normalizeAllDayRange(
  startAt: number,
  endAt: number,
  timeZone: string | undefined,
): { startAt: number; endAt: number } {
  const start = startAt % ALL_DAY_MS === 0 ? startAt : storedAllDayMs(dateKeyInZone(startAt, timeZone));
  let end: number;
  if (endAt % ALL_DAY_MS === 0) end = endAt;
  else {
    const endKey = dateKeyInZone(endAt, timeZone);
    const localMidnight = parseIsoInTimezone(endKey, timeZone, 'all-day end');
    end = storedAllDayMs(endKey) + (endAt === localMidnight ? 0 : ALL_DAY_MS);
  }
  if (end <= start) end = start + ALL_DAY_MS;
  return { startAt: start, endAt: end };
}
