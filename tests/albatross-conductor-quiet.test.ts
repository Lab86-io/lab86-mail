import { describe, expect, test } from 'bun:test';
import {
  conductorMayMove,
  conductorVerdict,
  lastUserTouch,
  USER_TOUCH_WINDOW_MS,
  userTouchedRecently,
  wokeRecently,
} from '../lib/albatross/conductor-quiet';

const NOW = Date.parse('2026-09-02T14:00:00Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe('the conductor quiet rule', () => {
  test('a capture is a touch when the field is missing', () => {
    expect(lastUserTouch({ createdAt: 5 })).toBe(5);
    expect(lastUserTouch({ createdAt: 5, lastUserTouchAt: 9 })).toBe(9);
    expect(lastUserTouch({ createdAt: 5, lastUserTouchAt: null })).toBe(5);
  });

  test('a recent touch keeps the window open, an old one does not', () => {
    expect(userTouchedRecently({ createdAt: NOW - HOUR }, NOW)).toBe(true);
    expect(userTouchedRecently({ createdAt: NOW - USER_TOUCH_WINDOW_MS }, NOW)).toBe(true);
    expect(userTouchedRecently({ createdAt: NOW - USER_TOUCH_WINDOW_MS - 1 }, NOW)).toBe(false);
  });

  test('a wake stands in for one touch', () => {
    expect(wokeRecently({ createdAt: 0, horizon: { kind: 'now', wokeAt: NOW - HOUR } }, NOW)).toBe(true);
    expect(wokeRecently({ createdAt: 0, horizon: { kind: 'now', wokeAt: NOW - 2 * DAY } }, NOW)).toBe(false);
    expect(wokeRecently({ createdAt: 0, horizon: { kind: 'now', wokeAt: NOW + HOUR } }, NOW)).toBe(false);
    expect(wokeRecently({ createdAt: 0, horizon: { kind: 'later' } }, NOW)).toBe(false);
    expect(wokeRecently({ createdAt: 0 }, NOW)).toBe(false);
  });

  test('the user always moves Work', () => {
    const old = { createdAt: NOW - 30 * DAY };
    expect(conductorVerdict(old, 'user', NOW)).toBe('move');
    expect(conductorVerdict({ ...old, horizon: { kind: 'someday' } }, 'user', NOW)).toBe('move');
  });

  test('dormant Work never moves for the conductor or for evidence', () => {
    const sleeping = { createdAt: NOW - HOUR, horizon: { kind: 'later' as const, notBefore: NOW + DAY } };
    expect(conductorVerdict(sleeping, 'conductor', NOW)).toBe('dormant');
    expect(conductorVerdict(sleeping, 'evidence', NOW)).toBe('dormant');
    expect(conductorMayMove(sleeping, 'conductor', NOW)).toBe(false);
  });

  test('evidence moves awake Work the user has not touched', () => {
    expect(conductorVerdict({ createdAt: NOW - 30 * DAY }, 'evidence', NOW)).toBe('move');
  });

  test('the conductor stays quiet on untouched Work and moves touched or woken Work', () => {
    expect(conductorVerdict({ createdAt: NOW - 30 * DAY }, 'conductor', NOW)).toBe('quiet');
    expect(
      conductorVerdict({ createdAt: NOW - 30 * DAY, lastUserTouchAt: NOW - HOUR }, 'conductor', NOW),
    ).toBe('move');
    expect(
      conductorVerdict(
        { createdAt: NOW - 30 * DAY, horizon: { kind: 'now', notBefore: NOW - HOUR, wokeAt: NOW - HOUR } },
        'conductor',
        NOW,
      ),
    ).toBe('move');
    expect(conductorMayMove({ createdAt: NOW - HOUR }, 'conductor', NOW)).toBe(true);
  });
});
