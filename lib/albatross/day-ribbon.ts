// The day, drawn to scale.
//
// A list of times tells you what is booked. A ribbon tells you what the day
// *feels* like — where the pressure is, where the open air is, how much of the
// afternoon is actually yours. That is the question Today is meant to answer,
// and a bulleted list cannot answer it.
//
// The maths lives here so the shape of a day is testable without a browser.

import type { TodayEvent } from './today';

/** The ribbon only draws the waking window unless events push past it. */
export const RIBBON_DEFAULT_START_HOUR = 7;
export const RIBBON_DEFAULT_END_HOUR = 22;

export interface RibbonWindow {
  startHour: number;
  endHour: number;
}

export interface RibbonBlock {
  id: string;
  title: string;
  /** 0..1 down the ribbon. */
  top: number;
  height: number;
  allDay: boolean;
  label: string;
  location?: string | null;
  /** True when the block is too short to carry a title and a time on two lines. */
  compact?: boolean;
}

export interface RibbonGap {
  /** 0..1 down the ribbon. */
  top: number;
  height: number;
  /** Whole minutes of open air. */
  minutes: number;
  label: string;
}

const hourOf = (ms: number) => {
  const date = new Date(ms);
  return date.getHours() + date.getMinutes() / 60;
};

/**
 * Where an event sits on the day being drawn, in hours from midnight.
 *
 * An overnight event is the reason this exists. A flight that left at 22:00
 * yesterday and lands at 09:00 today is part of today, so it comes back from
 * the day query — but its start hour is 22 and its end hour is 9. Read as plain
 * hours-of-day that is a block with negative height, drawn near the foot of the
 * ribbon at ten at night. Clamping to the drawn day puts it where it belongs:
 * running from the top of the ribbon down to nine.
 */
function eventHours(
  event: { startAt: number; endAt: number },
  nowMs: number,
): { start: number; end: number } {
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  // The clock, not the stopwatch. On the day the clocks go forward a two-hour
  // meeting at nine is still drawn at nine, because the ribbon is a picture of
  // a clock face. Counting elapsed milliseconds from midnight would slide every
  // event by an hour on exactly two days a year, and push a late one off the
  // foot of the ribbon.
  const placeInDay = (ms: number) => {
    if (ms <= dayStart.getTime()) return 0;
    if (ms >= dayEnd.getTime()) return 24;
    return hourOf(ms);
  };
  return { start: placeInDay(event.startAt), end: placeInDay(event.endAt) };
}

/**
 * How much of the clock the ribbon needs to cover. A 6am flight or a late
 * concert must not be clipped off the end of the day.
 */
export function ribbonWindow(events: TodayEvent[], nowMs: number): RibbonWindow {
  const timed = events.filter((event) => !event.allDay && event.status !== 'cancelled');
  let start = RIBBON_DEFAULT_START_HOUR;
  let end = RIBBON_DEFAULT_END_HOUR;
  for (const event of timed) {
    const hours = eventHours(event, nowMs);
    start = Math.min(start, Math.floor(hours.start));
    end = Math.max(end, Math.ceil(hours.end));
  }
  // Keep "now" on the ribbon so the marker is never off the top or bottom.
  const now = hourOf(nowMs);
  start = Math.min(start, Math.floor(now));
  end = Math.max(end, Math.ceil(now));
  return { startHour: Math.max(0, start), endHour: Math.min(24, Math.max(end, start + 4)) };
}

function fraction(hour: number, window: RibbonWindow) {
  const span = window.endHour - window.startHour;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (hour - window.startHour) / span));
}

/** Where "now" sits on the ribbon, or null when today is not the day shown. */
export function nowMarker(nowMs: number, window: RibbonWindow): number | null {
  const now = hourOf(nowMs);
  if (now < window.startHour || now > window.endHour) return null;
  return fraction(now, window);
}

export function ribbonBlocks(
  events: TodayEvent[],
  window: RibbonWindow,
  nowMs: number,
  locale = 'en-US',
): RibbonBlock[] {
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return events
    .filter((event) => event.status !== 'cancelled' && !event.allDay)
    .map((event) => {
      const hours = eventHours(event, nowMs);
      const top = fraction(hours.start, window);
      const bottom = fraction(hours.end, window);
      return {
        id: event._id,
        title: event.title,
        top,
        // A fifteen-minute stand-up still has to be readable and tappable.
        height: Math.max(bottom - top, 0.035),
        allDay: false,
        label: `${time(event.startAt)} – ${time(event.endAt)}`,
        location: event.location ?? null,
      };
    })
    .sort((a, b) => a.top - b.top);
}

/**
 * Make the drawn blocks legible without lying about the day.
 *
 * Two problems only appear once the ribbon has a real pixel height. A quarter-
 * hour block is shorter than the two lines of text inside it, so the text gets
 * cut in half. And a stand-up at nine followed by a review at half past nine
 * are close enough that the first block's minimum height runs into the second.
 *
 * So: anything with less room than `twoLineHeight` is marked compact and drawn
 * on one line, nothing is drawn shorter than `minHeight`, and a block that
 * would run into the one above it is nudged down to clear it. The label always
 * states the true time, so a nudge changes the drawing, never the claim.
 */
export function stackBlocks(
  blocks: RibbonBlock[],
  minHeight: number,
  twoLineHeight = minHeight,
): RibbonBlock[] {
  const stacked: RibbonBlock[] = [];
  let floor = 0;
  for (const block of blocks) {
    const compact = block.height < twoLineHeight;
    const height = Math.min(Math.max(block.height, minHeight), 1);
    const top = Math.min(Math.max(block.top, floor), Math.max(0, 1 - height));
    stacked.push({ ...block, top, height, compact });
    floor = top + height;
  }
  return stacked;
}

function describeGap(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest >= 15) return `${hours}h ${rest}m free`;
  if (hours) return `${hours === 1 ? '1 hour' : `${hours} hours`} free`;
  return `${minutes}m free`;
}

/**
 * The open air between commitments.
 *
 * This is the part a plain agenda never shows and the part that decides
 * whether anything can actually move today. Only gaps worth using are drawn —
 * a nine-minute window between two meetings is not free time, it is a corridor.
 */
export function ribbonGaps(
  blocks: RibbonBlock[],
  window: RibbonWindow,
  nowMs: number,
  minMinutes = 45,
): RibbonGap[] {
  const spanMinutes = (window.endHour - window.startHour) * 60;
  const nowFraction = nowMarker(nowMs, window) ?? 0;
  const gaps: RibbonGap[] = [];
  // Start from now rather than from the top: time already gone is not open.
  let cursor = Math.max(0, nowFraction);
  for (const block of blocks) {
    if (block.top > cursor) {
      const minutes = Math.round((block.top - cursor) * spanMinutes);
      if (minutes >= minMinutes) {
        gaps.push({ top: cursor, height: block.top - cursor, minutes, label: describeGap(minutes) });
      }
    }
    cursor = Math.max(cursor, block.top + block.height);
  }
  if (cursor < 1) {
    const minutes = Math.round((1 - cursor) * spanMinutes);
    if (minutes >= minMinutes) {
      gaps.push({ top: cursor, height: 1 - cursor, minutes, label: describeGap(minutes) });
    }
  }
  return gaps;
}

/** Hour ticks for the rail, thinned out so a long day does not turn to noise. */
export function ribbonTicks(window: RibbonWindow): Array<{ hour: number; top: number; label: string }> {
  const span = window.endHour - window.startHour;
  const step = span > 12 ? 3 : span > 8 ? 2 : 1;
  const ticks: Array<{ hour: number; top: number; label: string }> = [];
  for (let hour = window.startHour; hour <= window.endHour; hour += step) {
    const display = hour % 12 === 0 ? 12 : hour % 12;
    const suffix = hour >= 12 && hour < 24 ? 'pm' : 'am';
    ticks.push({ hour, top: fraction(hour, window), label: `${display}${suffix}` });
  }
  return ticks;
}

/** One honest sentence about how much of the day is actually open. */
export function openAirLine(gaps: RibbonGap[]): string {
  if (!gaps.length) return 'No real openings left today.';
  const longest = gaps.reduce((best, gap) => (gap.minutes > best.minutes ? gap : best));
  const total = gaps.reduce((sum, gap) => sum + gap.minutes, 0);
  if (gaps.length === 1) return `One opening left — ${describeGap(longest.minutes)}.`;
  return `${gaps.length} openings left, ${describeGap(total)} in all.`;
}
