import { describe, expect, test } from 'bun:test';
import {
  CRON_START_SPREAD_MS,
  calendarCronStartDelayMs,
  calendarWindowBounds,
  FULL_WINDOW_INTERVAL_MS,
  resolveCalendarWindow,
  spreadOffsetMs,
} from '../lib/calendar/sync';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 28, 12);

describe('calendar sync window', () => {
  test('full asks for the full window, and no full pass on record means full', () => {
    expect(resolveCalendarWindow('full', { lastFullSyncAt: NOW }, NOW, 'a')).toBe('full');
    expect(resolveCalendarWindow('hot', null, NOW, 'a')).toBe('full');
    expect(resolveCalendarWindow('auto', {}, NOW, 'a')).toBe('full');
    expect(resolveCalendarWindow('hot', { lastFullSyncAt: NOW - 1 }, NOW, 'a')).toBe('hot');
  });

  test('auto is hot until the daily pass is due', () => {
    expect(resolveCalendarWindow('auto', { lastFullSyncAt: NOW - 60_000 }, NOW, 'a')).toBe('hot');
    expect(
      resolveCalendarWindow('auto', { lastFullSyncAt: NOW - FULL_WINDOW_INTERVAL_MS + 1 }, NOW, 'a'),
    ).toBe('hot');
    expect(resolveCalendarWindow('auto', { lastFullSyncAt: NOW - 3 * DAY }, NOW, 'a')).toBe('full');
  });

  test('a state from before lastFullSyncAt counts its last full-window sync', () => {
    expect(
      resolveCalendarWindow('auto', { lastSyncedAt: NOW - 60_000, windowEnd: NOW + DAY }, NOW, 'a'),
    ).toBe('hot');
    // lastSyncedAt without a stored window is not a full pass.
    expect(resolveCalendarWindow('auto', { lastSyncedAt: NOW - 60_000 }, NOW, 'a')).toBe('full');
  });

  test('hot bounds are −1 to +14 days with a reconcile read bound', () => {
    expect(calendarWindowBounds('hot', NOW)).toEqual({
      windowStart: NOW - DAY,
      windowEnd: NOW + 14 * DAY,
      endBefore: NOW + 49 * DAY,
    });
    expect(calendarWindowBounds('full', NOW)).toEqual({
      windowStart: NOW - 92 * DAY,
      windowEnd: NOW + 366 * DAY,
      endBefore: undefined,
    });
  });

  test('offsets are stable, inside the span, and spread out', () => {
    expect(spreadOffsetMs('user_1', 1_000)).toBe(spreadOffsetMs('user_1', 1_000));
    expect(spreadOffsetMs('user_1', 0)).toBe(0);
    const offsets = new Set(
      Array.from({ length: 50 }, (_, index) => calendarCronStartDelayMs(`user_${index}`)),
    );
    expect(offsets.size).toBeGreaterThan(40);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(CRON_START_SPREAD_MS);
    }
  });
});
