import { addDays, format, isSameDay, parseISO, startOfWeek } from 'date-fns';
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { AddEditEventDialog } from '@/components/calendar/engine/add-edit-event-dialog';
import { fadeIn, staggerContainer, transition } from '@/components/calendar/engine/animations';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { CalendarTimeline } from '@/components/calendar/engine/calendar-time-line';
import { DroppableArea } from '@/components/calendar/engine/droppable-area';
import { groupEvents } from '@/components/calendar/engine/helpers';
import type { IEvent } from '@/components/calendar/engine/interfaces';
import { RenderGroupedEvents } from '@/components/calendar/engine/render-grouped-events';
import { WeekViewMultiDayEventsRow } from '@/components/calendar/engine/week-view-multi-day-events-row';
import { ScrollArea } from '@/components/ui/scroll-area';

interface IProps {
  singleDayEvents: IEvent[];
  multiDayEvents: IEvent[];
}

export function CalendarWeekView({ singleDayEvents, multiDayEvents }: IProps) {
  const { selectedDate, setSelectedDate, use24HourFormat, hourHeight, setHourHeight } = useCalendar();

  const weekStart = startOfWeek(selectedDate);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const hours = Array.from({ length: 24 }, (_, i) => i);

  // Land on the working day, not midnight: scroll to ~8am on mount and keep
  // the same anchor when the zoom level changes.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (viewport) viewport.scrollTop = 7.5 * hourHeight;
  }, [hourHeight]);

  // Trackpad gestures: pinch (ctrl+wheel) zooms the hour height; a clear
  // horizontal swipe pages to the previous/next week.
  const swipeAccum = useRef(0);
  const swipeLock = useRef(0);
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (!viewport) return;
    const onWheel = (event: Event) => {
      const wheel = event as WheelEvent;
      if (wheel.ctrlKey) {
        wheel.preventDefault();
        setHourHeight(hourHeight - Math.sign(wheel.deltaY) * 8);
        return;
      }
      if (Math.abs(wheel.deltaX) <= Math.abs(wheel.deltaY)) return;
      wheel.preventDefault();
      const nowTs = Date.now();
      if (nowTs - swipeLock.current < 450) return;
      swipeAccum.current += wheel.deltaX;
      if (Math.abs(swipeAccum.current) > 110) {
        const direction = Math.sign(swipeAccum.current);
        swipeAccum.current = 0;
        swipeLock.current = nowTs;
        setSelectedDate(addDays(selectedDate, direction * 7));
      }
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [hourHeight, setHourHeight, selectedDate, setSelectedDate]);

  return (
    <motion.div
      className="flex h-full min-h-0 flex-col"
      initial="initial"
      animate="animate"
      exit="exit"
      variants={fadeIn}
      transition={transition}
    >
      <motion.div
        className="flex flex-col items-center justify-center border-b p-4 text-sm sm:hidden"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition}
      >
        <p>Weekly view is not recommended on smaller devices.</p>
        <p>Please switch to a desktop device or use the daily view instead.</p>
      </motion.div>

      <motion.div className="hidden min-h-0 flex-1 flex-col sm:flex" variants={staggerContainer}>
        <div>
          {/* Week header */}
          <motion.div
            className="relative z-20 flex border-b"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transition}
          >
            {/* Time column header - responsive width */}
            <div className="w-18"></div>
            <div className="grid flex-1 grid-cols-7  border-l">
              {weekDays.map((day, index) => (
                <motion.span
                  key={day.toISOString()}
                  className="py-1 sm:py-2 text-center text-xs font-medium text-t-quaternary"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05, ...transition }}
                >
                  {/* Mobile: Show only day abbreviation and number */}
                  <span className="block sm:hidden">
                    {format(day, 'EEE').charAt(0)}
                    <span className="block font-semibold text-t-secondary text-xs">{format(day, 'd')}</span>
                  </span>
                  {/* Desktop: Show full format */}
                  <span className="hidden sm:inline">
                    {format(day, 'EE')}{' '}
                    <span className="ml-1 font-semibold text-t-secondary">{format(day, 'd')}</span>
                  </span>
                </motion.span>
              ))}
            </div>
          </motion.div>

          {/* All-day & multi-day events band, directly under the dates */}
          <WeekViewMultiDayEventsRow selectedDate={selectedDate} multiDayEvents={multiDayEvents} />
        </div>

        <ScrollArea className="min-h-0 flex-1" type="always" ref={scrollRef}>
          <div className="flex">
            {/* Hours column */}
            <motion.div className="relative w-18" variants={staggerContainer}>
              {hours.map((hour, index) => (
                <motion.div
                  key={hour}
                  className="relative"
                  style={{ height: `${hourHeight}px` }}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.02, ...transition }}
                >
                  <div className="absolute -top-3 right-2 flex h-6 items-center">
                    {index !== 0 && (
                      <span className="text-xs text-t-quaternary">
                        {format(new Date().setHours(hour, 0, 0, 0), use24HourFormat ? 'HH:00' : 'h a')}
                      </span>
                    )}
                  </div>
                </motion.div>
              ))}
            </motion.div>

            {/* Week grid */}
            <motion.div className="relative flex-1 border-l" variants={staggerContainer}>
              <div className="grid grid-cols-7 divide-x">
                {weekDays.map((day, dayIndex) => {
                  const dayEvents = singleDayEvents.filter(
                    (event) =>
                      isSameDay(parseISO(event.startDate), day) || isSameDay(parseISO(event.endDate), day),
                  );
                  const groupedEvents = groupEvents(dayEvents);

                  return (
                    <motion.div
                      key={day.toISOString()}
                      className="relative"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: dayIndex * 0.1, ...transition }}
                    >
                      {hours.map((hour, index) => (
                        <motion.div
                          key={hour}
                          className="relative"
                          style={{ height: `${hourHeight}px` }}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: index * 0.01, ...transition }}
                        >
                          {index !== 0 && (
                            <div className="pointer-events-none absolute inset-x-0 top-0 border-b"></div>
                          )}

                          <DroppableArea
                            date={day}
                            hour={hour}
                            minute={0}
                            className="absolute inset-x-0 top-0"
                            style={{ height: `${hourHeight / 2}px` }}
                          >
                            <AddEditEventDialog startDate={day} startTime={{ hour, minute: 0 }}>
                              <div className="absolute inset-0 cursor-pointer transition-colors hover:bg-secondary" />
                            </AddEditEventDialog>
                          </DroppableArea>

                          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-b border-dashed border-b-tertiary"></div>

                          <DroppableArea
                            date={day}
                            hour={hour}
                            minute={30}
                            className="absolute inset-x-0 bottom-0"
                            style={{ height: `${hourHeight / 2}px` }}
                          >
                            <AddEditEventDialog startDate={day} startTime={{ hour, minute: 30 }}>
                              <div className="absolute inset-0 cursor-pointer transition-colors hover:bg-secondary" />
                            </AddEditEventDialog>
                          </DroppableArea>
                        </motion.div>
                      ))}

                      <RenderGroupedEvents groupedEvents={groupedEvents} day={day} />
                    </motion.div>
                  );
                })}
              </div>

              <CalendarTimeline />
            </motion.div>
          </div>
        </ScrollArea>
      </motion.div>
    </motion.div>
  );
}
