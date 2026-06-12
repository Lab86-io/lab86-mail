import { CalendarHeaderSkeleton } from '@/components/calendar/engine/calendar-header-skeleton';
import { MonthViewSkeleton } from '@/components/calendar/engine/month-view-skeleton';

export function CalendarSkeleton() {
  return (
    <div className="container mx-auto">
      <div className="flex h-screen flex-col">
        <CalendarHeaderSkeleton />
        <div className="flex-1">
          <MonthViewSkeleton />
        </div>
      </div>
    </div>
  );
}
