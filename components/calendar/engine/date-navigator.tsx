import { formatDate } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { getEventsCount, navigateDate, rangeText } from '@/components/calendar/engine/helpers';
import type { IEvent } from '@/components/calendar/engine/interfaces';
import type { TCalendarView } from '@/components/calendar/engine/types';
import { Button } from '@/components/ui/button';

export function DateNavigator({ view, events }: { view: TCalendarView; events: IEvent[] }) {
  const { selectedDate, setSelectedDate } = useCalendar();
  const range = rangeText(view, selectedDate);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <span
            className="min-w-0 truncate font-display text-[15px] font-medium"
            title={formatDate(selectedDate, 'MMMM yyyy')}
          >
            {formatDate(selectedDate, 'MMMM yyyy')}
          </span>
          <span className="hidden text-[11px] text-[var(--color-text-muted)] @min-[760px]/calendar-toolbar:inline">
            {getEventsCount(events, selectedDate, view)} events
          </span>
        </div>
        <p className="truncate text-[11px] text-[var(--color-text-muted)]" title={range}>
          {view === 'week' ? range.replaceAll(/,? \d{4}/g, '').replace(' - ', ' – ') : range}
        </p>
      </div>
      <div className="flex shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous date range"
          onClick={() => setSelectedDate(navigateDate(selectedDate, view, 'previous'))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next date range"
          onClick={() => setSelectedDate(navigateDate(selectedDate, view, 'next'))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
