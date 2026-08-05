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
  stackBlocks,
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
      NOON,
    );
    expect(long.height).toBeGreaterThan(short.height);
    expect(short.top).toBeLessThan(long.top);
  });

  test('a fifteen-minute stand-up is still readable', () => {
    const window = ribbonWindow([], NOON);
    const [block] = ribbonBlocks([event({ _id: 'a', startAt: at(9), endAt: at(9, 15) })], window, NOON);
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
      NOON,
    );
    expect(blocks.map((b) => b.id)).toEqual(['real']);
  });
});

describe('a day that runs past midnight', () => {
  const yesterday = (hour: number) => new Date(2026, 7, 2, hour).getTime();
  const tomorrow = (hour: number) => new Date(2026, 7, 4, hour).getTime();

  test('an overnight flight lands at the top of the ribbon, not the foot', () => {
    // Live defect: read as plain hours-of-day, a 22:00→09:00 flight had a start
    // hour of 22 and an end hour of 9, so it drew as a hairline at ten at night.
    const window = ribbonWindow([event({ _id: 'flight', startAt: yesterday(22), endAt: at(9) })], NOON);
    const [block] = ribbonBlocks(
      [event({ _id: 'flight', startAt: yesterday(22), endAt: at(9) })],
      window,
      NOON,
    );
    expect(block.top).toBe(0);
    expect(block.height).toBeGreaterThan(0.1);
  });

  test('an event running into tomorrow ends at the foot rather than wrapping', () => {
    const window = ribbonWindow([event({ _id: 'late', startAt: at(21), endAt: tomorrow(2) })], NOON);
    const [block] = ribbonBlocks([event({ _id: 'late', startAt: at(21), endAt: tomorrow(2) })], window, NOON);
    expect(block.top + block.height).toBeCloseTo(1, 5);
  });

  test('the clocks changing does not slide the day by an hour', () => {
    // Live defect: measured as elapsed milliseconds from midnight, a nine
    // o'clock meeting on a spring-forward day drew at ten, and a late one could
    // be pushed off the foot of the ribbon.
    const springForward = (hour: number) => new Date(2026, 2, 8, hour).getTime();
    const noonThatDay = springForward(12);
    const window = ribbonWindow([], noonThatDay);
    const [block] = ribbonBlocks(
      [event({ _id: 'a', startAt: springForward(9), endAt: springForward(11) })],
      window,
      noonThatDay,
    );
    const nineOClock = (9 - window.startHour) / (window.endHour - window.startHour);
    expect(block.top).toBeCloseTo(nineOClock, 5);
  });

  test('the window still opens early enough for an overnight arrival', () => {
    const window = ribbonWindow([event({ _id: 'flight', startAt: yesterday(22), endAt: at(9) })], NOON);
    expect(window.startHour).toBe(0);
  });
});

describe('the drawing stays legible without lying', () => {
  const window = ribbonWindow([], NOON);
  // 26px and 42px of a 420px ribbon: the room one line and two lines need.
  const MIN = 26 / 420;
  const TWO = 42 / 420;

  test('a block too short for two lines is marked compact', () => {
    // Live defect: "Stand-up" was drawn 15px tall with two lines inside it, so
    // the screenshot showed a title cut through the middle.
    const stacked = stackBlocks(
      ribbonBlocks(
        [
          event({ _id: 'standup', startAt: at(9), endAt: at(9, 15) }),
          event({ _id: 'review', startAt: at(14), endAt: at(17) }),
        ],
        window,
        NOON,
      ),
      MIN,
      TWO,
    );
    expect(stacked[0].compact).toBe(true);
    expect(stacked[1].compact).toBe(false);
  });

  test('an hour on a long day is still one line, because that is all it fits', () => {
    // Live defect: an hour of a fifteen-hour day is 28px. It cleared the
    // one-line minimum, so it kept two lines and cut the second one in half.
    const [block] = stackBlocks(
      ribbonBlocks([event({ _id: 'review', startAt: at(9, 30), endAt: at(10, 30) })], window, NOON),
      MIN,
      TWO,
    );
    expect(block.compact).toBe(true);
  });

  test('two meetings close together never sit on top of each other', () => {
    // Live defect: a 9:00 stand-up and a 9:30 review overlapped, because the
    // first block's minimum height ran past the second block's start.
    const stacked = stackBlocks(
      ribbonBlocks(
        [
          event({ _id: 'standup', startAt: at(9), endAt: at(9, 15) }),
          event({ _id: 'review', startAt: at(9, 30), endAt: at(10, 30) }),
        ],
        window,
        NOON,
      ),
      MIN,
      TWO,
    );
    expect(stacked[1].top).toBeGreaterThanOrEqual(stacked[0].top + stacked[0].height);
  });

  test('a nudged block still states its real time', () => {
    const stacked = stackBlocks(
      ribbonBlocks(
        [
          event({ _id: 'a', startAt: at(9), endAt: at(9, 10) }),
          event({ _id: 'b', startAt: at(9, 15), endAt: at(9, 25) }),
        ],
        window,
        NOON,
      ),
      MIN,
      TWO,
    );
    // The drawing may move. The claim may not.
    expect(stacked[1].label).toContain('9:15');
  });

  test('the last block of a long day is never pushed off the bottom', () => {
    const stacked = stackBlocks(
      ribbonBlocks([event({ _id: 'late', startAt: at(21, 50), endAt: at(22) })], window, NOON),
      MIN,
      TWO,
    );
    expect(stacked[0].top + stacked[0].height).toBeLessThanOrEqual(1.0001);
  });

  test('a roomy day is left exactly where it belongs', () => {
    const blocks = ribbonBlocks([event({ _id: 'a', startAt: at(14), endAt: at(17) })], window, NOON);
    const stacked = stackBlocks(blocks, MIN, TWO);
    expect(stacked[0].top).toBeCloseTo(blocks[0].top, 10);
    expect(stacked[0].height).toBeCloseTo(blocks[0].height, 10);
  });
});

describe('open air is the fact an agenda never states', () => {
  test('a real gap after a meeting is found and measured', () => {
    const window = ribbonWindow([], at(8));
    const blocks = ribbonBlocks([event({ _id: 'a', startAt: at(9), endAt: at(10) })], window, NOON);
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
      NOON,
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
