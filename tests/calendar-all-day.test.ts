import { afterEach, describe, expect, test } from 'bun:test';
import {
  ALL_DAY_MS,
  allDayDateKey,
  allDayDisplayRange,
  allDayLocalDate,
  allDayWriteDates,
  dateKeyInZone,
  normalizeAllDayRange,
  storedAllDayMs,
} from '../lib/calendar/all-day';
import { gridCreateArgs, gridEventDates, gridUpdateArgs } from '../lib/calendar/surface-writes';
import { briefWeekDays, eventsByDay } from '../lib/mail/brief-prose';
import { parseIsoInTimezone } from '../lib/shared/timezones';

// CAL-3 / CAL-4: a stored all-day row is the UTC midnight of its date, with an
// exclusive end. Every reader must show it on that date in any zone.

const previousTz = process.env.TZ;
afterEach(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

const SEP_26 = Date.UTC(2026, 8, 26);
const ZONES = ['America/New_York', 'Europe/Berlin'];

describe('stored all-day dates', () => {
  test('date keys come from the UTC parts', () => {
    expect(allDayDateKey(SEP_26)).toBe('2026-09-26');
    expect(storedAllDayMs('2026-09-26')).toBe(SEP_26);
    expect(() => storedAllDayMs('26/09/2026')).toThrow('Invalid date');
  });

  for (const zone of ZONES) {
    test(`a one-day event shows on its own local date only (${zone})`, () => {
      process.env.TZ = zone;
      const local = allDayLocalDate(SEP_26);
      expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours()]).toEqual([
        2026, 8, 26, 0,
      ]);
      const range = allDayDisplayRange(SEP_26, SEP_26 + ALL_DAY_MS);
      expect(range.start.getDate()).toBe(26);
      expect(range.end.getDate()).toBe(26);
      expect(range.end.getHours()).toBe(23);
      // A three-day span ends on the 28th.
      expect(allDayDisplayRange(SEP_26, SEP_26 + 3 * ALL_DAY_MS).end.getDate()).toBe(28);

      const dates = gridEventDates({ startAt: SEP_26, endAt: SEP_26 + ALL_DAY_MS, allDay: true });
      expect(new Date(dates.startDate).getDate()).toBe(26);
      expect(new Date(dates.endDate).getDate()).toBe(26);
    });

    test(`grid writes send date-only strings with an exclusive end (${zone})`, () => {
      process.env.TZ = zone;
      const range = allDayDisplayRange(SEP_26, SEP_26 + ALL_DAY_MS);
      expect(allDayWriteDates(range.start, range.end)).toEqual({
        startIso: '2026-09-26',
        endIso: '2026-09-27',
      });
      // An end at exactly local midnight is exclusive.
      expect(allDayWriteDates(new Date(2026, 8, 26), new Date(2026, 8, 29))).toEqual({
        startIso: '2026-09-26',
        endIso: '2026-09-29',
      });
      // An end before the start makes a one-day event.
      expect(allDayWriteDates(new Date(2026, 8, 26), new Date(2026, 8, 20))).toEqual({
        startIso: '2026-09-26',
        endIso: '2026-09-27',
      });
    });

    test(`the Brief files an all-day event under its own date (${zone})`, () => {
      const now = parseIsoInTimezone('2026-09-26T08:00:00', zone, 'now');
      const days = briefWeekDays(now, zone, 2);
      const byDay = eventsByDay(
        [
          { title: 'Offsite', startAt: SEP_26, endAt: SEP_26 + ALL_DAY_MS, allDay: true } as any,
          {
            title: 'Holiday',
            startAt: SEP_26 + ALL_DAY_MS,
            endAt: SEP_26 + 2 * ALL_DAY_MS,
            allDay: true,
          } as any,
        ],
        days,
        zone,
      );
      expect(byDay.get('2026-09-26')?.map((event) => event.title)).toEqual(['Offsite']);
      expect(byDay.get('2026-09-27')?.map((event) => event.title)).toEqual(['Holiday']);
    });

    test(`server input is read in the user zone (${zone})`, () => {
      const localMidnight = parseIsoInTimezone('2026-09-26', zone, 'start');
      expect(
        normalizeAllDayRange(localMidnight, parseIsoInTimezone('2026-09-27', zone, 'end'), zone),
      ).toEqual({
        startAt: SEP_26,
        endAt: SEP_26 + ALL_DAY_MS,
      });
      // Late evening local time is still the 26th.
      const evening = parseIsoInTimezone('2026-09-26T22:30:00', zone, 'start');
      expect(dateKeyInZone(evening, zone)).toBe('2026-09-26');
      expect(normalizeAllDayRange(evening, evening + 30 * 60_000, zone)).toEqual({
        startAt: SEP_26,
        endAt: SEP_26 + ALL_DAY_MS,
      });
      // Stored dates (undo) pass through unchanged.
      expect(normalizeAllDayRange(SEP_26, SEP_26 + 2 * ALL_DAY_MS, zone)).toEqual({
        startAt: SEP_26,
        endAt: SEP_26 + 2 * ALL_DAY_MS,
      });
    });
  }
});

describe('web grid tool arguments (CAL-7)', () => {
  const target = { account: 'acct_1', calendarId: 'cal_1', eventId: 'evt_1' };
  const base = {
    title: 'Review',
    startDate: '2026-09-26T14:00:00.000Z',
    endDate: '2026-09-26T15:00:00.000Z',
    description: '',
    participants: [{ email: 'ann@example.com' }],
  };

  test('a plain edit sends only title, times, and description', () => {
    expect(gridUpdateArgs(target, base, base)).toEqual({
      ...target,
      title: 'Review',
      startIso: base.startDate,
      endIso: base.endDate,
      description: undefined,
    });
  });

  test('a changed rule and new invitees are sent', () => {
    const args = gridUpdateArgs(
      target,
      {
        ...base,
        recurrence: ['RRULE:FREQ=WEEKLY'],
        participants: [...base.participants, { email: 'Bob@x.com' }],
      },
      base,
    );
    expect(args.recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
    expect(args.attendees).toEqual([
      { email: 'ann@example.com', name: undefined },
      { email: 'Bob@x.com', name: undefined },
    ]);
    expect(args.notifyParticipants).toBe(true);
  });

  test('create sends all-day dates as date-only strings', () => {
    process.env.TZ = 'Europe/Berlin';
    const dates = gridEventDates({ startAt: SEP_26, endAt: SEP_26 + ALL_DAY_MS, allDay: true });
    expect(
      gridCreateArgs({ account: 'acct_1', calendarId: 'cal_1' }, { ...base, ...dates, allDay: true }),
    ).toMatchObject({
      startIso: '2026-09-26',
      endIso: '2026-09-27',
      allDay: true,
      attendees: [{ email: 'ann@example.com' }],
    });
    expect(gridEventDates({ startAt: 0, endAt: 1000 })).toEqual({
      startDate: '1970-01-01T00:00:00.000Z',
      endDate: '1970-01-01T00:00:01.000Z',
    });
  });
});
