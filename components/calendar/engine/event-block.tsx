import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';
import { differenceInMinutes, parseISO } from 'date-fns';
import { Video } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { DraggableEvent } from '@/components/calendar/engine/draggable-event';
import { EventDetailsDialog } from '@/components/calendar/engine/event-details-dialog';
import { contrastTextColor, extractConferencingUrl, formatTime } from '@/components/calendar/engine/helpers';
import type { IEvent } from '@/components/calendar/engine/interfaces';
import { ResizableEvent } from '@/components/calendar/engine/resizable-event';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

const calendarWeekEventCardVariants = cva(
  'relative flex w-full min-w-0 select-none flex-col gap-0.5 overflow-hidden rounded-lg border px-2 py-1.5 text-left text-xs focus-visible:outline-offset-2',
  {
    variants: {
      color: {
        // Colored variants
        blue: 'border-blue-200 bg-blue-100/50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:bg-blue-950',
        green:
          'border-green-200 bg-green-100/50 text-green-700 hover:bg-green-100 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300 dark:hover:bg-green-950',
        red: 'border-red-200 bg-red-100/50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-950',
        yellow:
          'border-yellow-200 bg-yellow-100/50 text-yellow-700 hover:bg-yellow-100 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300 dark:hover:bg-yellow-950',
        purple:
          'border-purple-200 bg-purple-100/50 text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:bg-purple-950/50 dark:text-purple-300 dark:hover:bg-purple-950',
        orange:
          'border-orange-200 bg-orange-100/50 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-300 dark:hover:bg-orange-950',

        // Dot variants
        'blue-dot':
          'border-border bg-card text-foreground hover:bg-accent [&_svg]:fill-blue-600 dark:[&_svg]:fill-blue-500',
        'green-dot':
          'border-border bg-card text-foreground hover:bg-accent [&_svg]:fill-green-600 dark:[&_svg]:fill-green-500',
        'red-dot':
          'border-border bg-card text-foreground hover:bg-accent [&_svg]:fill-red-600 dark:[&_svg]:fill-red-500',
        'orange-dot':
          'border-border bg-card text-foreground hover:bg-accent [&_svg]:fill-orange-600 dark:[&_svg]:fill-orange-500',
        'purple-dot':
          'border-border bg-card text-foreground hover:bg-accent [&_svg]:fill-purple-600 dark:[&_svg]:fill-purple-500',
        'yellow-dot':
          'border-border bg-card text-foreground hover:bg-accent [&_svg]:fill-yellow-600 dark:[&_svg]:fill-yellow-500',
      },
    },
    defaultVariants: {
      color: 'blue-dot',
    },
  },
);

interface IProps
  extends HTMLAttributes<HTMLDivElement>,
    Omit<VariantProps<typeof calendarWeekEventCardVariants>, 'color'> {
  event: IEvent;
}

export function EventBlock({ event, className }: IProps) {
  const { badgeVariant, use24HourFormat, hourHeight } = useCalendar();

  const start = parseISO(event.startDate);
  const end = parseISO(event.endDate);
  const durationInMinutes = differenceInMinutes(end, start);
  const heightInPixels = (durationInMinutes / 60) * hourHeight - 8;
  const showTime = durationInMinutes >= 75 && heightInPixels >= 58;

  const color = (badgeVariant === 'dot' ? `${event.color}-dot` : event.color) as VariantProps<
    typeof calendarWeekEventCardVariants
  >['color'];

  const calendarWeekEventCardClasses = cn(
    calendarWeekEventCardVariants({ color, className }),
    !showTime && 'py-0 justify-center',
  );

  // Data drives form: a meeting you can join, a held-but-unconfirmed slot, and
  // a free/transparent block should each *look* like what they are.
  const conferencingUrl = extractConferencingUrl(event.conferencing);
  const tentative = event.status === 'tentative';
  const free = event.busy === false;
  const participants = event.participants || [];
  const showAvatars = showTime && heightInPixels >= 72 && participants.length > 1;

  // Solid fill for a normal categorical event; outline-only when the slot is
  // free/transparent so it reads as "available", not "booked".
  const colorStyle: Record<string, string> = event.colorHex
    ? free
      ? { backgroundColor: 'transparent', borderColor: event.colorHex, color: event.colorHex }
      : {
          backgroundColor: event.colorHex,
          borderColor: event.colorHex,
          color: contrastTextColor(event.colorHex),
        }
    : {};
  const joinColor = colorStyle.color;

  return (
    <ResizableEvent event={event}>
      <DraggableEvent event={event}>
        <div className="relative w-full">
          <EventDetailsDialog event={event}>
            <button
              type="button"
              className={calendarWeekEventCardClasses}
              style={{
                height: `${heightInPixels}px`,
                ...colorStyle,
                ...(tentative ? { borderStyle: 'dashed' } : {}),
              }}
            >
              {/* Tentative events get a diagonal hatch — the universal calendar
                cue for "held, not confirmed". currentColor = the text colour. */}
              {tentative ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-25"
                  style={{
                    backgroundImage:
                      'repeating-linear-gradient(45deg, transparent 0 4px, currentColor 4px 5px)',
                  }}
                />
              ) : null}

              <div
                className={cn(
                  'relative flex items-center gap-1.5 truncate',
                  conferencingUrl && (showTime ? 'pr-12' : 'pr-6'),
                )}
              >
                {badgeVariant === 'dot' && (
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    xmlns="http://www.w3.org/2000/svg"
                    className="shrink-0"
                    aria-hidden="true"
                  >
                    <circle cx="4" cy="4" r="4" />
                  </svg>
                )}

                <p className="truncate font-semibold">{event.title}</p>
              </div>

              {showTime && (
                <p className="relative truncate">
                  {formatTime(start, use24HourFormat)} - {formatTime(end, use24HourFormat)}
                </p>
              )}

              {showAvatars ? (
                <div className="relative mt-auto flex items-center pt-0.5">
                  {participants.slice(0, 3).map((person, index) => (
                    <Avatar
                      key={person.email || person.name || index}
                      name={person.name || person.email}
                      size={14}
                      className={cn('ring-1 ring-white/40', index > 0 && '-ml-1.5')}
                    />
                  ))}
                  {participants.length > 3 ? (
                    <span className="ml-1 text-[9px] opacity-80">+{participants.length - 3}</span>
                  ) : null}
                </div>
              ) : null}
            </button>
          </EventDetailsDialog>

          {/* The join CTA is a sibling of the card trigger, never nested inside
              it — an <a> in a <button> is invalid and breaks keyboard/focus. */}
          {conferencingUrl ? (
            <a
              href={conferencingUrl}
              target="_blank"
              rel="noreferrer"
              draggable={false}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              title="Join video call"
              className="absolute right-1 top-1 z-10 inline-flex shrink-0 items-center gap-0.5 rounded border border-current/30 bg-current/15 px-1 py-px text-[10px] font-medium leading-none hover:bg-current/25"
              style={joinColor ? { color: joinColor } : undefined}
            >
              <Video className="size-2.5" />
              {showTime ? <span>Join</span> : null}
            </a>
          ) : null}
        </div>
      </DraggableEvent>
    </ResizableEvent>
  );
}
