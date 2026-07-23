import { describe, expect, test } from 'bun:test';
import { undoOperation } from '../lib/ai/operations';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getPrimaryCalendarId,
  rsvpCalendarEvent,
  unsubscribeCalendar,
  updateCalendarEvent,
} from '../lib/calendar/mutate';
import type { NylasAccountRow } from '../lib/nylas/provider';

// ---------------------------------------------------------------------------
// Calendar mutations go provider-first (Nylas over fetch) and then mirror into
// Convex (also over fetch), so one URL-routing fetch stub covers both seams:
// /api/query + /api/mutation are Convex, /v3/grants/... is Nylas.
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
    // Let fire-and-forget mirror refreshes drain against the stub instead of
    // leaking onto the restored real fetch.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const account: NylasAccountRow = {
  userId: 'user_1',
  accountId: 'acct_1',
  email: 'ann@example.com',
  provider: 'google',
  status: 'connected',
  displayName: 'Ann',
  grantId: 'grant_1',
  scopes: ['calendar'],
};

const calendars = [
  { accountId: 'acct_1', providerCalendarId: 'cal_readonly', readOnly: true, isPrimary: false },
  { accountId: 'acct_1', providerCalendarId: 'cal_primary', readOnly: false, isPrimary: true },
  { accountId: 'acct_1', providerCalendarId: 'cal_second', readOnly: false, isPrimary: false },
  { accountId: 'acct_other', providerCalendarId: 'cal_other', readOnly: false, isPrimary: true },
];

const START_AT = Date.UTC(2026, 7, 3, 14, 0, 0);
const END_AT = Date.UTC(2026, 7, 3, 15, 0, 0);

function setupBase(h: Harness) {
  h.onConvex('accounts:listConnectedAccounts', () => [account]);
  h.onConvex('calendarData:listCalendars', () => calendars);
  h.onConvex('calendarData:upsertEventBatch', () => ({ ok: true }));
  h.onConvex('calendarData:deleteEvent', () => ({ ok: true }));
  h.onConvex('operations:record', () => 'op_1');
  h.onConvex('operations:completeUndo', () => ({ status: 'undone' }));
}

function eventResponse(id: string, overrides: Record<string, unknown> = {}) {
  return {
    request_id: 'req_e',
    data: {
      id,
      calendar_id: 'cal_primary',
      title: 'Coffee',
      status: 'confirmed',
      busy: true,
      when: {
        object: 'timespan',
        start_time: Math.floor(START_AT / 1000),
        end_time: Math.floor(END_AT / 1000),
        start_timezone: 'America/New_York',
        end_timezone: 'America/New_York',
      },
      html_link: `https://calendar.example/${id}`,
      ...overrides,
    },
  };
}

describe('createCalendarEvent', () => {
  test('creates on the primary writable calendar and mirrors into Convex', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events$/, () => ({ json: eventResponse('evt_1') }));

      const result = await createCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        title: 'Coffee',
        startAt: START_AT,
        endAt: END_AT,
        timezone: 'America/New_York',
        description: 'catch up',
      });

      expect(result).toEqual({
        eventId: 'evt_1',
        calendarId: 'cal_primary',
        operationId: 'op_1',
        htmlLink: 'https://calendar.example/evt_1',
      });

      const create = h.nylasCalls[0];
      expect(create.url.pathname).toBe('/v3/grants/grant_1/events');
      expect(create.url.searchParams.get('calendar_id')).toBe('cal_primary');
      expect(create.url.searchParams.get('notify_participants')).toBe('false');
      expect(create.body).toMatchObject({
        title: 'Coffee',
        description: 'catch up',
        busy: true,
        when: {
          start_time: Math.floor(START_AT / 1000),
          end_time: Math.floor(END_AT / 1000),
          start_timezone: 'America/New_York',
          end_timezone: 'America/New_York',
        },
      });
      expect(create.body.metadata.lab86CreatedBy).toBe('lab86-mail');

      const mirror = h.convexCalls.find((call) => call.path === 'calendarData:upsertEventBatch');
      expect(mirror?.args).toMatchObject({
        userId: 'user_1',
        accountId: 'acct_1',
        grantId: 'grant_1',
        provider: 'google',
      });
      expect(mirror?.args.events[0]).toMatchObject({
        providerEventId: 'evt_1',
        providerCalendarId: 'cal_primary',
        title: 'Coffee',
        startAt: START_AT,
        endAt: END_AT,
        allDay: false,
      });

      const record = h.convexCalls.find((call) => call.path === 'operations:record');
      expect(record?.args).toMatchObject({
        userId: 'user_1',
        tool: 'calendar_create_event',
        surface: 'calendar',
        inverse: {
          kind: 'calendar.delete_event',
          payload: { accountId: 'acct_1', calendarId: 'cal_primary', eventId: 'evt_1' },
        },
      });
    });
  });

  test('ignores a read-only requested calendar but honors a writable one', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events$/, () => ({ json: eventResponse('evt_2') }));

      await createCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_readonly',
        title: 'Coffee',
        startAt: START_AT,
        endAt: END_AT,
      });
      expect(h.nylasCalls[0].url.searchParams.get('calendar_id')).toBe('cal_primary');

      await createCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_second',
        title: 'Coffee',
        startAt: START_AT,
        endAt: END_AT,
        participants: [{ email: 'bob@x.com', name: 'Bob' }],
      });
      const second = h.nylasCalls[1];
      expect(second.url.searchParams.get('calendar_id')).toBe('cal_second');
      // Participants present without an explicit notify flag → provider emails them.
      expect(second.url.searchParams.get('notify_participants')).toBe('true');
      expect(second.body.participants).toEqual([{ email: 'bob@x.com', name: 'Bob' }]);
    });
  });

  test('shapes all-day whens as date or datespan', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events$/, () => ({ json: eventResponse('evt_3') }));

      const dayStart = Date.UTC(2026, 7, 3);
      await createCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        title: 'Holiday',
        startAt: dayStart,
        endAt: dayStart + 86_400_000,
        allDay: true,
      });
      expect(h.nylasCalls[0].body.when).toEqual({ date: '2026-08-03' });

      await createCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        title: 'Conference',
        startAt: dayStart,
        endAt: dayStart + 3 * 86_400_000,
        allDay: true,
      });
      expect(h.nylasCalls[1].body.when).toEqual({ start_date: '2026-08-03', end_date: '2026-08-06' });
    });
  });

  test('surfaces provider rejections with an actionable message', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events$/, () => ({
        status: 400,
        json: { request_id: 'req_e', error: { type: 'invalid_request', message: 'Bad Request' } },
      }));

      await expect(
        createCalendarEvent({
          userId: 'user_1',
          accountId: 'acct_1',
          title: 'Coffee',
          startAt: START_AT,
          endAt: END_AT,
        }),
      ).rejects.toThrow(/Couldn't create the event on ann@example\.com \(HTTP 400: Bad Request\)/);
      expect(h.convexCalls.some((call) => call.path === 'operations:record')).toBe(false);
    });
  });

  test('recovers a created event by request-id metadata after an ambiguous 5xx', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events$/, () => ({
        status: 502,
        json: { request_id: 'req_e', error: { type: 'server_error', message: 'Server Error' } },
      }));
      h.onNylas('GET', /\/v3\/grants\/grant_1\/events$/, (call) => {
        const pair = call.url.searchParams.get('metadata_pair') || '';
        const requestId = pair.split(':')[1] || '';
        return {
          json: {
            request_id: 'req_l',
            data: [
              {
                ...eventResponse('evt_recovered').data,
                metadata: { lab86CreateRequestId: requestId },
              },
            ],
          },
        };
      });

      const result = await createCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        title: 'Coffee',
        startAt: START_AT,
        endAt: END_AT,
      });
      expect(result.eventId).toBe('evt_recovered');

      const lookup = h.nylasCalls.find((call) => call.method === 'GET');
      expect(lookup?.url.searchParams.get('metadata_pair')).toMatch(/^lab86CreateRequestId:/);
      expect(lookup?.url.searchParams.get('calendar_id')).toBe('cal_primary');
    });
  }, 10_000);

  test('rejects a create response without an event id', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events$/, () => ({
        json: { request_id: 'req_e', data: {} },
      }));

      await expect(
        createCalendarEvent({
          userId: 'user_1',
          accountId: 'acct_1',
          title: 'Coffee',
          startAt: START_AT,
          endAt: END_AT,
        }),
      ).rejects.toThrow('provider returned no event id');
    });
  });
});

describe('getPrimaryCalendarId', () => {
  test('demands a synced writable calendar', async () => {
    await withHarness(async (h) => {
      h.onConvex('calendarData:listCalendars', () => [
        { accountId: 'acct_1', providerCalendarId: 'cal_readonly', readOnly: true },
      ]);
      await expect(getPrimaryCalendarId('user_1', 'acct_1')).rejects.toThrow(
        'No writable calendar synced for this account. Run calendar sync first.',
      );

      h.onConvex('calendarData:listCalendars', () => calendars);
      expect(await getPrimaryCalendarId('user_1', 'acct_1')).toBe('cal_primary');
    });
  });
});

describe('updateCalendarEvent', () => {
  test('merges patch times with the mirrored event and records a restore inverse', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      const newStart = START_AT + 3_600_000;
      h.onConvex('calendarData:getEventByProviderId', () => ({
        title: 'Old title',
        description: 'old',
        location: 'HQ',
        busy: true,
        startAt: START_AT,
        endAt: END_AT,
        allDay: false,
        participants: [{ email: 'bob@x.com' }],
        recurrence: undefined,
      }));
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/events\/evt_1$/, () => ({
        json: eventResponse('evt_1', { title: 'New title' }),
      }));

      const result = await updateCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_primary',
        eventId: 'evt_1',
        patch: {
          title: 'New title',
          startAt: newStart,
          busy: false,
          participants: [{ email: 'carol@x.com', name: 'Carol' }],
        },
      });

      expect(result).toEqual({ ok: true, operationId: 'op_1' });
      const update = h.nylasCalls.find((call) => call.method === 'PUT');
      expect(update?.url.searchParams.get('calendar_id')).toBe('cal_primary');
      expect(update?.url.searchParams.get('notify_participants')).toBe('false');
      expect(update?.body).toEqual({
        title: 'New title',
        busy: false,
        participants: [{ email: 'carol@x.com', name: 'Carol' }],
        when: {
          start_time: Math.floor(newStart / 1000),
          // endAt comes from the mirrored previous event.
          end_time: Math.floor(END_AT / 1000),
          start_timezone: 'UTC',
          end_timezone: 'UTC',
        },
      });

      const record = h.convexCalls.find((call) => call.path === 'operations:record');
      expect(record?.args.summary).toContain('title, startAt, busy, participants');
      expect(record?.args.inverse).toMatchObject({
        kind: 'calendar.restore_event',
        payload: {
          accountId: 'acct_1',
          calendarId: 'cal_primary',
          eventId: 'evt_1',
          fields: { title: 'Old title', startAt: START_AT, endAt: END_AT, location: 'HQ' },
        },
      });
    });
  });

  test('refuses time patches when the mirror has no times', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('calendarData:getEventByProviderId', () => null);
      await expect(
        updateCalendarEvent({
          userId: 'user_1',
          accountId: 'acct_1',
          calendarId: 'cal_primary',
          eventId: 'evt_1',
          patch: { startAt: START_AT },
        }),
      ).rejects.toThrow('Event times unknown; sync the calendar first.');
      expect(h.nylasCalls).toHaveLength(0);
    });
  });

  test('wraps provider failures in an actionable error', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('calendarData:getEventByProviderId', () => null);
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/events\/evt_1$/, () => ({
        status: 400,
        json: { request_id: 'req_e', error: { type: 'invalid_request', message: 'Bad Request' } },
      }));

      await expect(
        updateCalendarEvent({
          userId: 'user_1',
          accountId: 'acct_1',
          calendarId: 'cal_primary',
          eventId: 'evt_1',
          patch: { title: 'x' },
        }),
      ).rejects.toThrow(/Couldn't update the event on ann@example\.com/);
    });
  });
});

describe('deleteCalendarEvent', () => {
  test('tolerates 404s from the provider and still prunes the mirror', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('calendarData:getEventByProviderId', () => ({
        title: 'Standup',
        startAt: START_AT,
        endAt: END_AT,
        allDay: false,
      }));
      h.onNylas('DELETE', /\/v3\/grants\/grant_1\/events\/evt_1$/, () => ({
        status: 404,
        json: { request_id: 'req_d', error: { type: 'not_found', message: 'Not Found' } },
      }));

      const result = await deleteCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_primary',
        eventId: 'evt_1',
      });

      expect(result).toEqual({ ok: true, operationId: 'op_1' });
      const prune = h.convexCalls.find((call) => call.path === 'calendarData:deleteEvent');
      expect(prune?.args).toMatchObject({
        userId: 'user_1',
        accountId: 'acct_1',
        providerCalendarId: 'cal_primary',
        providerEventId: 'evt_1',
        includeInstances: true,
      });
      const record = h.convexCalls.find((call) => call.path === 'operations:record');
      expect(record?.args.summary).toBe('Deleted "Standup"');
      expect(record?.args.inverse).toMatchObject({
        kind: 'calendar.recreate_event',
        payload: { calendarId: 'cal_primary', fields: { title: 'Standup', startAt: START_AT } },
      });
    });
  });

  test('deleteSeries retargets the master event', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('calendarData:getEventByProviderId', (args) =>
        args.providerEventId === 'evt_instance'
          ? { title: 'Instance', masterEventId: 'evt_master', startAt: START_AT, endAt: END_AT }
          : { title: 'Series master', startAt: START_AT, endAt: END_AT, recurrence: ['RRULE:FREQ=WEEKLY'] },
      );
      const deleted: string[] = [];
      h.onNylas('DELETE', /\/v3\/grants\/grant_1\/events\/[^/]+$/, (call) => {
        deleted.push(call.url.pathname.split('/').at(-1) || '');
        return { json: { request_id: 'req_d', data: {} } };
      });

      await deleteCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_primary',
        eventId: 'evt_instance',
        deleteSeries: true,
      });

      expect(deleted).toEqual(['evt_master']);
      const prune = h.convexCalls.find((call) => call.path === 'calendarData:deleteEvent');
      expect(prune?.args.providerEventId).toBe('evt_master');
      const record = h.convexCalls.find((call) => call.path === 'operations:record');
      expect(record?.args.summary).toBe('Deleted "Series master"');
      expect(record?.args.inverse.payload.fields.recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
    });
  });

  test('propagates real provider failures', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('calendarData:getEventByProviderId', () => null);
      h.onNylas('DELETE', /\/v3\/grants\/grant_1\/events\/evt_1$/, () => ({
        status: 403,
        json: { request_id: 'req_d', error: { type: 'forbidden', message: 'Forbidden' } },
      }));

      await expect(
        deleteCalendarEvent({
          userId: 'user_1',
          accountId: 'acct_1',
          calendarId: 'cal_primary',
          eventId: 'evt_1',
        }),
      ).rejects.toThrow(/Couldn't delete the event on ann@example\.com/);
      expect(h.convexCalls.some((call) => call.path === 'calendarData:deleteEvent')).toBe(false);
    });
  });
});

describe('unsubscribeCalendar', () => {
  test('removes the mirror after a provider unsubscribe (including 404/410)', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('calendarData:removeCalendar', () => ({ ok: true }));
      let status = 200;
      h.onNylas('DELETE', /\/v3\/grants\/grant_1\/calendars\/cal_second$/, () => ({
        status,
        json:
          status === 200
            ? { request_id: 'req_d', data: {} }
            : { request_id: 'req_d', error: { type: 'not_found', message: 'Gone' } },
      }));

      const first = await unsubscribeCalendar({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_second',
      });
      expect(first).toMatchObject({
        ok: true,
        accountId: 'acct_1',
        calendarId: 'cal_second',
        providerUnsubscribed: true,
        hiddenLocally: false,
      });

      status = 410;
      const second = await unsubscribeCalendar({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_second',
      });
      expect(second.providerUnsubscribed).toBe(true);

      const removals = h.convexCalls.filter((call) => call.path === 'calendarData:removeCalendar');
      expect(removals).toHaveLength(2);
      expect(removals[0].args).toMatchObject({ providerCalendarId: 'cal_second' });
    });
  });

  test('falls back to hiding locally when the provider refuses and fallbackToHide is set', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('calendarData:setCalendarHiddenInternal', () => ({ ok: true }));
      h.onNylas('DELETE', /\/v3\/grants\/grant_1\/calendars\/cal_second$/, () => ({
        status: 403,
        json: { request_id: 'req_d', error: { type: 'forbidden', message: 'Forbidden' } },
      }));

      const result = await unsubscribeCalendar({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_second',
        fallbackToHide: true,
      });

      expect(result).toMatchObject({ ok: true, providerUnsubscribed: false, hiddenLocally: true });
      expect(result.providerError).toContain('HTTP 403');
      const hide = h.convexCalls.find((call) => call.path === 'calendarData:setCalendarHiddenInternal');
      expect(hide?.args).toMatchObject({ providerCalendarId: 'cal_second', hidden: true });

      await expect(
        unsubscribeCalendar({ userId: 'user_1', accountId: 'acct_1', calendarId: 'cal_second' }),
      ).rejects.toThrow(/Couldn't delete\/unsubscribe the calendar/);
    });
  });
});

describe('rsvpCalendarEvent', () => {
  test('sends the RSVP and records a non-undoable operation', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('calendarData:getEventByProviderId', () => ({
        title: 'Team offsite',
        startAt: START_AT,
        endAt: END_AT,
      }));
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events\/evt_1\/send-rsvp$/, () => ({
        json: { request_id: 'req_r', data: {} },
      }));
      // Post-RSVP mirror refresh (fire and forget).
      h.onNylas('GET', /\/v3\/grants\/grant_1\/events\/evt_1$/, () => ({ json: eventResponse('evt_1') }));

      const result = await rsvpCalendarEvent({
        userId: 'user_1',
        accountId: 'acct_1',
        calendarId: 'cal_primary',
        eventId: 'evt_1',
        status: 'yes',
      });

      expect(result).toEqual({ ok: true, operationId: 'op_1' });
      const rsvp = h.nylasCalls.find((call) => call.url.pathname.endsWith('/send-rsvp'));
      expect(rsvp?.body).toEqual({ status: 'yes' });
      const record = h.convexCalls.find((call) => call.path === 'operations:record');
      expect(record?.args.summary).toBe(`RSVP'd yes to "Team offsite"`);
      expect(record?.args.inverse).toBeUndefined();
    });
  });

  test('wraps RSVP failures without recording an operation', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events\/evt_1\/send-rsvp$/, () => ({
        status: 400,
        json: { request_id: 'req_r', error: { type: 'invalid_request', message: 'Bad Request' } },
      }));

      await expect(
        rsvpCalendarEvent({
          userId: 'user_1',
          accountId: 'acct_1',
          calendarId: 'cal_primary',
          eventId: 'evt_1',
          status: 'no',
        }),
      ).rejects.toThrow(/Couldn't RSVP to the event on ann@example\.com/);
      expect(h.convexCalls.some((call) => call.path === 'operations:record')).toBe(false);
    });
  });
});

describe('undo executors', () => {
  test('calendar.delete_event deletes on the provider and prunes without recording', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('operations:claimUndo', () => ({
        tool: 'calendar_create_event',
        surface: 'calendar',
        summary: 'Created "Coffee"',
        inverse: {
          kind: 'calendar.delete_event',
          payload: { accountId: 'acct_1', calendarId: 'cal_primary', eventId: 'evt_1' },
        },
      }));
      h.onNylas('DELETE', /\/v3\/grants\/grant_1\/events\/evt_1$/, () => ({
        json: { request_id: 'req_d', data: {} },
      }));

      const result = await undoOperation('user_1', 'op_1');
      expect(result).toEqual({ undone: 'Created "Coffee"', surface: 'calendar' });
      const destroy = h.nylasCalls.find((call) => call.method === 'DELETE');
      expect(destroy?.url.searchParams.get('notify_participants')).toBe('false');
      const prune = h.convexCalls.find((call) => call.path === 'calendarData:deleteEvent');
      expect(prune?.args.providerEventId).toBe('evt_1');
      expect(h.convexCalls.some((call) => call.path === 'operations:record')).toBe(false);
    });
  });

  test('calendar.recreate_event recreates the event and mirrors it', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('operations:claimUndo', () => ({
        tool: 'calendar_delete_event',
        surface: 'calendar',
        summary: 'Deleted "Coffee"',
        inverse: {
          kind: 'calendar.recreate_event',
          payload: {
            accountId: 'acct_1',
            calendarId: 'cal_primary',
            fields: { title: 'Coffee', startAt: START_AT, endAt: END_AT, allDay: false },
          },
        },
      }));
      h.onNylas('POST', /\/v3\/grants\/grant_1\/events$/, () => ({ json: eventResponse('evt_again') }));

      await undoOperation('user_1', 'op_1');
      const create = h.nylasCalls.find((call) => call.method === 'POST');
      expect(create?.url.searchParams.get('notify_participants')).toBe('false');
      expect(create?.body).toMatchObject({
        title: 'Coffee',
        when: { start_time: Math.floor(START_AT / 1000), end_time: Math.floor(END_AT / 1000) },
      });
      expect(create?.body.metadata.lab86CreatedBy).toBe('lab86-mail-undo');
      const mirror = h.convexCalls.find((call) => call.path === 'calendarData:upsertEventBatch');
      expect(mirror?.args.events[0].providerEventId).toBe('evt_again');
    });
  });

  test('calendar.restore_event writes the previous fields back and mirrors them', async () => {
    await withHarness(async (h) => {
      setupBase(h);
      h.onConvex('operations:claimUndo', () => ({
        tool: 'calendar_update_event',
        surface: 'calendar',
        summary: 'Updated title of "Coffee"',
        inverse: {
          kind: 'calendar.restore_event',
          payload: {
            accountId: 'acct_1',
            calendarId: 'cal_primary',
            eventId: 'evt_1',
            fields: { title: 'Old title', busy: true, startAt: START_AT, endAt: END_AT, allDay: false },
          },
        },
      }));
      h.onNylas('PUT', /\/v3\/grants\/grant_1\/events\/evt_1$/, () => ({
        json: eventResponse('evt_1', { title: 'Old title' }),
      }));

      await undoOperation('user_1', 'op_1');
      const update = h.nylasCalls.find((call) => call.method === 'PUT');
      expect(update?.body).toMatchObject({
        title: 'Old title',
        busy: true,
        when: { start_time: Math.floor(START_AT / 1000), end_time: Math.floor(END_AT / 1000) },
      });
      const mirror = h.convexCalls.find((call) => call.path === 'calendarData:upsertEventBatch');
      expect(mirror?.args.events[0]).toMatchObject({ providerEventId: 'evt_1', title: 'Old title' });
    });
  });
});
