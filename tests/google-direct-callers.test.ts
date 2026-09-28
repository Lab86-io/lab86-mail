import { afterEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { deleteCalendarEvent, rsvpCalendarEvent, unsubscribeCalendar } from '../lib/calendar/mutate';
import { syncCalendarAccount } from '../lib/calendar/sync';
import { setContactSyncDependenciesForTest, syncAccountContacts } from '../lib/contacts/sync';
import { __resetCalendarAdapterCacheForTest } from '../lib/google/adapter/calendar';
import { __resetContactsAdapterCacheForTest } from '../lib/google/adapter/contacts';
import { __setGoogleHttpDepsForTest } from '../lib/google/http';
import { requireNylas } from '../lib/nylas/client';
import type { NylasAccountRow } from '../lib/nylas/provider';
import {
  resolveProviderProfilePhoto,
  setPhotoResolutionDependenciesForTest,
} from '../lib/tools/photo-resolution';

// Real callers with a direct Google grant: `requireNylas()` routes each call to
// the Google adapter, Google answers through a stub, and Convex answers
// through a fetch stub. Any request to Nylas fails the test.

const ENV_KEYS = ['NYLAS_API_KEY', 'NYLAS_CLIENT_ID', 'NEXT_PUBLIC_CONVEX_URL'];

interface ConvexCall {
  path: string;
  args: Record<string, any>;
}

interface GoogleCall {
  method: string;
  url: URL;
  body?: any;
}

type Reply = { status?: number; json?: unknown };

function account(overrides: Partial<NylasAccountRow> = {}): NylasAccountRow {
  return {
    userId: 'user_1',
    accountId: 'acct-1',
    email: 'ann@work.example.test',
    provider: 'google',
    status: 'connected',
    grantId: 'google:acct-1',
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/contacts.other.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
    ],
    ...overrides,
  } as NylasAccountRow;
}

async function withStubs(
  fn: (stubs: {
    convex: ConvexCall[];
    google: GoogleCall[];
    onConvex: (path: string, handler: (args: Record<string, any>) => unknown) => void;
    onGoogle: (method: string, pattern: RegExp, reply: Reply | ((call: GoogleCall) => Reply)) => void;
  }) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.NYLAS_API_KEY = process.env.NYLAS_API_KEY || 'test-nylas-key';
  process.env.NYLAS_CLIENT_ID = process.env.NYLAS_CLIENT_ID || 'test-nylas-client';
  if (!process.env.NEXT_PUBLIC_CONVEX_URL && !process.env.CONVEX_URL) {
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://convex.lab86-tests.example';
  }
  const convex: ConvexCall[] = [];
  const google: GoogleCall[] = [];
  const convexHandlers = new Map<string, (args: Record<string, any>) => unknown>();
  const googleRoutes: Array<{ method: string; pattern: RegExp; reply: (call: GoogleCall) => Reply }> = [];
  const nylasRequests: string[] = [];
  // A calendar write kicks a background sync. It finds the account and then
  // does not get the claim, so it ends at once.
  convexHandlers.set('accounts:getConnectedAccount', () => account());
  convexHandlers.set('calendarData:claimCalendarSync', () => ({ claimed: false, reason: 'active' }));

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/query' || url.pathname === '/api/mutation') {
      const { path, args } = JSON.parse(await request.text());
      const callArgs = { ...((args?.[0] as Record<string, any>) || {}) };
      delete callArgs.internalSecret;
      convex.push({ path, args: callArgs });
      const handler = convexHandlers.get(path);
      return Response.json({ status: 'success', value: (handler ? await handler(callArgs) : null) ?? null });
    }
    nylasRequests.push(`${request.method} ${url}`);
    return new Response('{}', { status: 599 });
  }) as typeof fetch;

  __setGoogleHttpDepsForTest({
    fetch: async (input: string, init?: RequestInit) => {
      const call: GoogleCall = {
        method: init?.method || 'GET',
        url: new URL(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      google.push(call);
      const route = googleRoutes.find(
        (entry) => entry.method === call.method && entry.pattern.test(call.url.pathname),
      );
      const reply = route
        ? route.reply(call)
        : { status: 404, json: { error: { code: 404, message: 'Not Found' } } };
      return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
        status: reply.status ?? 200,
      });
    },
    getGoogleAccessToken: async () => 'token',
    invalidateGoogleAccessToken: () => {},
    sleep: async () => {},
  });
  __resetCalendarAdapterCacheForTest();
  __resetContactsAdapterCacheForTest();
  try {
    await fn({
      convex,
      google,
      onConvex: (path, handler) => convexHandlers.set(path, handler),
      onGoogle: (method, pattern, reply) =>
        googleRoutes.push({ method, pattern, reply: typeof reply === 'function' ? reply : () => reply }),
    });
    // Let fire-and-forget work (sync kicks, mirror refreshes) end on the stubs.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(nylasRequests).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    __setGoogleHttpDepsForTest();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => __setGoogleHttpDepsForTest());

describe('calendar callers with a direct Google grant', () => {
  test('syncCalendarAccount mirrors Google calendars and events with the stored ids', async () => {
    await withStubs(async (s) => {
      const row = account();
      s.onConvex('accounts:getConnectedAccount', () => row);
      // A recent full pass on record: the hot window runs, with no history kick.
      s.onConvex('calendarData:claimCalendarSync', () => ({
        claimed: true,
        state: { lastFullSyncAt: Date.now() - 60_000 },
      }));
      s.onConvex('calendarData:reconcileWindow', () => ({ done: true, pruned: 0 }));
      s.onGoogle('GET', /\/users\/me\/calendarList$/, {
        json: {
          items: [
            {
              id: 'ann@work.example.test',
              summary: 'ann@work.example.test',
              primary: true,
              accessRole: 'owner',
              timeZone: 'America/New_York',
              backgroundColor: '#9fe1e7',
            },
            {
              id: 'en.usa#holiday@group.v.calendar.google.com',
              summary: 'Holidays in United States',
              accessRole: 'reader',
              timeZone: 'America/New_York',
            },
          ],
        },
      });
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      s.onGoogle('GET', /\/calendars\/ann%40work\.example\.test\/events$/, (call) =>
        call.url.searchParams.get('pageToken')
          ? {
              json: {
                accessRole: 'owner',
                items: [
                  {
                    id: 'series1_20260929T133000Z',
                    summary: 'Standup',
                    recurringEventId: 'series1',
                    organizer: { email: 'lead@work.example.test' },
                    start: { dateTime: iso(now + 3_600_000), timeZone: 'America/New_York' },
                    end: { dateTime: iso(now + 4_500_000), timeZone: 'America/New_York' },
                    attendees: [{ email: 'ann@work.example.test', self: true, responseStatus: 'accepted' }],
                  },
                ],
              },
            }
          : {
              json: {
                accessRole: 'owner',
                nextPageToken: 'more',
                items: [
                  {
                    id: 'plain1',
                    summary: 'Review',
                    organizer: { email: 'ann@work.example.test', self: true },
                    start: { dateTime: iso(now + 7_200_000), timeZone: 'UTC' },
                    end: { dateTime: iso(now + 9_000_000), timeZone: 'UTC' },
                  },
                ],
              },
            },
      );
      s.onGoogle('GET', /\/calendars\/en\.usa%23holiday%40group\.v\.calendar\.google\.com\/events$/, {
        json: {
          accessRole: 'reader',
          items: [
            {
              id: '20260930_o0fp6osmkvm13bo00clcd54g6o',
              summary: 'Day',
              organizer: { email: 'en.usa#holiday@group.v.calendar.google.com', self: true },
              start: { date: '2026-09-30' },
              end: { date: '2026-10-01' },
              transparency: 'transparent',
            },
          ],
        },
      });

      const result = await syncCalendarAccount({ userId: 'user_1', accountId: 'acct-1', window: 'hot' });
      expect(result).toEqual({ ok: true, accountId: 'acct-1', calendars: 2, events: 3 });

      const eventsCall = s.google.find((call) => call.url.pathname.endsWith('/events'))!;
      expect(eventsCall.url.searchParams.get('singleEvents')).toBe('true');
      expect(eventsCall.url.searchParams.get('maxResults')).toBe('50');
      expect(eventsCall.url.searchParams.get('timeMin')).toMatch(/Z$/);

      const calendars = s.convex.find((call) => call.path === 'calendarData:upsertCalendarBatch')!.args;
      expect(calendars.grantId).toBe('google:acct-1');
      expect(calendars.calendars).toEqual([
        {
          providerCalendarId: 'ann@work.example.test',
          name: 'ann@work.example.test',
          timezone: 'America/New_York',
          isPrimary: true,
          readOnly: false,
          hexColor: '#9fe1e7',
        },
        {
          providerCalendarId: 'en.usa#holiday@group.v.calendar.google.com',
          name: 'Holidays in United States',
          timezone: 'America/New_York',
          isPrimary: false,
          readOnly: true,
        },
      ]);
      const events = s.convex
        .filter((call) => call.path === 'calendarData:upsertEventBatch')
        .flatMap((call) => call.args.events);
      expect(
        events.map((event: any) => [event.providerEventId, event.masterEventId, event.readOnly]),
      ).toEqual([
        ['plain1', undefined, false],
        ['series1_20260929T133000Z', 'series1', true],
        ['20260930_o0fp6osmkvm13bo00clcd54g6o', undefined, true],
      ]);
      const holiday = events[2];
      expect(holiday).toMatchObject({ allDay: true, busy: false, startAt: Date.UTC(2026, 8, 30) });
      const reconciles = s.convex.filter((call) => call.path === 'calendarData:reconcileWindow');
      expect(reconciles[0].args.keepProviderEventIds).toEqual(['plain1', 'series1_20260929T133000Z']);
    });
  });

  test('unsubscribeCalendar removes the calendar from the Google list', async () => {
    await withStubs(async (s) => {
      s.onConvex('accounts:listConnectedAccounts', () => [account()]);
      s.onGoogle('DELETE', /\/users\/me\/calendarList\/.+/, { status: 204 });
      const result = await unsubscribeCalendar({
        userId: 'user_1',
        accountId: 'acct-1',
        calendarId: 'team@group.calendar.google.com',
      });
      expect(result).toMatchObject({ ok: true, providerUnsubscribed: true, hiddenLocally: false });
      expect(s.google.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
        'DELETE /calendar/v3/users/me/calendarList/team%40group.calendar.google.com',
      ]);
      expect(s.convex.some((call) => call.path === 'calendarData:removeCalendar')).toBe(true);
    });
  });

  test('deleteCalendarEvent accepts a Google 410 for an event that is gone', async () => {
    await withStubs(async (s) => {
      s.onConvex('accounts:listConnectedAccounts', () => [account()]);
      s.onGoogle('DELETE', /\/events\/.+/, {
        status: 410,
        json: { error: { code: 410, message: 'Resource has been deleted', errors: [{ reason: 'deleted' }] } },
      });
      const result = await deleteCalendarEvent({
        userId: 'user_1',
        accountId: 'acct-1',
        calendarId: 'ann@work.example.test',
        eventId: 'gone1',
      });
      expect(result.ok).toBe(true);
      expect(s.convex.find((call) => call.path === 'calendarData:deleteEvent')?.args.providerEventId).toBe(
        'gone1',
      );
    });
  });

  test('rsvpCalendarEvent patches the user attendee', async () => {
    await withStubs(async (s) => {
      s.onConvex('accounts:listConnectedAccounts', () => [account()]);
      const event = {
        id: 'inv1',
        summary: 'Invite',
        organizer: { email: 'lead@work.example.test' },
        start: { dateTime: '2026-10-01T14:00:00Z' },
        end: { dateTime: '2026-10-01T15:00:00Z' },
        attendees: [
          { email: 'lead@work.example.test', organizer: true, responseStatus: 'accepted' },
          { email: 'ann@work.example.test', self: true, responseStatus: 'needsAction' },
        ],
      };
      s.onGoogle('GET', /\/events\/inv1$/, { json: event });
      s.onGoogle('PATCH', /\/events\/inv1$/, (call) => ({ json: { ...event, ...call.body } }));
      s.onGoogle('GET', /\/users\/me\/calendarList\/.+/, { json: { accessRole: 'owner' } });
      await rsvpCalendarEvent({
        userId: 'user_1',
        accountId: 'acct-1',
        calendarId: 'ann@work.example.test',
        eventId: 'inv1',
        status: 'yes',
      });
      const patch = s.google.find((call) => call.method === 'PATCH')!;
      expect(patch.body.attendees[1]).toEqual({
        email: 'ann@work.example.test',
        self: true,
        responseStatus: 'accepted',
      });
      expect(patch.url.searchParams.get('sendUpdates')).toBe('all');
    });
  });
});

describe('contact callers with a direct Google grant', () => {
  test('syncAccountContacts reads all three sources through the router', async () => {
    await withStubs(async (s) => {
      const row = account();
      const mutations: Array<{ path: string; args: any }> = [];
      const restore = setContactSyncDependenciesForTest({
        query: (async (fn: any) => {
          const name = getFunctionName(fn);
          if (name === 'contacts:listContactIds') return { ids: [], isDone: true, continueCursor: '' };
          if (name === 'accounts:getConnectedAccount') return row;
          return [];
        }) as any,
        mutate: (async (fn: any, args: any) => {
          const name = getFunctionName(fn);
          mutations.push({ path: name, args });
          if (name === 'contacts:claimContactSync')
            return { claimed: true, reason: 'claimed', previous: null };
          return null;
        }) as any,
        nylas: requireNylas,
        retry: (fn) => fn(),
        now: () => 1_790_000_000_000,
        leaseId: () => 'lease-1',
      });
      try {
        s.onGoogle('GET', /\/people\/me\/connections$/, {
          json: {
            connections: [
              {
                resourceName: 'people/c1',
                names: [{ displayName: 'Bea Marsh', givenName: 'Bea', familyName: 'Marsh' }],
                emailAddresses: [{ value: 'bea@example.test' }],
              },
            ],
          },
        });
        s.onGoogle('GET', /\/otherContacts$/, {
          json: {
            otherContacts: [
              { resourceName: 'otherContacts/c2', emailAddresses: [{ value: 'ops@example.test' }] },
            ],
          },
        });
        s.onGoogle('GET', /\/people:listDirectoryPeople$/, {
          json: {
            people: [{ resourceName: 'people/1045', emailAddresses: [{ value: 'mia@work.example.test' }] }],
          },
        });
        const result = await syncAccountContacts({ userId: 'user_1', accountId: 'acct-1', force: true });
        expect(result.status).toBe('ready');
        expect(result.sources?.map((entry) => [entry.source, entry.state, entry.count])).toEqual([
          ['address_book', 'ok', 1],
          ['inbox', 'ok', 1],
          ['domain', 'ok', 1],
        ]);
        expect(mutations.find((entry) => entry.path === 'contacts:finishContactSync')?.args.status).toBe(
          'ready',
        );
        const ids = mutations
          .filter((entry) => entry.path === 'contacts:upsertContactBatch')
          .flatMap((entry) => entry.args.contacts.map((contact: any) => contact.providerContactId));
        expect(ids).toEqual(['c1', 'otherContacts/c2', '1045']);
      } finally {
        restore();
      }
    });
  });

  test('resolveProviderProfilePhoto finds a photo by address', async () => {
    await withStubs(async (s) => {
      const restore = setPhotoResolutionDependenciesForTest({
        isNylasConfigured: () => true,
        requireNylas,
        resolveConnectedAccount: (async () => account()) as any,
      });
      try {
        s.onGoogle('GET', /\/people:searchContacts$/, (call) =>
          call.url.searchParams.get('query')
            ? {
                json: {
                  results: [
                    {
                      person: {
                        resourceName: 'people/c1',
                        emailAddresses: [{ value: 'bea@example.test' }],
                        photos: [{ url: 'https://lh3.googleusercontent.com/a/bea' }],
                      },
                    },
                  ],
                },
              }
            : { json: {} },
        );
        const url = await resolveProviderProfilePhoto({
          userId: 'user_1',
          account: 'acct-1',
          email: 'Bea@example.test',
        });
        expect(url).toBe('https://lh3.googleusercontent.com/a/bea');
      } finally {
        restore();
      }
    });
  });
});
