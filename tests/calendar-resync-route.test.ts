import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createCalendarResyncPost } from '../app/api/calendar/resync/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/calendar/resync', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function dependencies() {
  const rateLimitCalls: Array<Record<string, unknown>> = [];
  const resyncCalls: Array<Record<string, unknown>> = [];
  const deps = {
    requireCurrentUser: async () => ({
      userId: 'user_resync',
      email: 'owner@example.test',
      name: 'Owner',
      source: 'clerk' as const,
    }),
    enforceUserRateLimit: async (input: Record<string, unknown>) => {
      rateLimitCalls.push(input);
      return { ok: true };
    },
    startCalendarResync: async (input: Record<string, unknown>) => {
      resyncCalls.push(input);
      return { started: true, lastSyncedAt: 1_700_000_000_000 };
    },
  };
  return { deps: deps as any, rateLimitCalls, resyncCalls };
}

describe('POST /api/calendar/resync', () => {
  test('defaults to manual_http with the rate limit and returns started + lastSyncedAt', async () => {
    const { deps, rateLimitCalls, resyncCalls } = dependencies();
    const response = await createCalendarResyncPost(deps)(request({ accountId: 'acct_1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      started: true,
      lastSyncedAt: 1_700_000_000_000,
      reason: 'manual_http',
    });
    expect(rateLimitCalls).toEqual([
      { userId: 'user_resync', key: 'calendar_resync', limit: 10, windowMs: 10 * 60_000 },
    ]);
    expect(resyncCalls).toEqual([{ userId: 'user_resync', accountId: 'acct_1', reason: 'manual_http' }]);
  });

  test('view_open skips the rate limit and passes the reason through', async () => {
    const { deps, rateLimitCalls, resyncCalls } = dependencies();
    deps.startCalendarResync = async (input: Record<string, unknown>) => {
      resyncCalls.push(input);
      return { started: false, lastSyncedAt: 1_700_000_000_000, skippedReason: 'fresh' };
    };
    const response = await createCalendarResyncPost(deps)(request({ reason: 'view_open' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      started: false,
      lastSyncedAt: 1_700_000_000_000,
      reason: 'view_open',
    });
    expect(rateLimitCalls).toHaveLength(0);
    expect(resyncCalls).toEqual([{ userId: 'user_resync', accountId: undefined, reason: 'view_open' }]);
  });

  test('pull uses the rate limit', async () => {
    const { deps, rateLimitCalls, resyncCalls } = dependencies();
    const response = await createCalendarResyncPost(deps)(request({ reason: 'pull', accountId: ' acct_2 ' }));
    expect(response.status).toBe(200);
    expect(rateLimitCalls).toHaveLength(1);
    expect(resyncCalls).toEqual([{ userId: 'user_resync', accountId: 'acct_2', reason: 'pull' }]);
  });

  test('rejects an unknown reason with 400 before any work', async () => {
    const { deps, rateLimitCalls, resyncCalls } = dependencies();
    const response = await createCalendarResyncPost(deps)(request({ reason: 'post_mutation' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'reason must be one of: view_open, pull, manual_http',
    });
    expect(rateLimitCalls).toHaveLength(0);
    expect(resyncCalls).toHaveLength(0);
  });

  test('rejects a non-string reason', async () => {
    const { deps } = dependencies();
    const response = await createCalendarResyncPost(deps)(request({ reason: 7 }));
    expect(response.status).toBe(400);
  });

  test('treats an unparsable body as an empty manual_http request', async () => {
    const { deps, resyncCalls } = dependencies();
    const response = await createCalendarResyncPost(deps)(request('not json'));
    expect(response.status).toBe(200);
    expect(resyncCalls).toEqual([{ userId: 'user_resync', accountId: undefined, reason: 'manual_http' }]);
  });

  test('returns 429 with Retry-After when the manual limit is hit', async () => {
    const { deps, resyncCalls } = dependencies();
    deps.enforceUserRateLimit = async () => {
      throw new RateLimitError('Too many resyncs.', 30_000, 10);
    };
    const response = await createCalendarResyncPost(deps)(request({ reason: 'manual_http' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(resyncCalls).toHaveLength(0);
  });

  test('returns 401 when the user is not signed in', async () => {
    const { deps } = dependencies();
    deps.requireCurrentUser = async () => {
      throw new AuthRequiredError('Sign in required.');
    };
    const response = await createCalendarResyncPost(deps)(request({ reason: 'pull' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
  });

  test('returns 500 when the helper fails', async () => {
    const { deps } = dependencies();
    deps.startCalendarResync = async () => {
      throw new Error('convex unreachable');
    };
    const response = await createCalendarResyncPost(deps)(request({ reason: 'pull' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'convex unreachable' });
  });
});
