import { expect, test } from 'bun:test';
import {
  BRIEF_EVENTS_PER_DAY,
  briefWeekDays,
  capCalendarPerDay,
  weekAheadFallback,
} from '../lib/mail/brief-prose';
import type { DailyReportCalendarItem } from '../lib/shared/types';

const TZ = 'America/Chicago';
// Monday 2026-09-28 08:00 in Chicago.
const MONDAY = Date.parse('2026-09-28T13:00:00Z');

function event(startAt: number, title: string): DailyReportCalendarItem {
  return { account: 'a', eventId: title, title, startAt, endAt: startAt + 1_800_000, scope: 'week' } as any;
}

test('the calendar cap applies to each local day, so a busy Friday stays busy', () => {
  const monday = Array.from({ length: 30 }, (_, i) => event(MONDAY + i * 600_000, `Monday ${i}`));
  const friday = event(MONDAY + 4 * 86_400_000, 'Friday review');
  const capped = capCalendarPerDay([friday, ...monday], TZ);
  expect(capped.filter((e) => e.title.startsWith('Monday'))).toHaveLength(BRIEF_EVENTS_PER_DAY);
  expect(capped.map((e) => e.title)).toContain('Friday review');
  // The old window cap (first 24 by start) would have dropped Friday.
  expect([...monday, friday].slice(0, 24).map((e) => e.title)).not.toContain('Friday review');
  const week = weekAheadFallback({ now: MONDAY, timezone: TZ, calendar: capped, tasks: [] } as any);
  expect(week).toContain('Friday review');
  expect(week).not.toMatch(/Friday (is|are) open/);
  expect(briefWeekDays(MONDAY, TZ)[4].weekday).toBe('Friday');
});
