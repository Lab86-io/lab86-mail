import { format, parseISO } from 'date-fns';
import type { FC } from 'react';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { EventBullet } from '@/components/calendar/engine/event-bullet';
import { EventDetailsDialog } from '@/components/calendar/engine/event-details-dialog';
import {
  formatTime,
  getBgColor,
  getColorClass,
  getEventsForMonth,
  toCapitalize,
} from '@/components/calendar/engine/helpers';
import { Avatar } from '@/components/ui/avatar';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';

export const AgendaEvents: FC = () => {
  const { events, use24HourFormat, badgeVariant, agendaModeGroupBy, selectedDate } = useCalendar();

  const monthEvents = getEventsForMonth(events, selectedDate);

  const agendaEvents = Object.groupBy(monthEvents, (event) => {
    return agendaModeGroupBy === 'date' ? format(parseISO(event.startDate), 'yyyy-MM-dd') : event.color;
  });

  // Date keys sort chronologically; color keys are plain strings and would
  // all become Invalid Date under the date comparator.
  const groupedAndSortedEvents = Object.entries(agendaEvents).sort((a, b) =>
    agendaModeGroupBy === 'color'
      ? a[0].localeCompare(b[0])
      : new Date(a[0]).getTime() - new Date(b[0]).getTime(),
  );

  return (
    <Command className="py-4 h-[80vh] bg-transparent">
      <div className="mb-4 mx-4">
        <CommandInput placeholder="Type a command or search..." />
      </div>
      <CommandList className="max-h-max px-3 border-t">
        {groupedAndSortedEvents.map(([date, groupedEvents]) => (
          <CommandGroup
            key={date}
            heading={
              agendaModeGroupBy === 'date'
                ? format(parseISO(date), 'EEEE, MMMM d, yyyy')
                : toCapitalize(groupedEvents![0].color)
            }
          >
            {groupedEvents!.map((event) => (
              <CommandItem
                key={event.id}
                className={cn(
                  'mb-2 p-4 border rounded-md data-[selected=true]:bg-bg transition-all data-[selected=true]:text-none hover:cursor-pointer',
                  {
                    [getColorClass(event.color)]: badgeVariant === 'colored',
                    'hover:bg-zinc-200 dark:hover:bg-gray-900': badgeVariant === 'dot',
                    'hover:opacity-60': badgeVariant === 'colored',
                  },
                )}
              >
                <EventDetailsDialog event={event}>
                  <div className="w-full flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      {badgeVariant === 'dot' ? (
                        <EventBullet color={event.color} />
                      ) : (
                        <Avatar name={event.title} size={24} className={getBgColor(event.color)} />
                      )}
                      <div className="flex flex-col">
                        <p
                          className={cn({
                            'font-medium': badgeVariant === 'dot',
                            'text-foreground': badgeVariant === 'dot',
                          })}
                        >
                          {event.title}
                        </p>
                        <p className="text-muted-foreground text-sm line-clamp-1 text-ellipsis md:text-clip w-1/3">
                          {event.description}
                        </p>
                      </div>
                    </div>
                    <div className="w-40 flex justify-center items-center gap-1">
                      {agendaModeGroupBy === 'date' ? (
                        <>
                          <p className="text-sm">{formatTime(event.startDate, use24HourFormat)}</p>
                          <span className="text-muted-foreground">-</span>
                          <p className="text-sm">{formatTime(event.endDate, use24HourFormat)}</p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm">{format(event.startDate, 'MM/dd/yyyy')}</p>
                          <span className="text-sm">at</span>
                          <p className="text-sm">{formatTime(event.startDate, use24HourFormat)}</p>
                        </>
                      )}
                    </div>
                  </div>
                </EventDetailsDialog>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandEmpty>No results found.</CommandEmpty>
      </CommandList>
    </Command>
  );
};
