import { describe, expect, test } from 'bun:test';
import { isUsableTimezone, pickCalendarTimezone, resolveBriefTimezone } from '../lib/mail/brief-timezone';

// The context (browser/cron) timezone tracks where the user actually is right
// now — including travel — so a usable context value wins. Synced calendars
// only fill in a missing or UTC-filler context; UTC-labeled provider calendars
// never count, and nothing invents a default city or zone.

describe('isUsableTimezone', () => {
  test('accepts real IANA zones', () => {
    expect(isUsableTimezone('America/New_York')).toBe(true);
    expect(isUsableTimezone('Europe/Paris')).toBe(true);
  });

  test('rejects UTC/GMT/Etc filler and garbage', () => {
    expect(isUsableTimezone('UTC')).toBe(false);
    expect(isUsableTimezone('GMT')).toBe(false);
    expect(isUsableTimezone('Etc/GMT+5')).toBe(false);
    expect(isUsableTimezone('Not/A_Zone')).toBe(false);
    expect(isUsableTimezone('')).toBe(false);
    expect(isUsableTimezone(undefined)).toBe(false);
  });
});

describe('pickCalendarTimezone', () => {
  test('majority of usable zones wins; UTC-labeled primaries never do', () => {
    // Shaped like the real account that triggered the bug: a UTC-labeled
    // primary and null provider calendars alongside real Eastern calendars.
    const tz = pickCalendarTimezone([
      { timezone: null, isPrimary: true },
      { timezone: 'America/New_York', isPrimary: false },
      { timezone: 'America/New_York', isPrimary: true },
      { timezone: 'UTC', isPrimary: false },
      { timezone: 'America/New_York', isPrimary: false },
      { timezone: 'UTC', isPrimary: true },
      { timezone: null },
    ]);
    expect(tz).toBe('America/New_York');
  });

  test('primary calendars outvote a larger pile of secondaries', () => {
    const tz = pickCalendarTimezone([
      { timezone: 'America/Denver', isPrimary: true },
      { timezone: 'Europe/Paris', isPrimary: false },
    ]);
    expect(tz).toBe('America/Denver');
  });

  test('returns null when nothing usable exists', () => {
    expect(pickCalendarTimezone([])).toBeNull();
    expect(pickCalendarTimezone([{ timezone: 'UTC', isPrimary: true }, { timezone: null }])).toBeNull();
  });
});

describe('resolveBriefTimezone', () => {
  test('a usable context timezone wins even when calendars disagree (travel)', async () => {
    // Traveling: browser says Chicago, home calendars say Eastern — the brief
    // follows the user, not the calendar.
    const tz = await resolveBriefTimezone('user_1', 'America/Chicago', {
      listCalendars: async () => {
        throw new Error('must not be consulted when the context is usable');
      },
    });
    expect(tz).toBe('America/Chicago');
  });

  test('an unusable context (UTC filler) falls back to calendar consensus', async () => {
    const tz = await resolveBriefTimezone('user_1', 'UTC', {
      listCalendars: async () => [{ timezone: 'America/New_York', isPrimary: true }],
    });
    expect(tz).toBe('America/New_York');
  });

  test('a missing context falls back to calendar consensus', async () => {
    const tz = await resolveBriefTimezone('user_1', undefined, {
      listCalendars: async () => [{ timezone: 'Europe/Paris', isPrimary: false }],
    });
    expect(tz).toBe('Europe/Paris');
  });

  test('never invents a zone: nothing usable resolves to undefined', async () => {
    const tz = await resolveBriefTimezone('user_1', 'UTC', { listCalendars: async () => [] });
    expect(tz).toBeUndefined();
    expect(await resolveBriefTimezone(null, undefined)).toBeUndefined();
  });

  test('a failing calendar lookup degrades to undefined, not a guess', async () => {
    const tz = await resolveBriefTimezone('user_1', undefined, {
      listCalendars: async () => {
        throw new Error('convex down');
      },
    });
    expect(tz).toBeUndefined();
  });

  test('without a userId only the context timezone is considered', async () => {
    expect(await resolveBriefTimezone(undefined, 'Europe/Paris')).toBe('Europe/Paris');
  });
});
