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
 * How much of the clock the ribbon needs to cover. A 6am flight or a late
 * concert must not be clipped off the end of the day.
 */
export function ribbonWindow(events: TodayEvent[], nowMs: number): RibbonWindow {
  const timed = events.filter((event) => !event.allDay && event.status !== 'cancelled');
  let start = RIBBON_DEFAULT_START_HOUR;
  let end = RIBBON_DEFAULT_END_HOUR;
  for (const event of timed) {
    start = Math.min(start, Math.floor(hourOf(event.startAt)));
    end = Math.max(end, Math.ceil(hourOf(event.endAt)));
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

export function ribbonBlocks(events: TodayEvent[], window: RibbonWindow, locale = 'en-US'): RibbonBlock[] {
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return events
    .filter((event) => event.status !== 'cancelled' && !event.allDay)
    .map((event) => {
      const top = fraction(hourOf(event.startAt), window);
      const bottom = fraction(hourOf(event.endAt), window);
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
