import { describe, expect, test } from 'bun:test';
import {
  nowMarker,
  openAirLine,
  RIBBON_DEFAULT_END_HOUR,
  RIBBON_DEFAULT_START_HOUR,
  ribbonBlocks,
  ribbonGaps,
  ribbonTicks,
  ribbonWindow,
} from '../lib/albatross/day-ribbon';
import type { TodayEvent } from '../lib/albatross/today';

const at = (hour: number, minute = 0) => new Date(2026, 7, 3, hour, minute).getTime();
const NOON = at(12);

const event = (over: Partial<TodayEvent> & { _id: string }): TodayEvent => ({
  title: over.title ?? 'Meeting',
  startAt: over.startAt ?? at(10),
  endAt: over.endAt ?? at(11),
  allDay: over.allDay ?? false,
  location: over.location ?? null,
  status: 'status' in over ? over.status : null,
  _id: over._id,
});

describe('the ribbon covers the whole day it is given', () => {
  test('a quiet day uses the waking window', () => {
    expect(ribbonWindow([], NOON)).toEqual({
      startHour: RIBBON_DEFAULT_START_HOUR,
      endHour: RIBBON_DEFAULT_END_HOUR,
    });
  });

  test('an early flight is never clipped off the top', () => {
    const window = ribbonWindow([event({ _id: 'a', startAt: at(5), endAt: at(7) })], NOON);
    expect(window.startHour).toBeLessThanOrEqual(5);
  });

  test('a late concert is never clipped off the bottom', () => {
    const window = ribbonWindow([event({ _id: 'a', startAt: at(21), endAt: at(23, 30) })], NOON);
    expect(window.endHour).toBeGreaterThanOrEqual(24 - 1);
  });

  test('now always sits somewhere on the ribbon', () => {
    const earlyMorning = at(4);
    const window = ribbonWindow([], earlyMorning);
    expect(nowMarker(earlyMorning, window)).not.toBeNull();
  });
});

describe('blocks are drawn to scale', () => {
  test('a longer meeting is taller than a shorter one', () => {
    const window = ribbonWindow([], NOON);
    const [short, long] = ribbonBlocks(
      [
        event({ _id: 'short', startAt: at(9), endAt: at(9, 30) }),
        event({ _id: 'long', startAt: at(14), endAt: at(17) }),
      ],
      window,
    );
    expect(long.height).toBeGreaterThan(short.height);
    expect(short.top).toBeLessThan(long.top);
  });

  test('a fifteen-minute stand-up is still readable', () => {
    const window = ribbonWindow([], NOON);
    const [block] = ribbonBlocks([event({ _id: 'a', startAt: at(9), endAt: at(9, 15) })], window);
    // Drawn strictly to scale it would be a hairline nobody could read or tap.
    expect(block.height).toBeGreaterThanOrEqual(0.035);
  });

  test('cancelled and all-day events stay off the timed ribbon', () => {
    const window = ribbonWindow([], NOON);
    const blocks = ribbonBlocks(
      [
        event({ _id: 'gone', status: 'cancelled' }),
        event({ _id: 'holiday', allDay: true }),
        event({ _id: 'real' }),
      ],
      window,
    );
    expect(blocks.map((b) => b.id)).toEqual(['real']);
  });
});

describe('open air is the fact an agenda never states', () => {
  test('a real gap after a meeting is found and measured', () => {
    const window = ribbonWindow([], at(8));
    const blocks = ribbonBlocks([event({ _id: 'a', startAt: at(9), endAt: at(10) })], window);
    const gaps = ribbonGaps(blocks, window, at(8));
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some((gap) => gap.minutes >= 45)).toBe(true);
  });

  test('a corridor between two meetings is not called free time', () => {
    const window = ribbonWindow([], at(8));
    const blocks = ribbonBlocks(
      [
        event({ _id: 'a', startAt: at(9), endAt: at(10) }),
        event({ _id: 'b', startAt: at(10, 20), endAt: at(11) }),
      ],
      window,
    );
    const gaps = ribbonGaps(blocks, window, at(8));
    // Twenty minutes between two meetings is a corridor, not an opening.
    expect(gaps.every((gap) => gap.minutes >= 45)).toBe(true);
  });

  test('time already gone is never offered as open', () => {
    const window = ribbonWindow([], at(20));
    const gaps = ribbonGaps([], window, at(20));
    // At 8pm the morning is not available, however empty it was.
    expect(gaps.every((gap) => gap.top >= 0.8)).toBe(true);
  });

  test('a fully booked day says so plainly', () => {
    expect(openAirLine([])).toBe('No real openings left today.');
  });

  test('the summary counts openings rather than scoring the day', () => {
    const line = openAirLine([
      { top: 0, height: 0.1, minutes: 60, label: '1 hour free' },
      { top: 0.5, height: 0.1, minutes: 90, label: '1h 30m free' },
    ]);
    expect(line).toContain('2 openings');
    expect(line.toLowerCase()).not.toContain('productiv');
    expect(line.toLowerCase()).not.toContain('%');
  });
});

describe('the hour rail stays legible', () => {
  test('a long day thins its ticks rather than crowding them', () => {
    const short = ribbonTicks({ startHour: 9, endHour: 15 });
    const long = ribbonTicks({ startHour: 5, endHour: 23 });
    expect(long.length).toBeLessThanOrEqual(short.length + 2);
  });

  test('hours read as a person says them', () => {
    const ticks = ribbonTicks({ startHour: 11, endHour: 14 });
    const labels = ticks.map((tick) => tick.label);
    expect(labels).toContain('11am');
    expect(labels).toContain('12pm');
    expect(labels).not.toContain('0pm');
  });
});
