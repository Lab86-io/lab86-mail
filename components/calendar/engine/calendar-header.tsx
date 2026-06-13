'use client';

import { Plus, ZoomIn, ZoomOut } from 'lucide-react';
import { motion } from 'motion/react';
import { AddEditEventDialog } from '@/components/calendar/engine/add-edit-event-dialog';
import { slideFromLeft, slideFromRight, transition } from '@/components/calendar/engine/animations';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { DateNavigator } from '@/components/calendar/engine/date-navigator';
import { TodayButton } from '@/components/calendar/engine/today-button';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Views from './view-tabs';

export function CalendarHeader() {
  const { view, events, hourHeight, setHourHeight } = useCalendar();

  return (
    <div className="flex flex-col gap-4 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
      <motion.div
        className="flex items-center gap-3"
        variants={slideFromLeft}
        initial="initial"
        animate="animate"
        transition={transition}
      >
        <TodayButton />
        <DateNavigator view={view} events={events} />
      </motion.div>

      <motion.div
        className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-1.5"
        variants={slideFromRight}
        initial="initial"
        animate="animate"
        transition={transition}
      >
        <div className="options flex-wrap flex items-center gap-4 md:gap-2">
          {view === 'week' || view === 'day' ? (
            <ButtonGroup>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setHourHeight(hourHeight - 16)}
                title="Shrink hours"
                disabled={hourHeight <= 40}
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setHourHeight(hourHeight + 16)}
                title="Grow hours"
                disabled={hourHeight >= 160}
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
            </ButtonGroup>
          ) : null}
          <Views />
        </div>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-1.5">
          <AddEditEventDialog>
            <Button>
              <Plus className="h-4 w-4" />
              Add Event
            </Button>
          </AddEditEventDialog>
        </div>
      </motion.div>
    </div>
  );
}
