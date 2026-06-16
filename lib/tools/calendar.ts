import { z } from 'zod';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getPrimaryCalendarId,
  rsvpCalendarEvent,
  unsubscribeCalendar,
  updateCalendarEvent,
} from '@/lib/calendar/mutate';
import { maybeKickCalendarSync, syncAllCalendarAccounts, syncCalendarAccount } from '@/lib/calendar/sync';
import { api, convexQuery } from '@/lib/hosted/convex';
import { requireConnectedAccount } from '@/lib/nylas/provider';
import { parseIsoInTimezone, wallClockInTimezone } from '@/lib/shared/timezones';
import { defineTool } from './registry';

const calendarApi = (api as any).calendarData;
const accountsApi = (api as any).accounts;

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

// Naive timestamps (no Z / offset) resolve in the requesting user's timezone.
function makeParseIso(userTimezone: string | undefined) {
  return (value: string, field: string) => parseIsoInTimezone(value, userTimezone, field);
}

const participantSchema = z.object({ email: z.string().email(), name: z.string().optional() });
const DAY_MS = 86_400_000;

export const calendarListCalendars = defineTool({
  name: 'calendar_list_calendars',
  description:
    'List all synced calendars across every connected account, with per-account sync status. Calendars marked readOnly cannot receive events.',
  category: 'calendar',
  mutating: false,
  input: z.object({}),
  output: z.object({ calendars: z.array(z.any()), syncStates: z.array(z.any()) }),
  async handler(_args, ctx) {
    const userId = requireUserId(ctx.userId);
    const [calendars, syncStates, accounts] = await Promise.all([
      convexQuery<any[]>(calendarApi.listCalendars, { userId }),
      convexQuery<any[]>(calendarApi.getSyncStates, { userId }),
      convexQuery<any[]>(accountsApi.listConnectedAccounts, { userId }),
    ]);
    // Lazy freshness, derived from CONNECTED ACCOUNTS — an account that has
    // never synced has no sync-state row, and deriving from states alone
    // meant pre-existing accounts never got their first sync.
    const stateByAccount = new Map((syncStates || []).map((state) => [state.accountId, state]));
    for (const account of accounts || []) {
      if (account.status !== 'connected') continue;
      const state = stateByAccount.get(account.accountId);
      if (state?.status === 'unauthorized') continue;
      const stale = !state?.lastSyncedAt || Date.now() - state.lastSyncedAt > 60 * 60_000;
      if (stale) maybeKickCalendarSync({ userId, accountId: account.accountId });
    }
    return {
      calendars: (calendars || []).map((cal) => ({
        accountId: cal.accountId,
        calendarId: cal.providerCalendarId,
        name: cal.name,
        timezone: cal.timezone,
        isPrimary: cal.isPrimary,
        readOnly: cal.readOnly,
        hexColor: cal.hexColor,
        hidden: cal.hidden,
      })),
      syncStates: (syncStates || []).map((state) => ({
        accountId: state.accountId,
        status: state.status,
        error: state.error,
        calendarsSynced: state.calendarsSynced,
        eventsSynced: state.eventsSynced,
        lastSyncedAt: state.lastSyncedAt,
      })),
    };
  },
});

export const calendarListEvents = defineTool({
  name: 'calendar_list_events',
  description:
    'List events across all synced calendars between two ISO timestamps (recurring events appear as expanded instances). Filter with calendarIds/accountIds if needed.',
  category: 'calendar',
  mutating: false,
  input: z.object({
    fromIso: z.string(),
    toIso: z.string(),
    accountIds: z.array(z.string()).optional(),
    calendarIds: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(2000).default(500),
  }),
  output: z.object({ events: z.array(z.any()) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const parseIso = makeParseIso(ctx.userTimezone);
    const rows = await convexQuery<any[]>(calendarApi.listEvents, {
      userId,
      startAt: parseIso(args.fromIso, 'fromIso'),
      endAt: parseIso(args.toIso, 'toIso'),
      limit: args.limit,
    });
    const accountFilter = args.accountIds?.length ? new Set(args.accountIds) : null;
    const calendarFilter = args.calendarIds?.length ? new Set(args.calendarIds) : null;
    return {
      events: (rows || [])
        .filter((row) => !accountFilter || accountFilter.has(row.accountId))
        .filter((row) => !calendarFilter || calendarFilter.has(row.providerCalendarId))
        .map(toToolEvent),
    };
  },
});

export const calendarSearchEvents = defineTool({
  name: 'calendar_search_events',
  description:
    'Search the local calendar corpus across synced events by title, description, location, attendees, organizer, conferencing, calendar name, and recurrence text. Use this for named/topic calendar lookup instead of broad date-window scans.',
  category: 'calendar',
  mutating: false,
  input: z.object({
    query: z.string().default(''),
    fromIso: z.string().optional(),
    toIso: z.string().optional(),
    accountIds: z.array(z.string()).optional(),
    calendarIds: z.array(z.string()).optional(),
    includeCancelled: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: z.object({ events: z.array(z.any()) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const parseIso = makeParseIso(ctx.userTimezone);
    const rows = await convexQuery<any[]>(calendarApi.searchEvents, {
      userId,
      query: args.query,
      startAt: args.fromIso ? parseIso(args.fromIso, 'fromIso') : undefined,
      endAt: args.toIso ? parseIso(args.toIso, 'toIso') : undefined,
      accountIds: args.accountIds,
      calendarIds: args.calendarIds,
      includeCancelled: args.includeCancelled,
      limit: args.limit,
    });
    return { events: (rows || []).map(toToolEvent) };
  },
});

export const calendarCountEvents = defineTool({
  name: 'calendar_count_events',
  description:
    'Count locally indexed calendar events matching optional text/date/account/calendar filters. Counts are capped at 1000 and may be approximate.',
  category: 'calendar',
  mutating: false,
  input: z.object({
    query: z.string().optional(),
    fromIso: z.string().optional(),
    toIso: z.string().optional(),
    accountIds: z.array(z.string()).optional(),
    calendarIds: z.array(z.string()).optional(),
    includeCancelled: z.boolean().default(false),
  }),
  output: z.object({ total: z.number(), approximate: z.boolean() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const parseIso = makeParseIso(ctx.userTimezone);
    const result = await convexQuery<{ count: number; approximate: boolean }>(calendarApi.countEvents, {
      userId,
      query: args.query,
      startAt: args.fromIso ? parseIso(args.fromIso, 'fromIso') : undefined,
      endAt: args.toIso ? parseIso(args.toIso, 'toIso') : undefined,
      accountIds: args.accountIds,
      calendarIds: args.calendarIds,
      includeCancelled: args.includeCancelled,
    });
    return { total: result.count, approximate: result.approximate };
  },
});

export const calendarEventDetail = defineTool({
  name: 'calendar_event_detail',
  description:
    'Fetch one event from the local calendar corpus by account, calendar id, and provider event id. Use after calendar_search_events or calendar_list_events when details/provenance are needed.',
  category: 'calendar',
  mutating: false,
  input: z.object({
    account: z.string(),
    eventId: z.string(),
    calendarId: z.string(),
  }),
  output: z.object({ event: z.any() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const account = await requireConnectedAccount(userId, args.account);
    const event = await convexQuery<any | null>(calendarApi.getEventByProviderId, {
      userId,
      accountId: account.accountId,
      providerCalendarId: args.calendarId,
      providerEventId: args.eventId,
    });
    if (!event) throw new Error('Calendar event not found in the local corpus. Run calendar_sync_now.');
    return { event: toToolEvent(event) };
  },
});

export const calendarSyncNow = defineTool({
  name: 'calendar_sync_now',
  description:
    'Force a full calendar resync from the providers, for one account or all of them. Use when events seem stale or after connecting an account.',
  category: 'calendar',
  mutating: true,
  input: z.object({ account: z.string().optional() }),
  output: z.object({ results: z.array(z.any()) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const results = args.account
      ? [await syncCalendarAccount({ userId, accountId: args.account, force: true, reason: 'manual_tool' })]
      : await syncAllCalendarAccounts(userId, { force: true, reason: 'manual_tool' });
    return { results };
  },
});

export const calendarFreeBusy = defineTool({
  name: 'calendar_free_busy',
  description:
    'Compute busy windows between two ISO timestamps from the synced calendars (all accounts merged unless accountIds filters them).',
  category: 'calendar',
  mutating: false,
  input: z.object({
    fromIso: z.string(),
    toIso: z.string(),
    accountIds: z.array(z.string()).optional(),
  }),
  output: z.object({ busy: z.array(z.object({ startIso: z.string(), endIso: z.string() })) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const parseIso = makeParseIso(ctx.userTimezone);
    const from = parseIso(args.fromIso, 'fromIso');
    const to = parseIso(args.toIso, 'toIso');
    const busy = await busyWindows(userId, from, to, args.accountIds);
    return {
      busy: busy.map(([start, end]) => ({
        startIso: new Date(start).toISOString(),
        endIso: new Date(end).toISOString(),
      })),
    };
  },
});

export const calendarSuggestTimes = defineTool({
  name: 'calendar_suggest_times',
  description:
    'Suggest open meeting slots within a date window given a duration, avoiding busy time across all synced calendars. Slots respect working hours (09:00–18:00 local) unless allowOutsideWorkingHours.',
  category: 'calendar',
  mutating: false,
  input: z.object({
    fromIso: z.string(),
    toIso: z.string(),
    durationMinutes: z.number().int().min(15).max(480).default(30),
    count: z.number().int().min(1).max(10).default(3),
    allowOutsideWorkingHours: z.boolean().default(false),
    accountIds: z.array(z.string()).optional(),
  }),
  output: z.object({ suggestions: z.array(z.object({ startIso: z.string(), endIso: z.string() })) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const parseIso = makeParseIso(ctx.userTimezone);
    const from = Math.max(parseIso(args.fromIso, 'fromIso'), Date.now());
    const to = parseIso(args.toIso, 'toIso');
    const busy = await busyWindows(userId, from, to, args.accountIds);
    const durationMs = args.durationMinutes * 60_000;
    const suggestions: Array<{ startIso: string; endIso: string }> = [];
    // Walk half-hour boundaries; take the first N slots that fit.
    const step = 30 * 60_000;
    let cursor = Math.ceil(from / step) * step;
    while (cursor + durationMs <= to && suggestions.length < args.count) {
      const slotStart = cursor;
      const slotEnd = cursor + durationMs;
      cursor += step;
      if (!args.allowOutsideWorkingHours) {
        // Working hours are the USER's wall clock, not the server's (UTC).
        const start = wallClockInTimezone(slotStart, ctx.userTimezone);
        const end = wallClockInTimezone(slotEnd, ctx.userTimezone);
        if (start.weekday === 0 || start.weekday === 6) continue;
        if (start.hour < 9 || end.hour > 18 || (end.hour === 18 && end.minute > 0)) continue;
      }
      const clash = busy.some(([busyStart, busyEnd]) => slotStart < busyEnd && slotEnd > busyStart);
      if (clash) continue;
      suggestions.push({
        startIso: new Date(slotStart).toISOString(),
        endIso: new Date(slotEnd).toISOString(),
      });
    }
    return { suggestions };
  },
});

export const calendarCreateEvent = defineTool({
  name: 'calendar_create_event',
  description:
    'Create a calendar event. Times are ISO timestamps; allDay uses date granularity. IMPORTANT: adding attendees emails real invitations — confirm with the user before passing attendees. The operation is recorded and undoable via undo_operation.',
  category: 'calendar',
  mutating: true,
  input: z.object({
    account: z.string(),
    calendarId: z.string().optional(),
    title: z.string().min(1),
    startIso: z.string(),
    endIso: z.string(),
    allDay: z.boolean().default(false),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: z.array(participantSchema).default([]),
    recurrence: z.array(z.string()).optional(),
    busy: z.boolean().default(true),
  }),
  output: z.object({
    ok: z.boolean(),
    eventId: z.string(),
    calendarId: z.string(),
    operationId: z.string(),
    htmlLink: z.string().optional(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const parseIso = makeParseIso(ctx.userTimezone);
    const result = await createCalendarEvent({
      userId,
      accountId: args.account,
      calendarId: args.calendarId,
      title: args.title,
      startAt: parseIso(args.startIso, 'startIso'),
      endAt: parseIso(args.endIso, 'endIso'),
      allDay: args.allDay,
      description: args.description,
      location: args.location,
      participants: args.attendees,
      recurrence: args.recurrence,
      busy: args.busy,
      timezone: ctx.userTimezone,
    });
    return { ok: true, ...result };
  },
});

export const calendarUpdateEvent = defineTool({
  name: 'calendar_update_event',
  description:
    'Update fields of an existing event (title, times, location, description, attendees, recurrence). For a recurring series pass the master event id to change every occurrence, or an instance id to change just that one. Undoable. notifyParticipants emails attendees about the change — confirm with the user first.',
  category: 'calendar',
  mutating: true,
  input: z.object({
    account: z.string(),
    calendarId: z.string(),
    eventId: z.string(),
    title: z.string().optional(),
    startIso: z.string().optional(),
    endIso: z.string().optional(),
    allDay: z.boolean().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: z.array(participantSchema).optional(),
    recurrence: z.array(z.string()).optional(),
    busy: z.boolean().optional(),
    notifyParticipants: z.boolean().default(false),
  }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const parseIso = makeParseIso(ctx.userTimezone);
    const result = await updateCalendarEvent({
      userId,
      accountId: args.account,
      calendarId: args.calendarId,
      eventId: args.eventId,
      notifyParticipants: args.notifyParticipants,
      patch: {
        title: args.title,
        startAt: args.startIso ? parseIso(args.startIso, 'startIso') : undefined,
        endAt: args.endIso ? parseIso(args.endIso, 'endIso') : undefined,
        allDay: args.allDay,
        description: args.description,
        location: args.location,
        participants: args.attendees,
        recurrence: args.recurrence,
        busy: args.busy,
      },
    });
    return { ok: true, operationId: result.operationId };
  },
});

export const calendarDeleteEvent = defineTool({
  name: 'calendar_delete_event',
  description:
    'Delete an event. If deleteSeries is true and eventId is a recurring instance, the tool resolves and deletes the whole series. Undoable — undo recreates the event. notifyParticipants emails attendees a cancellation — confirm with the user first.',
  category: 'calendar',
  mutating: true,
  input: z.object({
    account: z.string(),
    calendarId: z.string(),
    eventId: z.string(),
    notifyParticipants: z.boolean().default(false),
    deleteSeries: z.boolean().default(false),
  }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const result = await deleteCalendarEvent({
      userId,
      accountId: args.account,
      calendarId: args.calendarId,
      eventId: args.eventId,
      notifyParticipants: args.notifyParticipants,
      deleteSeries: args.deleteSeries,
    });
    return { ok: true, operationId: result.operationId };
  },
});

export const calendarDeleteRecurringSeries = defineTool({
  name: 'calendar_delete_recurring_series',
  description:
    'Delete one or more recurring calendar series. Use eventId when available; otherwise pass a title and optional account/calendar/window filters. This resolves expanded recurring instances to their master series id before deleting.',
  category: 'calendar',
  mutating: true,
  input: z.object({
    account: z.string().optional(),
    calendarId: z.string().optional(),
    eventId: z.string().optional(),
    title: z.string().optional(),
    titleMatch: z.enum(['exact', 'contains']).default('exact'),
    fromIso: z.string().optional(),
    toIso: z.string().optional(),
    notifyParticipants: z.boolean().default(false),
  }),
  output: z.object({
    ok: z.boolean(),
    deleted: z.number(),
    targets: z.array(z.any()),
    errors: z.array(z.string()),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const parseIso = makeParseIso(ctx.userTimezone);
    const targets = new Map<
      string,
      { accountId: string; calendarId: string; eventId: string; title?: string }
    >();

    if (args.eventId) {
      if (!args.account || !args.calendarId) {
        throw new Error('account and calendarId are required when deleting a series by eventId.');
      }
      const account = await requireConnectedAccount(userId, args.account);
      targets.set(`${account.accountId}:${args.calendarId}:${args.eventId}`, {
        accountId: account.accountId,
        calendarId: args.calendarId,
        eventId: args.eventId,
      });
    } else {
      const titleNeedle = args.title?.trim().toLowerCase();
      if (!titleNeedle) throw new Error('Provide eventId or title.');
      const from = args.fromIso ? parseIso(args.fromIso, 'fromIso') : Date.now() - 370 * DAY_MS;
      const to = args.toIso ? parseIso(args.toIso, 'toIso') : Date.now() + 730 * DAY_MS;
      const rows = await convexQuery<any[]>(calendarApi.listEvents, {
        userId,
        startAt: from,
        endAt: to,
        limit: 2000,
      });
      const account = args.account ? await requireConnectedAccount(userId, args.account) : null;
      for (const row of rows || []) {
        if (account && row.accountId !== account.accountId) continue;
        if (args.calendarId && row.providerCalendarId !== args.calendarId) continue;
        const rowTitle = String(row.title || '')
          .trim()
          .toLowerCase();
        const matches =
          args.titleMatch === 'contains' ? rowTitle.includes(titleNeedle) : rowTitle === titleNeedle;
        if (!matches) continue;
        const eventId = row.masterEventId || row.providerEventId;
        targets.set(`${row.accountId}:${row.providerCalendarId}:${eventId}`, {
          accountId: row.accountId,
          calendarId: row.providerCalendarId,
          eventId,
          title: row.title,
        });
      }
    }

    const deletedTargets: any[] = [];
    const errors: string[] = [];
    for (const target of targets.values()) {
      try {
        const result = await deleteCalendarEvent({
          userId,
          accountId: target.accountId,
          calendarId: target.calendarId,
          eventId: target.eventId,
          deleteSeries: true,
          notifyParticipants: args.notifyParticipants,
        });
        deletedTargets.push({ ...target, operationId: result.operationId });
      } catch (err: any) {
        errors.push(`${target.title || target.eventId}: ${err?.message || 'delete failed'}`);
      }
    }

    return { ok: errors.length === 0, deleted: deletedTargets.length, targets: deletedTargets, errors };
  },
});

export const calendarUnsubscribeCalendar = defineTool({
  name: 'calendar_unsubscribe_calendar',
  description:
    'Unsubscribe from or remove a synced provider calendar. Pass either calendarId or an exact calendar name. If the provider refuses deletion, fallbackToHide hides it locally and stops it from appearing in the merged calendar view.',
  category: 'calendar',
  mutating: true,
  input: z.object({
    account: z.string(),
    calendarId: z.string().optional(),
    name: z.string().optional(),
    fallbackToHide: z.boolean().default(true),
  }),
  output: z.object({
    ok: z.boolean(),
    accountId: z.string(),
    calendarId: z.string(),
    name: z.string().optional(),
    providerUnsubscribed: z.boolean(),
    hiddenLocally: z.boolean(),
    providerError: z.string().optional(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const account = await requireConnectedAccount(userId, args.account);
    const calendars = await convexQuery<any[]>(calendarApi.listCalendars, { userId });
    const nameNeedle = args.name?.trim().toLowerCase();
    const matches = (calendars || []).filter((cal) => {
      if (cal.accountId !== account.accountId) return false;
      if (args.calendarId) return cal.providerCalendarId === args.calendarId;
      return nameNeedle
        ? String(cal.name || '')
            .trim()
            .toLowerCase() === nameNeedle
        : false;
    });
    if (!args.calendarId && !nameNeedle) throw new Error('Provide calendarId or name.');
    if (!matches.length) {
      throw new Error(
        `Calendar not found under ${account.email}. Use calendar_list_calendars to inspect available calendars.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple calendars matched "${args.name || args.calendarId}". Pass calendarId to disambiguate.`,
      );
    }
    const calendar = matches[0];
    const result = await unsubscribeCalendar({
      userId,
      accountId: account.accountId,
      calendarId: calendar.providerCalendarId,
      fallbackToHide: args.fallbackToHide,
    });
    return { ...result, name: calendar.name };
  },
});

export const calendarRsvpEvent = defineTool({
  name: 'calendar_rsvp_event',
  description:
    'RSVP to an event invitation (yes/no/maybe). This notifies the organizer — confirm with the user before responding on their behalf. Not undoable (the organizer already saw it), but it can be re-sent with a different status.',
  category: 'calendar',
  mutating: true,
  input: z.object({
    account: z.string(),
    calendarId: z.string(),
    eventId: z.string(),
    status: z.enum(['yes', 'no', 'maybe']),
  }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const result = await rsvpCalendarEvent({
      userId,
      accountId: args.account,
      calendarId: args.calendarId,
      eventId: args.eventId,
      status: args.status,
    });
    return { ok: true, operationId: result.operationId };
  },
});

export const calendarGetPrimary = defineTool({
  name: 'calendar_get_primary',
  description: 'Resolve the primary writable calendar id for an account.',
  category: 'calendar',
  mutating: false,
  input: z.object({ account: z.string() }),
  output: z.object({ calendarId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    return { calendarId: await getPrimaryCalendarId(userId, args.account) };
  },
});

async function busyWindows(
  userId: string,
  from: number,
  to: number,
  accountIds?: string[],
): Promise<Array<[number, number]>> {
  const rows = await convexQuery<any[]>(calendarApi.listEvents, {
    userId,
    startAt: from,
    endAt: to,
    limit: 2000,
  });
  const filter = accountIds?.length ? new Set(accountIds) : null;
  const windows = (rows || [])
    .filter((row) => !filter || filter.has(row.accountId))
    .filter((row) => row.busy !== false && row.status !== 'cancelled')
    .map((row) => [Math.max(row.startAt, from), Math.min(row.endAt, to)] as [number, number])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  // Merge overlaps so callers get disjoint busy spans.
  const merged: Array<[number, number]> = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
    else merged.push([...window] as [number, number]);
  }
  return merged;
}

function toToolEvent(row: any) {
  return {
    eventId: row.providerEventId,
    accountId: row.accountId,
    calendarId: row.providerCalendarId,
    title: row.title,
    description: row.description,
    location: row.location,
    status: row.status,
    busy: row.busy,
    readOnly: row.readOnly,
    startIso: new Date(row.startAt).toISOString(),
    endIso: new Date(row.endAt).toISOString(),
    allDay: row.allDay,
    masterEventId: row.masterEventId,
    recurrence: row.recurrence,
    participants: row.participants,
    organizer: row.organizer,
    conferencing: row.conferencing,
    htmlLink: row.htmlLink,
  };
}
