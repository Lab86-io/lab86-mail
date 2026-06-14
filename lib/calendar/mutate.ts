import { recordOperation, registerUndoExecutor } from '@/lib/ai/operations';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireNylas } from '@/lib/nylas/client';
import { type NylasAccountRow, requireConnectedAccount } from '@/lib/nylas/provider';
import { type EventInputRow, toEventInput } from './sync';

const calendarApi = (api as any).calendarData;

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
  let calendarId = input.calendarId || (await getPrimaryCalendarId(input.userId, accountId));
  // Agents sometimes pair one account with another account's calendar id —
  // the provider answers with an opaque Bad Request. Verify ownership and
  // fall back to the account's own primary calendar instead.
  if (input.calendarId) {
    const calendars = await convexQuery<any[]>(calendarApi.listCalendars, { userId: input.userId });
    const owned = (calendars || []).some(
      (cal) => cal.accountId === accountId && cal.providerCalendarId === input.calendarId,
    );
    if (!owned) {
      calendarId = await getPrimaryCalendarId(input.userId, accountId);
    }
  }
  const response = await requireNylas().events.create({
    identifier: account.grantId,
    requestBody: {
      title: input.title,
      description: input.description,
      location: input.location,
      busy: input.busy ?? true,
      when: toNylasWhen(input.startAt, input.endAt, input.allDay),
      participants: input.participants?.map((p) => ({ email: p.email, name: p.name })),
      recurrence: input.recurrence,
    } as any,
    queryParams: {
      calendarId,
      notifyParticipants: input.notifyParticipants ?? Boolean(input.participants?.length),
    } as any,
  });
  const created = response.data as any;
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
  const previous = await getMirrorEvent(input.userId, accountId, input.eventId);
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
  const response = await requireNylas().events.update({
    identifier: account.grantId,
    eventId: input.eventId,
    requestBody: requestBody as any,
    queryParams: {
      calendarId: input.calendarId,
      notifyParticipants: input.notifyParticipants ?? false,
    } as any,
  });
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
  const previous = await getMirrorEvent(input.userId, accountId, input.eventId);
  const eventId = input.deleteSeries && previous?.masterEventId ? previous.masterEventId : input.eventId;
  const previousTarget =
    eventId === input.eventId ? previous : await getMirrorEvent(input.userId, accountId, eventId);
  await requireNylas().events.destroy({
    identifier: account.grantId,
    eventId,
    queryParams: {
      calendarId: input.calendarId,
      notifyParticipants: input.notifyParticipants ?? false,
    } as any,
  });
  await convexMutation(calendarApi.deleteEvent, {
    userId: input.userId,
    accountId,
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
    await requireNylas().calendars.destroy({
      identifier: account.grantId,
      calendarId: input.calendarId,
    });
    providerUnsubscribed = true;
  } catch (err: any) {
    providerError = err?.message || 'Provider calendar delete/unsubscribe failed.';
    if (!input.fallbackToHide) throw err;
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
  await requireNylas().events.sendRsvp({
    identifier: account.grantId,
    eventId: input.eventId,
    requestBody: { status: input.status },
    queryParams: { calendarId: input.calendarId } as any,
  });
  const previous = await getMirrorEvent(input.userId, accountId, input.eventId);
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
    } as any,
    queryParams: { calendarId: payload.calendarId, notifyParticipants: false } as any,
  });
  const row = toEventInput(response.data as any, payload.calendarId);
  if (row) await upsertMirror(account, [row]);
});

registerUndoExecutor('calendar.restore_event', async (payload, ctx) => {
  const account = await getAccount(ctx.userId, payload.accountId);
  const fields = payload.fields || {};
  const response = await requireNylas().events.update({
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
  });
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
  await requireNylas().events.destroy({
    identifier: account.grantId,
    eventId,
    queryParams: { calendarId, notifyParticipants: false } as any,
  });
  await convexMutation(calendarApi.deleteEvent, {
    userId,
    accountId: resolvedAccountId,
    providerEventId: eventId,
    includeInstances: true,
  });
}

async function syncEventIntoMirror(account: NylasAccountRow, calendarId: string, eventId: string) {
  const response = await requireNylas().events.find({
    identifier: account.grantId,
    eventId,
    queryParams: { calendarId } as any,
  });
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

async function getMirrorEvent(userId: string, accountId: string, eventId: string) {
  return convexQuery<any | null>(calendarApi.getEventByProviderId, {
    userId,
    accountId,
    providerEventId: eventId,
  }).catch(() => null);
}

async function getAccount(userId: string, accountId: string): Promise<NylasAccountRow> {
  // Flexible resolution (accountId | grantId | email) with an actionable
  // error — the exact-id-only lookup was the main "no grant"/"not found"
  // source when the AI passed an email or a stale id.
  return requireConnectedAccount(userId, accountId);
}

function toNylasWhen(startAt: number, endAt: number, allDay?: boolean) {
  if (allDay) {
    const startDate = new Date(startAt).toISOString().slice(0, 10);
    const endDate = new Date(endAt).toISOString().slice(0, 10);
    if (startDate === endDate || endAt - startAt <= 86_400_000) {
      return { date: startDate };
    }
    return { startDate, endDate };
  }
  return {
    startTime: Math.floor(startAt / 1000),
    endTime: Math.floor(endAt / 1000),
  };
}
