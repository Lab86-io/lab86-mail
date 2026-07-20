import { describe, expect, test } from 'bun:test';
import {
  applyCalendarWebhookDelta,
  backfillCalendarHistoryChunk,
  isCalendarWebhookType,
  syncAllCalendarAccounts,
  syncCalendarAccount,
  toEventInput,
} from '../lib/calendar/sync';
import type { NylasAccountRow } from '../lib/nylas/provider';

// ---------------------------------------------------------------------------
// Runtime sync coverage: the Nylas SDK and the Convex HTTP client both go
// through the global fetch, so a URL-routing stub covers the whole pipeline.
// /api/query + /api/mutation are Convex; /v3/grants/... is Nylas.
// ---------------------------------------------------------------------------

interface NylasCall {
  method: string;
  url: URL;
  body?: any;
}

interface ConvexCall {
  endpoint: 'query' | 'mutation';
  path: string;
  args: Record<string, any>;
}

interface NylasHandlerResult {
  status?: number;
  json?: unknown;
}

interface Harness {
  convexCalls: ConvexCall[];
  nylasCalls: NylasCall[];
  onConvex: (path: string, handler: (args: Record<string, any>) => unknown) => void;
  onNylas: (method: string, pathPattern: RegExp, handler: (call: NylasCall) => NylasHandlerResult) => void;
}

const ENV_KEYS = ['NYLAS_API_KEY', 'NYLAS_CLIENT_ID', 'NEXT_PUBLIC_CONVEX_URL'];

async function withHarness(fn: (harness: Harness) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NYLAS_API_KEY = process.env.NYLAS_API_KEY || 'test-nylas-key';
  process.env.NYLAS_CLIENT_ID = process.env.NYLAS_CLIENT_ID || 'test-nylas-client';
  if (!process.env.NEXT_PUBLIC_CONVEX_URL && !process.env.CONVEX_URL) {
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://convex.lab86-tests.example';
  }

  const convexCalls: ConvexCall[] = [];
  const nylasCalls: NylasCall[] = [];
  const convexHandlers = new Map<string, (args: Record<string, any>) => unknown>();
  const nylasHandlers: Array<{
    method: string;
    pattern: RegExp;
    handler: (call: NylasCall) => NylasHandlerResult;
  }> = [];

  const harness: Harness = {
    convexCalls,
    nylasCalls,
    onConvex: (path, handler) => convexHandlers.set(path, handler),
    onNylas: (method, pattern, handler) => nylasHandlers.push({ method, pattern, handler }),
  };

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/query' || url.pathname === '/api/mutation') {
      const { path, args } = JSON.parse(await request.text());
      const callArgs = { ...((args?.[0] as Record<string, any>) || {}) };
      delete callArgs.internalSecret;
      convexCalls.push({
        endpoint: url.pathname === '/api/query' ? 'query' : 'mutation',
        path,
        args: callArgs,
      });
      const handler = convexHandlers.get(path);
      if (!handler) {
        return Response.json({ status: 'error', errorMessage: `no convex handler for ${path}` });
      }
      try {
        const value = await handler(callArgs);
        return Response.json({ status: 'success', value: value ?? null });
      } catch (err: any) {
        return Response.json({ status: 'error', errorMessage: err?.message || 'handler failed' });
      }
    }
    const bodyText = await request.text();
    const call: NylasCall = {
      method: request.method,
      url,
      body: bodyText ? JSON.parse(bodyText) : undefined,
    };
    nylasCalls.push(call);
    const route = nylasHandlers.find(
      (entry) => entry.method === request.method && entry.pattern.test(url.pathname),
    );
    if (!route) {
      return new Response(
        JSON.stringify({
          error: { type: 'not_found', message: `no handler ${request.method} ${url.pathname}` },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    const result = route.handler(call);
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  globalThis.fetch = stub as typeof fetch;
  try {
    await fn(harness);
    // Drain fire-and-forget kicks (history backfill, webhook resyncs) against
    // the stub instead of leaking onto the restored real fetch.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function account(overrides: Partial<NylasAccountRow> = {}): NylasAccountRow {
  return {
    userId: 'user_1',
    accountId: 'acct_1',
    email: 'ann@example.com',
    provider: 'google',
    status: 'connected',
    grantId: 'grant_1',
    scopes: ['calendar'],
    ...overrides,
  };
}

function rawEvent(id: string, startSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    calendar_id: 'cal_1',
    title: `Event ${id}`,
    status: 'confirmed',
    busy: true,
    when: {
      object: 'timespan',
      start_time: startSeconds,
      end_time: startSeconds + 3600,
    },
    ...overrides,
  };
}

const DAY_MS = 86_400_000;

describe('syncCalendarAccount', () => {
  test('claims, walks calendars and window chunks, mirrors events, reconciles', async () => {
    await withHarness(async (h) => {
      const row = account();
      h.onConvex('accounts:getConnectedAccount', () => row);
      h.onConvex('calendarData:claimCalendarSync', () => ({ claimed: true }));
      h.onConvex('calendarData:upsertCalendarBatch', () => ({ ok: true }));
      h.onConvex('calendarData:upsertEventBatch', () => ({ ok: true }));
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));
      h.onConvex('calendarData:reconcileWindow', () => ({ done: true, pruned: 1 }));
      // Background history backfill kick exits immediately: already ready.
      h.onConvex('calendarData:getSyncState', () => ({ historyBackfillReady: true }));

      let calendarPage = 0;
      h.onNylas('GET', /\/v3\/grants\/grant_1\/calendars$/, () => {
        calendarPage += 1;
        return calendarPage === 1
          ? {
              json: {
                request_id: 'req_c',
                data: [{ id: 'cal_1', name: 'Work', is_primary: true, hex_color: '#336699' }],
                next_cursor: 'cal_cursor_2',
              },
            }
          : {
              json: {
                request_id: 'req_c',
                data: [{ id: 'cal_2', name: 'Shared', read_only: true }],
              },
            };
      });
      const nowSeconds = Math.floor(Date.now() / 1000);
      h.onNylas('GET', /\/v3\/grants\/grant_1\/events$/, (call) => ({
        json: {
          request_id: 'req_e',
          data:
            call.url.searchParams.get('calendar_id') === 'cal_1' &&
            Number(call.url.searchParams.get('start')) < nowSeconds
              ? [rawEvent('evt_1', nowSeconds - 3600), rawEvent('evt_2', nowSeconds + 7200)]
              : [],
        },
      }));

      const before = Date.now();
      const result = await syncCalendarAccount({ userId: 'user_1', accountId: 'acct_1' });
      expect(result).toEqual({ ok: true, accountId: 'acct_1', calendars: 2, events: 2 });

      const claim = h.convexCalls.find((call) => call.path === 'calendarData:claimCalendarSync');
      expect(claim?.args).toMatchObject({
        userId: 'user_1',
        accountId: 'acct_1',
        grantId: 'grant_1',
        provider: 'google',
        force: false,
        progress: { stage: 'claimed', reason: 'active_window' },
      });

      const calendarBatch = h.convexCalls.find((call) => call.path === 'calendarData:upsertCalendarBatch');
      expect(calendarBatch?.args.pruneMissing).toBe(true);
      expect(calendarBatch?.args.calendars).toEqual([
        {
          providerCalendarId: 'cal_1',
          name: 'Work',
          description: undefined,
          timezone: undefined,
          isPrimary: true,
          readOnly: undefined,
          hexColor: '#336699',
        },
        {
          providerCalendarId: 'cal_2',
          name: 'Shared',
          description: undefined,
          timezone: undefined,
          isPrimary: undefined,
          readOnly: true,
          hexColor: undefined,
        },
      ]);

      // The 92d-past → 366d-future window is walked in sub-year chunks per
      // calendar, and the first chunk starts at the window start.
      const eventLists = h.nylasCalls.filter((call) => call.url.pathname.endsWith('/events'));
      expect(eventLists.length).toBe(4);
      expect(eventLists[0].url.searchParams.get('expand_recurring')).toBe('true');
      expect(eventLists[0].url.searchParams.get('limit')).toBe('50');
      const firstStart = Number(eventLists[0].url.searchParams.get('start')) * 1000;
      expect(Math.abs(firstStart - (before - 92 * DAY_MS))).toBeLessThan(10_000);

      const eventBatch = h.convexCalls.find((call) => call.path === 'calendarData:upsertEventBatch');
      expect(eventBatch?.args.events.map((event: any) => event.providerEventId)).toEqual(['evt_1', 'evt_2']);
      expect(eventBatch?.args.events[0]).toMatchObject({
        providerCalendarId: 'cal_1',
        title: 'Event evt_1',
        allDay: false,
      });

      const reconcile = h.convexCalls.find((call) => call.path === 'calendarData:reconcileWindow');
      expect(reconcile?.args).toMatchObject({
        providerCalendarId: 'cal_1',
        keepProviderEventIds: ['evt_1', 'evt_2'],
        limit: 500,
      });

      const ready = h.convexCalls
        .filter((call) => call.path === 'calendarData:markSyncState')
        .find((call) => call.args.status === 'ready');
      expect(ready?.args).toMatchObject({ calendarsSynced: 2, eventsSynced: 2 });
    });
  });

  test('returns the previous counters when the sync claim is lost', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('calendarData:claimCalendarSync', () => ({
        claimed: false,
        reason: 'active_elsewhere',
        state: { calendarsSynced: 3, eventsSynced: 41 },
      }));

      const result = await syncCalendarAccount({ userId: 'user_1', accountId: 'acct_1' });
      expect(result).toEqual({
        ok: true,
        accountId: 'acct_1',
        calendars: 3,
        events: 41,
        skipped: true,
        reason: 'active_elsewhere',
      });
      expect(h.nylasCalls).toHaveLength(0);
    });
  });

  test('marks the account unauthorized when the grant is gone or scopes are missing', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('calendarData:claimCalendarSync', () => ({ claimed: true }));
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));
      let message = 'No grant found with id grant_1';
      let status = 404;
      h.onNylas('GET', /\/v3\/grants\/grant_1\/calendars$/, () => ({
        status,
        json: { request_id: 'req_c', error: { type: 'not_found', message } },
      }));

      const gone = await syncCalendarAccount({ userId: 'user_1', accountId: 'acct_1' });
      expect(gone).toEqual({ ok: false, accountId: 'acct_1', calendars: 0, events: 0, unauthorized: true });
      const goneMark = h.convexCalls
        .filter((call) => call.path === 'calendarData:markSyncState')
        .find((call) => call.args.status === 'unauthorized');
      expect(goneMark?.args.error).toContain('no longer exists');

      message = 'Forbidden';
      status = 403;
      const forbidden = await syncCalendarAccount({ userId: 'user_1', accountId: 'acct_1' });
      expect(forbidden.unauthorized).toBe(true);
      const scopeMark = h.convexCalls
        .filter((call) => call.path === 'calendarData:markSyncState')
        .filter((call) => call.args.status === 'unauthorized')
        .at(-1);
      expect(scopeMark?.args.error).toContain('connected without calendar access');
    });
  });

  test('records the error state and rethrows unexpected failures', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('calendarData:claimCalendarSync', () => ({ claimed: true }));
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));
      h.onNylas('GET', /\/v3\/grants\/grant_1\/calendars$/, () => ({
        status: 400,
        json: { request_id: 'req_c', error: { type: 'invalid_request', message: 'calendar melted' } },
      }));

      await expect(syncCalendarAccount({ userId: 'user_1', accountId: 'acct_1' })).rejects.toThrow(
        'calendar melted',
      );
      const errorMark = h.convexCalls
        .filter((call) => call.path === 'calendarData:markSyncState')
        .find((call) => call.args.status === 'error');
      expect(errorMark?.args.error).toBe('calendar melted');
    });
  });

  test('rejects accounts that are not connected', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account({ status: 'disconnected' }));
      await expect(syncCalendarAccount({ userId: 'user_1', accountId: 'acct_1' })).rejects.toThrow(
        'Connected account not found.',
      );
    });
  });
});

describe('syncAllCalendarAccounts', () => {
  test('skips disconnected accounts and folds per-account failures into results', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:listConnectedAccounts', () => [
        account({ accountId: 'acct_off', status: 'disconnected' }),
        account({ accountId: 'acct_err' }),
      ]);
      h.onConvex('accounts:getConnectedAccount', () => account({ accountId: 'acct_err' }));
      h.onConvex('calendarData:claimCalendarSync', () => {
        throw new Error('claim blew up');
      });

      const results = await syncAllCalendarAccounts('user_1');
      expect(results).toEqual([
        { ok: false, accountId: 'acct_err', calendars: 0, events: 0, error: 'claim blew up' },
      ]);
    });
  });
});

describe('backfillCalendarHistoryChunk', () => {
  test('short-circuits when history is already backfilled', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('calendarData:getSyncState', () => ({ historyBackfillReady: true }));
      const result = await backfillCalendarHistoryChunk({ userId: 'user_1', accountId: 'acct_1' });
      expect(result).toMatchObject({ ok: true, skipped: true, reason: 'history_ready' });
      expect(h.nylasCalls).toHaveLength(0);
    });
  });

  test('marks history ready when the cursor already reached the floor', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('calendarData:getSyncState', () => null);
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));

      // pastDays <= the 92-day active window ⇒ nothing left to walk.
      const result = await backfillCalendarHistoryChunk({
        userId: 'user_1',
        accountId: 'acct_1',
        pastDays: 30,
      });
      expect(result).toMatchObject({ ok: true, skipped: true, reason: 'history_ready' });
      const mark = h.convexCalls.find((call) => call.path === 'calendarData:markSyncState');
      expect(mark?.args).toMatchObject({ status: 'ready', historyBackfillReady: true });
    });
  });

  test('walks one history chunk backwards and advances the cursor', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('calendarData:getSyncState', () => null);
      h.onConvex('calendarData:claimCalendarSync', () => ({ claimed: true }));
      h.onConvex('calendarData:upsertCalendarBatch', () => ({ ok: true }));
      h.onConvex('calendarData:upsertEventBatch', () => ({ ok: true }));
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));
      h.onConvex('calendarData:reconcileWindow', () => ({ done: true, pruned: 0 }));
      h.onNylas('GET', /\/v3\/grants\/grant_1\/calendars$/, () => ({
        json: { request_id: 'req_c', data: [{ id: 'cal_1', name: 'Work' }] },
      }));
      const historicalStart = Math.floor((Date.now() - 100 * DAY_MS) / 1000);
      h.onNylas('GET', /\/v3\/grants\/grant_1\/events$/, () => ({
        json: { request_id: 'req_e', data: [rawEvent('evt_hist', historicalStart)] },
      }));

      const result = await backfillCalendarHistoryChunk({
        userId: 'user_1',
        accountId: 'acct_1',
        pastDays: 200,
        chunkDays: 60,
      });

      expect(result).toEqual({ ok: true, accountId: 'acct_1', calendars: 1, events: 1 });
      const calendarBatch = h.convexCalls.find((call) => call.path === 'calendarData:upsertCalendarBatch');
      expect(calendarBatch?.args.pruneMissing).toBe(false);
      const mark = h.convexCalls.filter((call) => call.path === 'calendarData:markSyncState').at(-1);
      // Cursor lands on the chunk's windowStart: 92d (active window) + 60d chunk.
      expect(mark?.args.historyBackfillReady).toBe(false);
      expect(Math.abs(mark?.args.historyCursorEnd - (Date.now() - 152 * DAY_MS))).toBeLessThan(60_000);
    });
  });

  test('returns skipped when the history claim is lost', async () => {
    await withHarness(async (h) => {
      h.onConvex('accounts:getConnectedAccount', () => account());
      h.onConvex('calendarData:getSyncState', () => null);
      h.onConvex('calendarData:claimCalendarSync', () => ({ claimed: false, reason: 'busy' }));
      const result = await backfillCalendarHistoryChunk({
        userId: 'user_1',
        accountId: 'acct_1',
        pastDays: 200,
      });
      expect(result).toMatchObject({ ok: true, skipped: true, reason: 'busy' });
    });
  });
});

describe('applyCalendarWebhookDelta', () => {
  test('event deletions prune the mirror as point deltas', async () => {
    await withHarness(async (h) => {
      const row = account({ userId: 'user_wh1', accountId: 'acct_wh1' });
      h.onConvex('calendarData:deleteEvent', () => ({ ok: true }));
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));

      await applyCalendarWebhookDelta(row, 'event.deleted', {
        data: { object: { id: 'evt_gone', calendar_id: 'cal_w' } },
      });

      const prune = h.convexCalls.find((call) => call.path === 'calendarData:deleteEvent');
      expect(prune?.args).toMatchObject({
        userId: 'user_wh1',
        accountId: 'acct_wh1',
        providerCalendarId: 'cal_w',
        providerEventId: 'evt_gone',
        includeInstances: true,
      });
      const mark = h.convexCalls.find((call) => call.path === 'calendarData:markSyncState');
      expect(mark?.args.progress).toMatchObject({ stage: 'event_webhook', type: 'event.deleted' });
    });
  });

  test('payloads without an event id are ignored with a progress note', async () => {
    await withHarness(async (h) => {
      const row = account({ userId: 'user_wh2', accountId: 'acct_wh2' });
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));

      await applyCalendarWebhookDelta(row, 'event.updated', { data: { object: {} } });
      const mark = h.convexCalls.find((call) => call.path === 'calendarData:markSyncState');
      expect(mark?.args.progress).toMatchObject({
        stage: 'event_webhook_ignored',
        reason: 'missing_event_id',
      });
      expect(h.convexCalls.some((call) => call.path === 'calendarData:upsertEventBatch')).toBe(false);
    });
  });

  test('plain event payloads upsert directly into the mirror', async () => {
    await withHarness(async (h) => {
      const row = account({ userId: 'user_wh3', accountId: 'acct_wh3' });
      h.onConvex('calendarData:upsertEventBatch', () => ({ ok: true }));
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));

      const startSeconds = Math.floor(Date.now() / 1000);
      await applyCalendarWebhookDelta(row, 'event.updated', {
        data: { object: rawEvent('evt_w', startSeconds, { calendar_id: 'cal_w' }) },
      });

      const upsert = h.convexCalls.find((call) => call.path === 'calendarData:upsertEventBatch');
      expect(upsert?.args.events[0]).toMatchObject({
        providerEventId: 'evt_w',
        providerCalendarId: 'cal_w',
        title: 'Event evt_w',
        startAt: startSeconds * 1000,
      });
    });
  });

  test('cancelled events delete instead of upserting', async () => {
    await withHarness(async (h) => {
      const row = account({ userId: 'user_wh4', accountId: 'acct_wh4' });
      h.onConvex('calendarData:deleteEvent', () => ({ ok: true }));
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));

      await applyCalendarWebhookDelta(row, 'event.updated', {
        data: {
          object: rawEvent('evt_c', Math.floor(Date.now() / 1000), {
            calendar_id: 'cal_w',
            status: 'cancelled',
          }),
        },
      });

      expect(h.convexCalls.some((call) => call.path === 'calendarData:deleteEvent')).toBe(true);
      expect(h.convexCalls.some((call) => call.path === 'calendarData:upsertEventBatch')).toBe(false);
    });
  });

  test('recurring payloads trigger a debounced resync instead of a point delta', async () => {
    await withHarness(async (h) => {
      const row = account({ userId: 'user_wh5', accountId: 'acct_wh5', grantId: 'grant_wh5' });
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));
      // The kicked background sync loses the claim and exits quietly.
      h.onConvex('accounts:getConnectedAccount', () => row);
      h.onConvex('calendarData:claimCalendarSync', () => ({ claimed: false }));

      await applyCalendarWebhookDelta(row, 'event.updated', {
        data: {
          object: { id: 'evt_r', calendar_id: 'cal_w', recurrence: ['RRULE:FREQ=DAILY'] },
        },
      });

      const mark = h.convexCalls.find((call) => call.path === 'calendarData:markSyncState');
      expect(mark?.args.progress).toMatchObject({ stage: 'event_webhook', recurring: true });
      expect(h.convexCalls.some((call) => call.path === 'calendarData:upsertEventBatch')).toBe(false);
    });
  });

  test('thin payloads fetch the full event from the provider before upserting', async () => {
    await withHarness(async (h) => {
      const row = account({ userId: 'user_wh6', accountId: 'acct_wh6', grantId: 'grant_wh6' });
      h.onConvex('calendarData:upsertEventBatch', () => ({ ok: true }));
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));
      const startSeconds = Math.floor(Date.now() / 1000);
      h.onNylas('GET', /\/v3\/grants\/grant_wh6\/events\/evt_thin$/, () => ({
        json: { request_id: 'req_e', data: rawEvent('evt_thin', startSeconds) },
      }));

      await applyCalendarWebhookDelta(row, 'event.created', {
        data: { object: { id: 'evt_thin', calendar_id: 'cal_1' } },
      });

      const find = h.nylasCalls.find((call) => call.url.pathname.endsWith('/events/evt_thin'));
      expect(find?.url.searchParams.get('calendar_id')).toBe('cal_1');
      const upsert = h.convexCalls.find((call) => call.path === 'calendarData:upsertEventBatch');
      expect(upsert?.args.events[0].providerEventId).toBe('evt_thin');
    });
  });

  test('calendar.* webhooks stamp sync progress and kick a resync', async () => {
    await withHarness(async (h) => {
      const row = account({ userId: 'user_wh7', accountId: 'acct_wh7', grantId: 'grant_wh7' });
      h.onConvex('calendarData:markSyncState', () => ({ ok: true }));
      h.onConvex('accounts:getConnectedAccount', () => row);
      h.onConvex('calendarData:claimCalendarSync', () => ({ claimed: false }));

      await applyCalendarWebhookDelta(row, 'calendar.updated', { data: { object: { id: 'cal_9' } } });
      const mark = h.convexCalls.find((call) => call.path === 'calendarData:markSyncState');
      expect(mark?.args.progress).toMatchObject({
        stage: 'calendar_webhook',
        type: 'calendar.updated',
        calendarId: 'cal_9',
      });
    });
  });
});

describe('webhook type and event normalization helpers', () => {
  test('isCalendarWebhookType matches event.* and calendar.* only', () => {
    expect(isCalendarWebhookType('event.created')).toBe(true);
    expect(isCalendarWebhookType('calendar.deleted')).toBe(true);
    expect(isCalendarWebhookType('message.created')).toBe(false);
  });

  test('toEventInput handles date spans, defaults, and rejects unusable payloads', () => {
    expect(toEventInput({ title: 'no id', when: { date: '2026-08-03' } })).toBeNull();
    expect(toEventInput({ id: 'evt_x', calendar_id: 'cal_x', when: {} })).toBeNull();
    expect(toEventInput({ id: 'evt_x', calendar_id: 'cal_x', when: { date: 'not-a-date' } })).toBeNull();

    const singleDay = toEventInput({ id: 'evt_d', calendar_id: 'cal_x', when: { date: '2026-08-03' } });
    expect(singleDay).toMatchObject({
      title: '(no title)',
      allDay: true,
      startAt: Date.UTC(2026, 7, 3),
      endAt: Date.UTC(2026, 7, 4),
      yearMonth: '2026-08',
    });

    const span = toEventInput({
      id: 'evt_s',
      calendar_id: 'cal_x',
      when: { start_date: '2026-08-03', end_date: '2026-08-06' },
      updated_at: 1_700_000_000,
    });
    expect(span).toMatchObject({
      allDay: true,
      startAt: Date.UTC(2026, 7, 3),
      endAt: Date.UTC(2026, 7, 6),
      providerUpdatedAt: 1_700_000_000_000,
    });

    const timed = toEventInput(
      {
        id: 'evt_t',
        when: { start_time: 1_754_000_000, end_time: 1_754_003_600, start_timezone: 'UTC' },
        updated_at: '2026-08-01T12:00:00.000Z',
      },
      'cal_fallback',
      'Work',
    );
    expect(timed).toMatchObject({
      providerCalendarId: 'cal_fallback',
      startAt: 1_754_000_000_000,
      endAt: 1_754_003_600_000,
      allDay: false,
      startTimezone: 'UTC',
      providerUpdatedAt: Date.parse('2026-08-01T12:00:00.000Z'),
    });
    expect(timed?.searchText).toContain('Work');
  });
});
