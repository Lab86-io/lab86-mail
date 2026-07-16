import { describe, expect, test } from 'bun:test';
import {
  describeRoutineCadence,
  nextRoutineRunAt,
  routineIsDue,
  routineIsInQuietHours,
  routineRunKey,
  routineRunsOnDay,
} from '@/lib/albatross/routines';

describe('Albatross routines', () => {
  test('uses a local-date idempotency key', () => {
    expect(routineRunKey('routine_1', 'America/New_York', new Date('2026-07-15T01:00:00Z'))).toBe(
      'routine_1:2026-07-14',
    );
  });

  test('supports daily, weekday, weekly, and custom cadence', () => {
    const monday = new Date('2026-07-13T16:00:00Z');
    const sunday = new Date('2026-07-12T16:00:00Z');
    const base = { timezone: 'UTC', localTime: '12:00' } as const;
    expect(routineRunsOnDay({ ...base, cadence: 'daily' }, sunday)).toBe(true);
    expect(routineRunsOnDay({ ...base, cadence: 'weekdays' }, monday)).toBe(true);
    expect(routineRunsOnDay({ ...base, cadence: 'weekdays' }, sunday)).toBe(false);
    expect(routineRunsOnDay({ ...base, cadence: 'weekly', daysOfWeek: [1] }, monday)).toBe(true);
    expect(routineRunsOnDay({ ...base, cadence: 'custom', daysOfWeek: [0, 6] }, monday)).toBe(false);
  });

  test('finds the next local wall-clock run across timezones', () => {
    const next = nextRoutineRunAt(
      { cadence: 'daily', localTime: '20:30', timezone: 'America/New_York' },
      Date.parse('2026-07-14T20:00:00Z'),
    );
    expect(new Date(next).toISOString()).toBe('2026-07-15T00:30:00.000Z');
  });

  test('includes the exact scheduled minute and rejects invalid custom schedules', () => {
    const exact = Date.parse('2026-07-14T20:30:00.000Z');
    expect(nextRoutineRunAt({ cadence: 'daily', localTime: '20:30', timezone: 'UTC' }, exact)).toBe(exact);
    expect(
      nextRoutineRunAt({ cadence: 'custom', daysOfWeek: [], localTime: '20:30', timezone: 'UTC' }, exact),
    ).toBeNull();
    expect(
      nextRoutineRunAt({ cadence: 'custom', daysOfWeek: [1.5], localTime: '20:30', timezone: 'UTC' }, exact),
    ).toBeNull();
  });

  test('requires both consent and active status', () => {
    const base = {
      cadence: 'daily' as const,
      localTime: '19:00',
      timezone: 'UTC',
      nextRunAt: 100,
    };
    expect(routineIsDue({ ...base, status: 'active', consent: 'enabled' }, 100)).toBe(true);
    expect(routineIsDue({ ...base, status: 'active', consent: 'proposed' }, 100)).toBe(false);
    expect(routineIsDue({ ...base, status: 'paused', consent: 'enabled' }, 100)).toBe(false);
  });

  test('suppresses notifications inside daytime and overnight quiet windows', () => {
    const base = { cadence: 'daily' as const, localTime: '20:30', timezone: 'UTC' };
    expect(
      routineIsInQuietHours(
        { ...base, quietHoursStart: '09:00', quietHoursEnd: '17:00' },
        Date.parse('2026-07-14T12:00:00Z'),
      ),
    ).toBe(true);
    expect(
      routineIsInQuietHours(
        { ...base, quietHoursStart: '22:00', quietHoursEnd: '07:00' },
        Date.parse('2026-07-14T23:00:00Z'),
      ),
    ).toBe(true);
    expect(
      routineIsInQuietHours(
        { ...base, quietHoursStart: '22:00', quietHoursEnd: '07:00' },
        Date.parse('2026-07-14T12:00:00Z'),
      ),
    ).toBe(false);
  });

  test('describes cadence without leaking cron syntax', () => {
    expect(
      describeRoutineCadence({
        cadence: 'custom',
        daysOfWeek: [1, 3, 5],
        localTime: '08:00',
        timezone: 'UTC',
      }),
    ).toBe('Mon, Wed, Fri at 08:00');
  });
});
