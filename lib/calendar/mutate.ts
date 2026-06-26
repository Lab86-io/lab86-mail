import { recordOperation, registerUndoExecutor } from '@/lib/ai/operations';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireNylas } from '@/lib/nylas/client';
import { type NylasAccountRow, requireConnectedAccount } from '@/lib/nylas/provider';
import {
  describeNylasError,
  isNylasResponseParseError,
  nylasErrorStatus,
  withNylasRetry,
} from '@/lib/nylas/retry';
import { type EventInputRow, toEventInput } from './sync';

const calendarApi = (api as any).calendarData;
const CREATE_REQUEST_ID_KEY = 'lab86CreateRequestId';
const DEFAULT_CALENDAR_WRITE_TIMEOUT_SECONDS = 20;

// Calendar writes go provider-first (Nylas), then mirror into Convex so the
// surface updates without waiting for the webhook echo. Every mutation
// records an aiOperation with a declarative inverse — the act-then-undo
// contract from docs/productivity-platform-spec.md.

export interface CreateEventInput {
  userId: string;
  accountId: string;
  calendarId?: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  description?: string;
  location?: string;
  participants?: Array<{ email: string; name?: string }>;
  recurrence?: string[];
  busy?: boolean;
  // IANA timezone the naive start/end were interpreted in. Google rejects /
  // mis-places timed events without it, so it's stamped on the Nylas `when`.
  timezone?: string;
  // Whether the provider emails participants. Callers must confirm with the
  // user before passing participants at all (spec: outward-facing confirms).
  notifyParticipants?: boolean;
}

export interface UpdateEventPatch {
  title?: string;
  startAt?: number;
  endAt?: number;
  allDay?: boolean;
  description?: string;
  location?: string;
  participants?: Array<{ email: string; name?: string }>;
  busy?: boolean;
  recurrence?: string[];
}

export interface UnsubscribeCalendarInput {
  userId: string;
  accountId: string;
  calendarId: string;
  fallbackToHide?: boolean;
}

export async function createCalendarEvent(input: CreateEventInput) {
  const account = await getAccount(input.userId, input.accountId);
  const accountId = account.accountId;
  // Resolve to a calendar this account can actually WRITE to. A requested
  // calendar is honored only if it belongs to this account AND is not read-only
  // — agents frequently pass a read-only/subscribed calendar id (holidays,
  // shared, birthdays) from calendar_list_events, and the provider answers with
  // an opaque "Bad Request". Otherwise fall back to the account's primary
  // writable calendar. This is the "some calendars work, some don't" bug.
  let calendarId = input.calendarId;
  if (calendarId) {
    const calendars = await convexQuery<any[]>(calendarApi.listCalendars, { userId: input.userId });
    const target = (calendars || []).find(
      (cal) => cal.accountId === accountId && cal.providerCalendarId === calendarId,
    );
    if (!target || target.readOnly) {
      calendarId = await getPrimaryCalendarId(input.userId, accountId);
    }
  } else {
    calendarId = await getPrimaryCalendarId(input.userId, accountId);
  }

  let created: any;
  const createRequestId = newCreateRequestId();
  const requestBody = {
    title: input.title,
    description: input.description,
    location: input.location,
    busy: input.busy ?? true,
    when: toNylasWhen(input.startAt, input.endAt, input.allDay, input.timezone),
    participants: input.participants?.map((p) => ({ email: p.email, name: p.name })),
    recurrence: input.recurrence,
    metadata: {
      [CREATE_REQUEST_ID_KEY]: createRequestId,
      lab86CreatedBy: 'lab86-mail',
    },
  } as any;
  try {
    const response = await requireNylas().events.create({
      identifier: account.grantId,
      requestBody,
      queryParams: {
        calendarId,
        notifyParticipants: input.notifyParticipants ?? Boolean(input.participants?.length),
      } as any,
      overrides: calendarWriteOverrides(),
    });
    created = response.data as any;
  } catch (err: any) {
    if (isAmbiguousCreateError(err)) {
      const recovered = await recoverCreatedEventByMetadata(account.grantId, calendarId, createRequestId);
      if (recovered) {
        console.warn(
          `[calendar] recovered created event after ambiguous response account=${accountId} provider=${account.provider} calendar=${calendarId} event=${recovered.id}`,
        );
        created = recovered;
      }
    }
    if (!created) {
      const providerError = describeNylasError(err);
      console.error(
        `[calendar] create failed account=${accountId} provider=${account.provider} calendar=${calendarId}: ${providerError}`,
      );
      throw new Error(
        `Couldn't create the event on ${account.email || accountId} (${providerError}). The calendar may be read-only, or the account may need reconnecting.`,
      );
    }
  }
  if (!created?.id) {
    throw new Error(
      `Couldn't create the event on ${account.email || accountId}: provider returned no event id.`,
    );
  }
  const row = toEventInput(created, calendarId);
  if (row) await upsertMirror(account, [row]);

  const operationId = await recordOperation({
    userId: input.userId,
    tool: 'calendar_create_event',
    surface: 'calendar',
    summary: `Created "${input.title}" on ${new Date(input.startAt).toLocaleString()}`,
    target: { kind: 'calendarEvent', id: created.id, accountId, calendarId },
    inverse: {
      kind: 'calendar.delete_event',
      payload: { accountId, calendarId, eventId: created.id },
    },
  });
  return { eventId: created.id as string, calendarId, operationId, htmlLink: row?.htmlLink };
}

async function recoverCreatedEventByMetadata(grantId: string, calendarId: string, requestId: string) {
  for (const delayMs of [500, 1500, 3000]) {
    await sleep(delayMs);
    try {
      const page = await withNylasRetry(
        () =>
          requireNylas().events.list({
            identifier: grantId,
            queryParams: {
              calendarId,
              metadataPair: { [CREATE_REQUEST_ID_KEY]: requestId },
              limit: 10,
            } as any,
            overrides: calendarWriteOverrides(),
          }),
        1,
      );
      const match = (page.data || []).find(
        (event: any) => event?.metadata?.[CREATE_REQUEST_ID_KEY] === requestId,
      );
      if (match) return match;
    } catch (err: any) {
      console.warn(`[calendar] create recovery lookup failed: ${describeNylasError(err)}`);
    }
  }
  return null;
}

function isAmbiguousCreateError(err: any): boolean {
  const status = nylasErrorStatus(err);
  return isNylasResponseParseError(err) || status === undefined || status >= 500;
}

function calendarWriteOverrides() {
  const timeout = Number(process.env.NYLAS_CALENDAR_WRITE_TIMEOUT_SECONDS);
  return {
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CALENDAR_WRITE_TIMEOUT_SECONDS,
  };
}

function newCreateRequestId() {
  return (
    globalThis.crypto?.randomUUID?.().replaceAll('-', '') ||
    `cal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calendarMutationError(account: NylasAccountRow, err: any, action: string) {
  const providerError = describeNylasError(err);
  return new Error(
    `Couldn't ${action} on ${account.email || account.accountId} (${providerError}). The account may need reconnecting, or the provider may be temporarily unavailable.`,
  );
}

export async function updateCalendarEvent(input: {
  userId: string;
  accountId: string;
  calendarId: string;
  eventId: string;
  patch: UpdateEventPatch;
  notifyParticipants?: boolean;
}) {
  const account = await getAccount(input.userId, input.accountId);
  const accountId = account.accountId;
  const previous = await getMirrorEvent(input.userId, accountId, input.eventId, input.calendarId);
  const requestBody: Record<string, unknown> = {};
  if (input.patch.title !== undefined) requestBody.title = input.patch.title;
  if (input.patch.description !== undefined) requestBody.description = input.patch.description;
  if (input.patch.location !== undefined) requestBody.location = input.patch.location;
  if (input.patch.busy !== undefined) requestBody.busy = input.patch.busy;
  if (input.patch.recurrence !== undefined) requestBody.recurrence = input.patch.recurrence;
  if (input.patch.participants !== undefined) {
    requestBody.participants = input.patch.participants.map((p) => ({ email: p.email, name: p.name }));
  }
  if (input.patch.startAt !== undefined || input.patch.endAt !== undefined) {
    const startAt = input.patch.startAt ?? previous?.startAt;
    const endAt = input.patch.endAt ?? previous?.endAt;
    if (!startAt || !endAt) throw new Error('Event times unknown; sync the calendar first.');
    requestBody.when = toNylasWhen(startAt, endAt, input.patch.allDay ?? previous?.allDay);
  }
  let response: any;
  try {
    response = await withNylasRetry(
      () =>
        requireNylas().events.update({
          identifier: account.grantId,
          eventId: input.eventId,
          requestBody: requestBody as any,
          queryParams: {
            calendarId: input.calendarId,
            notifyParticipants: input.notifyParticipants ?? false,
          } as any,
          overrides: calendarWriteOverrides(),
        }),
      input.notifyParticipants ? 0 : 1,
    );
  } catch (err: any) {
    throw calendarMutationError(account, err, 'update the event');
  }
  const updated = toEventInput(response.data as any, input.calendarId);
  if (updated) await upsertMirror(account, [updated]);

  const summaryBits = Object.keys(input.patch).join(', ');
  const operationId = await recordOperation({
    userId: input.userId,
    tool: 'calendar_update_event',
    surface: 'calendar',
    summary: `Updated ${summaryBits} of "${updated?.title || previous?.title || input.eventId}"`,
    target: {
      kind: 'calendarEvent',
      id: input.eventId,
      accountId,
      calendarId: input.calendarId,
    },
    inverse: previous
      ? {
          kind: 'calendar.restore_event',
          payload: {
            accountId,
            calendarId: input.calendarId,
            eventId: input.eventId,
            fields: {
              title: previous.title,
              description: previous.description,
              location: previous.location,
              busy: previous.busy,
              startAt: previous.startAt,
              endAt: previous.endAt,
              allDay: previous.allDay,
              participants: previous.participants,
              recurrence: previous.recurrence,
            },
          },
        }
      : undefined,
  });
  return { ok: true, operationId };
}

export async function deleteCalendarEvent(input: {
  userId: string;
  accountId: string;
  calendarId: string;
  eventId: string;
  notifyParticipants?: boolean;
  deleteSeries?: boolean;
}) {
  const account = await getAccount(input.userId, input.accountId);
  const accountId = account.accountId;
  const previous = await getMirrorEvent(input.userId, accountId, input.eventId, input.calendarId);
  const eventId = input.deleteSeries && previous?.masterEventId ? previous.masterEventId : input.eventId;
  const previousTarget =
    eventId === input.eventId
      ? previous
      : await getMirrorEvent(input.userId, accountId, eventId, input.calendarId);
  try {
    await withNylasRetry(
      () =>
        requireNylas().events.destroy({
          identifier: account.grantId,
          eventId,
          queryParams: {
            calendarId: input.calendarId,
            notifyParticipants: input.notifyParticipants ?? false,
          } as any,
          overrides: calendarWriteOverrides(),
        }),
      input.notifyParticipants ? 0 : 1,
    );
  } catch (err: any) {
    if (nylasErrorStatus(err) !== 404 && nylasErrorStatus(err) !== 410) {
      throw calendarMutationError(account, err, 'delete the event');
    }
  }
  await convexMutation(calendarApi.deleteEvent, {
    userId: input.userId,
    accountId,
    providerCalendarId: input.calendarId,
    providerEventId: eventId,
    includeInstances: true,
  });
  const inverseSource = previousTarget || previous;

  const operationId = await recordOperation({
    userId: input.userId,
    tool: 'calendar_delete_event',
    surface: 'calendar',
    summary: `Deleted "${previousTarget?.title || previous?.title || eventId}"`,
    target: {
      kind: 'calendarEvent',
      id: eventId,
      accountId,
      calendarId: input.calendarId,
    },
    // Recreation mints a new provider id, but restores the substance.
    inverse: inverseSource
      ? {
          kind: 'calendar.recreate_event',
          payload: {
            accountId,
            calendarId: input.calendarId,
            fields: {
              title: inverseSource.title,
              description: inverseSource.description,
              location: inverseSource.location,
              busy: inverseSource.busy,
              startAt: inverseSource.startAt,
              endAt: inverseSource.endAt,
              allDay: inverseSource.allDay,
              participants: inverseSource.participants,
              recurrence: inverseSource.recurrence,
            },
          },
        }
      : undefined,
  });
  return { ok: true, operationId };
}

export async function unsubscribeCalendar(input: UnsubscribeCalendarInput) {
  const account = await getAccount(input.userId, input.accountId);
  const accountId = account.accountId;
  let providerUnsubscribed = false;
  let providerError: string | undefined;
  try {
    await withNylasRetry(
      () =>
        requireNylas().calendars.destroy({
          identifier: account.grantId,
          calendarId: input.calendarId,
          overrides: calendarWriteOverrides(),
        }),
      1,
    );
    providerUnsubscribed = true;
  } catch (err: any) {
    const status = nylasErrorStatus(err);
    if (status === 404 || status === 410) {
      // Provider already has no such calendar — the desired terminal state is
      // reached, so treat it as a successful unsubscribe (matches the event
      // delete path, which also suppresses 404/410).
      providerUnsubscribed = true;
    } else {
      providerError = describeNylasError(err, 'Provider calendar delete/unsubscribe failed.');
      if (!input.fallbackToHide) throw calendarMutationError(account, err, 'delete/unsubscribe the calendar');
    }
  }

  if (providerUnsubscribed) {
    await convexMutation(calendarApi.removeCalendar, {
      userId: input.userId,
      accountId,
      providerCalendarId: input.calendarId,
    });
  } else {
    await convexMutation(calendarApi.setCalendarHiddenInternal, {
      userId: input.userId,
      accountId,
      providerCalendarId: input.calendarId,
      hidden: true,
    });
  }

  return {
    ok: true,
    accountId,
    calendarId: input.calendarId,
    providerUnsubscribed,
    hiddenLocally: !providerUnsubscribed,
    providerError,
  };
}

export async function rsvpCalendarEvent(input: {
  userId: string;
  accountId: string;
  calendarId: string;
  eventId: string;
  status: 'yes' | 'no' | 'maybe';
}) {
  const account = await getAccount(input.userId, input.accountId);
  const accountId = account.accountId;
  try {
    await withNylasRetry(
      () =>
        requireNylas().events.sendRsvp({
          identifier: account.grantId,
          eventId: input.eventId,
          requestBody: { status: input.status },
          queryParams: { calendarId: input.calendarId } as any,
          overrides: calendarWriteOverrides(),
        }),
      0,
    );
  } catch (err: any) {
    throw calendarMutationError(account, err, 'RSVP to the event');
  }
  const previous = await getMirrorEvent(input.userId, accountId, input.eventId, input.calendarId);
  const operationId = await recordOperation({
    userId: input.userId,
    tool: 'calendar_rsvp_event',
    surface: 'calendar',
    summary: `RSVP'd ${input.status} to "${previous?.title || input.eventId}"`,
    target: {
      kind: 'calendarEvent',
      id: input.eventId,
      accountId,
      calendarId: input.calendarId,
    },
    // No reliable previous-RSVP source; an RSVP change is re-doable but the
    // provider already notified the organizer, so we don't pretend to undo.
    inverse: undefined,
  });
  // Refresh the mirrored copy so the surface shows the new own-status.
  void syncEventIntoMirror(account, input.calendarId, input.eventId).catch(() => undefined);
  return { ok: true, operationId };
}

// ---- undo executors -------------------------------------------------------

registerUndoExecutor('calendar.delete_event', async (payload, ctx) => {
  await deleteWithoutRecording(ctx.userId, payload.accountId, payload.calendarId, payload.eventId);
});

registerUndoExecutor('calendar.recreate_event', async (payload, ctx) => {
  const account = await getAccount(ctx.userId, payload.accountId);
  const fields = payload.fields || {};
  const createRequestId = newCreateRequestId();
  let created: any;
  try {
    const response = await requireNylas().events.create({
      identifier: account.grantId,
      requestBody: {
        title: fields.title,
        description: fields.description,
        location: fields.location,
        busy: fields.busy ?? true,
        when: toNylasWhen(fields.startAt, fields.endAt, fields.allDay),
        participants: fields.participants,
        recurrence: fields.recurrence,
        metadata: {
          [CREATE_REQUEST_ID_KEY]: createRequestId,
          lab86CreatedBy: 'lab86-mail-undo',
        },
      } as any,
      queryParams: { calendarId: payload.calendarId, notifyParticipants: false } as any,
      overrides: calendarWriteOverrides(),
    });
    created = response.data as any;
  } catch (err: any) {
    if (isAmbiguousCreateError(err)) {
      created = await recoverCreatedEventByMetadata(account.grantId, payload.calendarId, createRequestId);
    }
    if (!created) throw err;
  }
  if (!created?.id) {
    throw new Error(
      `Couldn't recreate the event on ${account.email || account.accountId}: provider returned no event id.`,
    );
  }
  const row = toEventInput(created as any, payload.calendarId);
  if (row) await upsertMirror(account, [row]);
});

registerUndoExecutor('calendar.restore_event', async (payload, ctx) => {
  const account = await getAccount(ctx.userId, payload.accountId);
  const fields = payload.fields || {};
  const response = await withNylasRetry(
    () =>
      requireNylas().events.update({
        identifier: account.grantId,
        eventId: payload.eventId,
        requestBody: {
          title: fields.title,
          description: fields.description,
          location: fields.location,
          busy: fields.busy,
          when: toNylasWhen(fields.startAt, fields.endAt, fields.allDay),
          participants: fields.participants,
          recurrence: fields.recurrence,
        } as any,
        queryParams: { calendarId: payload.calendarId, notifyParticipants: false } as any,
        overrides: calendarWriteOverrides(),
      }),
    1,
  );
  const row = toEventInput(response.data as any, payload.calendarId);
  if (row) await upsertMirror(account, [row]);
});

// ---- helpers ---------------------------------------------------------------

async function deleteWithoutRecording(
  userId: string,
  accountId: string,
  calendarId: string,
  eventId: string,
) {
  const account = await getAccount(userId, accountId);
  const resolvedAccountId = account.accountId;
  try {
    await withNylasRetry(
      () =>
        requireNylas().events.destroy({
          identifier: account.grantId,
          eventId,
          queryParams: { calendarId, notifyParticipants: false } as any,
          overrides: calendarWriteOverrides(),
        }),
      1,
    );
  } catch (err: any) {
    if (nylasErrorStatus(err) !== 404 && nylasErrorStatus(err) !== 410) throw err;
  }
  await convexMutation(calendarApi.deleteEvent, {
    userId,
    accountId: resolvedAccountId,
    providerCalendarId: calendarId,
    providerEventId: eventId,
    includeInstances: true,
  });
}

async function syncEventIntoMirror(account: NylasAccountRow, calendarId: string, eventId: string) {
  const response = await withNylasRetry(
    () =>
      requireNylas().events.find({
        identifier: account.grantId,
        eventId,
        queryParams: { calendarId } as any,
        overrides: calendarWriteOverrides(),
      }),
    1,
  );
  const row = toEventInput(response.data as any, calendarId);
  if (row) await upsertMirror(account, [row]);
}

async function upsertMirror(account: NylasAccountRow, events: EventInputRow[]) {
  await convexMutation(calendarApi.upsertEventBatch, {
    userId: account.userId,
    accountId: account.accountId,
    grantId: account.grantId,
    provider: account.provider,
    events,
  });
}

export async function getPrimaryCalendarId(userId: string, accountId: string): Promise<string> {
  const calendars = await convexQuery<any[]>(calendarApi.listCalendars, { userId });
  const own = (calendars || []).filter((cal) => cal.accountId === accountId && !cal.readOnly);
  const primary = own.find((cal) => cal.isPrimary) || own[0];
  if (!primary) {
    throw new Error('No writable calendar synced for this account. Run calendar sync first.');
  }
  return primary.providerCalendarId;
}

async function getMirrorEvent(
  userId: string,
  accountId: string,
  eventId: string,
  providerCalendarId?: string,
) {
  return convexQuery<any | null>(calendarApi.getEventByProviderId, {
    userId,
    accountId,
    providerCalendarId,
    providerEventId: eventId,
  }).catch(() => null);
}

async function getAccount(userId: string, accountId: string): Promise<NylasAccountRow> {
  // Flexible resolution (accountId | grantId | email) with an actionable
  // error — the exact-id-only lookup was the main "no grant"/"not found"
  // source when the AI passed an email or a stale id.
  return requireConnectedAccount(userId, accountId);
}

function toNylasWhen(startAt: number, endAt: number, allDay?: boolean, timezone?: string) {
  if (allDay) {
    const startDate = new Date(startAt).toISOString().slice(0, 10);
    const endDate = new Date(endAt).toISOString().slice(0, 10);
    if (startDate === endDate || endAt - startAt <= 86_400_000) {
      return { date: startDate };
    }
    return { startDate, endDate };
  }
  // Google (via Nylas) needs the timezone alongside the unix seconds to place a
  // timed event correctly; without it events land in UTC / get rejected.
  const tz = timezone || 'UTC';
  return {
    startTime: Math.floor(startAt / 1000),
    endTime: Math.floor(endAt / 1000),
    startTimezone: tz,
    endTimezone: tz,
  };
}
