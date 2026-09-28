import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { toEventInput } from '../lib/calendar/sync';
import { __resetCalendarAdapterCacheForTest, googleCalendarAdapter } from '../lib/google/adapter/calendar';
import {
  addDays,
  conferencingFromText,
  googleConferencingToNylas,
  googleEventToNylas,
  googleWhenToNylas,
  ianaTimezone,
  nylasEventBodyToGoogle,
  nylasWhenToGoogle,
  participantsToAttendees,
  sendUpdatesFor,
} from '../lib/google/calendar-map';
import { __setGoogleHttpDepsForTest, GoogleApiError } from '../lib/google/http';

// Google Calendar API fixtures follow the real JSON of Google accounts (the
// ids, zones, attendee and conference shapes) with invented people.

const GRANT = 'google:acct-1';
const CAL = 'ann@example.test';
const API = 'https://www.googleapis.com/calendar/v3';

interface Call {
  method: string;
  url: URL;
  body?: any;
  signal?: AbortSignal | null;
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
type Route = { method: string; pattern: RegExp; reply: (call: Call) => Reply };

function google() {
  const calls: Call[] = [];
  const routes: Route[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method || 'GET',
      url: new URL(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    const route = routes.find(
      (entry) => entry.method === call.method && entry.pattern.test(call.url.pathname),
    );
    const reply = route
      ? route.reply(call)
      : {
          status: 404,
          json: { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
        };
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  };
  __setGoogleHttpDepsForTest({
    fetch,
    getGoogleAccessToken: async () => 'token',
    invalidateGoogleAccessToken: () => {},
    sleep: async () => {},
  });
  return {
    calls,
    on(method: string, pattern: RegExp, reply: Reply | ((call: Call) => Reply)) {
      routes.push({ method, pattern, reply: typeof reply === 'function' ? reply : () => reply });
    },
  };
}

const adapter = googleCalendarAdapter as Required<typeof googleCalendarAdapter>;

beforeEach(() => __resetCalendarAdapterCacheForTest());
afterEach(() => __setGoogleHttpDepsForTest());

// ---- Fixtures -------------------------------------------------------------------

const timedEvent = {
  kind: 'calendar#event',
  id: '0ecj52b02h59k745sdsmcnhmpg',
  status: 'confirmed',
  htmlLink: 'https://www.google.com/calendar/event?eid=MGVjajUy',
  created: '2026-06-26T21:17:43.000Z',
  updated: '2026-06-27T15:36:26.418Z',
  summary: 'Lunch with Tris',
  creator: { email: CAL, self: true },
  organizer: { email: CAL, self: true },
  start: { dateTime: '2026-06-27T12:00:00-04:00', timeZone: 'America/New_York' },
  end: { dateTime: '2026-06-27T15:00:00-04:00', timeZone: 'America/New_York' },
  iCalUID: '0ecj52b02h59k745sdsmcnhmpg@google.com',
  sequence: 0,
  attendees: [
    { email: 'tris@example.test', displayName: 'Tris', responseStatus: 'declined' },
    { email: CAL, organizer: true, self: true, responseStatus: 'accepted' },
  ],
  reminders: { useDefault: true },
  eventType: 'default',
};

const instanceEvent = {
  id: '28k8p596aiaco1n6q9c8ldtqgv_20270929T133000Z',
  status: 'confirmed',
  htmlLink: 'https://www.google.com/calendar/event?eid=Mjhr',
  updated: '2026-09-27T01:11:56.000Z',
  summary: 'Daily standup',
  organizer: { email: 'lead@example.test', displayName: 'Lead' },
  start: { dateTime: '2027-09-29T09:30:00-04:00', timeZone: 'America/New_York' },
  end: { dateTime: '2027-09-29T09:45:00-04:00', timeZone: 'America/New_York' },
  recurringEventId: '28k8p596aiaco1n6q9c8ldtqgv_R20260624T133000',
  originalStartTime: { dateTime: '2027-09-29T09:30:00-04:00', timeZone: 'America/New_York' },
  iCalUID: '28k8p596aiaco1n6q9c8ldtqgv_R20260624T133000@google.com',
  attendees: [
    { email: 'lead@example.test', organizer: true, responseStatus: 'accepted' },
    { email: CAL, self: true, responseStatus: 'needsAction' },
    { email: 'sam@example.test', responseStatus: 'tentative', comment: 'Late' },
  ],
  hangoutLink: 'https://meet.google.com/zvh-qsnw-gow',
  conferenceData: {
    entryPoints: [
      {
        entryPointType: 'video',
        uri: 'https://meet.google.com/zvh-qsnw-gow',
        label: 'meet.google.com/zvh-qsnw-gow',
      },
      { entryPointType: 'phone', uri: 'tel:+1-304-441-0816', label: '+1 304-441-0816', pin: '592007283' },
      { entryPointType: 'more', uri: 'https://tel.meet/zvh-qsnw-gow?pin=592007283', pin: '592007283' },
    ],
    conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
    conferenceId: 'zvh-qsnw-gow',
  },
  eventType: 'default',
};

const allDayEvent = {
  id: 'rjfdlor0983494dnoq3876l47s',
  status: 'confirmed',
  summary: 'Holiday',
  organizer: { email: CAL, self: true },
  start: { date: '2026-08-11' },
  end: { date: '2026-08-12' },
  transparency: 'transparent',
  iCalUID: 'rjfdlor0983494dnoq3876l47s@google.com',
};

const tripEvent = {
  id: 'trip1',
  status: 'tentative',
  summary: 'Trip',
  organizer: { email: CAL, self: true },
  start: { date: '2026-08-11' },
  end: { date: '2026-08-14' },
  extendedProperties: { private: { lab86CreateRequestId: 'req-123' } },
};

const offsetZoneEvent = {
  id: '_6l246gq668pk2b9i88ojab9k691k4ba26sq36b9h6l0jie1g6krk4gi26g',
  status: 'confirmed',
  summary: 'Movie',
  organizer: { email: CAL, self: true },
  start: { dateTime: '2023-10-27T22:35:00-04:00', timeZone: 'GMT-04:00' },
  end: { dateTime: '2023-10-28T01:35:00-04:00', timeZone: 'GMT-04:00' },
  description: 'Join: https://rit.zoom.us/j/94573260981 now',
};

const zeroLengthEvent = {
  id: '3339188fdeff4d628f39c301aaee7314_20270730T110000Z',
  status: 'confirmed',
  summary: 'Wake up',
  organizer: { email: CAL, self: true },
  start: { dateTime: '2027-07-30T07:00:00-04:00', timeZone: 'America/New_York' },
  end: { dateTime: '2027-07-30T07:00:00-04:00', timeZone: 'America/New_York' },
  recurringEventId: '3339188fdeff4d628f39c301aaee7314',
};

const workingLocation = {
  id: 'wl1',
  eventType: 'workingLocation',
  summary: 'Home',
  start: { date: '2026-08-11' },
  end: { date: '2026-08-12' },
};

// ---- Calendars ------------------------------------------------------------------

describe('calendars', () => {
  test('list maps the calendar list, follows the page token, and skips deleted entries', async () => {
    const g = google();
    g.on('GET', /\/users\/me\/calendarList$/, (call) =>
      call.url.searchParams.get('pageToken')
        ? { json: { items: [{ id: 'gone@group.calendar.google.com', deleted: true, accessRole: 'owner' }] } }
        : {
            json: {
              nextPageToken: 'page-2',
              items: [
                {
                  id: CAL,
                  summary: CAL,
                  timeZone: 'America/New_York',
                  primary: true,
                  accessRole: 'owner',
                  backgroundColor: '#9fe1e7',
                  foregroundColor: '#000000',
                },
                {
                  id: 'en.usa#holiday@group.v.calendar.google.com',
                  summary: 'Holidays in United States',
                  description: 'Holidays and Observances in United States',
                  timeZone: 'America/New_York',
                  accessRole: 'reader',
                  backgroundColor: '#16a765',
                },
                {
                  id: 'family1346@group.calendar.google.com',
                  summary: 'Family',
                  summaryOverride: 'Home',
                  timeZone: 'UTC',
                  accessRole: 'writer',
                },
              ],
            },
          },
    );
    const first = await adapter.calendars.list({ identifier: GRANT, queryParams: { limit: 50 } });
    expect(first.nextCursor).toBe('page-2');
    expect(typeof first.requestId).toBe('string');
    expect(first.data).toEqual([
      {
        id: CAL,
        grantId: GRANT,
        object: 'calendar',
        name: CAL,
        timezone: 'America/New_York',
        isPrimary: true,
        readOnly: false,
        isOwnedByUser: true,
        hexColor: '#9fe1e7',
        hexForegroundColor: '#000000',
      },
      {
        id: 'en.usa#holiday@group.v.calendar.google.com',
        grantId: GRANT,
        object: 'calendar',
        name: 'Holidays in United States',
        description: 'Holidays and Observances in United States',
        timezone: 'America/New_York',
        isPrimary: false,
        readOnly: true,
        isOwnedByUser: false,
        hexColor: '#16a765',
      },
      {
        id: 'family1346@group.calendar.google.com',
        grantId: GRANT,
        object: 'calendar',
        name: 'Home',
        timezone: 'UTC',
        isPrimary: false,
        readOnly: false,
        isOwnedByUser: false,
      },
    ]);
    expect(g.calls[0].url.searchParams.get('maxResults')).toBe('50');
    expect(g.calls[0].url.searchParams.has('pageToken')).toBe(false);
    expect(g.calls[0].url.origin + g.calls[0].url.pathname).toBe(`${API}/users/me/calendarList`);

    const second = await adapter.calendars.list({ identifier: GRANT, queryParams: { pageToken: 'page-2' } });
    expect(second.data).toEqual([]);
    expect(second.nextCursor).toBeUndefined();
    expect(g.calls[1].url.searchParams.get('pageToken')).toBe('page-2');
  });

  test('find reads one calendar list entry', async () => {
    const g = google();
    g.on('GET', /\/users\/me\/calendarList\/.+/, {
      json: { id: CAL, summary: 'Main', accessRole: 'freeBusyReader' },
    });
    const found = await adapter.calendars.find({ identifier: GRANT, calendarId: CAL });
    expect(found.data).toMatchObject({ id: CAL, name: 'Main', readOnly: true, isOwnedByUser: false });
    expect(g.calls[0].url.pathname).toBe(`/calendar/v3/users/me/calendarList/${encodeURIComponent(CAL)}`);
  });

  test('destroy removes the calendar from the list and never deletes the calendar', async () => {
    const g = google();
    g.on('DELETE', /\/users\/me\/calendarList\/.+/, { status: 204 });
    const id = 'en.usa#holiday@group.v.calendar.google.com';
    const result = await adapter.calendars.destroy({
      identifier: GRANT,
      calendarId: id,
      overrides: { timeout: 20 },
    });
    expect(typeof result.requestId).toBe('string');
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0].method).toBe('DELETE');
    expect(g.calls[0].url.pathname).toBe(`/calendar/v3/users/me/calendarList/${encodeURIComponent(id)}`);
    expect(g.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(g.calls.some((call) => call.url.pathname.startsWith('/calendar/v3/calendars/'))).toBe(false);
  });

  test('destroy of a calendar that is already gone rejects with a 404 that callers accept', async () => {
    google();
    const error = await adapter.calendars
      .destroy({ identifier: GRANT, calendarId: 'gone@group.calendar.google.com' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).statusCode).toBe(404);
  });
});

// ---- Events: list ---------------------------------------------------------------

describe('events.list', () => {
  test('sends the Nylas window and paging as Google parameters', async () => {
    const g = google();
    g.on('GET', /\/calendars\/.+\/events$/, (call) =>
      call.url.searchParams.get('pageToken')
        ? { json: { accessRole: 'owner', items: [allDayEvent] } }
        : { json: { accessRole: 'owner', items: [timedEvent], nextPageToken: 'next-1' } },
    );
    const first = await adapter.events.list({
      identifier: GRANT,
      queryParams: {
        calendarId: CAL,
        start: '1790000000',
        end: '1791209600',
        expandRecurring: true,
        limit: 50,
        showCancelled: true,
        orderBy: 'start',
      },
    });
    const params = g.calls[0].url.searchParams;
    expect(g.calls[0].url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`);
    expect(params.get('timeMin')).toBe('2026-09-21T14:13:20Z');
    expect(params.get('timeMax')).toBe('2026-10-05T14:13:20Z');
    expect(params.get('singleEvents')).toBe('true');
    expect(params.get('orderBy')).toBe('startTime');
    expect(params.get('maxResults')).toBe('50');
    expect(params.get('showDeleted')).toBe('true');
    expect(params.has('eventTypes')).toBe(false);
    expect(first.nextCursor).toBe('next-1');
    expect(first.data).toHaveLength(1);

    const second = await adapter.events.list({
      identifier: GRANT,
      queryParams: { calendarId: CAL, pageToken: 'next-1' },
    });
    expect(g.calls[1].url.searchParams.get('pageToken')).toBe('next-1');
    expect(g.calls[1].url.searchParams.has('singleEvents')).toBe(false);
    expect(g.calls[1].url.searchParams.has('timeMin')).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  test('maps a timed event to the Nylas shape that sync stores', async () => {
    const g = google();
    g.on('GET', /\/events$/, { json: { accessRole: 'owner', items: [timedEvent] } });
    const page = await adapter.events.list({ identifier: GRANT, queryParams: { calendarId: CAL } });
    expect(page.data[0]).toEqual({
      id: '0ecj52b02h59k745sdsmcnhmpg',
      grantId: GRANT,
      object: 'event',
      calendarId: CAL,
      title: 'Lunch with Tris',
      when: {
        object: 'timespan',
        startTime: 1782576000,
        endTime: 1782586800,
        startTimezone: 'America/New_York',
        endTimezone: 'America/New_York',
      },
      busy: true,
      status: 'confirmed',
      readOnly: false,
      participants: [
        { email: 'tris@example.test', name: 'Tris', status: 'no' },
        { email: CAL, status: 'yes' },
      ],
      organizer: { email: CAL, name: '' },
      creator: { email: CAL },
      icalUid: '0ecj52b02h59k745sdsmcnhmpg@google.com',
      htmlLink: 'https://www.google.com/calendar/event?eid=MGVjajUy',
      reminders: { useDefault: true, overrides: [] },
      visibility: 'default',
      createdAt: 1782508663,
      updatedAt: 1782574586,
    });
    // The stored row matches the row that Nylas produced for this event.
    const row = toEventInput(page.data[0], CAL)!;
    expect(row).toMatchObject({
      providerEventId: '0ecj52b02h59k745sdsmcnhmpg',
      providerCalendarId: CAL,
      startAt: 1782576000000,
      endAt: 1782586800000,
      allDay: false,
      startTimezone: 'America/New_York',
      endTimezone: 'America/New_York',
      busy: true,
      readOnly: false,
      status: 'confirmed',
      providerUpdatedAt: 1782574586000,
      organizer: { email: CAL, name: '' },
    });
    expect(row.masterEventId).toBeUndefined();
    expect(row.conferencing).toBeUndefined();
  });

  test('maps a recurring instance with Google ids, Meet details, and readOnly for a guest', async () => {
    const g = google();
    g.on('GET', /\/events$/, { json: { accessRole: 'owner', items: [instanceEvent] } });
    const [event] = (await adapter.events.list({ identifier: GRANT, queryParams: { calendarId: CAL } })).data;
    expect(event.id).toBe('28k8p596aiaco1n6q9c8ldtqgv_20270929T133000Z');
    expect(event.masterEventId).toBe('28k8p596aiaco1n6q9c8ldtqgv_R20260624T133000');
    expect(event.icalUid).toBe('28k8p596aiaco1n6q9c8ldtqgv_R20260624T133000@google.com');
    expect(event.originalStartTime).toBe(1822224600);
    // Another person organizes it, so the user cannot edit it.
    expect(event.readOnly).toBe(true);
    expect(event.organizer).toEqual({ email: 'lead@example.test', name: 'Lead' });
    expect(event.participants).toEqual([
      { email: 'lead@example.test', status: 'yes' },
      { email: CAL, status: 'noreply' },
      { email: 'sam@example.test', status: 'maybe', comment: 'Late' },
    ]);
    expect(event.conferencing).toEqual({
      provider: 'Google Meet',
      details: {
        meetingCode: 'zvh-qsnw-gow',
        phone: ['tel:+1-304-441-0816'],
        pin: '592007283',
        url: 'https://meet.google.com/zvh-qsnw-gow',
      },
    });
  });

  test('maps all-day events with an exclusive end, like the stored rows', async () => {
    const g = google();
    g.on('GET', /\/events$/, { json: { accessRole: 'owner', items: [allDayEvent, tripEvent] } });
    const [day, trip] = (await adapter.events.list({ identifier: GRANT, queryParams: { calendarId: CAL } }))
      .data;
    expect(day.when).toEqual({ object: 'date', date: '2026-08-11' });
    expect(day.busy).toBe(false);
    expect(trip.when).toEqual({ object: 'datespan', startDate: '2026-08-11', endDate: '2026-08-14' });
    expect(trip.status).toBe('maybe');
    expect(trip.metadata).toEqual({ lab86CreateRequestId: 'req-123' });
    const dayRow = toEventInput(day, CAL)!;
    expect(dayRow).toMatchObject({ allDay: true, startAt: 1786406400000, endAt: 1786492800000 });
    expect(dayRow.startTimezone).toBeUndefined();
    const tripRow = toEventInput(trip, CAL)!;
    expect(tripRow.endAt - tripRow.startAt).toBe(3 * 86_400_000);
  });

  test('drops offset zones, keeps zero-length events timed, and reads meeting links from text', async () => {
    const g = google();
    g.on('GET', /\/events$/, {
      json: { accessRole: 'owner', items: [offsetZoneEvent, zeroLengthEvent, workingLocation] },
    });
    const page = await adapter.events.list({ identifier: GRANT, queryParams: { calendarId: CAL } });
    // The working-location marker is not a meeting.
    expect(page.data.map((event: any) => event.id)).toEqual([offsetZoneEvent.id, zeroLengthEvent.id]);
    const [movie, wake] = page.data;
    expect(movie.when).toEqual({ object: 'timespan', startTime: 1698460500, endTime: 1698471300 });
    expect(movie.conferencing).toEqual({
      provider: 'Zoom Meeting',
      details: { meetingCode: '94573260981', url: 'https://rit.zoom.us/j/94573260981' },
    });
    expect(wake.when.startTime).toBe(wake.when.endTime);
    expect(toEventInput(wake, CAL)).toMatchObject({
      allDay: false,
      startAt: 1816945200000,
      endAt: 1816945200000,
    });
  });

  test('keeps working-location events when the caller asks for the type', async () => {
    const g = google();
    g.on('GET', /\/events$/, { json: { items: [workingLocation] } });
    const page = await adapter.events.list({
      identifier: GRANT,
      queryParams: { calendarId: CAL, eventType: ['workingLocation'] },
    });
    expect(page.data).toHaveLength(1);
    expect(g.calls[0].url.searchParams.getAll('eventTypes')).toEqual(['workingLocation']);
  });

  test('marks every event on a read-only calendar as read-only', async () => {
    const g = google();
    g.on('GET', /\/events$/, {
      json: {
        accessRole: 'reader',
        items: [
          {
            id: '20270906_o0fp6osmkvm13bo00clcd54g6o',
            summary: 'Labor Day',
            organizer: { email: 'en.usa#holiday@group.v.calendar.google.com', self: true },
            start: { date: '2027-09-06' },
            end: { date: '2027-09-07' },
            transparency: 'transparent',
          },
        ],
      },
    });
    const [holiday] = (
      await adapter.events.list({
        identifier: GRANT,
        queryParams: { calendarId: 'en.usa#holiday@group.v.calendar.google.com' },
      })
    ).data;
    expect(holiday.readOnly).toBe(true);
    expect(holiday.busy).toBe(false);
  });

  test('finds a created event by its metadata pair', async () => {
    const g = google();
    g.on('GET', /\/events$/, { json: { items: [tripEvent] } });
    const page = await adapter.events.list({
      identifier: GRANT,
      queryParams: { calendarId: CAL, metadataPair: { lab86CreateRequestId: 'req-123' }, limit: 10 },
      overrides: { timeout: 20 },
    });
    expect(g.calls[0].url.searchParams.getAll('privateExtendedProperty')).toEqual([
      'lab86CreateRequestId=req-123',
    ]);
    expect(g.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(page.data[0].metadata.lab86CreateRequestId).toBe('req-123');
  });

  test('turns a Calendar 403 rate limit into a 429', async () => {
    const g = google();
    g.on('GET', /\/events$/, {
      status: 403,
      json: {
        error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
      },
    });
    const error = (await adapter.events
      .list({ identifier: GRANT, queryParams: { calendarId: CAL } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.statusCode).toBe(429);
    expect(error.reason).toBe('rateLimitExceeded');
  });

  test('keeps a scope 403 as a 403', async () => {
    const g = google();
    g.on('GET', /\/events$/, {
      status: 403,
      json: {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          status: 'PERMISSION_DENIED',
        },
      },
    });
    const error = (await adapter.events
      .list({ identifier: GRANT, queryParams: { calendarId: CAL } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(403);
  });

  test('rejects a start that is not a number', async () => {
    google();
    const error = (await adapter.events
      .list({ identifier: GRANT, queryParams: { calendarId: CAL, start: 'soon' } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(400);
  });

  test('rejects a call without a grant id', async () => {
    const error = (await adapter.events.list({ queryParams: {} }).catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(400);
  });
});

// ---- Events: find ---------------------------------------------------------------

describe('events.find', () => {
  test('reads the event and the calendar role once', async () => {
    const g = google();
    g.on('GET', /\/events\/.+/, { json: instanceEvent });
    g.on('GET', /\/users\/me\/calendarList\/.+/, { json: { id: CAL, accessRole: 'reader' } });
    const found = await adapter.events.find({
      identifier: GRANT,
      eventId: instanceEvent.id,
      queryParams: { calendarId: CAL },
    });
    expect(found.data.id).toBe(instanceEvent.id);
    expect(found.data.readOnly).toBe(true);
    await adapter.events.find({
      identifier: GRANT,
      eventId: instanceEvent.id,
      queryParams: { calendarId: CAL },
    });
    expect(g.calls.filter((call) => call.url.pathname.includes('calendarList'))).toHaveLength(1);
  });

  test('uses the role from an earlier list and survives a failed role read', async () => {
    const g = google();
    g.on('GET', /\/calendars\/.+\/events$/, { json: { accessRole: 'owner', items: [] } });
    g.on('GET', /\/events\/.+/, { json: timedEvent });
    await adapter.events.list({ identifier: GRANT, queryParams: { calendarId: CAL } });
    const found = await adapter.events.find({
      identifier: GRANT,
      eventId: timedEvent.id,
      queryParams: { calendarId: CAL },
    });
    expect(found.data.readOnly).toBe(false);
    expect(g.calls.some((call) => call.url.pathname.includes('calendarList'))).toBe(false);

    // No cached role and a failed role read: the organizer rule still applies.
    __resetCalendarAdapterCacheForTest();
    const again = await adapter.events.find({
      identifier: GRANT,
      eventId: timedEvent.id,
      queryParams: { calendarId: CAL },
    });
    expect(again.data.readOnly).toBe(false);
  });

  test('maps a cancelled event and passes a 404 through', async () => {
    const g = google();
    g.on('GET', /\/events\/cancelled1$/, {
      json: {
        id: 'cancelled1',
        status: 'cancelled',
        start: { date: '2026-08-11' },
        end: { date: '2026-08-12' },
      },
    });
    g.on('GET', /\/users\/me\/calendarList\/.+/, { json: { accessRole: 'owner' } });
    const found = await adapter.events.find({
      identifier: GRANT,
      eventId: 'cancelled1',
      queryParams: { calendarId: CAL },
    });
    expect(found.data.status).toBe('cancelled');
    const error = (await adapter.events
      .find({ identifier: GRANT, eventId: 'missing', queryParams: { calendarId: CAL } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(404);
  });

  test('rejects a call without an event id', async () => {
    google();
    const error = (await adapter.events
      .find({ identifier: GRANT, queryParams: { calendarId: CAL } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(400);
  });
});

// ---- Events: writes ----------------------------------------------------------------

describe('events.create', () => {
  test('writes a timed event with guests, a rule, metadata, and a Meet request', async () => {
    const g = google();
    g.on('POST', /\/events$/, (call) => ({
      json: {
        ...call.body,
        id: 'new1',
        status: 'confirmed',
        organizer: { email: CAL, self: true },
        conferenceData: {
          createRequest: {
            requestId: call.body.conferenceData.createRequest.requestId,
            status: { statusCode: 'pending' },
          },
          conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
        },
      },
    }));
    const created = await adapter.events.create({
      identifier: GRANT,
      requestBody: {
        title: 'Plan',
        description: undefined,
        location: 'Room 4',
        conferencing: { provider: 'Google Meet', autocreate: {} },
        busy: true,
        when: {
          startTime: 1790000000,
          endTime: 1790003600,
          startTimezone: 'America/New_York',
          endTimezone: 'America/New_York',
        },
        participants: [{ email: 'sam@example.test', name: 'Sam' }],
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
        metadata: { lab86CreateRequestId: 'abc', lab86CreatedBy: 'lab86-mail' },
      },
      queryParams: { calendarId: CAL, notifyParticipants: true },
      overrides: { timeout: 20 },
    });
    const call = g.calls[0];
    expect(call.url.searchParams.get('sendUpdates')).toBe('all');
    expect(call.url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(call.body).toMatchObject({
      summary: 'Plan',
      location: 'Room 4',
      transparency: 'opaque',
      start: { dateTime: '2026-09-21T14:13:20Z', timeZone: 'America/New_York' },
      end: { dateTime: '2026-09-21T15:13:20Z', timeZone: 'America/New_York' },
      attendees: [{ email: 'sam@example.test', displayName: 'Sam' }],
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
      extendedProperties: { private: { lab86CreateRequestId: 'abc', lab86CreatedBy: 'lab86-mail' } },
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    expect('description' in call.body).toBe(false);
    expect(call.body.start.date).toBeUndefined();
    expect(created.data.id).toBe('new1');
    // The Meet link is not ready yet, so the caller reports a pending conference.
    expect(created.data.conferencing).toEqual({ provider: 'Google Meet', autocreate: {} });
    expect(created.data.conferencing.details?.url).toBeUndefined();
  });

  test('writes all-day dates with an exclusive end and can skip notifications', async () => {
    const g = google();
    g.on('POST', /\/events$/, (call) => ({ json: { ...call.body, id: `n${g.calls.length}` } }));
    await adapter.events.create({
      identifier: GRANT,
      requestBody: { title: 'Off', busy: false, when: { date: '2026-12-31' } },
      queryParams: { calendarId: CAL, notifyParticipants: false },
    });
    await adapter.events.create({
      identifier: GRANT,
      requestBody: { title: 'Trip', when: { startDate: '2026-08-11', endDate: '2026-08-14' } },
      queryParams: { calendarId: CAL },
    });
    expect(g.calls[0].url.searchParams.get('sendUpdates')).toBe('none');
    expect(g.calls[0].url.searchParams.has('conferenceDataVersion')).toBe(false);
    expect(g.calls[0].body).toMatchObject({
      transparency: 'transparent',
      start: { date: '2026-12-31' },
      end: { date: '2027-01-01' },
    });
    expect(g.calls[1].body).toMatchObject({ start: { date: '2026-08-11' }, end: { date: '2026-08-14' } });
    expect(g.calls[1].url.searchParams.get('sendUpdates')).toBe('all');
  });

  test('passes a Google 400 through with its status', async () => {
    const g = google();
    g.on('POST', /\/events$/, {
      status: 400,
      json: { error: { code: 400, message: 'Bad Request', errors: [{ reason: 'invalid' }] } },
    });
    const error = (await adapter.events
      .create({
        identifier: GRANT,
        requestBody: { when: { date: '2026-01-01' } },
        queryParams: { calendarId: CAL },
      })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(400);
  });
});

describe('events.update', () => {
  test('patches only the given fields and clears the other kind of time', async () => {
    const g = google();
    g.on('PATCH', /\/events\/.+/, (call) => ({ json: { ...timedEvent, ...call.body } }));
    const updated = await adapter.events.update({
      identifier: GRANT,
      eventId: allDayEvent.id,
      requestBody: {
        title: 'Moved',
        when: { startTime: 1790000000, endTime: 1790003600, startTimezone: 'UTC', endTimezone: 'UTC' },
        recurrence: [],
      },
      queryParams: { calendarId: CAL, notifyParticipants: false },
    });
    const call = g.calls[0];
    expect(call.method).toBe('PATCH');
    expect(call.url.searchParams.get('sendUpdates')).toBe('none');
    expect(call.body).toEqual({
      summary: 'Moved',
      start: { dateTime: '2026-09-21T14:13:20Z', timeZone: 'UTC', date: null },
      end: { dateTime: '2026-09-21T15:13:20Z', timeZone: 'UTC', date: null },
      recurrence: [],
    });
    expect(updated.data.title).toBe('Moved');
    // No participant change: no read before the write.
    expect(g.calls).toHaveLength(1);
  });

  test('turns a timed event into an all-day event', async () => {
    const g = google();
    g.on('PATCH', /\/events\/.+/, (call) => ({ json: { ...allDayEvent, ...call.body } }));
    await adapter.events.update({
      identifier: GRANT,
      eventId: timedEvent.id,
      requestBody: { when: { date: '2026-08-11' }, busy: false },
      queryParams: { calendarId: CAL },
    });
    expect(g.calls[0].body).toEqual({
      transparency: 'transparent',
      start: { date: '2026-08-11', dateTime: null, timeZone: null },
      end: { date: '2026-08-12', dateTime: null, timeZone: null },
    });
  });

  test('keeps the response status of guests that stay on the list', async () => {
    const g = google();
    g.on('GET', /\/events\/.+/, { json: instanceEvent });
    g.on('PATCH', /\/events\/.+/, (call) => ({ json: { ...instanceEvent, ...call.body } }));
    await adapter.events.update({
      identifier: GRANT,
      eventId: instanceEvent.id,
      requestBody: {
        participants: [
          { email: 'Sam@example.test', name: 'Sam S', status: 'yes' },
          { email: 'new@example.test' },
          { email: 'sam@example.test' },
          { name: 'no address' },
        ],
      },
      queryParams: { calendarId: CAL, notifyParticipants: true },
    });
    expect(g.calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
    expect(g.calls[1].body.attendees).toEqual([
      { email: 'sam@example.test', displayName: 'Sam S', responseStatus: 'tentative', comment: 'Late' },
      { email: 'new@example.test' },
    ]);
  });
});

describe('events.destroy', () => {
  test('deletes with the notify flag', async () => {
    const g = google();
    g.on('DELETE', /\/events\/.+/, { status: 204 });
    const result = await adapter.events.destroy({
      identifier: GRANT,
      eventId: instanceEvent.recurringEventId,
      queryParams: { calendarId: CAL, notifyParticipants: false },
    });
    expect(typeof result.requestId).toBe('string');
    expect(g.calls[0].url.pathname).toBe(
      `/calendar/v3/calendars/${encodeURIComponent(CAL)}/events/${instanceEvent.recurringEventId}`,
    );
    expect(g.calls[0].url.searchParams.get('sendUpdates')).toBe('none');
  });

  test('a gone event rejects with 410, which the callers accept', async () => {
    const g = google();
    g.on('DELETE', /\/events\/.+/, {
      status: 410,
      json: { error: { code: 410, message: 'Resource has been deleted', errors: [{ reason: 'deleted' }] } },
    });
    const error = (await adapter.events
      .destroy({ identifier: GRANT, eventId: 'old', queryParams: { calendarId: CAL } })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(410);
  });
});

describe('events.sendRsvp', () => {
  test('patches only the user attendee and notifies by default', async () => {
    const g = google();
    g.on('GET', /\/events\/.+/, { json: instanceEvent });
    g.on('PATCH', /\/events\/.+/, (call) => ({ json: { ...instanceEvent, ...call.body } }));
    const result = await adapter.events.sendRsvp({
      identifier: GRANT,
      eventId: instanceEvent.id,
      requestBody: { status: 'maybe' },
      queryParams: { calendarId: CAL },
    });
    expect(typeof result.requestId).toBe('string');
    const patch = g.calls[1];
    expect(patch.url.searchParams.get('sendUpdates')).toBe('all');
    expect(patch.body.attendees).toEqual([
      { email: 'lead@example.test', organizer: true, responseStatus: 'accepted' },
      { email: CAL, self: true, responseStatus: 'tentative' },
      { email: 'sam@example.test', responseStatus: 'tentative', comment: 'Late' },
    ]);
  });

  test('finds the user by the calendar address and honors notifyParticipants false', async () => {
    const g = google();
    g.on('GET', /\/events\/.+/, {
      json: { ...timedEvent, attendees: [{ email: 'ANN@example.test', responseStatus: 'needsAction' }] },
    });
    g.on('PATCH', /\/events\/.+/, { json: timedEvent });
    for (const [status, expected] of [
      ['yes', 'accepted'],
      ['no', 'declined'],
    ] as const) {
      await adapter.events.sendRsvp({
        identifier: GRANT,
        eventId: timedEvent.id,
        requestBody: { status },
        queryParams: { calendarId: CAL, notifyParticipants: false },
      });
      const patch = g.calls[g.calls.length - 1];
      expect(patch.body.attendees[0].responseStatus).toBe(expected);
      expect(patch.url.searchParams.get('sendUpdates')).toBe('none');
    }
  });

  test('rejects a bad status and an event without the user', async () => {
    const g = google();
    g.on('GET', /\/events\/.+/, { json: { ...timedEvent, attendees: [{ email: 'x@example.test' }] } });
    const bad = (await adapter.events
      .sendRsvp({
        identifier: GRANT,
        eventId: 'e',
        requestBody: { status: 'noreply' },
        queryParams: { calendarId: CAL },
      })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(bad.statusCode).toBe(400);
    const outsider = (await adapter.events
      .sendRsvp({
        identifier: GRANT,
        eventId: 'e',
        requestBody: { status: 'yes' },
        queryParams: { calendarId: CAL },
      })
      .catch((e: unknown) => e)) as GoogleApiError;
    expect(outsider.statusCode).toBe(400);
    expect(g.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

// ---- Pure mapping rules ------------------------------------------------------------

describe('calendar mapping rules', () => {
  test('ianaTimezone keeps named zones only', () => {
    expect(ianaTimezone('America/New_York')).toBe('America/New_York');
    expect(ianaTimezone('UTC')).toBe('UTC');
    expect(ianaTimezone('GMT-04:00')).toBeUndefined();
    expect(ianaTimezone('-04:00')).toBeUndefined();
    expect(ianaTimezone('Mars/Olympus')).toBeUndefined();
    expect(ianaTimezone(undefined)).toBeUndefined();
  });

  test('googleWhenToNylas handles missing and odd times', () => {
    expect(googleWhenToNylas(undefined, undefined)).toBeUndefined();
    expect(googleWhenToNylas({ dateTime: '2026-01-01T10:00:00Z' }, undefined)).toEqual({
      object: 'timespan',
      startTime: 1767261600,
      endTime: 1767261600,
    });
    // An end before the start is one day.
    expect(googleWhenToNylas({ date: '2026-01-02' }, { date: '2026-01-01' })).toEqual({
      object: 'date',
      date: '2026-01-02',
    });
    expect(addDays('not-a-date', 1)).toBe('not-a-date');
  });

  test('nylasWhenToGoogle reads every Nylas when kind', () => {
    expect(nylasWhenToGoogle({ time: 1767261600, timezone: 'UTC' })).toEqual({
      start: { dateTime: '2026-01-01T10:00:00Z', timeZone: 'UTC' },
      end: { dateTime: '2026-01-01T10:00:00Z', timeZone: 'UTC' },
    });
    expect(nylasWhenToGoogle({ start_time: 1767261600, end_time: 1767265200 })).toEqual({
      start: { dateTime: '2026-01-01T10:00:00Z' },
      end: { dateTime: '2026-01-01T11:00:00Z' },
    });
    expect(nylasWhenToGoogle({ start_date: '2026-01-05', end_date: '2026-01-05' })).toEqual({
      start: { date: '2026-01-05' },
      end: { date: '2026-01-06' },
    });
    expect(nylasWhenToGoogle({})).toBeUndefined();
    expect(nylasWhenToGoogle(null)).toBeUndefined();
  });

  test('event bodies map reminders, visibility, and hidden guests', () => {
    expect(
      nylasEventBodyToGoogle({
        reminders: { useDefault: false, overrides: [{ reminderMinutes: 10, reminderMethod: 'popup' }] },
        visibility: 'private',
        hideParticipants: true,
        metadata: { a: 1, b: null },
      }),
    ).toEqual({
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
      visibility: 'private',
      guestsCanSeeOtherGuests: false,
      extendedProperties: { private: { a: '1' } },
    });
    expect(nylasEventBodyToGoogle({ visibility: 'default' })).toEqual({ visibility: 'default' });
    expect(nylasEventBodyToGoogle(undefined)).toEqual({});
    expect(participantsToAttendees(undefined)).toBeUndefined();
    expect(sendUpdatesFor('false')).toBe('none');
    expect(sendUpdatesFor(undefined)).toBe('all');
  });

  test('conference data maps each provider shape', () => {
    expect(
      googleConferencingToNylas({
        id: 'z',
        conferenceData: {
          conferenceId: '98882755923',
          conferenceSolution: { name: 'Zoom Meeting', key: { type: 'addOn' } },
          entryPoints: [
            {
              entryPointType: 'video',
              uri: 'https://draftkings.zoom.us/j/98882755923?pwd=x',
              passcode: '504533',
            },
            { entryPointType: 'phone', uri: 'tel:+13126266799,,98882755923#' },
          ],
        },
      }),
    ).toEqual({
      provider: 'Zoom Meeting',
      details: {
        meetingCode: '98882755923',
        password: '504533',
        phone: ['tel:+13126266799,,98882755923#'],
        url: 'https://draftkings.zoom.us/j/98882755923?pwd=x',
      },
    });
    expect(
      googleConferencingToNylas({
        id: 't',
        conferenceData: {
          conferenceSolution: { name: 'Microsoft Teams Meeting' },
          entryPoints: [{ entryPointType: 'video', uri: 'https://teams.microsoft.com/l/meetup-join/1' }],
        },
      }),
    ).toEqual({
      provider: 'Microsoft Teams',
      details: { url: 'https://teams.microsoft.com/l/meetup-join/1' },
    });
    expect(
      googleConferencingToNylas({ id: 'h', hangoutLink: 'https://meet.google.com/abc-defg-hij' }),
    ).toEqual({
      provider: 'Google Meet',
      details: { meetingCode: 'abc-defg-hij', url: 'https://meet.google.com/abc-defg-hij' },
    });
    expect(
      googleConferencingToNylas({
        id: 'o',
        conferenceData: {
          conferenceSolution: { name: 'Other Call' },
          entryPoints: [{ entryPointType: 'more' }],
        },
      }),
    ).toEqual({ provider: 'Other Call', details: {} });
    expect(googleConferencingToNylas({ id: 'none' })).toBeUndefined();
  });

  test('meeting links come from the location first, then the description', () => {
    expect(
      conferencingFromText('https://teams.microsoft.com/l/meetup-join/19%3ameeting_X?a=1&amp;b=2.'),
    ).toEqual({
      provider: 'Microsoft Teams',
      details: { url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_X?a=1&b=2' },
    });
    expect(
      conferencingFromText(undefined, 'Join https://rit.zoom.us/my/room Meeting ID: 462 332 4450'),
    ).toEqual({
      provider: 'Zoom Meeting',
      details: { meetingCode: '4623324450', url: 'https://rit.zoom.us/my/room' },
    });
    expect(conferencingFromText('Room 4', 'https://acme.webex.com/meet/ann')).toEqual({
      provider: 'WebEx',
      details: { url: 'https://acme.webex.com/meet/ann' },
    });
    expect(conferencingFromText('https://meet.goto.com/123456789')).toEqual({
      provider: 'GoToMeeting',
      details: { url: 'https://meet.goto.com/123456789' },
    });
    expect(conferencingFromText('https://rit.zoom.us/my/room')).toEqual({
      provider: 'Zoom Meeting',
      details: { url: 'https://rit.zoom.us/my/room' },
    });
    expect(conferencingFromText('Room 4', 'no link')).toBeUndefined();
  });

  test('events map reminders, visibility, and an all-day original start', () => {
    const event = googleEventToNylas(
      {
        id: 'r1_20260811',
        recurringEventId: 'r1',
        originalStartTime: { date: '2026-08-11' },
        start: { date: '2026-08-11' },
        end: { date: '2026-08-12' },
        visibility: 'confidential',
        reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 30 }] },
        guestsCanSeeOtherGuests: false,
        extendedProperties: { private: {} },
      },
      { grantId: GRANT, calendarId: CAL },
    );
    expect(event).toMatchObject({
      originalStartTime: 1786406400,
      visibility: 'private',
      reminders: { useDefault: false, overrides: [{ reminderMinutes: 30, reminderMethod: 'email' }] },
      hideParticipants: true,
      readOnly: false,
    });
    expect(event.metadata).toBeUndefined();
    const plain = googleEventToNylas(
      { id: 'p', visibility: 'public', originalStartTime: {} },
      { grantId: GRANT, calendarId: CAL },
    );
    expect(plain.visibility).toBe('public');
    expect(plain.originalStartTime).toBeUndefined();
    expect(plain.when).toBeUndefined();
  });
});

describe('access role cache', () => {
  test('drops the oldest role when it is full', async () => {
    const g = google();
    const items = Array.from({ length: 2_001 }, (_, index) => ({
      id: `cal${index}@group.calendar.google.com`,
      summary: `Cal ${index}`,
      accessRole: 'reader',
    }));
    g.on('GET', /\/users\/me\/calendarList$/, { json: { items } });
    g.on('GET', /\/users\/me\/calendarList\/.+/, { json: { accessRole: 'owner' } });
    g.on('GET', /\/events\/.+/, { json: timedEvent });
    await adapter.calendars.list({ identifier: GRANT });
    const evicted = await adapter.events.find({
      identifier: GRANT,
      eventId: timedEvent.id,
      queryParams: { calendarId: 'cal0@group.calendar.google.com' },
    });
    // The first role left the cache, so the role is read again: owner.
    expect(evicted.data.readOnly).toBe(false);
    const kept = await adapter.events.find({
      identifier: GRANT,
      eventId: timedEvent.id,
      queryParams: { calendarId: 'cal2000@group.calendar.google.com' },
    });
    expect(kept.data.readOnly).toBe(true);
    expect(g.calls.filter((call) => /calendarList\/.+/.test(call.url.pathname))).toHaveLength(1);
  });
});
