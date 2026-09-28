import {
  compact,
  type GoogleAttendee,
  type GoogleCalendarListEntry,
  type GoogleEvent,
  googleCalendarToNylas,
  googleEventToNylas,
  googleResponseStatus,
  nylasEventBodyToGoogle,
  rfc3339FromSeconds,
  sendUpdatesFor,
  wantsConferenceCreate,
} from '../calendar-map';
import { CALENDAR_API, GoogleApiError, type GoogleRequestInit, googleJson, googleUrl } from '../http';
import type { GoogleNylasAdapter } from './types';

// Google Calendar: calendars and events, with the argument and result shapes
// of the Nylas SDK (see lib/google/calendar-map.ts for the field rules).
//
// `calendars.destroy` removes the calendar from the user's calendar list
// (calendarList.delete). It never deletes a calendar: the tool that calls it
// is "unsubscribe". Nylas deleted a secondary calendar that the user owned.

// Calendar API answers some rate limits with 403, not 429. The callers treat a
// 403 as a missing scope, so these become a 429 that they retry.
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

function asRateLimit(err: unknown): unknown {
  if (err instanceof GoogleApiError && err.statusCode === 403 && RATE_LIMIT_REASONS.has(err.reason || '')) {
    return new GoogleApiError(429, err.message, err.reason);
  }
  return err;
}

function requestId() {
  return globalThis.crypto.randomUUID();
}

function grantOf(args: any): string {
  const grantId = args?.identifier ?? args?.grantId;
  if (typeof grantId !== 'string' || !grantId) throw new GoogleApiError(400, 'A grant id is required.');
  return grantId;
}

function calendarIdOf(args: any): string {
  const id = args?.calendarId ?? args?.queryParams?.calendarId ?? args?.queryParams?.calendar_id;
  return typeof id === 'string' && id ? id : 'primary';
}

function eventIdOf(args: any): string {
  const id = args?.eventId;
  if (typeof id !== 'string' || !id) throw new GoogleApiError(400, 'An event id is required.');
  return id;
}

/** The SDK `overrides.timeout` (seconds) as an abort signal. */
function timeoutInit(overrides: any): Pick<GoogleRequestInit, 'signal'> {
  const seconds = Number(overrides?.timeout);
  return Number.isFinite(seconds) && seconds > 0 ? { signal: AbortSignal.timeout(seconds * 1000) } : {};
}

async function call<T>(grantId: string, url: string, init: GoogleRequestInit = {}): Promise<T> {
  try {
    return await googleJson<T>(grantId, url, init);
  } catch (err) {
    throw asRateLimit(err);
  }
}

function calendarListUrl(calendarId?: string) {
  const base = `${CALENDAR_API}/users/me/calendarList`;
  return calendarId ? `${base}/${encodeURIComponent(calendarId)}` : base;
}

function eventsUrl(calendarId: string, eventId?: string) {
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

// ---- Access roles -------------------------------------------------------------

// The user's role on each calendar decides `readOnly` for its events. A list
// call gives it; a single event read looks it up once.
const ACCESS_ROLE_CACHE_LIMIT = 2_000;
const accessRoles = new Map<string, string>();

function roleKey(grantId: string, calendarId: string) {
  return `${grantId}\n${calendarId}`;
}

function rememberAccessRole(grantId: string, calendarId: string, role: unknown) {
  if (typeof role !== 'string' || !role) return;
  const key = roleKey(grantId, calendarId);
  accessRoles.delete(key);
  accessRoles.set(key, role);
  if (accessRoles.size > ACCESS_ROLE_CACHE_LIMIT) {
    accessRoles.delete(accessRoles.keys().next().value as string);
  }
}

async function accessRoleFor(grantId: string, calendarId: string): Promise<string | undefined> {
  const cached = accessRoles.get(roleKey(grantId, calendarId));
  if (cached) return cached;
  try {
    const entry = await call<GoogleCalendarListEntry>(grantId, calendarListUrl(calendarId));
    rememberAccessRole(grantId, calendarId, entry?.accessRole);
    return entry?.accessRole;
  } catch {
    // The role only refines `readOnly`; the event read does not depend on it.
    return undefined;
  }
}

export function __resetCalendarAdapterCacheForTest() {
  accessRoles.clear();
}

// ---- Calendars ----------------------------------------------------------------

async function listCalendars(args: any) {
  const grantId = grantOf(args);
  const query = args?.queryParams || {};
  const page = await call<{ items?: GoogleCalendarListEntry[]; nextPageToken?: string }>(
    grantId,
    googleUrl(calendarListUrl(), { maxResults: query.limit, pageToken: query.pageToken }),
  );
  const items = (page?.items || []).filter((item) => item?.id && !item.deleted);
  for (const item of items) rememberAccessRole(grantId, item.id, item.accessRole);
  return compact({
    data: items.map((item) => googleCalendarToNylas(item, grantId)),
    requestId: requestId(),
    nextCursor: page?.nextPageToken || undefined,
  });
}

async function findCalendar(args: any) {
  const grantId = grantOf(args);
  const calendarId = calendarIdOf(args);
  const entry = await call<GoogleCalendarListEntry>(
    grantId,
    calendarListUrl(calendarId),
    timeoutInit(args?.overrides),
  );
  rememberAccessRole(grantId, entry.id, entry.accessRole);
  return { data: googleCalendarToNylas(entry, grantId), requestId: requestId() };
}

async function destroyCalendar(args: any) {
  const grantId = grantOf(args);
  const calendarId = calendarIdOf(args);
  await call(grantId, calendarListUrl(calendarId), { method: 'DELETE', ...timeoutInit(args?.overrides) });
  accessRoles.delete(roleKey(grantId, calendarId));
  return { requestId: requestId() };
}

// ---- Events -------------------------------------------------------------------

function secondsParam(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) throw new GoogleApiError(400, `Invalid time value: ${String(value)}.`);
  return rfc3339FromSeconds(seconds);
}

function metadataFilters(pair: unknown): string[] | undefined {
  if (!pair || typeof pair !== 'object') return undefined;
  const filters = Object.entries(pair as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);
  return filters.length ? filters : undefined;
}

async function listEvents(args: any) {
  const grantId = grantOf(args);
  const query = args?.queryParams || {};
  const calendarId = calendarIdOf(args);
  const expand = query.expandRecurring === true || query.expandRecurring === 'true';
  const eventTypes = Array.isArray(query.eventType) ? query.eventType : undefined;
  const page = await call<{ items?: GoogleEvent[]; nextPageToken?: string; accessRole?: string }>(
    grantId,
    googleUrl(eventsUrl(calendarId), {
      timeMin: secondsParam(query.start),
      timeMax: secondsParam(query.end),
      singleEvents: expand ? 'true' : undefined,
      orderBy: expand && query.orderBy === 'start' ? 'startTime' : undefined,
      maxResults: query.limit,
      pageToken: query.pageToken,
      showDeleted: query.showCancelled ? 'true' : undefined,
      updatedMin: secondsParam(query.updatedAfter),
      privateExtendedProperty: metadataFilters(query.metadataPair),
      eventTypes,
    }),
    timeoutInit(args?.overrides),
  );
  rememberAccessRole(grantId, calendarId, page?.accessRole);
  const role = page?.accessRole ?? accessRoles.get(roleKey(grantId, calendarId));
  // A working-location event marks where the user works each day. It is not a
  // meeting, so it stays out unless the caller asks for that type.
  const items = (page?.items || []).filter(
    (event) => event?.id && (eventTypes || event.eventType !== 'workingLocation'),
  );
  return compact({
    data: items.map((event) => googleEventToNylas(event, { grantId, calendarId, accessRole: role })),
    requestId: requestId(),
    nextCursor: page?.nextPageToken || undefined,
  });
}

async function readEvent(grantId: string, calendarId: string, eventId: string, init: GoogleRequestInit = {}) {
  return await call<GoogleEvent>(grantId, eventsUrl(calendarId, eventId), init);
}

async function findEvent(args: any) {
  const grantId = grantOf(args);
  const calendarId = calendarIdOf(args);
  const event = await readEvent(grantId, calendarId, eventIdOf(args), timeoutInit(args?.overrides));
  const accessRole = await accessRoleFor(grantId, calendarId);
  return { data: googleEventToNylas(event, { grantId, calendarId, accessRole }), requestId: requestId() };
}

async function createEvent(args: any) {
  const grantId = grantOf(args);
  const calendarId = calendarIdOf(args);
  const query = args?.queryParams || {};
  const body = nylasEventBodyToGoogle(args?.requestBody);
  const created = await call<GoogleEvent>(
    grantId,
    googleUrl(eventsUrl(calendarId), {
      sendUpdates: sendUpdatesFor(query.notifyParticipants),
      conferenceDataVersion: wantsConferenceCreate(args?.requestBody) ? 1 : undefined,
    }),
    { method: 'POST', json: body, ...timeoutInit(args?.overrides) },
  );
  return {
    data: googleEventToNylas(created, {
      grantId,
      calendarId,
      accessRole: accessRoles.get(roleKey(grantId, calendarId)),
    }),
    requestId: requestId(),
  };
}

async function updateEvent(args: any) {
  const grantId = grantOf(args);
  const calendarId = calendarIdOf(args);
  const eventId = eventIdOf(args);
  const query = args?.queryParams || {};
  const init = timeoutInit(args?.overrides);
  // A participant edit keeps the Google fields (response status, organizer)
  // of the attendees that stay, so the current list is read first.
  let currentAttendees: GoogleAttendee[] = [];
  if (Array.isArray(args?.requestBody?.participants)) {
    currentAttendees = (await readEvent(grantId, calendarId, eventId, init)).attendees || [];
  }
  const body = nylasEventBodyToGoogle(args?.requestBody, { patch: true, currentAttendees });
  const updated = await call<GoogleEvent>(
    grantId,
    googleUrl(eventsUrl(calendarId, eventId), {
      sendUpdates: sendUpdatesFor(query.notifyParticipants),
      conferenceDataVersion: wantsConferenceCreate(args?.requestBody) ? 1 : undefined,
    }),
    { method: 'PATCH', json: body, ...init },
  );
  return {
    data: googleEventToNylas(updated, {
      grantId,
      calendarId,
      accessRole: accessRoles.get(roleKey(grantId, calendarId)),
    }),
    requestId: requestId(),
  };
}

async function destroyEvent(args: any) {
  const grantId = grantOf(args);
  const query = args?.queryParams || {};
  await call(
    grantId,
    googleUrl(eventsUrl(calendarIdOf(args), eventIdOf(args)), {
      sendUpdates: sendUpdatesFor(query.notifyParticipants),
    }),
    { method: 'DELETE', ...timeoutInit(args?.overrides) },
  );
  return { requestId: requestId() };
}

async function sendRsvp(args: any) {
  const grantId = grantOf(args);
  const calendarId = calendarIdOf(args);
  const eventId = eventIdOf(args);
  const responseStatus = googleResponseStatus(args?.requestBody?.status);
  if (!responseStatus || responseStatus === 'needsAction') {
    throw new GoogleApiError(400, 'An RSVP status must be yes, no, or maybe.');
  }
  const init = timeoutInit(args?.overrides);
  const event = await readEvent(grantId, calendarId, eventId, init);
  const attendees = event.attendees || [];
  const ownEmail = calendarId.toLowerCase();
  let index = attendees.findIndex((attendee) => attendee.self === true);
  if (index < 0) index = attendees.findIndex((attendee) => attendee.email?.toLowerCase() === ownEmail);
  if (index < 0) throw new GoogleApiError(400, 'The account is not a participant of this event.');
  const next = attendees.map((attendee, position) =>
    position === index ? { ...attendee, responseStatus } : attendee,
  );
  await call<GoogleEvent>(
    grantId,
    googleUrl(eventsUrl(calendarId, eventId), {
      sendUpdates: sendUpdatesFor(args?.queryParams?.notifyParticipants),
    }),
    { method: 'PATCH', json: { attendees: next }, ...init },
  );
  return { requestId: requestId() };
}

export const googleCalendarAdapter: GoogleNylasAdapter = {
  calendars: {
    list: listCalendars,
    find: findCalendar,
    destroy: destroyCalendar,
  },
  events: {
    list: listEvents,
    find: findEvent,
    create: createEvent,
    update: updateEvent,
    destroy: destroyEvent,
    sendRsvp,
  },
};
