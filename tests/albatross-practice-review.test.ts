import { describe, expect, test } from 'bun:test';
import {
  formatMetricValue,
  metricSummary,
  practiceReviewLine,
  weeksWithEntry,
} from '../lib/albatross/practice-review';

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
const NOW = Date.parse('2026-09-03T12:00:00Z');
const weight = { name: 'weight', unit: 'lb', direction: 'down' as const };

describe('metricSummary', () => {
  test('is empty for no entries', () => {
    expect(metricSummary([], NOW)).toEqual({ latest: null, latestAt: null, count: 0, weeksWithEntry: 0 });
  });

  test('reports the latest value, the count, and distinct weeks in the last 12', () => {
    const entries = [
      { at: NOW - 20 * WEEK, value: 190 },
      { at: NOW - 3 * WEEK, value: 186 },
      { at: NOW - 3 * WEEK - DAY, value: 185.5 },
      { at: NOW - 1 * WEEK, value: 184 },
      { at: NOW - DAY, value: 183.6 },
    ];
    expect(metricSummary(entries, NOW)).toEqual({
      latest: 183.6,
      latestAt: NOW - DAY,
      count: 5,
      weeksWithEntry: 3,
    });
  });

  test('accepts entries in any order', () => {
    const summary = metricSummary(
      [
        { at: NOW - DAY, value: 2 },
        { at: NOW - 5 * DAY, value: 1 },
      ],
      NOW,
    );
    expect(summary.latest).toBe(2);
  });
});

describe('weeksWithEntry', () => {
  test('ignores entries older than the window and entries in the future', () => {
    expect(
      weeksWithEntry(
        [
          { at: NOW - 13 * WEEK, value: 1 },
          { at: NOW + DAY, value: 1 },
          { at: NOW - 2 * DAY, value: 1 },
        ],
        NOW,
      ),
    ).toBe(1);
  });
});

describe('formatMetricValue', () => {
  test('keeps at most one decimal and drops the sign', () => {
    expect(formatMetricValue(-2.44, 'lb')).toBe('2.4 lb');
    expect(formatMetricValue(3, 'kg')).toBe('3 kg');
    expect(formatMetricValue(2.96)).toBe('3');
  });
});

describe('practiceReviewLine', () => {
  test('asks for the first log when there is none', () => {
    expect(practiceReviewLine([], weight, NOW)).toBe('Log the first number to start the trend.');
  });

  test('waits for the second log', () => {
    expect(practiceReviewLine([{ at: NOW - DAY, value: 186 }], weight, NOW)).toBe(
      'One log so far. Add the next when you want.',
    );
  });

  test('writes the doc example: change over weeks and the streak', () => {
    const entries = [
      { at: NOW - 5 * WEEK, value: 186 },
      { at: NOW - 4 * WEEK, value: 185.6 },
      { at: NOW - 3 * WEEK, value: 185 },
      { at: NOW - 1 * WEEK, value: 184.2 },
      { at: NOW - 2 * DAY, value: 183.6 },
    ];
    expect(practiceReviewLine(entries, weight, NOW)).toBe(
      'Down 2.4 lb over 5 weeks. 5 of the last 6 weeks have a log.',
    );
  });

  test('names a full streak and an upward change', () => {
    const entries = [
      { at: NOW - 2 * WEEK, value: 10 },
      { at: NOW - 1 * WEEK, value: 12 },
      { at: NOW - DAY, value: 15 },
    ];
    expect(practiceReviewLine(entries, { name: 'distance', unit: 'km', direction: 'up' }, NOW)).toBe(
      'Up 5 km over 2 weeks. Every one of the last 3 weeks has a log.',
    );
  });

  test('counts logs inside one week and reports no change', () => {
    const entries = [
      { at: NOW - 3 * DAY, value: 180 },
      { at: NOW - DAY, value: 180 },
    ];
    expect(practiceReviewLine(entries, weight, NOW)).toBe('No change over 2 days. 2 logs this week.');
  });

  test('adds the gap to the target, and says so when it is reached', () => {
    const entries = [
      { at: NOW - 2 * WEEK, value: 175 },
      { at: NOW - DAY, value: 172.5 },
    ];
    expect(practiceReviewLine(entries, { ...weight, target: 170 }, NOW)).toBe(
      'Down 2.5 lb over 2 weeks. 2 of the last 3 weeks have a log. 2.5 lb to the target.',
    );
    expect(practiceReviewLine(entries, { ...weight, target: 173 }, NOW)).toEndWith('At the target.');
    expect(
      practiceReviewLine(entries, { name: 'steps', unit: 'steps', target: 200, direction: 'up' }, NOW),
    ).toEndWith('27.5 steps to the target.');
  });

  test('a null metric still writes the trend without a unit', () => {
    const entries = [
      { at: NOW - 8 * DAY, value: 1 },
      { at: NOW - DAY, value: 3 },
    ];
    expect(practiceReviewLine(entries, null, NOW)).toBe(
      'Up 2 over one week. Every one of the last 2 weeks has a log.',
    );
  });
});
