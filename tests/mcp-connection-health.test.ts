import { describe, expect, test } from 'bun:test';
import { isMcpReconnectMessage, mcpNeedsReconnect, mcpSyncProblem } from '../lib/mcp/connection-health';
import { mcpConnectionSyncPatch } from '../lib/mcp/sync-state';

// AI-7: a connector's `status` says only whether its sign-in works. A sync
// problem is a separate, quiet fact.

describe('connection health helpers', () => {
  test('only the error status needs a reconnect', () => {
    expect(mcpNeedsReconnect({ status: 'error' })).toBe(true);
    expect(mcpNeedsReconnect({ status: 'connected' })).toBe(false);
    expect(mcpNeedsReconnect({ status: 'disconnected' })).toBe(false);
  });

  test('a sync problem shows only on a working connection, and says when it was partial', () => {
    expect(mcpSyncProblem({ status: 'connected' })).toBeNull();
    expect(mcpSyncProblem({ status: 'connected', lastSyncError: '  ' })).toBeNull();
    expect(mcpSyncProblem({ status: 'error', lastSyncError: 'auth rejected' })).toBeNull();
    expect(
      mcpSyncProblem({ status: 'connected', lastSyncError: 'x', lastSyncErrorAt: 5, lastSyncOkAt: 5 }),
    ).toEqual({ message: 'x', at: 5, partial: true });
    expect(
      mcpSyncProblem({ status: 'connected', lastSyncError: 'x', lastSyncErrorAt: 9, lastSyncOkAt: 5 }),
    ).toEqual({ message: 'x', at: 9, partial: false });
    expect(mcpSyncProblem({ status: 'connected', lastSyncError: 'x' })).toEqual({
      message: 'x',
      at: null,
      partial: false,
    });
  });

  test('knows the old sign-in failure messages', () => {
    expect(isMcpReconnectMessage('auth rejected — reconnect with a valid token')).toBe(true);
    expect(isMcpReconnectMessage('Reconnect Granola: its sign-in expired.')).toBe(true);
    expect(isMcpReconnectMessage('missing or unreadable credentials')).toBe(true);
    expect(isMcpReconnectMessage('account check: rate limited')).toBe(false);
    expect(isMcpReconnectMessage(undefined)).toBe(false);
  });
});

describe('the connection patch for one sync result', () => {
  const connected = { status: 'connected' };

  test('a started sync touches only the update time and a given sync time', () => {
    expect(mcpConnectionSyncPatch(connected, { status: 'syncing' }, 10)).toEqual({ updatedAt: 10 });
    expect(mcpConnectionSyncPatch(connected, { status: 'idle', lastSyncedAt: 3 }, 10)).toEqual({
      updatedAt: 10,
      lastSyncedAt: 3,
    });
  });

  test('a ready sync counts as a working connection and clears old problems', () => {
    expect(mcpConnectionSyncPatch({ status: 'error' }, { status: 'ready', lastSyncedAt: 7 }, 10)).toEqual({
      updatedAt: 10,
      lastSyncedAt: 7,
      status: 'connected',
      lastSyncOkAt: 10,
      lastSyncError: undefined,
      lastSyncErrorAt: undefined,
      error: undefined,
    });
  });

  test('a partial failure keeps connected and records the problem', () => {
    expect(
      mcpConnectionSyncPatch(
        connected,
        { status: 'error', outcome: 'ok', error: ' details unavailable ' },
        10,
      ),
    ).toMatchObject({
      status: 'connected',
      lastSyncOkAt: 10,
      lastSyncError: 'details unavailable',
      lastSyncErrorAt: 10,
      error: undefined,
    });
  });

  test('a failed sign-in sets the reconnect state with its reason', () => {
    expect(
      mcpConnectionSyncPatch(connected, { status: 'error', outcome: 'reconnect', error: 'expired' }, 10),
    ).toMatchObject({ status: 'error', error: 'expired', lastSyncError: 'expired' });
    expect(mcpConnectionSyncPatch(connected, { status: 'error', outcome: 'reconnect' }, 10)).toMatchObject({
      status: 'error',
      error: 'sync failed',
    });
  });

  test('a failure with no outcome keeps the current state', () => {
    const patch = mcpConnectionSyncPatch({ status: 'error' }, { status: 'error', error: 'timeout' }, 10);
    expect(patch).toMatchObject({ status: 'error', lastSyncError: 'timeout' });
    expect(patch).not.toHaveProperty('error');
    expect(patch).not.toHaveProperty('lastSyncOkAt');
  });

  test('a disconnected row never comes back', () => {
    expect(mcpConnectionSyncPatch({ status: 'disconnected' }, { status: 'ready' }, 10)).toBeNull();
  });
});
