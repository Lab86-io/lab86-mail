import { afterEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createGooglePushCronPost } from '../app/api/cron/google-push/route';
import { FULL_WINDOW_INTERVAL_MS } from '../lib/calendar/sync';
import {
  __setCalendarPushPollDepsForTest,
  calendarPushPollSkipped,
  calendarPushPollSkips,
} from '../lib/google/push/calendar-poll';
import { CALENDAR_PUSH_FALLBACK_POLL_MS } from '../lib/google/push/rules';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

afterEach(() => {
  __setCalendarPushPollDepsForTest();
});

describe('calendar poll back-off', () => {
  const fresh = { lastSyncedAt: NOW - 10 * MINUTE, lastFullSyncAt: NOW - 60 * MINUTE, windowEnd: NOW };

  test('a healthy account with a recent sync and no full pass due is skipped', () => {
    expect(calendarPushPollSkipped({ healthy: true, state: fresh, now: NOW, key: 'u:a' })).toBe(true);
  });

  test('an account without healthy push or without a state is polled', () => {
    expect(calendarPushPollSkipped({ healthy: false, state: fresh, now: NOW, key: 'u:a' })).toBe(false);
    expect(calendarPushPollSkipped({ healthy: true, state: null, now: NOW, key: 'u:a' })).toBe(false);
  });

  test('a healthy account is polled when its last sync is an hour old', () => {
    const old = { ...fresh, lastSyncedAt: NOW - CALENDAR_PUSH_FALLBACK_POLL_MS };
    expect(calendarPushPollSkipped({ healthy: true, state: old, now: NOW, key: 'u:a' })).toBe(false);
    expect(
      calendarPushPollSkipped({
        healthy: true,
        state: { lastFullSyncAt: fresh.lastFullSyncAt },
        now: NOW,
        key: 'u:a',
      }),
    ).toBe(false);
  });

  test('a healthy account is polled when its daily full pass is due', () => {
    const due = { ...fresh, lastFullSyncAt: NOW - FULL_WINDOW_INTERVAL_MS - 3 * 60 * MINUTE };
    expect(calendarPushPollSkipped({ healthy: true, state: due, now: NOW, key: 'u:a' })).toBe(false);
    expect(
      calendarPushPollSkipped({ healthy: true, state: { lastSyncedAt: NOW }, now: NOW, key: 'u:a' }),
    ).toBe(false);
  });

  test('with the calendar flag off no Convex read is made', async () => {
    const reads: unknown[] = [];
    __setCalendarPushPollDepsForTest({
      flags: () => ({ gmail: true, calendar: false, drive: true }),
      query: (async (...args: unknown[]) => {
        reads.push(args);
        return [];
      }) as any,
    });
    expect(await calendarPushPollSkips('user_1')).toEqual([]);
    expect(reads).toEqual([]);
  });

  test('with the flag on the cron skips only the healthy, fresh accounts', async () => {
    const reads: Array<[string, unknown]> = [];
    __setCalendarPushPollDepsForTest({
      flags: () => ({ gmail: false, calendar: true, drive: false }),
      now: () => NOW,
      query: (async (fn: unknown, args: unknown) => {
        reads.push([getFunctionName(fn as any), args]);
        return [
          { accountId: 'healthy', healthy: true, state: fresh },
          { accountId: 'broken', healthy: false, state: fresh },
          {
            accountId: 'stale',
            healthy: true,
            state: { ...fresh, lastSyncedAt: NOW - 2 * CALENDAR_PUSH_FALLBACK_POLL_MS },
          },
        ];
      }) as any,
    });
    expect(await calendarPushPollSkips('user_1')).toEqual(['healthy']);
    expect(reads).toEqual([['googlePush:calendarPollPlan', { userId: 'user_1', now: NOW }]]);
  });

  test('a failed read polls every account', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      __setCalendarPushPollDepsForTest({
        flags: () => ({ gmail: false, calendar: true, drive: false }),
        query: (async () => {
          throw new Error('convex down');
        }) as any,
      });
      expect(await calendarPushPollSkips('user_1')).toEqual([]);
      __setCalendarPushPollDepsForTest({
        flags: () => ({ gmail: false, calendar: true, drive: false }),
        query: (async () => null) as any,
      });
      expect(await calendarPushPollSkips('user_1')).toEqual([]);
    } finally {
      console.warn = original;
    }
  });
});

describe('POST /api/cron/google-push', () => {
  const request = (body: unknown) =>
    new NextRequest('http://localhost/api/cron/google-push', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  test('refuses a caller without the internal secret', async () => {
    const POST = createGooglePushCronPost({ isInternalCronRequest: () => false });
    expect((await POST(request({ userId: 'u' }))).status).toBe(401);
  });

  test('needs a user id', async () => {
    const POST = createGooglePushCronPost({ isInternalCronRequest: () => true });
    expect((await POST(request({}))).status).toBe(400);
    expect((await POST(request('not json'))).status).toBe(400);
    expect((await POST(request({ userId: 'x'.repeat(241) }))).status).toBe(400);
  });

  test('with all flags off and no rows it does nothing', async () => {
    const runs: string[] = [];
    const POST = createGooglePushCronPost({
      isInternalCronRequest: () => true,
      googlePushFlags: () => ({ gmail: false, calendar: false, drive: false }),
      reconcileGooglePush: (async (userId: string) => {
        runs.push(userId);
        return {} as any;
      }) as any,
    });
    const response = await POST(request({ userId: 'user_1', hasChannels: false }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, started: false });
    expect(runs).toEqual([]);
  });

  test('with rows to stop, or a flag on, it starts the renewal of the user', async () => {
    const runs: string[] = [];
    const reconcile = (async (userId: string) => {
      runs.push(userId);
      if (userId === 'user_fail') throw new Error('boom');
      return {} as any;
    }) as any;
    const off = createGooglePushCronPost({
      isInternalCronRequest: () => true,
      googlePushFlags: () => ({ gmail: false, calendar: false, drive: false }),
      reconcileGooglePush: reconcile,
    });
    expect((await off(request({ userId: 'user_1', hasChannels: true }))).status).toBe(202);
    const on = createGooglePushCronPost({
      isInternalCronRequest: () => true,
      googlePushFlags: () => ({ gmail: false, calendar: true, drive: false }),
      reconcileGooglePush: reconcile,
    });
    const original = console.error;
    console.error = () => {};
    try {
      expect((await on(request({ userId: ' user_2 ' }))).status).toBe(202);
      expect((await on(request({ userId: 'user_fail' }))).status).toBe(202);
      await Promise.resolve();
    } finally {
      console.error = original;
    }
    expect(runs).toEqual(['user_1', 'user_2', 'user_fail']);
  });
});
