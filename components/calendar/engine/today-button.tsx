import { formatDate } from 'date-fns';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { Button } from '@/components/ui/button';

export function TodayButton() {
  const { setSelectedDate } = useCalendar();
  const today = new Date();
  return (
    <Button
      variant="ghost"
      aria-label="Go to today"
      className="flex size-10 shrink-0 flex-col gap-0 border-0 p-0 text-center"
      onClick={() => setSelectedDate(new Date())}
    >
      <span className="text-[9px] font-normal uppercase leading-3 text-[var(--color-accent)]">
        {formatDate(today, 'MMM')}
      </span>
      <span className="text-[17px] font-medium leading-5">{today.getDate()}</span>
    </Button>
  );
}
