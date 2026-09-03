import { describe, expect, test } from 'bun:test';
import {
  horizonLine,
  isDormant,
  laterShelf,
  parseHorizonHint,
  shortDate,
  wakeIsDue,
  wakeLine,
  wokenHorizon,
  workHorizonSchema,
} from '../lib/albatross/horizon';

// Wednesday 2026-09-02, 09:00 local time.
const NOW = new Date(2026, 8, 2, 9, 0, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;
const localDay = (year: number, month: number, day: number) =>
  new Date(year, month, day, 0, 0, 0, 0).getTime();

describe('isDormant', () => {
  test('no horizon is not dormant', () => {
    expect(isDormant({ horizon: null }, NOW)).toBe(false);
    expect(isDormant({}, NOW)).toBe(false);
    expect(isDormant(null, NOW)).toBe(false);
  });

  test('a future notBefore sleeps and a passed one does not', () => {
    expect(isDormant({ horizon: { kind: 'later', notBefore: NOW + DAY } }, NOW)).toBe(true);
    expect(isDormant({ horizon: { kind: 'later', notBefore: NOW - 1 } }, NOW)).toBe(false);
    expect(isDormant({ horizon: { kind: 'now', notBefore: NOW - DAY, wokeAt: NOW - DAY } }, NOW)).toBe(false);
  });

  test('someday and undated later both sleep', () => {
    expect(isDormant({ horizon: { kind: 'someday' } }, NOW)).toBe(true);
    expect(isDormant({ horizon: { kind: 'later', label: 'after the wedding' } }, NOW)).toBe(true);
  });

  test('now with a soft target is awake', () => {
    expect(isDormant({ horizon: { kind: 'now', by: NOW + 3 * DAY } }, NOW)).toBe(false);
  });
});

describe('wake helpers', () => {
  test('wake is due once notBefore passed and no wake fired', () => {
    expect(wakeIsDue({ horizon: { kind: 'later', notBefore: NOW - 1 } }, NOW)).toBe(true);
    expect(wakeIsDue({ horizon: { kind: 'later', notBefore: NOW + 1 } }, NOW)).toBe(false);
    expect(wakeIsDue({ horizon: { kind: 'later', notBefore: NOW - 1, wokeAt: NOW - 1 } }, NOW)).toBe(false);
    expect(wakeIsDue({ horizon: { kind: 'someday' } }, NOW)).toBe(false);
    expect(wakeIsDue(null, NOW)).toBe(false);
  });

  test('a woken horizon moves to now and records the wake once', () => {
    const woken = wokenHorizon({ kind: 'later', notBefore: NOW - 1, label: 'not before November' }, NOW);
    expect(woken).toEqual({ kind: 'now', notBefore: NOW - 1, label: 'not before November', wokeAt: NOW });
    expect(wokenHorizon(woken, NOW + 5).wokeAt).toBe(NOW);
  });

  test('the wake line is exact', () => {
    expect(wakeLine('Passport renewal')).toBe('Passport renewal is back. Ready when you are.');
    expect(wakeLine('   ')).toBe('Something you kept is back. Ready when you are.');
  });
});

describe('horizonLine', () => {
  test('says nothing for plain Work', () => {
    expect(horizonLine(null, NOW)).toBeNull();
    expect(horizonLine({ kind: 'now' }, NOW)).toBeNull();
  });

  test('names the wake date', () => {
    expect(horizonLine({ kind: 'later', notBefore: localDay(2026, 10, 1) }, NOW)).toBe('Back on Nov 1');
    expect(horizonLine({ kind: 'later', notBefore: localDay(2027, 0, 4) }, NOW)).toBe('Back on Jan 4, 2027');
    expect(horizonLine({ kind: 'later', notBefore: localDay(2026, 8, 4) }, NOW)).toBe('Back on Friday');
    expect(horizonLine({ kind: 'later', notBefore: localDay(2026, 8, 3) }, NOW)).toBe('Back on tomorrow');
  });

  test('someday, later, and soft targets', () => {
    expect(horizonLine({ kind: 'someday' }, NOW)).toBe('Someday');
    expect(horizonLine({ kind: 'later' }, NOW)).toBe('Later');
    expect(horizonLine({ kind: 'later', label: 'after the wedding' }, NOW)).toBe('After the wedding');
    expect(horizonLine({ kind: 'later', notBefore: NOW - DAY }, NOW)).toBe('Back now');
    expect(horizonLine({ kind: 'now', by: localDay(2026, 8, 4) }, NOW)).toBe('By Friday');
  });

  test('shortDate covers today and tomorrow', () => {
    expect(shortDate(NOW + 60_000, NOW)).toBe('today');
    expect(shortDate(NOW + DAY, NOW)).toBe('tomorrow');
  });
});

describe('laterShelf', () => {
  test('orders dormant Work by wake date and puts undated Work at the end', () => {
    const rows = [
      { _id: 'awake', updatedAt: 9, horizon: { kind: 'now' as const } },
      { _id: 'someday', updatedAt: 5, horizon: { kind: 'someday' as const } },
      { _id: 'dec', updatedAt: 1, horizon: { kind: 'later' as const, notBefore: localDay(2026, 11, 1) } },
      { _id: 'nov', updatedAt: 2, horizon: { kind: 'later' as const, notBefore: localDay(2026, 10, 1) } },
      { _id: 'wedding', updatedAt: 7, horizon: { kind: 'later' as const, label: 'after the wedding' } },
      { _id: 'plain', updatedAt: 8 },
    ];
    expect(laterShelf(rows, NOW).map((row) => row._id)).toEqual(['nov', 'dec', 'wedding', 'someday']);
  });
});

describe('parseHorizonHint', () => {
  test('empty and plain text carry no horizon', () => {
    expect(parseHorizonHint('', NOW)).toBeNull();
    expect(parseHorizonHint('Renew the passport.', NOW)).toBeNull();
    expect(parseHorizonHint('Call the dentist after work today and book a slot', NOW)).toBeNull();
    expect(parseHorizonHint('Get the form from the post office', NOW)).toBeNull();
  });

  test('"in two weeks" sleeps until that day', () => {
    expect(parseHorizonHint('Follow up with the landlord in two weeks', NOW)).toEqual({
      kind: 'later',
      notBefore: localDay(2026, 8, 16),
      label: 'in two weeks',
    });
    expect(parseHorizonHint('Check in 3 days', NOW)?.notBefore).toBe(localDay(2026, 8, 5));
    expect(parseHorizonHint('Try again in a month', NOW)?.notBefore).toBe(localDay(2026, 9, 2));
    expect(parseHorizonHint('Revisit in a couple of weeks', NOW)?.notBefore).toBe(localDay(2026, 8, 16));
  });

  test('"next month" sleeps until the first of next month', () => {
    expect(parseHorizonHint('Look at the budget next month', NOW)).toEqual({
      kind: 'later',
      notBefore: localDay(2026, 9, 1),
      label: 'next month',
    });
    expect(parseHorizonHint('Plan the trip next year', NOW)?.notBefore).toBe(localDay(2027, 0, 1));
    expect(parseHorizonHint('Reply next week', NOW)?.notBefore).toBe(localDay(2026, 8, 7));
  });

  test('"someday" is someday', () => {
    expect(parseHorizonHint('Learn to sail someday', NOW)).toEqual({ kind: 'someday', label: 'someday' });
    expect(parseHorizonHint('Eventually read Proust', NOW)?.kind).toBe('someday');
    expect(parseHorizonHint('No rush, fix the shed door', NOW)?.kind).toBe('someday');
  });

  test('"by Friday" is a soft target on the now horizon', () => {
    expect(parseHorizonHint('Send the invoice by Friday', NOW)).toEqual({
      kind: 'now',
      by: localDay(2026, 8, 4),
      label: 'by friday',
    });
    expect(parseHorizonHint('File the claim by Nov 15', NOW)?.by).toBe(localDay(2026, 10, 15));
    expect(parseHorizonHint('Finish it by tomorrow', NOW)?.by).toBe(localDay(2026, 8, 3));
  });

  test('"not before November" sleeps until November 1', () => {
    expect(parseHorizonHint('I need to renew the passport, but not before November', NOW)).toEqual({
      kind: 'later',
      notBefore: localDay(2026, 10, 1),
      label: 'not before november',
    });
    expect(parseHorizonHint('Not until March', NOW)?.notBefore).toBe(localDay(2027, 2, 1));
    expect(parseHorizonHint('Get the form from the office, not before November', NOW)?.notBefore).toBe(
      localDay(2026, 10, 1),
    );
    expect(parseHorizonHint('Start the garden in March', NOW)?.notBefore).toBe(localDay(2027, 2, 1));
    expect(parseHorizonHint('Ask again starting Monday', NOW)?.notBefore).toBe(localDay(2026, 8, 7));
  });

  test('"after Thanksgiving" keeps the words and no date', () => {
    expect(parseHorizonHint('Book the cabin after Thanksgiving', NOW)).toEqual({
      kind: 'later',
      label: 'after thanksgiving',
    });
    expect(parseHorizonHint('Sort the photos after the wedding.', NOW)).toEqual({
      kind: 'later',
      label: 'after the wedding',
    });
    expect(parseHorizonHint('Not before the move', NOW)).toEqual({
      kind: 'later',
      label: 'not before the move',
    });
  });

  test('a sleep and a soft target combine', () => {
    const parsed = parseHorizonHint('Renew the passport not before November, by December 10', NOW);
    expect(parsed?.kind).toBe('later');
    expect(parsed?.notBefore).toBe(localDay(2026, 10, 1));
    expect(parsed?.by).toBe(localDay(2026, 11, 10));
  });

  test('a target before the wake date is dropped', () => {
    const parsed = parseHorizonHint('Renew the passport not before November, by Friday', NOW);
    expect(parsed?.notBefore).toBe(localDay(2026, 10, 1));
    expect(parsed?.by).toBeUndefined();
  });

  test('cadence is not a horizon', () => {
    expect(parseHorizonHint('Water the plants once a week', NOW)).toBeNull();
  });
});

describe('workHorizonSchema', () => {
  test('accepts the contract and rejects extra fields', () => {
    expect(
      workHorizonSchema.safeParse({ kind: 'later', notBefore: NOW, label: 'after the move' }).success,
    ).toBe(true);
    expect(workHorizonSchema.safeParse({ kind: 'never' }).success).toBe(false);
    expect(workHorizonSchema.safeParse({ kind: 'now', extra: true }).success).toBe(false);
  });
});
