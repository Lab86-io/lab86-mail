import { describe, expect, test } from 'bun:test';
import { parseIcsEvents } from '../lib/calendar/ics';

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
});
