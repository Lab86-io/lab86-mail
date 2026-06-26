import { describe, expect, test } from 'bun:test';
import { parseIsoInTimezone, wallClockInTimezone } from '../lib/shared/timezones';

describe('parseIsoInTimezone', () => {
  test('parses absolute ISO timestamps directly', () => {
    const iso = '2026-06-10T14:30:00.000Z';
    expect(parseIsoInTimezone(iso, 'America/New_York', 'start')).toBe(Date.parse(iso));
  });
  test('interprets naive timestamps in the supplied timezone', () => {
    const utc = parseIsoInTimezone('2026-01-15T09:00:00', 'America/New_York', 'start');
    const expected = Date.parse('2026-01-15T14:00:00.000Z');
    expect(Math.abs(utc - expected)).toBeLessThan(60_000);
  });
  test('rejects invalid timestamps', () => {
    expect(() => parseIsoInTimezone('not-a-date', 'UTC', 'start')).toThrow(/Invalid ISO timestamp/);
  });
});

describe('wallClockInTimezone', () => {
  test('returns hour/minute/weekday in the target timezone', () => {
    const wall = wallClockInTimezone(Date.parse('2026-06-10T14:30:00.000Z'), 'UTC');
    expect(wall.hour).toBe(14);
    expect(wall.minute).toBe(30);
    expect(wall.weekday).toBeGreaterThanOrEqual(0);
    expect(wall.weekday).toBeLessThanOrEqual(6);
  });
});
