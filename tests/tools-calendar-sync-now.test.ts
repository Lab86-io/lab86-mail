import { describe, expect, test } from 'bun:test';
import { executeMobileCommand } from '../lib/mobile/v1/command-executor';
import { MobileCommandSchema } from '../lib/mobile/v1/contract';
import { calendarSyncNow } from '../lib/tools/calendar';

// The `calendar_sync_now` tool and the default mobile executor both reach the
// shared resync helper without an injection seam, so one Convex fetch stub
// covers them. The sync claim is refused, so no provider call happens.

const account = {
  userId: 'user_sync_now',
  accountId: 'acct_1',
  email: 'ann@example.com',
  provider: 'google',
  status: 'connected',
  displayName: 'Ann',
  grantId: 'grant_1',
};

const user = {
  userId: 'user_sync_now',
  email: 'ann@example.com',
  name: 'Ann',
  source: 'clerk' as const,
};

const ENV_KEYS = ['NEXT_PUBLIC_CONVEX_URL', 'CONVEX_URL', 'NYLAS_API_KEY', 'NYLAS_CLIENT_ID'];

async function withConvexStub(
  handlers: Record<string, (args: Record<string, any>) => unknown>,
  fn: (calls: Array<{ path: string; args: Record<string, any> }>) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://convex.lab86-tests.example';
  process.env.NYLAS_API_KEY = process.env.NYLAS_API_KEY || 'test-nylas-key';
  process.env.NYLAS_CLIENT_ID = process.env.NYLAS_CLIENT_ID || 'test-nylas-client';
  const calls: Array<{ path: string; args: Record<string, any> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname !== '/api/query' && url.pathname !== '/api/mutation') {
      return new Response(JSON.stringify({ error: { message: `unexpected ${url.pathname}` } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    const { path, args } = JSON.parse(await request.text());
    const callArgs = { ...((args?.[0] as Record<string, any>) || {}) };
    delete callArgs.internalSecret;
    calls.push({ path, args: callArgs });
    const handler = handlers[path];
    if (!handler) return Response.json({ status: 'error', errorMessage: `no convex handler for ${path}` });
    return Response.json({ status: 'success', value: (await handler(callArgs)) ?? null });
  }) as typeof fetch;
  try {
    await fn(calls);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const handlers = {
  'calendarData:getSyncStates': () => [
    { accountId: 'acct_1', status: 'ready', lastSyncedAt: Date.now() - 10 * 60_000 },
  ],
  'accounts:getConnectedAccount': () => account,
  'accounts:listConnectedAccounts': () => [account],
  'calendarData:claimCalendarSync': () => ({
    claimed: false,
    reason: 'active',
    state: { calendarsSynced: 2, eventsSynced: 40 },
  }),
};

describe('calendar_sync_now', () => {
  test('requires a signed-in user', async () => {
    await expect(calendarSyncNow.handler({}, { agent: 'user', userId: null })).rejects.toThrow(
      /Not authenticated/,
    );
  });

  test('waits for one account through the shared resync helper and returns its result', async () => {
    await withConvexStub(handlers, async (calls) => {
      const result = await calendarSyncNow.handler(
        { account: 'acct_1' },
        { agent: 'user', userId: 'user_sync_now' },
      );
      expect(result).toEqual({
        results: [
          { ok: true, accountId: 'acct_1', calendars: 2, events: 40, skipped: true, reason: 'active' },
        ],
      });
      const claim = calls.find((call) => call.path === 'calendarData:claimCalendarSync');
      expect(claim?.args).toMatchObject({
        userId: 'user_sync_now',
        accountId: 'acct_1',
        force: true,
        progress: { stage: 'claimed', reason: 'manual_tool' },
      });
    });
  });

  test('syncs every connected account when no account is given', async () => {
    await withConvexStub(handlers, async (calls) => {
      const result = await calendarSyncNow.handler({}, { agent: 'user', userId: 'user_sync_now' });
      expect(result.results).toHaveLength(1);
      expect(calls.some((call) => call.path === 'accounts:listConnectedAccounts')).toBe(true);
    });
  });
});

describe('calendar.resync with the default executor dependencies', () => {
  test('view_open on a fresh account reads sync state and starts nothing', async () => {
    await withConvexStub(
      {
        ...handlers,
        'calendarData:getSyncStates': () => [
          { accountId: 'acct_1', status: 'ready', lastSyncedAt: Date.now() - 5_000 },
        ],
      },
      async (calls) => {
        const command = MobileCommandSchema.parse({
          idempotencyKey: 'calendar-resync-default-1',
          kind: 'calendar.resync',
          payload: { accountID: 'acct_1', reason: 'view_open' },
          clientCreatedAt: '2026-09-03T09:00:00.000Z',
        });
        const result = await executeMobileCommand(command, user);
        expect(result).toEqual({ status: 'applied', syncDomain: 'calendar' });
        expect(calls.map((call) => call.path)).toEqual(['calendarData:getSyncStates']);
      },
    );
  });

  test('the default invoke routes a command through the tool registry', async () => {
    await withConvexStub(
      {
        'boards:updateCard': () => ({
          previous: { completed: false },
          card: { _id: 'card-1', completed: true },
        }),
        'operations:record': () => 'op_default_1',
      },
      async (calls) => {
        const command = MobileCommandSchema.parse({
          idempotencyKey: 'task-default-1',
          kind: 'task.setCompleted',
          payload: { cardID: 'card-1', completed: true },
          clientCreatedAt: '2026-09-03T09:00:00.000Z',
        });
        const result = await executeMobileCommand(command, user);
        expect(result).toMatchObject({ status: 'applied', entityKind: 'task', entityID: 'card-1' });
        expect(calls[0]?.path).toBe('boards:updateCard');
        expect(calls[0]?.args).toMatchObject({ userId: 'user_sync_now', cardId: 'card-1' });
      },
    );
  });

  test('the default enqueueApproval writes the approval row', async () => {
    await withConvexStub({ 'albatrossWork:enqueueApproval': () => 'approval-default-1' }, async (calls) => {
      const command = MobileCommandSchema.parse({
        idempotencyKey: 'calendar-invite-default-1',
        kind: 'calendar.create',
        payload: {
          accountID: 'acct_1',
          title: 'Review',
          startAt: '2026-09-04T13:00:00.000Z',
          endAt: '2026-09-04T14:00:00.000Z',
          allDay: false,
          attendees: [{ email: 'ari@example.com' }],
          busy: true,
        },
        clientCreatedAt: '2026-09-03T09:00:00.000Z',
      });
      const result = await executeMobileCommand(command, user);
      expect(result).toMatchObject({ status: 'needsApproval', approvalID: 'approval-default-1' });
      expect(calls.map((call) => call.path)).toEqual(['albatrossWork:enqueueApproval']);
    });
  });
});
