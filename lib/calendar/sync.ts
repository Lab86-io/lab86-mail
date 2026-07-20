import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireNylas } from '@/lib/nylas/client';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { nylasErrorStatus, withNylasRetry } from '@/lib/nylas/retry';
import { buildCalendarEventSearchText, calendarYearMonthFromTimestamp } from './corpus';

const calendarApi = (api as any).calendarData;
const accountsApi = (api as any).accounts;

// Rolling sync window: recurring events arrive pre-expanded inside it via
// expand_recurring, so no client-side RRULE math on the read path. A daily
// refresh (and every webhook-triggered resync) slides the horizon forward.
const WINDOW_PAST_DAYS = 92;
const WINDOW_FUTURE_DAYS = 366;
const EVENT_PAGE_LIMIT = 50;
const MUTATION_BATCH = 50;
const ACTIVE_SYNC_CLAIM_MS = 10 * 60_000;
const HISTORY_PAST_DAYS = 5 * 366;
const HISTORY_CHUNK_DAYS = 350;
const HISTORY_BACKFILL_KICK_DEBOUNCE_MS = 6 * 60 * 60_000;

export interface CalendarSyncResult {
  ok: boolean;
  accountId: string;
  calendars: number;
  events: number;
  unauthorized?: boolean;
  skipped?: boolean;
  reason?: string;
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
  searchText?: string;
  yearMonth?: string;
  providerUpdatedAt?: number;
}

type ReconcileMutation = (fn: any, args: Record<string, unknown>) => Promise<any>;

export async function reconcileCalendarWindowBatched(
  args: Record<string, unknown>,
  mutate: ReconcileMutation = convexMutation,
) {
  let cursor: string | undefined;
  let pruned = 0;
  for (let batch = 0; batch < 1_000; batch += 1) {
    const result = await mutate(calendarApi.reconcileWindow, {
      ...args,
      ...(cursor ? { cursor } : {}),
      limit: 500,
    });
    pruned += Number(result?.pruned) || 0;
    if (result?.done) return { ok: true, pruned };
    if (!result?.continueCursor) throw new Error('Calendar reconciliation lost its continuation cursor.');
    cursor = result.continueCursor;
  }
  throw new Error('Calendar reconciliation exceeded 1,000 bounded batches.');
}

export async function syncCalendarAccount({
  userId,
  accountId,
  force = false,
  reason = 'active_window',
}: {
  userId: string;
  accountId: string;
  force?: boolean;
  reason?: string;
}): Promise<CalendarSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
  const windowStart = Date.now() - WINDOW_PAST_DAYS * 86_400_000;
  const windowEnd = Date.now() + WINDOW_FUTURE_DAYS * 86_400_000;
  const claim = await convexMutation<{ claimed: boolean; reason?: string; state?: any }>(
    calendarApi.claimCalendarSync,
    {
      userId,
      accountId,
      grantId: row.grantId,
      provider: row.provider,
      activeWindowMs: ACTIVE_SYNC_CLAIM_MS,
      force,
      progress: { stage: 'claimed', reason },
    },
  );
  if (!claim.claimed) {
    return {
      ok: true,
      accountId,
      calendars: Number(claim.state?.calendarsSynced) || 0,
      events: Number(claim.state?.eventsSynced) || 0,
      skipped: true,
      reason: claim.reason || 'not_claimed',
    };
  }
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
    let calendarIndex = 0;
    for (const calendar of calendars) {
      calendarIndex += 1;
      // Progress heartbeat: the surface shows "syncing · N events" live.
      await markSync(row, {
        status: 'syncing',
        calendarsSynced: calendarIndex,
        eventsSynced: totalEvents,
        progress: {
          stage: 'calendar_window',
          calendarId: calendar.providerCalendarId,
          calendarIndex,
          calendars: calendars.length,
        },
      }).catch(() => undefined);
      const events = await listCalendarEventsInWindow(
        row.grantId,
        calendar.providerCalendarId,
        windowStart,
        windowEnd,
        calendar.name,
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
      await reconcileCalendarWindowBatched({
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
      await markSync(row, { eventsSynced: totalEvents }).catch(() => undefined);
    }

    await markSync(row, {
      status: 'ready',
      calendarsSynced: calendars.length,
      eventsSynced: totalEvents,
      windowStart,
      windowEnd,
      lastSyncedAt: Date.now(),
      progress: { stage: 'ready', reason },
    });
    maybeKickCalendarHistoryBackfill(row);
    return { ok: true, accountId, calendars: calendars.length, events: totalEvents };
  } catch (err: any) {
    if (isGrantGoneError(err)) {
      // The provider grant no longer exists (e.g. a partially-failed account
      // removal). Terminal: stop retrying until the account is removed or
      // reconnected.
      await markSync(row, {
        status: 'unauthorized',
        error: 'This account’s connection no longer exists. Remove the account or reconnect it.',
      }).catch(() => undefined);
      return { ok: false, accountId, calendars: 0, events: 0, unauthorized: true };
    }
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

function isGrantGoneError(err: any): boolean {
  return /no grant found/i.test(String(err?.message || ''));
}

export async function syncAllCalendarAccounts(
  userId: string,
  options: { force?: boolean; reason?: string } = {},
): Promise<CalendarSyncResult[]> {
  const accounts = await convexQuery<NylasAccountRow[]>(accountsApi.listConnectedAccounts, { userId });
  const results: CalendarSyncResult[] = [];
  for (const account of accounts || []) {
    if (account.status !== 'connected') continue;
    try {
      results.push(
        await syncCalendarAccount({
          userId,
          accountId: account.accountId,
          force: options.force,
          reason: options.reason,
        }),
      );
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
  void syncCalendarAccount({ userId: row.userId, accountId: row.accountId, reason: 'lazy_kick' }).catch(
    (err) => {
      syncKickAt.delete(key);
      console.error(`[calendar] background sync failed for ${row.accountId}:`, err?.message || err);
    },
  );
}

const historyBackfillKickAt = new Map<string, number>();

function maybeKickCalendarHistoryBackfill(row: Pick<NylasAccountRow, 'userId' | 'accountId'>) {
  const key = `${row.userId}:${row.accountId}`;
  const last = historyBackfillKickAt.get(key) || 0;
  if (Date.now() - last < HISTORY_BACKFILL_KICK_DEBOUNCE_MS) return;
  historyBackfillKickAt.set(key, Date.now());
  void backfillCalendarHistoryChunk({ userId: row.userId, accountId: row.accountId }).catch((err) => {
    historyBackfillKickAt.delete(key);
    console.error(`[calendar] history backfill failed for ${row.accountId}:`, err?.message || err);
  });
}

export async function backfillCalendarHistoryChunk({
  userId,
  accountId,
  pastDays = HISTORY_PAST_DAYS,
  chunkDays = HISTORY_CHUNK_DAYS,
}: {
  userId: string;
  accountId: string;
  pastDays?: number;
  chunkDays?: number;
}): Promise<CalendarSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
  const state = await convexQuery<any | null>(calendarApi.getSyncState, { userId, accountId }).catch(
    () => null,
  );
  if (state?.historyBackfillReady) {
    return { ok: true, accountId, calendars: 0, events: 0, skipped: true, reason: 'history_ready' };
  }

  const nowMs = Date.now();
  const activeWindowStart = nowMs - WINDOW_PAST_DAYS * 86_400_000;
  const historyFloor = nowMs - Math.max(WINDOW_PAST_DAYS, pastDays) * 86_400_000;
  const cursorEnd = Math.min(
    Number.isFinite(Number(state?.historyCursorEnd)) ? Number(state?.historyCursorEnd) : activeWindowStart,
    activeWindowStart,
  );
  if (cursorEnd <= historyFloor) {
    await markSync(row, {
      status: 'ready',
      historyBackfillReady: true,
      historyWindowStart: historyFloor,
      progress: { stage: 'history_ready' },
    }).catch(() => undefined);
    return { ok: true, accountId, calendars: 0, events: 0, skipped: true, reason: 'history_ready' };
  }

  const windowEnd = cursorEnd;
  const windowStart = Math.max(historyFloor, cursorEnd - Math.max(30, chunkDays) * 86_400_000);
  const claim = await convexMutation<{ claimed: boolean; reason?: string; state?: any }>(
    calendarApi.claimCalendarSync,
    {
      userId,
      accountId,
      grantId: row.grantId,
      provider: row.provider,
      activeWindowMs: ACTIVE_SYNC_CLAIM_MS,
      progress: { stage: 'history_claimed', windowStart, windowEnd },
    },
  );
  if (!claim.claimed) {
    return {
      ok: true,
      accountId,
      calendars: Number(claim.state?.calendarsSynced) || 0,
      events: Number(claim.state?.eventsSynced) || 0,
      skipped: true,
      reason: claim.reason || 'not_claimed',
    };
  }

  try {
    const calendars = await listAllCalendars(row.grantId);
    await convexMutation(calendarApi.upsertCalendarBatch, {
      userId,
      accountId,
      grantId: row.grantId,
      provider: row.provider,
      calendars,
      pruneMissing: false,
    });
    let totalEvents = 0;
    for (const calendar of calendars) {
      const events = await listCalendarEventsInWindow(
        row.grantId,
        calendar.providerCalendarId,
        windowStart,
        windowEnd,
        calendar.name,
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
      await reconcileCalendarWindowBatched({
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
    const historyBackfillReady = windowStart <= historyFloor;
    await markSync(row, {
      status: 'ready',
      lastHistoryBackfillAt: Date.now(),
      historyCursorEnd: windowStart,
      historyWindowStart: historyFloor,
      historyBackfillReady,
      progress: {
        stage: historyBackfillReady ? 'history_ready' : 'history_chunk_ready',
        windowStart,
        windowEnd,
        events: totalEvents,
      },
    });
    return { ok: true, accountId, calendars: calendars.length, events: totalEvents };
  } catch (err: any) {
    await markSync(row, {
      status: 'error',
      error: err?.message || 'calendar history backfill failed',
      progress: { stage: 'history_error', windowStart, windowEnd },
    }).catch(() => undefined);
    throw err;
  }
}

// Webhook delta: plain events apply as point upserts/deletes; anything in a
// recurring series triggers a debounced account resync, because one payload
// can imply many expanded instances changing.
export async function applyCalendarWebhookDelta(row: NylasAccountRow, type: string, payload: unknown) {
  const object = extractWebhookObject(payload);
  if (/^calendar\./.test(type)) {
    maybeKickCalendarSync(row);
    await markSync(row, {
      progress: { stage: 'calendar_webhook', type, calendarId: str(object.id) },
      lastWebhookAt: Date.now(),
      lastIncrementalSyncAt: Date.now(),
    }).catch(() => undefined);
    return;
  }
  const providerEventId = str(object.id);
  const providerCalendarId = str(object.calendarId ?? object.calendar_id);
  if (!providerEventId) {
    await markSync(row, {
      progress: { stage: 'event_webhook_ignored', type, reason: 'missing_event_id' },
      lastWebhookAt: Date.now(),
    }).catch(() => undefined);
    return;
  }
  if (/deleted/i.test(type)) {
    await convexMutation(calendarApi.deleteEvent, {
      userId: row.userId,
      accountId: row.accountId,
      providerCalendarId,
      providerEventId,
      includeInstances: true,
    });
    await markCalendarWebhookApplied(row, type, providerEventId);
    return;
  }
  const isRecurring =
    Array.isArray(object.recurrence) || str(object.master_event_id) || str(object.masterEventId);
  if (isRecurring) {
    maybeKickCalendarSync(row);
    await markCalendarWebhookApplied(row, type, providerEventId, { recurring: true });
    return;
  }
  const event = toEventInput(object) || (await fetchWebhookEvent(row, providerEventId, providerCalendarId));
  if (!event) {
    maybeKickCalendarSync(row);
    await markSync(row, {
      progress: { stage: 'event_webhook_resync', type, eventId: providerEventId },
      lastWebhookAt: Date.now(),
      lastIncrementalSyncAt: Date.now(),
    }).catch(() => undefined);
    return;
  }
  if (event.status === 'cancelled') {
    await convexMutation(calendarApi.deleteEvent, {
      userId: row.userId,
      accountId: row.accountId,
      providerCalendarId: event.providerCalendarId,
      providerEventId,
      includeInstances: true,
    });
    await markCalendarWebhookApplied(row, type, providerEventId, { cancelled: true });
    return;
  }
  await convexMutation(calendarApi.upsertEventBatch, {
    userId: row.userId,
    accountId: row.accountId,
    grantId: row.grantId,
    provider: row.provider,
    events: [event],
  });
  await markCalendarWebhookApplied(row, type, providerEventId);
}

export function isCalendarWebhookType(type: string) {
  return /^event\.|^calendar\./.test(type);
}

async function fetchWebhookEvent(
  row: NylasAccountRow,
  eventId: string,
  calendarId?: string,
): Promise<EventInputRow | null> {
  if (!calendarId) return null;
  try {
    const response = await withNylasRetry(() =>
      requireNylas().events.find({
        identifier: row.grantId,
        eventId,
        queryParams: { calendarId } as any,
      }),
    );
    return toEventInput(response.data as any, calendarId);
  } catch (err: any) {
    const status = nylasErrorStatus(err);
    if (status === 404 || status === 410) return null;
    throw err;
  }
}

async function markCalendarWebhookApplied(
  row: NylasAccountRow,
  type: string,
  eventId: string,
  detail: Record<string, unknown> = {},
) {
  await markSync(row, {
    progress: { stage: 'event_webhook', type, eventId, ...detail },
    lastWebhookAt: Date.now(),
    lastIncrementalSyncAt: Date.now(),
  }).catch(() => undefined);
}

async function listAllCalendars(grantId: string): Promise<CalendarInputRow[]> {
  const out: CalendarInputRow[] = [];
  let pageToken: string | undefined;
  do {
    const page = await withNylasRetry(() =>
      requireNylas().calendars.list({
        identifier: grantId,
        queryParams: { limit: 50, ...(pageToken ? { pageToken } : {}) } as any,
      }),
    );
    for (const cal of page.data || []) {
      out.push(toCalendarInput(cal));
    }
    pageToken = (page as any).nextCursor || undefined;
  } while (pageToken);
  return out;
}

// iCloud rejects event queries spanning more than one year, so the window is
// always walked in sub-year chunks (harmless for the other providers). The
// chunk boundary never splits an event: queries match by overlap, and the
// upsert path dedupes by providerEventId.
const EVENT_QUERY_CHUNK_MS = 350 * 86_400_000;

async function listCalendarEventsInWindow(
  grantId: string,
  calendarId: string,
  windowStart: number,
  windowEnd: number,
  calendarName?: string,
): Promise<EventInputRow[]> {
  const byId = new Map<string, EventInputRow>();
  for (let chunkStart = windowStart; chunkStart < windowEnd; chunkStart += EVENT_QUERY_CHUNK_MS) {
    const chunkEnd = Math.min(chunkStart + EVENT_QUERY_CHUNK_MS, windowEnd);
    let pageToken: string | undefined;
    do {
      const page = await withNylasRetry(() =>
        requireNylas().events.list({
          identifier: grantId,
          queryParams: {
            calendarId,
            start: String(Math.floor(chunkStart / 1000)),
            end: String(Math.floor(chunkEnd / 1000)),
            expandRecurring: true,
            limit: EVENT_PAGE_LIMIT,
            ...(pageToken ? { pageToken } : {}),
          } as any,
        }),
      );
      for (const raw of page.data || []) {
        const event = toEventInput(raw, calendarId, calendarName);
        if (event) byId.set(event.providerEventId, event);
      }
      pageToken = (page as any).nextCursor || undefined;
    } while (pageToken);
  }
  return [...byId.values()];
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
export function toEventInput(
  raw: any,
  fallbackCalendarId?: string,
  calendarName?: string,
): EventInputRow | null {
  const providerEventId = str(raw.id);
  const providerCalendarId = str(raw.calendarId ?? raw.calendar_id) || fallbackCalendarId;
  const when = raw.when || {};
  if (!providerEventId || !providerCalendarId) return null;
  const times = whenToTimes(when);
  if (!times) return null;
  const recurrence = Array.isArray(raw.recurrence) ? raw.recurrence.map(String) : undefined;
  const participants = Array.isArray(raw.participants) ? raw.participants : undefined;
  const organizer = raw.organizer ?? undefined;
  const conferencing = raw.conferencing ?? undefined;
  const title = str(raw.title) || '(no title)';
  const description = str(raw.description);
  const location = str(raw.location);
  const status = str(raw.status);
  const icalUid = str(raw.icalUid ?? raw.ical_uid);
  const htmlLink = str(raw.htmlLink ?? raw.html_link);
  return {
    providerEventId,
    providerCalendarId,
    title,
    description,
    location,
    status,
    busy: bool(raw.busy),
    readOnly: bool(raw.readOnly ?? raw.read_only),
    ...times,
    masterEventId: str(raw.masterEventId ?? raw.master_event_id),
    recurrence,
    participants,
    organizer,
    conferencing,
    icalUid,
    htmlLink,
    providerUpdatedAt: timestampMs(raw.updatedAt ?? raw.updated_at),
    yearMonth: calendarYearMonthFromTimestamp(times.startAt),
    searchText: buildCalendarEventSearchText({
      title,
      description,
      location,
      status,
      calendarName,
      recurrence,
      participants,
      organizer,
      conferencing,
      icalUid,
      htmlLink,
    }),
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
    lastIncrementalSyncAt?: number;
    lastWebhookAt?: number;
    lastHistoryBackfillAt?: number;
    historyCursorEnd?: number;
    historyWindowStart?: number;
    historyBackfillReady?: boolean;
    progress?: unknown;
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

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
