'use client';

import { isSameDay, parseISO } from 'date-fns';
import { motion } from 'motion/react';
import { AgendaEvents } from '@/components/calendar/engine/agenda-events';
import { fadeIn, transition } from '@/components/calendar/engine/animations';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { CalendarDayView } from '@/components/calendar/engine/calendar-day-view';
import { CalendarMonthView } from '@/components/calendar/engine/calendar-month-view';
import { CalendarWeekView } from '@/components/calendar/engine/calendar-week-view';
import { CalendarYearView } from '@/components/calendar/engine/calendar-year-view';

export function CalendarBody() {
  const { view, events } = useCalendar();

  // All-day events always ride the day row, even a one-day event that starts
  // and ends on the same local date; they never go into the hour grid.
  const isSpanRow = (event: (typeof events)[number]) =>
    Boolean(event.allDay) || !isSameDay(parseISO(event.startDate), parseISO(event.endDate));
  const singleDayEvents = events.filter((event) => !isSpanRow(event));
  const multiDayEvents = events.filter(isSpanRow);

  return (
    <div className="@container/calendar-view relative flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <motion.div
        key={view}
        className="min-h-0 flex-1"
        initial="initial"
        animate="animate"
        exit="exit"
        variants={fadeIn}
        transition={transition}
      >
        {view === 'month' && (
          <CalendarMonthView singleDayEvents={singleDayEvents} multiDayEvents={multiDayEvents} />
        )}
        {view === 'week' && (
          <CalendarWeekView singleDayEvents={singleDayEvents} multiDayEvents={multiDayEvents} />
        )}
        {view === 'day' && (
          <CalendarDayView singleDayEvents={singleDayEvents} multiDayEvents={multiDayEvents} />
        )}
        {view === 'year' && (
          <CalendarYearView singleDayEvents={singleDayEvents} multiDayEvents={multiDayEvents} />
        )}
        {view === 'agenda' && (
          <motion.div
            key="agenda"
            initial="initial"
            animate="animate"
            exit="exit"
            variants={fadeIn}
            transition={transition}
          >
            <AgendaEvents />
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
