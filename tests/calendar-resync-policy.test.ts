import { describe, expect, test } from 'bun:test';
import {
  type CalendarResyncDependencies,
  consumesCalendarResyncRateLimit,
  decideCalendarResync,
  latestCalendarSyncedAt,
  parseCalendarResyncReason,
  startCalendarResync,
  VIEW_OPEN_RESYNC_DEBOUNCE_MS,
} from '../lib/calendar/resync';

const NOW = 1_800_000_000_000;

describe('parseCalendarResyncReason', () => {
  test('accepts the three client reasons only', () => {
    expect(parseCalendarResyncReason('view_open')).toBe('view_open');
    expect(parseCalendarResyncReason('pull')).toBe('pull');
    expect(parseCalendarResyncReason('manual_http')).toBe('manual_http');
    expect(parseCalendarResyncReason('manual_tool')).toBeNull();
    expect(parseCalendarResyncReason('post_mutation')).toBeNull();
    expect(parseCalendarResyncReason(42)).toBeNull();
    expect(parseCalendarResyncReason(undefined)).toBeNull();
  });
});

describe('consumesCalendarResyncRateLimit', () => {
  test('view_open never uses the manual limit', () => {
    expect(consumesCalendarResyncRateLimit('view_open')).toBe(false);
    expect(consumesCalendarResyncRateLimit('pull')).toBe(true);
    expect(consumesCalendarResyncRateLimit('manual_http')).toBe(true);
    expect(consumesCalendarResyncRateLimit('manual_tool')).toBe(true);
  });
});

describe('latestCalendarSyncedAt', () => {
  test('returns the oldest completed sync across accounts', () => {
    expect(
      latestCalendarSyncedAt([
        { accountId: 'a', lastSyncedAt: NOW - 10_000 },
        { accountId: 'b', lastSyncedAt: NOW - 90_000 },
      ]),
    ).toBe(NOW - 90_000);
  });

  test('returns null when one account never finished a sync', () => {
    expect(
      latestCalendarSyncedAt([
        { accountId: 'a', lastSyncedAt: NOW - 10_000 },
        { accountId: 'b', lastSyncedAt: null },
      ]),
    ).toBeNull();
    expect(latestCalendarSyncedAt([{ accountId: 'a' }])).toBeNull();
    expect(latestCalendarSyncedAt([])).toBeNull();
  });

  test('ignores unauthorized accounts because a sync cannot help them', () => {
    expect(
      latestCalendarSyncedAt([
        { accountId: 'a', lastSyncedAt: NOW - 10_000 },
        { accountId: 'b', status: 'unauthorized', lastSyncedAt: null },
      ]),
    ).toBe(NOW - 10_000);
  });
});

describe('decideCalendarResync', () => {
  test('view_open is skipped when the last sync is under two minutes old', () => {
    expect(decideCalendarResync({ reason: 'view_open', lastSyncedAt: NOW - 30_000, nowMs: NOW })).toEqual({
      start: false,
      force: false,
      skippedReason: 'fresh',
    });
    expect(
      decideCalendarResync({
        reason: 'view_open',
        lastSyncedAt: NOW - VIEW_OPEN_RESYNC_DEBOUNCE_MS + 1,
        nowMs: NOW,
      }),
    ).toEqual({ start: false, force: false, skippedReason: 'fresh' });
  });

  test('view_open starts an unforced sync at or past two minutes, or with no sync yet', () => {
    expect(
      decideCalendarResync({
        reason: 'view_open',
        lastSyncedAt: NOW - VIEW_OPEN_RESYNC_DEBOUNCE_MS,
        nowMs: NOW,
      }),
    ).toEqual({ start: true, force: false });
    expect(decideCalendarResync({ reason: 'view_open', lastSyncedAt: null, nowMs: NOW })).toEqual({
      start: true,
      force: false,
    });
  });

  test('pull, manual_http, and manual_tool always start a forced sync', () => {
    for (const reason of ['pull', 'manual_http', 'manual_tool'] as const) {
      expect(decideCalendarResync({ reason, lastSyncedAt: NOW - 1, nowMs: NOW })).toEqual({
        start: true,
        force: true,
      });
    }
  });

  test('honors a custom debounce window', () => {
    expect(
      decideCalendarResync({ reason: 'view_open', lastSyncedAt: NOW - 5_000, nowMs: NOW, debounceMs: 4_000 }),
    ).toEqual({ start: true, force: false });
  });
});

function dependencies(overrides: Partial<CalendarResyncDependencies> = {}) {
  const calls: Array<{ kind: 'account' | 'all'; args: unknown[] }> = [];
  const deps: CalendarResyncDependencies = {
    readSyncStates: async () => [
      { accountId: 'acct_1', status: 'ready', lastSyncedAt: NOW - 10 * 60_000 },
      { accountId: 'acct_2', status: 'ready', lastSyncedAt: NOW - 30_000 },
    ],
    syncAccount: async (input) => {
      calls.push({ kind: 'account', args: [input] });
      return { ok: true, accountId: input.accountId, calendars: 1, events: 3 };
    },
    syncAll: async (userId, options) => {
      calls.push({ kind: 'all', args: [userId, options] });
      return [{ ok: true, accountId: 'acct_1', calendars: 1, events: 3 }];
    },
    now: () => NOW,
    reportError: () => undefined,
    ...overrides,
  };
  return { deps, calls };
}

async function drain() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('startCalendarResync', () => {
  test('view_open on a fresh account returns started:false with the last sync time', async () => {
    const { deps, calls } = dependencies();
    const outcome = await startCalendarResync(
      { userId: 'u', accountId: 'acct_2', reason: 'view_open' },
      deps,
    );
    expect(outcome).toEqual({ started: false, lastSyncedAt: NOW - 30_000, skippedReason: 'fresh' });
    await drain();
    expect(calls).toHaveLength(0);
  });

  test('view_open on a stale account starts an unforced sync in the background', async () => {
    const { deps, calls } = dependencies();
    const outcome = await startCalendarResync(
      { userId: 'u', accountId: 'acct_1', reason: 'view_open' },
      deps,
    );
    expect(outcome).toEqual({ started: true, lastSyncedAt: NOW - 10 * 60_000 });
    await drain();
    expect(calls).toEqual([
      { kind: 'account', args: [{ userId: 'u', accountId: 'acct_1', force: false, reason: 'view_open' }] },
    ]);
  });

  test('without an accountId the oldest account decides and all accounts sync', async () => {
    const { deps, calls } = dependencies();
    const outcome = await startCalendarResync({ userId: 'u', reason: 'view_open' }, deps);
    expect(outcome).toEqual({ started: true, lastSyncedAt: NOW - 10 * 60_000 });
    await drain();
    expect(calls).toEqual([{ kind: 'all', args: ['u', { force: false, reason: 'view_open' }] }]);
  });

  test('pull forces a sync even when the account is fresh', async () => {
    const { deps, calls } = dependencies();
    const outcome = await startCalendarResync({ userId: 'u', accountId: 'acct_2', reason: 'pull' }, deps);
    expect(outcome).toEqual({ started: true, lastSyncedAt: NOW - 30_000 });
    await drain();
    expect(calls).toEqual([
      { kind: 'account', args: [{ userId: 'u', accountId: 'acct_2', force: true, reason: 'pull' }] },
    ]);
  });

  test('wait:true returns the sync results to the caller', async () => {
    const { deps } = dependencies();
    const outcome = await startCalendarResync(
      { userId: 'u', accountId: 'acct_1', reason: 'manual_tool', wait: true },
      deps,
    );
    expect(outcome.started).toBe(true);
    expect(outcome.results).toEqual([{ ok: true, accountId: 'acct_1', calendars: 1, events: 3 }]);
  });

  test('a background sync failure is reported and does not reject the caller', async () => {
    const errors: string[] = [];
    const { deps } = dependencies({
      syncAccount: async () => {
        throw new Error('provider down');
      },
      reportError: (message, error) => errors.push(`${message} ${(error as Error).message}`),
    });
    const outcome = await startCalendarResync(
      { userId: 'u', accountId: 'acct_1', reason: 'manual_http' },
      deps,
    );
    expect(outcome.started).toBe(true);
    await drain();
    expect(errors).toEqual(['[calendar] resync (manual_http) failed for acct_1: provider down']);
  });

  test('an unknown accountId has no state, so view_open syncs it', async () => {
    const { deps, calls } = dependencies();
    const outcome = await startCalendarResync(
      { userId: 'u', accountId: 'acct_9', reason: 'view_open' },
      deps,
    );
    expect(outcome).toEqual({ started: true, lastSyncedAt: null });
    await drain();
    expect(calls).toHaveLength(1);
  });
});
