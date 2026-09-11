'use client';

import { MoreHorizontal, Plus, ZoomIn, ZoomOut } from 'lucide-react';
import { AddEditEventDialog } from '@/components/calendar/engine/add-edit-event-dialog';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { DateNavigator } from '@/components/calendar/engine/date-navigator';
import { TodayButton } from '@/components/calendar/engine/today-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Views from './view-tabs';
import './calendar-toolbar.css';

/** One control plane. At narrow pane widths the second row contains a named
 * view picker and display options; date navigation and creation never move. */
export function CalendarHeader() {
  const { view, events, hourHeight, setHourHeight } = useCalendar();
  return (
    <header data-calendar-toolbar className="calendar-toolbar shrink-0 border-b border-[var(--color-border)]">
      <div className="calendar-toolbar__surface">
        <div data-calendar-date-controls className="calendar-toolbar__date">
          <TodayButton />
          <DateNavigator view={view} events={events} />
        </div>
        <div className="calendar-toolbar__views">
          <Views />
          {view === 'week' || view === 'day' ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Calendar display options">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setHourHeight(hourHeight - 16)} disabled={hourHeight <= 40}>
                  <ZoomOut className="size-4" /> Shrink hours
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setHourHeight(hourHeight + 16)}
                  disabled={hourHeight >= 160}
                >
                  <ZoomIn className="size-4" /> Grow hours
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <div className="calendar-toolbar__create">
          <AddEditEventDialog>
            <Button size="sm" aria-label="Add Event">
              <Plus className="size-4" />
              <span>Add</span>
            </Button>
          </AddEditEventDialog>
        </div>
      </div>
    </header>
  );
}
