import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireNylas } from '@/lib/nylas/client';
import type { NylasAccountRow } from '@/lib/nylas/provider';

const calendarApi = (api as any).calendarData;
const accountsApi = (api as any).accounts;

// Rolling sync window: recurring events arrive pre-expanded inside it via
// expand_recurring, so no client-side RRULE math on the read path. A daily
// refresh (and every webhook-triggered resync) slides the horizon forward.
const WINDOW_PAST_DAYS = 92;
const WINDOW_FUTURE_DAYS = 366;
const EVENT_PAGE_LIMIT = 50;
const MUTATION_BATCH = 50;

export interface CalendarSyncResult {
  ok: boolean;
  accountId: string;
  calendars: number;
  events: number;
  unauthorized?: boolean;
  error?: string;
}

export interface CalendarInputRow {
  providerCalendarId: string;
  name: string;
  description?: string;
  timezone?: string;
  isPrimary?: boolean;
  readOnly?: boolean;
  hexColor?: string;
}

export interface EventInputRow {
  providerEventId: string;
  providerCalendarId: string;
  title: string;
  description?: string;
  location?: string;
  status?: string;
  busy?: boolean;
  readOnly?: boolean;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  startTimezone?: string;
  endTimezone?: string;
  masterEventId?: string;
  recurrence?: string[];
  participants?: unknown[];
  organizer?: unknown;
  conferencing?: unknown;
  icalUid?: string;
  htmlLink?: string;
}

export async function syncCalendarAccount({
  userId,
  accountId,
}: {
  userId: string;
  accountId: string;
}): Promise<CalendarSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
  const windowStart = Date.now() - WINDOW_PAST_DAYS * 86_400_000;
  const windowEnd = Date.now() + WINDOW_FUTURE_DAYS * 86_400_000;
  await markSync(row, { status: 'syncing' });
  try {
    const calendars = await listAllCalendars(row.grantId);
    await convexMutation(calendarApi.upsertCalendarBatch, {
      userId,
      accountId,
      grantId: row.grantId,
      provider: row.provider,
      calendars,
      pruneMissing: true,
    });

    let totalEvents = 0;
    for (const calendar of calendars) {
      const events = await listCalendarEventsInWindow(
        row.grantId,
        calendar.providerCalendarId,
        windowStart,
        windowEnd,
      );
      for (let i = 0; i < events.length; i += MUTATION_BATCH) {
        await convexMutation(calendarApi.upsertEventBatch, {
          userId,
          accountId,
          grantId: row.grantId,
          provider: row.provider,
          events: events.slice(i, i + MUTATION_BATCH),
        });
      }
      await convexMutation(calendarApi.reconcileWindow, {
        userId,
        accountId,
        grantId: row.grantId,
        provider: row.provider,
        providerCalendarId: calendar.providerCalendarId,
        windowStart,
        windowEnd,
        keepProviderEventIds: events.map((event) => event.providerEventId),
      });
      totalEvents += events.length;
    }

    await markSync(row, {
      status: 'ready',
      calendarsSynced: calendars.length,
      eventsSynced: totalEvents,
      windowStart,
      windowEnd,
      lastSyncedAt: Date.now(),
    });
    return { ok: true, accountId, calendars: calendars.length, events: totalEvents };
  } catch (err: any) {
    if (isMissingScopeError(err)) {
      await markSync(row, {
        status: 'unauthorized',
        error: 'This account was connected without calendar access. Reconnect it to enable calendar sync.',
      }).catch(() => undefined);
      return { ok: false, accountId, calendars: 0, events: 0, unauthorized: true };
    }
    await markSync(row, {
      status: 'error',
      error: err?.message || 'calendar sync failed',
    }).catch(() => undefined);
    throw err;
  }
}

export async function syncAllCalendarAccounts(userId: string): Promise<CalendarSyncResult[]> {
  const accounts = await convexQuery<NylasAccountRow[]>(accountsApi.listConnectedAccounts, { userId });
  const results: CalendarSyncResult[] = [];
  for (const account of accounts || []) {
    if (account.status !== 'connected') continue;
    try {
      results.push(await syncCalendarAccount({ userId, accountId: account.accountId }));
    } catch (err: any) {
      results.push({
        ok: false,
        accountId: account.accountId,
        calendars: 0,
        events: 0,
        error: err?.message || 'calendar sync failed',
      });
    }
  }
  return results;
}

const syncKickAt = new Map<string, number>();
const SYNC_KICK_DEBOUNCE_MS = 5 * 60_000;

// Fire-and-forget kick used by the surface load, the OAuth callback, and
// recurring-event webhooks (whose payloads can't be applied as point deltas).
export function maybeKickCalendarSync(row: Pick<NylasAccountRow, 'userId' | 'accountId'>) {
  const key = `${row.userId}:${row.accountId}`;
  const last = syncKickAt.get(key) || 0;
  if (Date.now() - last < SYNC_KICK_DEBOUNCE_MS) return;
  syncKickAt.set(key, Date.now());
  void syncCalendarAccount({ userId: row.userId, accountId: row.accountId }).catch((err) => {
    syncKickAt.delete(key);
    console.error(`[calendar] background sync failed for ${row.accountId}:`, err?.message || err);
  });
}

// Webhook delta: plain events apply as point upserts/deletes; anything in a
// recurring series triggers a debounced account resync, because one payload
// can imply many expanded instances changing.
export async function applyCalendarWebhookDelta(row: NylasAccountRow, type: string, payload: unknown) {
  const object = extractWebhookObject(payload);
  const providerEventId = str(object.id);
  if (!providerEventId) return;
  if (/deleted/i.test(type)) {
    await convexMutation(calendarApi.deleteEvent, {
      userId: row.userId,
      accountId: row.accountId,
      providerEventId,
      includeInstances: true,
    });
    return;
  }
  const isRecurring =
    Array.isArray(object.recurrence) || str(object.master_event_id) || str(object.masterEventId);
  if (isRecurring) {
    maybeKickCalendarSync(row);
    return;
  }
  const event = toEventInput(object);
  if (!event) return;
  if (event.status === 'cancelled') {
    await convexMutation(calendarApi.deleteEvent, {
      userId: row.userId,
      accountId: row.accountId,
      providerEventId,
      includeInstances: true,
    });
    return;
  }
  await convexMutation(calendarApi.upsertEventBatch, {
    userId: row.userId,
    accountId: row.accountId,
    grantId: row.grantId,
    provider: row.provider,
    events: [event],
  });
}

export function isCalendarWebhookType(type: string) {
  return /^event\.|^calendar\./.test(type);
}

async function listAllCalendars(grantId: string): Promise<CalendarInputRow[]> {
  const out: CalendarInputRow[] = [];
  let pageToken: string | undefined;
  do {
    const page = await requireNylas().calendars.list({
      identifier: grantId,
      queryParams: { limit: 50, ...(pageToken ? { pageToken } : {}) } as any,
    });
    for (const cal of page.data || []) {
      out.push(toCalendarInput(cal));
    }
    pageToken = (page as any).nextCursor || undefined;
  } while (pageToken);
  return out;
}

async function listCalendarEventsInWindow(
  grantId: string,
  calendarId: string,
  windowStart: number,
  windowEnd: number,
): Promise<EventInputRow[]> {
  const out: EventInputRow[] = [];
  let pageToken: string | undefined;
  do {
    const page = await requireNylas().events.list({
      identifier: grantId,
      queryParams: {
        calendarId,
        start: String(Math.floor(windowStart / 1000)),
        end: String(Math.floor(windowEnd / 1000)),
        expandRecurring: true,
        limit: EVENT_PAGE_LIMIT,
        ...(pageToken ? { pageToken } : {}),
      } as any,
    });
    for (const raw of page.data || []) {
      const event = toEventInput(raw, calendarId);
      if (event) out.push(event);
    }
    pageToken = (page as any).nextCursor || undefined;
  } while (pageToken);
  return out;
}

function toCalendarInput(raw: any): CalendarInputRow {
  return {
    providerCalendarId: str(raw.id) || '',
    name: str(raw.name) || '(unnamed calendar)',
    description: str(raw.description),
    timezone: str(raw.timezone),
    isPrimary: bool(raw.isPrimary ?? raw.is_primary),
    readOnly: bool(raw.readOnly ?? raw.read_only),
    hexColor: str(raw.hexColor ?? raw.hex_color),
  };
}

// Accepts both SDK responses (camelCase) and raw webhook objects (snake_case).
export function toEventInput(raw: any, fallbackCalendarId?: string): EventInputRow | null {
  const providerEventId = str(raw.id);
  const providerCalendarId = str(raw.calendarId ?? raw.calendar_id) || fallbackCalendarId;
  const when = raw.when || {};
  if (!providerEventId || !providerCalendarId) return null;
  const times = whenToTimes(when);
  if (!times) return null;
  return {
    providerEventId,
    providerCalendarId,
    title: str(raw.title) || '(no title)',
    description: str(raw.description),
    location: str(raw.location),
    status: str(raw.status),
    busy: bool(raw.busy),
    readOnly: bool(raw.readOnly ?? raw.read_only),
    ...times,
    masterEventId: str(raw.masterEventId ?? raw.master_event_id),
    recurrence: Array.isArray(raw.recurrence) ? raw.recurrence.map(String) : undefined,
    participants: Array.isArray(raw.participants) ? raw.participants : undefined,
    organizer: raw.organizer ?? undefined,
    conferencing: raw.conferencing ?? undefined,
    icalUid: str(raw.icalUid ?? raw.ical_uid),
    htmlLink: str(raw.htmlLink ?? raw.html_link),
  };
}

function whenToTimes(when: any): {
  startAt: number;
  endAt: number;
  allDay?: boolean;
  startTimezone?: string;
  endTimezone?: string;
} | null {
  const object = str(when.object);
  const startTime = num(when.startTime ?? when.start_time);
  const endTime = num(when.endTime ?? when.end_time);
  if (startTime && endTime) {
    return {
      startAt: startTime * 1000,
      endAt: endTime * 1000,
      allDay: false,
      startTimezone: str(when.startTimezone ?? when.start_timezone),
      endTimezone: str(when.endTimezone ?? when.end_timezone),
    };
  }
  const date = str(when.date);
  if (object === 'date' || date) {
    const start = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(start)) return null;
    return { startAt: start, endAt: start + 86_400_000, allDay: true };
  }
  const startDate = str(when.startDate ?? when.start_date);
  const endDate = str(when.endDate ?? when.end_date);
  if (startDate) {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    // Datespan end date is exclusive (Google semantics); a same-day span
    // still renders as one full day.
    const endParsed = endDate ? Date.parse(`${endDate}T00:00:00Z`) : Number.NaN;
    const end = Number.isFinite(endParsed) && endParsed > start ? endParsed : start + 86_400_000;
    if (!Number.isFinite(start)) return null;
    return { startAt: start, endAt: end, allDay: true };
  }
  return null;
}

function isMissingScopeError(err: any): boolean {
  const status = Number(err?.statusCode ?? err?.status);
  const message = String(err?.message || '').toLowerCase();
  return (
    status === 403 ||
    status === 401 ||
    message.includes('insufficient') ||
    message.includes('forbidden') ||
    message.includes('scope')
  );
}

async function getConnectedAccount(userId: string, accountId: string) {
  const row = await convexQuery<NylasAccountRow | null>(accountsApi.getConnectedAccount, {
    userId,
    accountId,
  });
  if (!row || row.status !== 'connected') throw new Error('Connected account not found.');
  return row;
}

async function markSync(
  row: NylasAccountRow,
  patch: {
    status?: 'idle' | 'syncing' | 'ready' | 'error' | 'unauthorized';
    error?: string;
    calendarsSynced?: number;
    eventsSynced?: number;
    windowStart?: number;
    windowEnd?: number;
    lastSyncedAt?: number;
  },
) {
  await convexMutation(calendarApi.markSyncState, {
    userId: row.userId,
    accountId: row.accountId,
    grantId: row.grantId,
    provider: row.provider,
    ...patch,
  });
}

function extractWebhookObject(payload: unknown): any {
  const root = (payload || {}) as any;
  const data = root.data || {};
  return data.object || root.object || data;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
