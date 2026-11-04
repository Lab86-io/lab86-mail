'use client';

import { useConvexAuth, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { useMemo } from 'react';
import { startOfLocalDay } from '@/lib/obligations/rules';
import {
  allDayEvents,
  clockLabel,
  type ScheduleState,
  scheduleLines,
  type TodayScheduleEvent,
} from '@/lib/obligations/today-page';
import { cn } from '@/lib/utils';

const dayEventsQuery = makeFunctionReference<
  'query',
  { startAt: number; endAt: number },
  TodayScheduleEvent[]
>('calendarData:myDayEvents');

const DAY_MS = 24 * 60 * 60_000;

/** The events of the local day. Undefined while they load, or before sign-in. */
export function useDayEvents(now: number, timezone: string | undefined) {
  const { isAuthenticated } = useConvexAuth();
  const startAt = timezone ? startOfLocalDay(now, timezone) : undefined;
  // The start changes once a day, so the subscription stays open all day.
  const args = useMemo(
    () => (startAt === undefined ? null : { startAt, endAt: startAt + DAY_MS }),
    [startAt],
  );
  return useQuery(dayEventsQuery, isAuthenticated && args ? args : 'skip');
}

function clock(at: number, timezone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(at))
    .replace(/:00/, '')
    .replace(' ', ' ');
}

const TITLE_TONE: Record<ScheduleState, string> = {
  past: 'text-[var(--color-text-muted)]',
  now: 'font-medium text-[var(--color-text)]',
  next: 'font-medium text-[var(--color-text)]',
  later: 'text-[var(--color-text)]',
};

/** The day as a short list: what passed, what runs, what is next, and the open room between. */
export function TodaySchedule({
  events,
  now,
  timezone,
  onOpen,
}: {
  events: readonly TodayScheduleEvent[] | undefined;
  now: number;
  timezone: string;
  onOpen: () => void;
}) {
  const lines = useMemo(() => scheduleLines(events ?? [], now), [events, now]);
  const allDay = useMemo(() => allDayEvents(events ?? []), [events]);
  // One line carries the present: what runs now, or else what comes next.
  const present = useMemo(() => {
    const timed = lines.flatMap((line) => (line.type === 'event' ? [line] : []));
    return (timed.find((line) => line.state === 'now') ?? timed.find((line) => line.state === 'next'))?.event.id;
  }, [lines]);
  return (
    <section data-today-schedule aria-label="Schedule" className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <h2 className="font-display text-[17px] font-medium tracking-tight text-[var(--color-text)]">
          Schedule
        </h2>
        <button
          type="button"
          onClick={onOpen}
          className="rounded-ui text-[12.5px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]"
        >
          Open calendar
        </button>
      </div>
      <div className="border-t border-[var(--color-border)] pt-2">
        {allDay.map((event) => (
          <p key={event.id} className="py-1 text-[13px] text-[var(--color-text-muted)]">
            {event.title}
          </p>
        ))}
        {events && !lines.length ? (
          <p className="py-1.5 text-[13px] text-[var(--color-text-muted)]">Nothing is scheduled today.</p>
        ) : null}
        <ol>
          {lines.map((line) =>
            line.type === 'open' ? (
              <li
                key={line.id}
                data-today-open
                className="grid grid-cols-[62px_minmax(0,1fr)] gap-x-2 py-1.5 text-[12.5px] text-[var(--color-text-muted)]"
              >
                <span aria-hidden />
                <span>Open until {line.until ? clock(line.until, timezone) : 'the end of the day'}</span>
              </li>
            ) : (
              <li
                key={line.event.id}
                data-today-event={line.state}
                className={cn(
                  'grid grid-cols-[62px_minmax(0,1fr)] items-baseline gap-x-2',
                  line.state === 'past' ? 'py-0.5' : 'py-1.5',
                  present === line.event.id &&
                    '-ml-2.5 mt-1 rounded-r-[var(--radius-control)] border-l-2 border-[var(--color-accent)] bg-[var(--color-accent-soft)] pl-2',
                )}
              >
                <span
                  className={cn(
                    'text-[12.5px] tabular-nums',
                    line.state === 'past'
                      ? 'text-[var(--color-text-muted)]'
                      : line.state === 'now'
                        ? 'font-medium text-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)]',
                  )}
                >
                  {line.state === 'now' ? 'Now' : clock(line.event.startAt, timezone)}
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-[13.5px] leading-[18px]', TITLE_TONE[line.state])}>
                    {line.event.title}
                  </span>
                  {line.state === 'now' || line.state === 'next' ? (
                    <span className="mt-0.5 block text-[11.5px] leading-[15px] text-[var(--color-text-muted)]">
                      {line.state === 'now'
                        ? `Until ${clock(line.event.endAt, timezone)}`
                        : line.event.location || `Ends ${clock(line.event.endAt, timezone)}`}
                    </span>
                  ) : null}
                </span>
              </li>
            ),
          )}
        </ol>
      </div>
    </section>
  );
}
