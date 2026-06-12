'use client';

import { useMutation as useConvexMutation, useQuery_experimental as useConvexQuery } from 'convex/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CalendarBody } from '@/components/calendar/engine/calendar-body';
import { type CalendarPersistence, CalendarProvider } from '@/components/calendar/engine/calendar-context';
import { CalendarHeader } from '@/components/calendar/engine/calendar-header';
import { DndProvider } from '@/components/calendar/engine/dnd-context';
import type { IEvent, IUser } from '@/components/calendar/engine/interfaces';
import type { TEventColor } from '@/components/calendar/engine/types';
import { CalendarDaysIcon } from '@/components/ui/calendar-days';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';

const EVENT_COLORS: TEventColor[] = ['blue', 'green', 'red', 'yellow', 'purple', 'orange'];

// Due-dated Kanban cards appear as a pseudo-calendar lane; their event ids
// are prefixed so persistence can route them to card mutations instead of
// Nylas.
const TASKS_LANE_ID = '__tasks__';
const TASK_EVENT_PREFIX = 'task_';

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

  const calendars: any[] = liveCalendars.status === 'success' ? liveCalendars.data?.calendars || [] : [];
  const syncStates: any[] = liveCalendars.status === 'success' ? liveCalendars.data?.syncStates || [] : [];
  const eventRows: any[] = liveEvents.status === 'success' ? liveEvents.data || [] : [];

  const colorByCalendar = useMemo(() => {
    const map = new Map<string, TEventColor>();
    calendars.forEach((cal, index) => {
      map.set(cal.providerCalendarId, EVENT_COLORS[index % EVENT_COLORS.length]);
    });
    return map;
  }, [calendars]);

  const dueCards: any[] = liveDueCards.status === 'success' ? liveDueCards.data || [] : [];

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
          color: colorByCalendar.get(row.providerCalendarId) || 'blue',
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
        })),
    );
  }, [eventRows, users, calendars, colorByCalendar, dueCards]);

  // New events land on the primary writable calendar; edits route to the
  // event's own calendar. Failures toast and the live resync restores truth.
  const defaultCalendar = useMemo(() => {
    const writable = calendars.filter((cal) => !cal.readOnly && !cal.hidden);
    return writable.find((cal) => cal.isPrimary) || writable[0] || null;
  }, [calendars]);

  const persistence: CalendarPersistence = useMemo(
    () => ({
      onEventAdded: async (event) => {
        if (!defaultCalendar) {
          toast.error('No writable calendar is synced yet.');
          return;
        }
        try {
          await callTool('calendar_create_event', {
            account: defaultCalendar.accountId,
            calendarId: defaultCalendar.providerCalendarId,
            title: event.title,
            startIso: event.startDate,
            endIso: event.endDate,
            allDay: Boolean(event.allDay),
            description: event.description || undefined,
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
      onEventRemoved: async (event) => {
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
          });
        } catch (err: any) {
          toast.error(err?.message || 'Could not delete the event.');
        }
      },
    }),
    [defaultCalendar, updateCard],
  );

  const unauthorized = syncStates.filter((state) => state.status === 'unauthorized');
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
        <div className="border-b border-[var(--color-border)] bg-[var(--color-accent-soft)] px-4 py-2 text-[12.5px] text-[var(--color-text-muted)]">
          {unauthorized.length === 1 ? 'One account needs' : `${unauthorized.length} accounts need`} a
          reconnect to grant calendar access. Their events are missing from this view.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CalendarProvider users={users} events={events} view="week" persistence={persistence}>
          <DndProvider>
            <CalendarHeader />
            <CalendarBody />
          </DndProvider>
        </CalendarProvider>
      </div>
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
