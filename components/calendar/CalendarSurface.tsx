'use client';

import { useMutation as useConvexMutation, useQuery_experimental as useConvexQuery } from 'convex/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CalendarBody } from '@/components/calendar/engine/calendar-body';
import { type CalendarPersistence, CalendarProvider } from '@/components/calendar/engine/calendar-context';
import { CalendarHeader } from '@/components/calendar/engine/calendar-header';
import { DndProvider } from '@/components/calendar/engine/dnd-context';
import type { IEvent, IUser } from '@/components/calendar/engine/interfaces';
import { CalendarDaysIcon } from '@/components/ui/calendar-days';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';

// Tableau-10 categorical palette: opaque, distinguishable, configurable
// per calendar (calendars.colorIndex).
export const TABLEAU10 = [
  '#4E79A7',
  '#F28E2B',
  '#E15759',
  '#76B7B2',
  '#59A14E',
  '#EDC948',
  '#B07AA1',
  '#FF9DA7',
  '#9C755F',
  '#BAB0AC',
] as const;

const TASKS_COLOR = '#EDC948';

// Due-dated Kanban cards appear as a pseudo-calendar lane; their event ids
// are prefixed so persistence can route them to card mutations instead of
// Nylas.
const TASKS_LANE_ID = '__tasks__';
const TASK_EVENT_PREFIX = 'task_';

// Shared stable empty array — see the loop note where it's consumed.
const EMPTY_ARRAY: any[] = [];

// The visible data window mirrors the sync window (lib/calendar/sync.ts).
const WINDOW_PAST_MS = 92 * 86_400_000;
const WINDOW_FUTURE_MS = 366 * 86_400_000;

export function CalendarSurface() {
  // Stable bounds: recomputing per render would resubscribe the live query.
  const [window] = useState(() => ({
    startAt: Date.now() - WINDOW_PAST_MS,
    endAt: Date.now() + WINDOW_FUTURE_MS,
  }));

  const liveCalendars = useConvexQuery({
    query: (api as any).calendarData.liveCalendars,
    args: {},
  });
  const liveEvents = useConvexQuery({
    query: (api as any).calendarData.liveEvents,
    args: window,
  });
  // Cross-surface: due-dated cards ride the calendar as a distinct lane.
  const liveDueCards = useConvexQuery({
    query: (api as any).boards.listDueCards,
    args: window,
  });
  const updateCard = useConvexMutation((api as any).boards.updateCard);

  // One nudge per mount: kicks a debounced resync for stale/never-synced
  // accounts (the tool no-ops when everything is fresh).
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current) return;
    kicked.current = true;
    void callTool('calendar_list_calendars', {}).catch(() => undefined);
  }, []);

  // Stable empty fallbacks: `data || []` minting a fresh [] every render
  // cascades through the memos below into the calendar context's
  // useEffect([events]) → setState → re-render → infinite loop (React #185).
  // Reusing one EMPTY ref keeps identities stable until the data truly changes.
  const calendars: any[] =
    liveCalendars.status === 'success' ? liveCalendars.data?.calendars || EMPTY_ARRAY : EMPTY_ARRAY;
  const syncStates: any[] =
    liveCalendars.status === 'success' ? liveCalendars.data?.syncStates || EMPTY_ARRAY : EMPTY_ARRAY;
  const eventRows: any[] = liveEvents.status === 'success' ? liveEvents.data || EMPTY_ARRAY : EMPTY_ARRAY;

  const colorByCalendar = useMemo(() => {
    const map = new Map<string, string>();
    calendars.forEach((cal, index) => {
      map.set(cal.providerCalendarId, TABLEAU10[(cal.colorIndex ?? index) % TABLEAU10.length]);
    });
    return map;
  }, [calendars]);

  const dueCards: any[] = liveDueCards.status === 'success' ? liveDueCards.data || EMPTY_ARRAY : EMPTY_ARRAY;

  const users: IUser[] = useMemo(() => {
    const list = calendars
      .filter((cal) => !cal.hidden)
      .map((cal) => ({ id: cal.providerCalendarId, name: cal.name, picturePath: null }));
    if (dueCards.length) list.push({ id: TASKS_LANE_ID, name: 'Tasks', picturePath: null });
    return list;
  }, [calendars, dueCards.length]);

  const events: IEvent[] = useMemo(() => {
    const visible = new Set(users.map((user) => user.id));
    // Due-dated cards render as 30-minute task blocks; dragging one
    // reschedules the card's due date (see persistence below).
    const taskEvents: IEvent[] = dueCards.map((card) => ({
      id: `${TASK_EVENT_PREFIX}${card.cardId}`,
      startDate: new Date(card.dueAt).toISOString(),
      endDate: new Date(card.dueAt + 30 * 60_000).toISOString(),
      title: card.completedAt ? `✓ ${card.title}` : card.title,
      description: card.description || '',
      color: 'yellow',
      colorHex: TASKS_COLOR,
      user: { id: TASKS_LANE_ID, name: 'Tasks', picturePath: null },
      calendarId: TASKS_LANE_ID,
    }));
    return taskEvents.concat(
      eventRows
        .filter((row) => visible.has(row.providerCalendarId))
        .map((row) => ({
          id: row.providerEventId,
          startDate: new Date(row.startAt).toISOString(),
          endDate: new Date(row.endAt).toISOString(),
          title: row.title,
          description: row.description || '',
          color: 'blue',
          colorHex: colorByCalendar.get(row.providerCalendarId) || TABLEAU10[0],
          user: {
            id: row.providerCalendarId,
            name: calendars.find((cal) => cal.providerCalendarId === row.providerCalendarId)?.name || '',
            picturePath: null,
          },
          accountId: row.accountId,
          calendarId: row.providerCalendarId,
          readOnly: row.readOnly,
          allDay: row.allDay,
          location: row.location,
          masterEventId: row.masterEventId,
          participants: row.participants,
          organizer: row.organizer,
          conferencing: row.conferencing,
          recurrence: row.recurrence,
          htmlLink: row.htmlLink,
        })),
    );
  }, [eventRows, users, calendars, colorByCalendar, dueCards]);

  // New events land on the primary writable calendar; edits route to the
  // event's own calendar. Failures toast and the live resync restores truth.
  const defaultCalendar = useMemo(() => {
    const writable = calendars.filter((cal) => !cal.readOnly && !cal.hidden);
    return writable.find((cal) => cal.isPrimary) || writable[0] || null;
  }, [calendars]);

  // Options for the add-event dialog: every writable calendar with its
  // categorical color; the account decides the color, not a "variant".
  const writableCalendars = useMemo(
    () =>
      calendars
        .filter((cal) => !cal.readOnly && !cal.hidden)
        .map((cal) => ({
          id: cal.providerCalendarId,
          name: cal.name,
          colorHex: colorByCalendar.get(cal.providerCalendarId) || TABLEAU10[0],
          accountId: cal.accountId,
        })),
    [calendars, colorByCalendar],
  );

  const persistence: CalendarPersistence = useMemo(
    () => ({
      onEventAdded: async (event) => {
        const account = event.accountId || defaultCalendar?.accountId;
        const calendarId = event.calendarId || defaultCalendar?.providerCalendarId;
        if (!account || !calendarId) {
          toast.error('No writable calendar is synced yet.');
          return;
        }
        try {
          await callTool('calendar_create_event', {
            account,
            calendarId,
            title: event.title,
            startIso: event.startDate,
            endIso: event.endDate,
            allDay: Boolean(event.allDay),
            description: event.description || undefined,
            attendees: (event.participants || [])
              .filter((p) => p.email)
              .map((p) => ({ email: p.email as string, name: p.name })),
            recurrence: event.recurrence,
          });
        } catch (err: any) {
          toast.error(err?.message || 'Could not create the event.');
        }
      },
      onEventUpdated: async (event) => {
        if (event.id.startsWith('local_')) return;
        if (event.id.startsWith(TASK_EVENT_PREFIX)) {
          // Dragging a task block reschedules the card's due date.
          try {
            await updateCard({
              cardId: event.id.slice(TASK_EVENT_PREFIX.length),
              dueAt: new Date(event.startDate).getTime(),
            });
          } catch (err: any) {
            toast.error(err?.message || 'Could not reschedule the task.');
          }
          return;
        }
        if (!event.accountId || !event.calendarId) return;
        try {
          await callTool('calendar_update_event', {
            account: event.accountId,
            calendarId: event.calendarId,
            eventId: event.id,
            title: event.title,
            startIso: event.startDate,
            endIso: event.endDate,
            description: event.description || undefined,
          });
        } catch (err: any) {
          toast.error(err?.message || 'Could not update the event.');
        }
      },
      onEventRemoved: async (event, options) => {
        if (event.id.startsWith('local_')) return;
        if (event.id.startsWith(TASK_EVENT_PREFIX)) {
          // Removing a task block clears the due date; the card survives.
          try {
            await updateCard({ cardId: event.id.slice(TASK_EVENT_PREFIX.length), dueAt: null });
          } catch (err: any) {
            toast.error(err?.message || 'Could not clear the due date.');
          }
          return;
        }
        if (!event.accountId || !event.calendarId) return;
        try {
          await callTool('calendar_delete_event', {
            account: event.accountId,
            calendarId: event.calendarId,
            eventId: event.id,
            deleteSeries: options?.deleteSeries ?? false,
          });
        } catch (err: any) {
          toast.error(err?.message || 'Could not delete the event.');
        }
      },
    }),
    [defaultCalendar, updateCard],
  );

  const unauthorized = syncStates.filter((state) => state.status === 'unauthorized');
  const syncing = syncStates.filter((state) => state.status === 'syncing');
  const loading = liveCalendars.status !== 'success' || liveEvents.status !== 'success';
  const nothingSynced = !loading && calendars.length === 0;

  if (nothingSynced) {
    return (
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        <SurfaceHeader />
        <div className="grid flex-1 place-items-center px-6">
          <div className="flex max-w-md flex-col items-center gap-3 text-center">
            <span className="grid size-12 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)]">
              <CalendarDaysIcon size={22} />
            </span>
            <p className="font-display text-[16px] font-semibold text-[var(--color-text)]">
              {unauthorized.length ? 'Calendar access needed' : 'No calendars synced yet'}
            </p>
            <p className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              {unauthorized.length
                ? 'Your accounts were connected before calendar support existed. Reconnect them from Settings to grant calendar access — everything else keeps working meanwhile.'
                : 'Connect an account in Settings, or wait a moment while the first sync completes.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {unauthorized.length ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)] px-4 py-2 text-[12.5px] text-[var(--color-text-muted)]">
          <span>Missing calendar access:</span>
          {unauthorized.map((state) => (
            <a
              key={state.accountId}
              href={`/api/nylas/connect?provider=${state.provider}&redirectTo=/`}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[11.5px] text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              title={state.error || 'Reconnect to grant calendar access'}
            >
              {state.email || state.accountId.slice(0, 8)}
              <span className="text-[var(--color-accent)]">· reconnect</span>
            </a>
          ))}
        </div>
      ) : null}
      {syncing.length ? (
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-1.5 text-[12px] text-[var(--color-text-muted)]">
          <span className="size-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
          {syncing
            .map(
              (state) =>
                `${state.email || 'calendar'} syncing · ${state.eventsSynced ?? 0} events${
                  state.calendarsSynced ? ` · calendar ${state.calendarsSynced}` : ''
                }`,
            )
            .join('  ·  ')}
        </div>
      ) : null}
      {/* font-display so the calendar's headings, dates, and event titles
          follow the user's chosen display font (theme customization). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden font-display">
        <CalendarProvider
          users={users}
          events={events}
          view="week"
          persistence={persistence}
          writableCalendars={writableCalendars}
        >
          <DndProvider>
            <CalendarHeader />
            <CalendarColorBar calendars={calendars} colorByCalendar={colorByCalendar} />
            <CalendarBody />
          </DndProvider>
        </CalendarProvider>
      </div>
    </div>
  );
}

// One chip per synced calendar: shows its categorical color; clicking opens
// the ten-swatch picker. Colors persist per calendar (colorIndex).
function CalendarColorBar({
  calendars,
  colorByCalendar,
}: {
  calendars: any[];
  colorByCalendar: Map<string, string>;
}) {
  const setCalendarColor = useConvexMutation((api as any).calendarData.setCalendarColor);
  if (!calendars.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-4 py-1.5">
      {calendars
        .filter((cal) => !cal.hidden)
        .map((cal) => (
          <Popover key={cal._id}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11.5px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text)]"
                title={`${cal.name} — change color`}
              >
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: colorByCalendar.get(cal.providerCalendarId) }}
                />
                <span className="max-w-36 truncate">{cal.name}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-2" align="start">
              <div className="flex gap-1.5">
                {TABLEAU10.map((hex, index) => (
                  <button
                    key={hex}
                    type="button"
                    title={hex}
                    onClick={() => {
                      void setCalendarColor({ calendarId: cal._id, colorIndex: index }).catch((err: any) =>
                        toast.error(err?.message || 'Could not set color'),
                      );
                    }}
                    className={
                      colorByCalendar.get(cal.providerCalendarId) === hex
                        ? 'size-6 rounded-full ring-2 ring-[var(--color-text)] ring-offset-1'
                        : 'size-6 rounded-full transition-transform hover:scale-110'
                    }
                    style={{ backgroundColor: hex }}
                  >
                    <span className="sr-only">{hex}</span>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        ))}
    </div>
  );
}

function SurfaceHeader() {
  return (
    <header className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 pb-4 pt-12 md:pt-5">
      <h1 className="font-display text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
        Calendar
      </h1>
    </header>
  );
}
