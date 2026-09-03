import { describe, expect, test } from 'bun:test';
import {
  briefWeekDays,
  buildBriefProsePrompt,
  clampSentences,
  clampWords,
  eventsByDay,
  ledeFallback,
  localDayKey,
  parseBriefProse,
  sanitizeLine,
  sanitizeProse,
  splitSentences,
  weekAheadFallback,
  writeBriefProse,
} from '../lib/mail/brief-prose';
import type { DailyReportCalendarItem } from '../lib/shared/types';

const NOW = Date.parse('2026-09-03T12:00:00Z'); // Thursday
const TZ = 'America/New_York';

function event(
  id: string,
  title: string,
  iso: string,
  extra: Partial<DailyReportCalendarItem> = {},
): DailyReportCalendarItem {
  return {
    account: 'a',
    eventId: id,
    title,
    startAt: Date.parse(iso),
    endAt: Date.parse(iso) + 3_600_000,
    scope: 'week',
    ...extra,
  };
}

describe('day table', () => {
  test('computes weekday names and local day keys in the user timezone', () => {
    const days = briefWeekDays(NOW, TZ);
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({
      weekday: 'Thursday',
      dayKey: '2026-09-03',
      isToday: true,
      label: 'Thu, Sep 3',
    });
    expect(days[1]).toMatchObject({ weekday: 'Friday', isTomorrow: true });
    expect(days[6].weekday).toBe('Wednesday');
    // 03:00Z is still Wednesday evening in New York.
    expect(localDayKey(Date.parse('2026-09-03T03:00:00Z'), TZ)).toBe('2026-09-02');
    expect(localDayKey(Date.parse('2026-09-03T03:00:00Z'), 'Not/AZone')).toBe('2026-09-03');
  });

  test('groups events by local day and sorts them', () => {
    const days = briefWeekDays(NOW, TZ);
    const byDay = eventsByDay(
      [
        event('b', 'Later', '2026-09-03T18:00:00Z'),
        event('a', 'Earlier', '2026-09-03T14:00:00Z'),
        event('x', 'Past', '2026-08-01T14:00:00Z'),
      ],
      days,
      TZ,
    );
    expect(byDay.get('2026-09-03')?.map((item) => item.title)).toEqual(['Earlier', 'Later']);
    expect([...byDay.values()].flat()).toHaveLength(2);
  });
});

describe('fallback prose', () => {
  test('week ahead names days with events and deadlines, then the open days', () => {
    const text = weekAheadFallback({
      calendar: [
        event('d', 'Dentist', '2026-09-03T14:00:00Z'),
        event('r', 'Launch review', '2026-09-07T15:00:00Z'),
        event('h', 'Holiday', '2026-09-08T04:00:00Z', { allDay: true }),
      ],
      tasks: [
        { title: 'Send the passport form', dueAt: Date.parse('2026-09-04T20:00:00Z') },
        { title: 'No date', dueAt: null },
      ],
      now: NOW,
      timezone: TZ,
    });
    expect(text).toBe(
      'Today: Dentist at 10:00 AM. Tomorrow: Send the passport form is due. Monday: Launch review at 11:00 AM. Tuesday: Holiday.',
    );
  });

  test('week ahead with nothing on it says so', () => {
    expect(weekAheadFallback({ calendar: [], tasks: [], now: NOW, timezone: TZ })).toBe(
      'Friday, Saturday, Sunday, and Monday are open.',
    );
  });

  test('lede fallback counts replies, today, and the rest without a name', () => {
    expect(
      ledeFallback({
        firstName: null,
        kind: 'evening',
        items: [
          { lane: 'answer', sender: 'Maya', subject: 'Venue' },
          { lane: 'answer', sender: 'Ben', subject: 'Contract' },
          { lane: 'today', sender: 'Ana', subject: 'Form' },
          { lane: 'know', sender: '', subject: 'Notes' },
        ],
        todayEventCount: 2,
      }),
    ).toBe(
      'Here is where the day ends. Maya and Ben are waiting on replies. Today holds 2 events and 1 deadline. 1 more thread is worth a look.',
    );
    expect(ledeFallback({ firstName: 'Jakob', kind: 'manual', items: [], todayEventCount: 0 })).toBe(
      'Jakob, here is where things stand. Nobody is waiting on a reply.',
    );
    expect(
      ledeFallback({
        firstName: 'Jakob',
        kind: 'morning',
        items: [{ lane: 'answer', sender: 'Maya', subject: 'Venue' }],
        todayEventCount: 0,
      }),
    ).toBe('Jakob, here is your morning. Maya is waiting on a reply about Venue.');
  });
});

describe('clamps', () => {
  test('splits and clamps sentences', () => {
    expect(splitSentences('One. Two! Three? Four. e.g. lower')).toEqual([
      'One.',
      'Two!',
      'Three?',
      'Four. e.g. lower',
    ]);
    expect(clampSentences('One. Two. Three.', 2)).toBe('One. Two.');
  });

  test('clamps words and closes the cut', () => {
    expect(clampWords('a b c d', 10)).toBe('a b c d');
    expect(clampWords('one two three, four five', 3)).toBe('one two three.');
  });

  test('sanitizeProse drops AI sentences, emoji, and exclamation marks', () => {
    expect(sanitizeProse('Great news! 🎉 AI wrote this. Maya replied.', 4)).toBe('Great news. Maya replied.');
    expect(sanitizeProse('Only AI here.', 4)).toBe('');
    expect(sanitizeLine('Reply to Maya about the AI budget')).toBe('');
    expect(sanitizeLine('Reply to Maya today!')).toBe('Reply to Maya today.');
    expect(
      sanitizeLine('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20 w21 w22'),
    ).toBe('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20.');
  });
});

describe('parseBriefProse', () => {
  test('keeps only supplied keys and clamps every field', () => {
    const parsed = parseBriefProse(
      `Here you go:\n${JSON.stringify({
        lede: 'One. Two. Three. Four. Five.',
        items: [
          { key: 'k1', line: 'Fine line.' },
          { key: 'k2', line: '' },
          { key: 'zz', line: 'Not allowed.' },
          { line: 'No key.' },
        ],
        weekAhead: 'Thursday is open. AI says hi. Friday too.',
      })}`,
      ['k1', 'k2'],
    );
    expect(parsed).toEqual({
      lede: 'One. Two. Three. Four.',
      lines: { k1: 'Fine line.' },
      weekAhead: 'Thursday is open. Friday too.',
    });
  });

  test('returns null for missing or broken JSON', () => {
    expect(parseBriefProse('nope', [])).toBeNull();
    expect(parseBriefProse('{ broken', [])).toBeNull();
    expect(parseBriefProse('[1]', [])).toBeNull();
    expect(parseBriefProse('"text"', [])).toBeNull();
  });
});

describe('writeBriefProse', () => {
  const input = {
    firstName: 'Jakob',
    kind: 'morning' as const,
    now: NOW,
    timezone: TZ,
    items: [
      {
        key: 'a:t1',
        lane: 'answer' as const,
        sender: 'Maya',
        subject: 'Venue',
        receivedAt: NOW - 3_600_000,
        dueAt: NOW + 7_200_000,
        whyItMatters: 'Maya is waiting.',
        messages: [{ from: 'Maya', date: NOW - 3_600_000, body: 'Which venue do you prefer?' }],
      },
    ],
    calendar: [event('d', 'Dentist', '2026-09-03T14:00:00Z', { location: 'Main St' })],
    tasks: [{ title: 'Passport form', dueAt: Date.parse('2026-09-04T20:00:00Z') }],
    areas: [{ name: 'Launch', line: 'Pick a venue.' }],
    tomorrowIntent: 'Deep work in the morning.',
    weather: 'Rain today.',
  };

  test('prompt carries the reader, week table, items with bodies, areas, and intent', () => {
    const prompt = buildBriefProsePrompt(input);
    expect(prompt).toContain('"reader": "Jakob"');
    expect(prompt).toContain('Thursday, Thu, Sep 3, 8:00 AM (America/New_York)');
    expect(prompt).toContain('"time": "10:00 AM"');
    expect(prompt).toContain('"location": "Main St"');
    expect(prompt).toContain('Which venue do you prefer?');
    expect(prompt).toContain('"due": "Thursday, Sep 3"');
    expect(prompt).toContain('Passport form');
    expect(prompt).toContain('Pick a venue.');
    expect(prompt).toContain('Deep work in the morning.');
    expect(prompt).toContain('Rain today.');
  });

  test('uses the model reply, with fallbacks for empty fields', async () => {
    const result = await writeBriefProse(input, {
      generate: (async () => ({
        text: JSON.stringify({
          lede: '',
          items: [{ key: 'a:t1', line: 'Say which venue.' }],
          weekAhead: 'Friday is open.',
        }),
      })) as any,
    });
    expect(result.lede).toBe(
      'Jakob, here is your morning. Maya is waiting on a reply about Venue. Today holds 1 event.',
    );
    expect(result.lines).toEqual({ 'a:t1': 'Say which venue.' });
    expect(result.weekAhead).toBe('Friday is open.');
    expect(result.model).not.toBe('local');
  });

  test('falls back when the model throws or when no generator exists', async () => {
    const thrown = await writeBriefProse(input, {
      generate: (async () => {
        throw new Error('down');
      }) as any,
    });
    expect(thrown.model).toBe('local');
    expect(thrown.lines).toEqual({});
    const none = await writeBriefProse(input, { generate: null });
    expect(none.model).toBe('local');
    expect(none.weekAhead).toContain('Today: Dentist at 10:00 AM.');
  });
});
