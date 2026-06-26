import { describe, expect, test } from 'bun:test';
import { endOfDayMs, epochSecondsForDayEnd, epochSecondsForDayStart, startOfDayMs } from '../lib/mail/search/dates';

describe('mail search date helpers', () => {
  test('startOfDayMs and endOfDayMs bound UTC days', () => {
    const start = startOfDayMs('2026-06-10');
    const end = endOfDayMs('2026-06-10');
    expect(end).toBeGreaterThan(start);
    expect(new Date(start).toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });
  test('invalid dates degrade to infinities for local matching', () => {
    expect(startOfDayMs('not-a-date')).toBe(Number.NEGATIVE_INFINITY);
    expect(endOfDayMs('not-a-date')).toBe(Number.POSITIVE_INFINITY);
  });
  test('epochSecondsForDayStart/End return null for invalid dates', () => {
    expect(epochSecondsForDayStart('2026-06-10')).toBe(Math.floor(startOfDayMs('2026-06-10') / 1000));
    expect(epochSecondsForDayEnd('2026-06-10')).toBe(Math.floor(endOfDayMs('2026-06-10') / 1000));
    expect(epochSecondsForDayStart('bad')).toBeNull();
    expect(epochSecondsForDayEnd('bad')).toBeNull();
  });
});
