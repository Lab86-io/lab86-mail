import { describe, expect, test } from 'bun:test';
import { parseWorthKnowing } from '../lib/mail/brief-worth-knowing';
import type { ObligationView } from '../lib/obligations/contract';
import { NEEDS_YOU_FIXTURE_NOW as NOW, NEEDS_YOU_FIXTURE_TIMEZONE as TZ } from '../lib/obligations/fixtures';
import { groupNeedsYou } from '../lib/obligations/groups';
import { TODAY_PREVIEW_EVENTS, TODAY_PREVIEW_ITEMS } from '../lib/obligations/today-fixtures';
import {
  allDayEvents,
  clockLabel,
  scheduleLines,
  type TodayNoteLines,
  type TodayScheduleEvent,
  todayNote,
  todayRows,
} from '../lib/obligations/today-page';

const HOUR = 3_600_000;
const text = (note: TodayNoteLines) => `${note.lead} ${note.day}`;

const item = (overrides: Partial<ObligationView> & { id: string }): ObligationView => ({
  kind: 'reply',
  state: 'open',
  source: 'mail',
  sourceKey: `mail:acct:${overrides.id}`,
  title: 'Can you confirm the date?',
  asker: 'Ada Example',
  due: 'none',
  pushLevel: 'none',
  probability: 0.9,
  createdAt: NOW - HOUR,
  updatedAt: NOW - HOUR,
  ...overrides,
});
const rowsOf = (items: ObligationView[], cap?: number) => todayRows(groupNeedsYou(items, [], NOW, TZ), cap);
const event = (id: string, from: number, to: number, extra: Partial<TodayScheduleEvent> = {}) => ({
  id,
  title: id,
  startAt: NOW + from * HOUR,
  endAt: NOW + to * HOUR,
  ...extra,
});

describe('the rows of the Today list', () => {
  test('the notices of one sender share a row; two questions from one person do not', () => {
    const list = rowsOf([
      item({ id: 'a', kind: 'change', asker: 'Lumen Hosting', title: 'Payment failed.' }),
      item({
        id: 'b',
        kind: 'change',
        asker: 'lumen hosting',
        title: 'Payment failed again.',
        createdAt: NOW - 2 * HOUR,
      }),
      item({ id: 'c', asker: 'Marin' }),
      item({ id: 'd', asker: 'Marin', createdAt: NOW - 3 * HOUR }),
    ]);
    expect(list.open).toBe(3);
    expect(list.rows.map((row) => [row.entry.id, row.others.map((other) => other.id)])).toEqual([
      ['c', []],
      ['d', []],
      ['a', ['b']],
    ]);
  });

  test('the cap counts rows, and the rest is a count', () => {
    const items = Array.from({ length: 8 }, (_, index) => item({ id: `r${index}` }));
    const list = rowsOf(items, 6);
    expect(list.rows).toHaveLength(6);
    expect(list.more).toBe(2);
    expect(list.open).toBe(8);
  });

  test('due today leads; after it a question comes before a notice with a due word', () => {
    const list = rowsOf([
      item({ id: 'notice', kind: 'change', due: 'soon' }),
      item({ id: 'question' }),
      item({ id: 'today', kind: 'action', due: 'today', asker: 'Sam' }),
    ]);
    expect(list.rows.map((row) => row.entry.id)).toEqual(['today', 'question', 'notice']);
  });

  test('waiting on others and closed items are not on the list', () => {
    const list = rowsOf([
      item({ id: 'wait', kind: 'waiting' }),
      item({ id: 'closed', state: 'done', closedAt: NOW - 1000, closeReason: 'user_done' }),
    ]);
    expect(list.rows).toEqual([]);
    expect(list.open).toBe(0);
  });
});

describe('the schedule', () => {
  test('each event has its state at this moment, and a long open stretch has a line', () => {
    const lines = scheduleLines(
      [event('past', -3, -2), event('now', -0.5, 0.5), event('next', 3, 4), event('later', 4, 5)],
      NOW,
    );
    expect(
      lines.map((line) => (line.type === 'event' ? `${line.event.id}:${line.state}` : line.type)),
    ).toEqual(['past:past', 'now:now', 'open', 'next:next', 'later:later']);
  });

  test('a cancelled event leaves the day; an all-day event has its own place', () => {
    const lines = scheduleLines(
      [event('gone', 1, 2, { status: 'cancelled' }), event('all', -11, 13, { allDay: true })],
      NOW,
    );
    expect(lines).toEqual([]);
    expect(allDayEvents([event('all', -11, 13, { allDay: true })]).map((row) => row.id)).toEqual(['all']);
  });

  test('a time reads as a person says it', () => {
    expect(clockLabel(Date.UTC(2026, 9, 28, 19, 0), TZ)).toBe('12 PM');
    expect(clockLabel(Date.UTC(2026, 9, 28, 22, 0), TZ)).toBe('3 PM');
    expect(clockLabel(Date.UTC(2026, 9, 28, 16, 30), TZ)).toBe('9:30 AM');
  });
});

describe('the note', () => {
  const note = (items: ObligationView[], events: TodayScheduleEvent[], now = NOW) => {
    const list = rowsOf(items);
    return text(
      todayNote({ rows: list.rows, open: list.open, lines: scheduleLines(events, now), now, timezone: TZ }),
    );
  };

  test('the fixture day says the news, the count, and what is next', () => {
    expect(note(TODAY_PREVIEW_ITEMS, TODAY_PREVIEW_EVENTS)).toBe(
      '8 things need you. First, an urgent notice from Harbor Air. Design review ends at 11:30 AM. Lunch with Mara is next, at 12 PM.',
    );
  });

  test('it never promises a time that has passed', () => {
    expect(note([], TODAY_PREVIEW_EVENTS, NOW + 10 * HOUR)).toBe(
      'Nothing needs you right now. Your calendar is clear for the rest of today.',
    );
  });

  test('an empty day says so', () => {
    expect(note([], [])).toBe('Nothing needs you right now. Nothing is on your calendar today.');
  });

  test('one item, and one sender with many notices, read as one thing to start', () => {
    expect(note([item({ id: 'r', asker: 'Marin' })], [])).toStartWith(
      'One thing needs you: a reply to Marin.',
    );
    expect(
      note(
        [
          item({ id: 'a', kind: 'change', asker: 'Stripe', title: 'Failed.' }),
          item({ id: 'b', kind: 'change', asker: 'Stripe', title: 'Failed.', createdAt: NOW - 2 * HOUR }),
        ],
        [],
      ),
    ).toStartWith('One thing needs you: 2 notices from Stripe. Nothing is');
  });

  test('a next event soon counts the minutes', () => {
    expect(note([], [event('Standup', 0.25, 0.5)])).toEndWith('Standup starts in 15 minutes.');
  });
});

describe('the short facts', () => {
  test('at most two, each cut to its size', () => {
    const long = Array.from({ length: 40 }, () => 'word').join(' ');
    const items = parseWorthKnowing(
      JSON.stringify({
        items: [
          { title: 'One.', line: long },
          { title: 'Two.', line: 'Two.' },
          { title: 'Three.', line: 'Three.' },
        ],
      }),
    );
    expect(items.map((entry) => entry.title)).toEqual(['One.', 'Two.']);
    expect(items[0].line.split(' ')).toHaveLength(24);
  });

  test('a fenced answer reads; anything else gives none', () => {
    expect(parseWorthKnowing('```json\n{"items":[]}\n```')).toEqual([]);
    expect(parseWorthKnowing('{"items":[{"title":"A.","line":"B."}]}')).toEqual([
      { title: 'A.', line: 'B.' },
    ]);
    expect(parseWorthKnowing('Nothing today.')).toEqual([]);
  });
});
