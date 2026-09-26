import { describe, expect, test } from 'bun:test';
import { ianaZone, parseIcsEvents } from '../lib/calendar/ics';

describe('parseIcsEvents', () => {
  test('parses a basic timed event', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Team sync
DTSTART:20260610T150000Z
DTEND:20260610T160000Z
LOCATION:Room 4B
DESCRIPTION:Weekly check-in
END:VEVENT
END:VCALENDAR`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Team sync',
      allDay: false,
      location: 'Room 4B',
      description: 'Weekly check-in',
    });
    expect(events[0]?.startAt).toBe(Date.parse('2026-06-10T15:00:00.000Z'));
  });
  test('parses all-day events', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Holiday
DTSTART;VALUE=DATE:20260704
END:VEVENT
END:VCALENDAR`);
    expect(events[0]).toMatchObject({
      title: 'Holiday',
      allDay: true,
    });
    expect(events[0]?.endAt).toBe(events[0]!.startAt + 86_400_000);
  });
  test('unfolds wrapped lines and unescapes text', () => {
    const events = parseIcsEvents(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Long, \r\n title\r\nDTSTART:20260610T150000Z\r\nDESCRIPTION:Line one\\nLine two\r\nEND:VEVENT\r\nEND:VCALENDAR',
    );
    expect(events[0]?.title).toBe('Long, title');
    expect(events[0]?.description).toBe('Line one\nLine two');
  });
  test('returns empty array for malformed input', () => {
    expect(parseIcsEvents('not an ics file')).toEqual([]);
  });

  const vevent = (start: string, end: string) =>
    `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Review\r\n${start}\r\n${end}\r\nEND:VEVENT\r\nEND:VCALENDAR`;

  test('reads a quoted Outlook TZID with a colon in it (CAL-6)', () => {
    const [event] = parseIcsEvents(
      vevent(
        'DTSTART;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260924T100000',
        'DTEND;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260924T110000',
      ),
    );
    // 10:00 EDT is 14:00Z, not 10:00Z.
    expect(event?.startAt).toBe(Date.parse('2026-09-24T14:00:00Z'));
    expect(event?.endAt).toBe(Date.parse('2026-09-24T15:00:00Z'));
    expect(event?.timezone).toBe('America/New_York');
  });

  test('maps Windows zone names to IANA zones (CAL-6)', () => {
    const [eastern] = parseIcsEvents(
      vevent(
        'DTSTART;TZID=Eastern Standard Time:20260115T100000',
        'DTEND;TZID=Eastern Standard Time:20260115T110000',
      ),
    );
    expect(eastern?.startAt).toBe(Date.parse('2026-01-15T15:00:00Z'));
    const [berlin] = parseIcsEvents(
      vevent(
        'DTSTART;TZID="W. Europe Standard Time":20260715T100000',
        'DTEND;TZID="W. Europe Standard Time":20260715T110000',
      ),
    );
    expect(berlin?.startAt).toBe(Date.parse('2026-07-15T08:00:00Z'));
    expect(berlin?.timezone).toBe('Europe/Berlin');
    expect(ianaZone('/citadel.org/20250101_1/America/Chicago')).toBe('America/Chicago');
    expect(ianaZone('Not A Zone')).toBeUndefined();
  });

  test('uses the label offset for an unknown Outlook place', () => {
    const [event] = parseIcsEvents(
      vevent(
        'DTSTART;TZID="(UTC+03:30) Somewhere New":20260715T100000',
        'DTEND;TZID="(UTC+03:30) Somewhere New":20260715T110000',
      ),
    );
    expect(event?.startAt).toBe(Date.parse('2026-07-15T06:30:00Z'));
    expect(event?.timezone).toBeUndefined();
  });

  test('places floating and unreadable times in the user zone (CAL-6)', () => {
    const [floating] = parseIcsEvents(vevent('DTSTART:20260715T100000', 'DTEND:20260715T110000'), {
      timezone: 'Europe/Berlin',
    });
    expect(floating?.startAt).toBe(Date.parse('2026-07-15T08:00:00Z'));
    const [unknown] = parseIcsEvents(
      vevent('DTSTART;TZID=Mars Time:20260715T100000', 'DTEND;TZID=Mars Time:20260715T110000'),
      {
        timezone: 'America/New_York',
      },
    );
    expect(unknown?.startAt).toBe(Date.parse('2026-07-15T14:00:00Z'));
    // Without a user zone, a floating time stays in UTC.
    const [utc] = parseIcsEvents(vevent('DTSTART:20260715T100000', 'DTEND:20260715T110000'));
    expect(utc?.startAt).toBe(Date.parse('2026-07-15T10:00:00Z'));
  });
});
