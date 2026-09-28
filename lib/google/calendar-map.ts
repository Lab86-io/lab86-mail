// Direct Google transport: Google Calendar API v3 JSON to and from the Nylas v3
// SDK shapes that the calendar code reads (`toCalendarInput`, `toEventInput`,
// and the write paths in lib/calendar/mutate.ts).
//
// The rules copy what Nylas v3 returned for Google accounts, checked against
// stored production rows on 2026-09-28:
// - Ids are Google's own ids. A recurring instance is `<master>_<YYYYMMDDTHHMMSSZ>`,
//   and `masterEventId` is Google's `recurringEventId`.
// - A timed event is always a `timespan` (a zero-length event too). The zone is
//   Google's IANA zone; an offset zone such as "GMT-04:00" is dropped.
// - An all-day end date is exclusive, as in Google. One day is a `date`; more
//   days are a `datespan`.
// - `busy` is false only for a transparent event. `readOnly` is true on a
//   calendar that the user cannot write, and for an event that another person
//   organizes.
// - The organizer name is "" when Google has no display name. Participants are
//   all attendees (the user too), with status yes/no/maybe/noreply.

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  location?: string;
  timeZone?: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  deleted?: boolean;
}

export interface GoogleEventDateTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface GoogleAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  comment?: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
  optional?: boolean;
}

export interface GoogleEntryPoint {
  entryPointType?: string;
  uri?: string;
  label?: string;
  pin?: string;
  meetingCode?: string;
  passcode?: string;
  password?: string;
  accessCode?: string;
}

export interface GoogleConferenceData {
  conferenceId?: string;
  conferenceSolution?: { name?: string; key?: { type?: string } };
  entryPoints?: GoogleEntryPoint[];
  createRequest?: { requestId?: string; status?: { statusCode?: string } };
}

export interface GoogleEvent {
  id: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: { email?: string; displayName?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleEventDateTime;
  transparency?: string;
  visibility?: string;
  iCalUID?: string;
  attendees?: GoogleAttendee[];
  guestsCanSeeOtherGuests?: boolean;
  hangoutLink?: string;
  conferenceData?: GoogleConferenceData;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  reminders?: { useDefault?: boolean; overrides?: Array<{ method?: string; minutes?: number }> };
  eventType?: string;
}

const DAY_MS = 86_400_000;

/** An object type whose keys that can hold undefined become optional. */
export type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Removes keys whose value is undefined, so results compare cleanly. */
export function compact<T extends Record<string, unknown>>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Compact<T>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function isReadOnlyAccessRole(role: string | undefined): boolean {
  return role === 'reader' || role === 'freeBusyReader' || role === 'none';
}

/** A named IANA zone, or undefined. Offset zones ("GMT-04:00", "-04:00") do not count. */
export function ianaTimezone(value: unknown): string | undefined {
  const zone = text(value)?.trim();
  if (!zone || /^(?:GMT|UTC)?[+-]\d/i.test(zone)) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** Epoch seconds of an RFC 3339 value, or undefined. */
export function epochSeconds(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

/** RFC 3339 (UTC, no milliseconds) of epoch seconds. */
export function rfc3339FromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A YYYY-MM-DD date plus a number of days. */
export function addDays(date: string, days: number): string {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(start)) return date;
  return new Date(start + days * DAY_MS).toISOString().slice(0, 10);
}

// ---- Calendars --------------------------------------------------------------

export function googleCalendarToNylas(item: GoogleCalendarListEntry, grantId: string) {
  return compact({
    id: item.id,
    grantId,
    object: 'calendar',
    name: text(item.summaryOverride) || text(item.summary) || '',
    description: text(item.description),
    location: text(item.location),
    timezone: text(item.timeZone),
    isPrimary: item.primary === true,
    readOnly: isReadOnlyAccessRole(item.accessRole),
    isOwnedByUser: item.accessRole === 'owner',
    hexColor: text(item.backgroundColor),
    hexForegroundColor: text(item.foregroundColor),
  });
}

// ---- Events: Google to Nylas ------------------------------------------------

const PARTICIPANT_STATUS: Record<string, string> = {
  accepted: 'yes',
  declined: 'no',
  tentative: 'maybe',
  needsAction: 'noreply',
};

const RESPONSE_STATUS: Record<string, string> = {
  yes: 'accepted',
  no: 'declined',
  maybe: 'tentative',
  noreply: 'needsAction',
};

/** The Google attendee `responseStatus` for a Nylas RSVP or participant status. */
export function googleResponseStatus(status: unknown): string | undefined {
  return typeof status === 'string' ? RESPONSE_STATUS[status] : undefined;
}

const EVENT_STATUS: Record<string, string> = {
  confirmed: 'confirmed',
  tentative: 'maybe',
  cancelled: 'cancelled',
};

export function googleWhenToNylas(start?: GoogleEventDateTime, end?: GoogleEventDateTime) {
  const startTime = epochSeconds(start?.dateTime);
  if (startTime !== undefined) {
    const startTimezone = ianaTimezone(start?.timeZone);
    return compact({
      object: 'timespan',
      startTime,
      endTime: epochSeconds(end?.dateTime) ?? startTime,
      startTimezone,
      endTimezone: ianaTimezone(end?.timeZone) ?? startTimezone,
    });
  }
  const date = text(start?.date);
  if (!date) return undefined;
  const nextDay = addDays(date, 1);
  const endDate = text(end?.date);
  if (!endDate || endDate <= nextDay) return { object: 'date', date };
  return { object: 'datespan', startDate: date, endDate };
}

function participantFrom(attendee: GoogleAttendee) {
  return compact({
    email: text(attendee.email),
    name: text(attendee.displayName),
    status: PARTICIPANT_STATUS[attendee.responseStatus || ''] || 'noreply',
    comment: text(attendee.comment),
  });
}

// "Zoom Meeting" and "Microsoft Teams Meeting" also contain "meet", so Google
// Meet is the last test.
const CONFERENCE_PROVIDERS: Array<[RegExp, string]> = [
  [/zoom/i, 'Zoom Meeting'],
  [/teams/i, 'Microsoft Teams'],
  [/webex/i, 'WebEx'],
  [/goto/i, 'GoToMeeting'],
  [/meet|hangout/i, 'Google Meet'],
];

function conferenceProvider(name?: string, type?: string): string {
  const label = `${name || ''} ${type || ''}`;
  for (const [pattern, provider] of CONFERENCE_PROVIDERS) if (pattern.test(label)) return provider;
  return name || 'Google Meet';
}

// Meeting links in the location or the description. Nylas reads links from
// event text for events without conference data (invitations from Zoom or
// Teams, imported calendars), so the join button stays.
const TEXT_CONFERENCE_LINKS: Array<[RegExp, string]> = [
  [/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i, 'Google Meet'],
  [/https:\/\/[\w.-]*zoom\.us\/(?:j|my|w|s)\/[^\s"'<>)\]]+/i, 'Zoom Meeting'],
  [/https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)\]]+/i, 'Microsoft Teams'],
  [/https:\/\/[\w-]+\.webex\.com\/[^\s"'<>)\]]+/i, 'WebEx'],
  [
    /https:\/\/(?:global|app)\.gotomeeting\.com\/[^\s"'<>)\]]+|https:\/\/meet\.goto\.com\/[^\s"'<>)\]]+/i,
    'GoToMeeting',
  ],
];

function meetingCodeFrom(url: string, provider: string, body: string): string | undefined {
  if (provider === 'Google Meet') return url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1];
  if (provider !== 'Zoom Meeting') return undefined;
  const fromUrl = url.match(/\/j\/(\d{6,})/)?.[1];
  if (fromUrl) return fromUrl;
  const fromText = body.match(/Meeting ID:?\s*([\d ]{9,})/i)?.[1];
  return fromText ? fromText.replace(/\s+/g, '') : undefined;
}

export function conferencingFromText(...parts: Array<string | undefined>) {
  for (const part of parts) {
    const body = (part || '').replaceAll('&amp;', '&');
    if (!body) continue;
    for (const [pattern, provider] of TEXT_CONFERENCE_LINKS) {
      const match = body.match(pattern)?.[0];
      if (!match) continue;
      const url = match.replace(/[.,;:!?]+$/, '');
      return { provider, details: compact({ meetingCode: meetingCodeFrom(url, provider, body), url }) };
    }
  }
  return undefined;
}

export function googleConferencingToNylas(event: GoogleEvent) {
  const data = event.conferenceData;
  const points = data?.entryPoints || [];
  if (points.length) {
    const video = points.find((point) => point.entryPointType === 'video');
    const phones = points.filter((point) => point.entryPointType === 'phone');
    const phoneUris = phones.map((point) => text(point.uri)).filter((uri): uri is string => Boolean(uri));
    return {
      provider: conferenceProvider(data?.conferenceSolution?.name, data?.conferenceSolution?.key?.type),
      details: compact({
        meetingCode: text(data?.conferenceId) || text(video?.meetingCode),
        password: text(video?.password) || text(video?.passcode),
        phone: phoneUris.length ? phoneUris : undefined,
        pin: text(phones.find((point) => point.pin)?.pin),
        url: text(video?.uri),
      }),
    };
  }
  if (data?.createRequest) {
    return {
      provider: conferenceProvider(data.conferenceSolution?.name, data.conferenceSolution?.key?.type),
      autocreate: {},
    };
  }
  if (event.hangoutLink) {
    return {
      provider: 'Google Meet',
      details: compact({
        meetingCode: meetingCodeFrom(event.hangoutLink, 'Google Meet', ''),
        url: event.hangoutLink,
      }),
    };
  }
  return conferencingFromText(event.location, event.description);
}

function remindersFrom(reminders: GoogleEvent['reminders']) {
  if (!reminders) return undefined;
  return {
    useDefault: reminders.useDefault === true,
    overrides: (reminders.overrides || []).map((item) =>
      compact({ reminderMinutes: item.minutes, reminderMethod: item.method }),
    ),
  };
}

function visibilityFrom(value: string | undefined) {
  if (value === 'public') return 'public';
  if (value === 'private' || value === 'confidential') return 'private';
  return 'default';
}

function originalStartSeconds(value: GoogleEventDateTime | undefined): number | undefined {
  if (!value) return undefined;
  const timed = epochSeconds(value.dateTime);
  if (timed !== undefined) return timed;
  const date = text(value.date);
  return date ? epochSeconds(`${date}T00:00:00Z`) : undefined;
}

export interface EventMapContext {
  grantId: string;
  calendarId: string;
  /** The user's access role on the calendar, when known. */
  accessRole?: string;
}

/** One Google event in the Nylas v3 SDK shape (camelCase). */
export function googleEventToNylas(event: GoogleEvent, context: EventMapContext) {
  const organizer = text(event.organizer?.email)
    ? { email: event.organizer!.email as string, name: event.organizer?.displayName ?? '' }
    : undefined;
  const creator = text(event.creator?.email)
    ? compact({ email: event.creator!.email as string, name: text(event.creator?.displayName) })
    : undefined;
  const metadata = event.extendedProperties?.private;
  return compact({
    id: event.id,
    grantId: context.grantId,
    object: 'event',
    calendarId: context.calendarId,
    title: text(event.summary),
    description: text(event.description),
    location: text(event.location),
    when: googleWhenToNylas(event.start, event.end),
    busy: event.transparency !== 'transparent',
    status: EVENT_STATUS[event.status || ''] ?? text(event.status),
    readOnly:
      isReadOnlyAccessRole(context.accessRole) || (event.organizer ? event.organizer.self !== true : false),
    participants: (event.attendees || []).map(participantFrom),
    organizer,
    creator,
    recurrence: Array.isArray(event.recurrence) ? event.recurrence : undefined,
    masterEventId: text(event.recurringEventId),
    originalStartTime: originalStartSeconds(event.originalStartTime),
    icalUid: text(event.iCalUID),
    htmlLink: text(event.htmlLink),
    conferencing: googleConferencingToNylas(event),
    reminders: remindersFrom(event.reminders),
    visibility: visibilityFrom(event.visibility),
    hideParticipants: event.guestsCanSeeOtherGuests === false ? true : undefined,
    metadata: metadata && Object.keys(metadata).length ? { ...metadata } : undefined,
    createdAt: epochSeconds(event.created),
    updatedAt: epochSeconds(event.updated),
  });
}

// ---- Events: Nylas to Google ------------------------------------------------

/**
 * A Nylas `when` as Google `start` and `end`. With `patch`, the other kind of
 * time is set to null, so a PATCH can turn an all-day event into a timed one.
 */
export function nylasWhenToGoogle(
  when: any,
  { patch = false }: { patch?: boolean } = {},
): { start: GoogleEventDateTime; end: GoogleEventDateTime } | undefined {
  if (!when || typeof when !== 'object') return undefined;
  const timed = (seconds: number, zone: unknown): GoogleEventDateTime =>
    compact({
      dateTime: rfc3339FromSeconds(seconds),
      timeZone: text(zone) ?? (patch ? null : undefined),
      date: patch ? null : undefined,
    });
  const allDay = (date: string): GoogleEventDateTime =>
    compact({ date, dateTime: patch ? null : undefined, timeZone: patch ? null : undefined });

  const startTime = Number(when.startTime ?? when.start_time);
  if (Number.isFinite(startTime) && startTime > 0) {
    const endTime = Number(when.endTime ?? when.end_time);
    const startZone = when.startTimezone ?? when.start_timezone;
    return {
      start: timed(startTime, startZone),
      end: timed(
        Number.isFinite(endTime) && endTime > 0 ? endTime : startTime,
        when.endTimezone ?? when.end_timezone ?? startZone,
      ),
    };
  }
  const time = Number(when.time);
  if (Number.isFinite(time) && time > 0) {
    return { start: timed(time, when.timezone), end: timed(time, when.timezone) };
  }
  const date = text(when.date);
  if (date) return { start: allDay(date), end: allDay(addDays(date, 1)) };
  const startDate = text(when.startDate ?? when.start_date);
  if (startDate) {
    const endDate = text(when.endDate ?? when.end_date);
    return {
      start: allDay(startDate),
      end: allDay(endDate && endDate > startDate ? endDate : addDays(startDate, 1)),
    };
  }
  return undefined;
}

/**
 * Nylas participants as Google attendees. An attendee that the event already
 * has keeps its Google fields (response status, organizer and resource flags);
 * a new one starts with no response.
 */
export function participantsToAttendees(participants: unknown, current: GoogleAttendee[] = []) {
  if (!Array.isArray(participants)) return undefined;
  const byEmail = new Map(
    current.filter((item) => item.email).map((item) => [String(item.email).toLowerCase(), item]),
  );
  const out: GoogleAttendee[] = [];
  const seen = new Set<string>();
  for (const participant of participants) {
    const email = text(participant?.email)?.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    const existing = byEmail.get(email.toLowerCase());
    const name = text(participant?.name);
    if (existing) out.push(compact({ ...existing, displayName: name ?? existing.displayName }));
    else out.push(compact({ email, displayName: name }));
  }
  return out;
}

/** True when a Nylas request body asks Google to create a conference. */
export function wantsConferenceCreate(body: any): boolean {
  return Boolean(body?.conferencing && typeof body.conferencing === 'object' && body.conferencing.autocreate);
}

/**
 * A Nylas create or update body as a Google event resource. Only the fields
 * that the body sets are in the result, so it also serves as a PATCH body.
 */
export function nylasEventBodyToGoogle(
  body: any,
  { patch = false, currentAttendees = [] }: { patch?: boolean; currentAttendees?: GoogleAttendee[] } = {},
) {
  const input = body && typeof body === 'object' ? body : {};
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.summary = input.title;
  if (input.description !== undefined) out.description = input.description;
  if (input.location !== undefined) out.location = input.location;
  if (typeof input.busy === 'boolean') out.transparency = input.busy ? 'opaque' : 'transparent';
  const when = nylasWhenToGoogle(input.when, { patch });
  if (when) Object.assign(out, when);
  const attendees = participantsToAttendees(input.participants, currentAttendees);
  if (attendees) out.attendees = attendees;
  if (Array.isArray(input.recurrence)) out.recurrence = input.recurrence.map(String);
  if (input.metadata && typeof input.metadata === 'object') {
    out.extendedProperties = {
      private: Object.fromEntries(
        Object.entries(input.metadata)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)]),
      ),
    };
  }
  if (wantsConferenceCreate(input)) {
    out.conferenceData = {
      createRequest: {
        requestId: globalThis.crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }
  if (input.reminders && typeof input.reminders === 'object') {
    out.reminders = {
      useDefault: input.reminders.useDefault === true,
      overrides: (input.reminders.overrides || []).map((item: any) =>
        compact({ method: item?.reminderMethod, minutes: item?.reminderMinutes }),
      ),
    };
  }
  if (input.visibility === 'public' || input.visibility === 'private') out.visibility = input.visibility;
  else if (input.visibility === 'default') out.visibility = 'default';
  if (typeof input.hideParticipants === 'boolean') out.guestsCanSeeOtherGuests = !input.hideParticipants;
  return out;
}

/** Google `sendUpdates` for the Nylas `notifyParticipants` flag (default: notify). */
export function sendUpdatesFor(notifyParticipants: unknown): 'all' | 'none' {
  return notifyParticipants === false || notifyParticipants === 'false' ? 'none' : 'all';
}
