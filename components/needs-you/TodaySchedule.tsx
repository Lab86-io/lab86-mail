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

const AFTER_ANY_DAY_MS = 26 * 60 * 60_000;

/** The local day from its start to the next midnight: a day can have 23 or 25 hours. */
export function localDayWindow(startAt: number, timezone: string) {
  return { startAt, endAt: startOfLocalDay(startAt + AFTER_ANY_DAY_MS, timezone) };
}

/** The events of the local day. Undefined while they load, or before sign-in. */
export function useDayEvents(now: number, timezone: string | undefined) {
  const { isAuthenticated } = useConvexAuth();
  const startAt = timezone ? startOfLocalDay(now, timezone) : undefined;
  // The start changes once a day, so the subscription stays open all day.
  const args = useMemo(
    () => (startAt === undefined || !timezone ? null : localDayWindow(startAt, timezone)),
    [startAt, timezone],
  );
  return useQuery(dayEventsQuery, isAuthenticated && args ? args : 'skip');
}

const clock = (at: number, timezone: string) => clockLabel(at, timezone).replace(' ', '\u00a0');

const TITLE_TONE: Record<ScheduleState, string> = {
  past: 'text-[var(--color-text-muted)]',
  now: 'font-medium text-[var(--color-text)]',
  next: 'font-medium text-[var(--color-text)]',
  later: 'font-medium text-[var(--color-text)]',
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
  return (
    <section data-today-schedule aria-label="Schedule" className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <h2 className="font-display text-[17px] font-medium tracking-tight text-[var(--color-text)]">
          Schedule
        </h2>
        <button
          type="button"
          onClick={onOpen}
          className="rounded-ui text-[13px] font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]"
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
                className="flex items-center gap-2 py-2 text-[13px] text-[var(--color-text-muted)]"
              >
                <span>Free until {line.until ? clock(line.until, timezone) : 'the end of the day'}</span>
                <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
              </li>
            ) : (
              <li
                key={line.event.id}
                data-today-event={line.state}
                className={cn(
                  'grid grid-cols-[62px_minmax(0,1fr)] items-baseline gap-x-2',
                  line.state === 'past' ? 'py-0.5' : 'py-1.5',
                  // Only what runs now has a fill. The text stays on the column edge.
                  line.state === 'now' &&
                    '-mx-2 my-0.5 rounded-[var(--radius-control)] bg-[var(--color-accent-soft)] px-2',
                )}
              >
                <span
                  className={cn(
                    'text-[13px] leading-[20px] tabular-nums',
                    line.state === 'past'
                      ? 'text-[var(--color-text-muted)]'
                      : line.state === 'now' || line.state === 'next'
                        ? 'text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)]',
                  )}
                >
                  {clock(line.event.startAt, timezone)}
                  {line.state === 'now' || line.state === 'next' ? (
                    <span
                      className={cn(
                        'block text-[12px] font-medium leading-[18px]',
                        line.state === 'now' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]',
                      )}
                    >
                      {line.state === 'now' ? 'Now' : 'Next'}
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-[14px] leading-[20px]', TITLE_TONE[line.state])}>
                    {line.event.title}
                  </span>
                  {line.state === 'now' || line.state === 'next' ? (
                    <span className="block text-[13px] leading-[18px] text-[var(--color-text-muted)]">
                      {line.state === 'next' && line.event.location
                        ? line.event.location
                        : `Ends ${clock(line.event.endAt, timezone)}`}
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
