import { describe, expect, test } from 'bun:test';
import {
  anyAccountSyncing,
  isPendingEventRow,
  oldestSyncedAt,
  retryLine,
  SYNC_FAILED_LINE,
  syncedAtByAccount,
  syncedLine,
  syncStatusLine,
} from '../lib/calendar/sync-copy';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe('syncedLine', () => {
  test('reads "Not synced yet" without a completed sync', () => {
    expect(syncedLine(null, NOW)).toBe('Not synced yet');
    expect(syncedLine(undefined, NOW)).toBe('Not synced yet');
    expect(syncedLine(0, NOW)).toBe('Not synced yet');
  });

  test('reads "just now" under one minute and counts minutes, hours, days', () => {
    expect(syncedLine(NOW - 20_000, NOW)).toBe('Synced just now');
    expect(syncedLine(NOW - MIN, NOW)).toBe('Synced 1 minute ago');
    expect(syncedLine(NOW - 4 * MIN, NOW)).toBe('Synced 4 minutes ago');
    expect(syncedLine(NOW - 90 * MIN, NOW)).toBe('Synced 1 hour ago');
    expect(syncedLine(NOW - 5 * 60 * MIN, NOW)).toBe('Synced 5 hours ago');
    expect(syncedLine(NOW - 26 * 60 * MIN, NOW)).toBe('Synced 1 day ago');
    expect(syncedLine(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('Synced 3 days ago');
  });

  test('a future timestamp reads as just now', () => {
    expect(syncedLine(NOW + 5_000, NOW)).toBe('Synced just now');
  });
});

describe('retryLine', () => {
  test('counts minutes, then seconds', () => {
    expect(retryLine(NOW + 3 * MIN, NOW)).toBe('Too many syncs. Try again in 3 minutes.');
    expect(retryLine(NOW + MIN, NOW)).toBe('Too many syncs. Try again in 1 minute.');
    expect(retryLine(NOW + 30_000, NOW)).toBe('Too many syncs. Try again in 30 seconds.');
    expect(retryLine(NOW, NOW)).toBe('Too many syncs. Try again in 1 second.');
  });
});

describe('syncStatusLine', () => {
  test('error wins, then the active sync, then the age', () => {
    expect(
      syncStatusLine({ lastSyncedAt: NOW - MIN, nowMs: NOW, syncing: true, error: { kind: 'failed' } }),
    ).toBe(SYNC_FAILED_LINE);
    expect(
      syncStatusLine({
        lastSyncedAt: NOW - MIN,
        nowMs: NOW,
        syncing: true,
        error: { kind: 'limited', retryAt: NOW + 2 * MIN },
      }),
    ).toBe('Too many syncs. Try again in 2 minutes.');
    expect(syncStatusLine({ lastSyncedAt: NOW - MIN, nowMs: NOW, syncing: true, error: null })).toBe(
      'Syncing',
    );
    expect(syncStatusLine({ lastSyncedAt: NOW - 4 * MIN, nowMs: NOW, syncing: false, error: null })).toBe(
      'Synced 4 minutes ago',
    );
  });

  test('an expired rate limit falls through to the age', () => {
    expect(
      syncStatusLine({
        lastSyncedAt: NOW - 4 * MIN,
        nowMs: NOW,
        syncing: false,
        error: { kind: 'limited', retryAt: NOW - 1 },
      }),
    ).toBe('Synced 4 minutes ago');
  });
});

describe('sync state helpers', () => {
  const states = [
    { accountId: 'a', status: 'ready', lastSyncedAt: NOW - 3 * MIN },
    { accountId: 'b', status: 'ready', lastSyncedAt: NOW - 8 * MIN },
    { accountId: 'c', status: 'unauthorized', lastSyncedAt: undefined },
  ];

  test('oldestSyncedAt skips unauthorized accounts and returns the oldest', () => {
    expect(oldestSyncedAt(states)).toBe(NOW - 8 * MIN);
    expect(oldestSyncedAt([])).toBeNull();
    expect(oldestSyncedAt([{ accountId: 'a', status: 'idle' }])).toBeNull();
    expect(oldestSyncedAt([states[0], { accountId: 'd', status: 'syncing' }])).toBeNull();
  });

  test('syncedAtByAccount maps only completed syncs', () => {
    const map = syncedAtByAccount(states);
    expect(map.get('a')).toBe(NOW - 3 * MIN);
    expect(map.get('b')).toBe(NOW - 8 * MIN);
    expect(map.has('c')).toBe(false);
  });

  test('anyAccountSyncing', () => {
    expect(anyAccountSyncing(states)).toBe(false);
    expect(anyAccountSyncing([...states, { accountId: 'd', status: 'syncing' }])).toBe(true);
  });

  test('a mirror row is pending until its account syncs again', () => {
    const map = syncedAtByAccount(states);
    expect(isPendingEventRow({ accountId: 'a', createdAt: NOW - MIN }, map)).toBe(true);
    expect(isPendingEventRow({ accountId: 'a', createdAt: NOW - 5 * MIN }, map)).toBe(false);
    // No completed sync for the account: not pending, the first sync is not
    // a pending state.
    expect(isPendingEventRow({ accountId: 'c', createdAt: NOW }, map)).toBe(false);
    expect(isPendingEventRow({ accountId: 'a' }, map)).toBe(false);
  });
});
