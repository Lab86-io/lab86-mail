'use client';

import { useQuery_experimental as useConvexQuery } from 'convex/react';
import { format, parseISO } from 'date-fns';
import {
  CalendarDays,
  Clock,
  ExternalLink,
  ListChecks,
  MapPin,
  Repeat,
  Text,
  Users,
  Video,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AddEditEventDialog } from '@/components/calendar/engine/add-edit-event-dialog';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { extractConferencingUrl, formatTime } from '@/components/calendar/engine/helpers';
import type { IEvent } from '@/components/calendar/engine/interfaces';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/convex/_generated/api';
import { useClientStore } from '@/lib/client-state';

interface IProps {
  event: IEvent;
  children: ReactNode;
}

const RSVP_LABEL: Record<string, string> = {
  yes: 'Going',
  no: 'Declined',
  maybe: 'Maybe',
  noreply: 'No reply',
};

// Dedicated event viewer: everything the synced event knows — times in the
// user's clock format, owning calendar, location with an embedded map,
// attendees with RSVP state, conferencing link, recurrence and notes.
export function EventDetailsDialog({ event, children }: IProps) {
  const startDate = parseISO(event.startDate);
  const endDate = parseISO(event.endDate);
  const { use24HourFormat, removeEvent } = useCalendar();
  const setPrimaryView = useClientStore((s) => s.setPrimaryView);
  const [open, setOpen] = useState(false);
  // Only subscribe to linked cards while the dialog is open — otherwise every
  // rendered event card on a dense calendar holds a live Convex subscription.
  const linkedCardsQuery = useConvexQuery({
    query: (api as any).boards.liveCardsForCalendarEvent,
    args: open ? { eventId: event.id, masterEventId: event.masterEventId } : 'skip',
  });
  const linkedCards: Array<{ cardId: string; title: string; completedAt?: number }> =
    linkedCardsQuery.status === 'success' ? linkedCardsQuery.data || [] : [];

  const conferencingUrl = extractConferencingUrl(event.conferencing);
  const participants = event.participants || [];
  const sameDay = format(startDate, 'yyyy-MM-dd') === format(endDate, 'yyyy-MM-dd');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-6 font-display text-[18px] leading-snug">{event.title}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-4 pr-3">
            {/* When */}
            <div className="flex items-start gap-2.5">
              <Clock className="mt-0.5 size-4 shrink-0 text-[var(--color-text-faint)]" />
              <div className="text-[13.5px]">
                {event.allDay ? (
                  <span>
                    {format(startDate, 'EEEE, MMMM d')}
                    {sameDay ? '' : ` – ${format(endDate, 'EEEE, MMMM d')}`} · All day
                  </span>
                ) : sameDay ? (
                  <span>
                    {format(startDate, 'EEEE, MMMM d')} · {formatTime(startDate, use24HourFormat)} –{' '}
                    {formatTime(endDate, use24HourFormat)}
                  </span>
                ) : (
                  <span>
                    {format(startDate, 'EEE, MMM d')} {formatTime(startDate, use24HourFormat)} –{' '}
                    {format(endDate, 'EEE, MMM d')} {formatTime(endDate, use24HourFormat)}
                  </span>
                )}
                {event.recurrence?.length ? (
                  <span className="mt-0.5 flex items-center gap-1 text-[12px] text-[var(--color-text-muted)]">
                    <Repeat className="size-3" /> Repeats
                  </span>
                ) : null}
              </div>
            </div>

            {/* Calendar */}
            <div className="flex items-center gap-2.5">
              <CalendarDays className="size-4 shrink-0 text-[var(--color-text-faint)]" />
              <span className="text-[13px] text-[var(--color-text-muted)]">{event.user.name}</span>
            </div>

            {event.htmlLink ? (
              <div className="flex items-center gap-2.5">
                <ExternalLink className="size-4 shrink-0 text-[var(--color-text-faint)]" />
                <a
                  href={event.htmlLink}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="truncate text-[13px] text-[var(--color-accent)] underline-offset-2 hover:underline"
                >
                  Open in calendar
                </a>
              </div>
            ) : null}

            {linkedCards.length ? (
              <div className="flex items-start gap-2.5">
                <ListChecks className="mt-0.5 size-4 shrink-0 text-[var(--color-text-faint)]" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-[12px] font-medium text-[var(--color-text-muted)]">Linked tasks</p>
                  {linkedCards.slice(0, 5).map((card) => (
                    <button
                      key={card.cardId}
                      type="button"
                      onClick={() => setPrimaryView('tasks')}
                      className="block max-w-full truncate rounded-md border border-[var(--color-border)] px-2 py-1 text-left text-[12px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >
                      {card.completedAt ? '✓ ' : ''}
                      {card.title}
                    </button>
                  ))}
                  {linkedCards.length > 5 ? (
                    <p className="text-[11px] text-[var(--color-text-faint)]">
                      + {linkedCards.length - 5} more linked task{linkedCards.length - 5 === 1 ? '' : 's'}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Conferencing */}
            {conferencingUrl ? (
              <div className="flex items-center gap-2.5">
                <Video className="size-4 shrink-0 text-[var(--color-text-faint)]" />
                <a
                  href={conferencingUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="truncate text-[13px] text-[var(--color-accent)] underline-offset-2 hover:underline"
                >
                  Join video call
                </a>
              </div>
            ) : null}

            {/* Location + map */}
            {event.location ? (
              <div className="space-y-2">
                <div className="flex items-start gap-2.5">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-[var(--color-text-faint)]" />
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[13px] leading-snug text-[var(--color-text)] underline-offset-2 hover:underline"
                  >
                    {event.location}
                  </a>
                </div>
                <iframe
                  title={`Map of ${event.location}`}
                  src={`https://www.google.com/maps?q=${encodeURIComponent(event.location)}&output=embed`}
                  className="h-44 w-full rounded-lg border border-[var(--color-border)]"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>
            ) : null}

            {/* Attendees */}
            {participants.length ? (
              <div className="flex items-start gap-2.5">
                <Users className="mt-0.5 size-4 shrink-0 text-[var(--color-text-faint)]" />
                <ul className="min-w-0 flex-1 space-y-1">
                  {participants.map((person, index) => (
                    <li
                      key={person.email || index}
                      className="flex items-center gap-2 text-[12.5px] text-[var(--color-text)]"
                    >
                      <span className="min-w-0 truncate">{person.name || person.email}</span>
                      {person.status ? (
                        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[9.5px]">
                          {RSVP_LABEL[person.status] || person.status}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Notes */}
            {event.description ? (
              <div className="flex items-start gap-2.5">
                <Text className="mt-0.5 size-4 shrink-0 text-[var(--color-text-faint)]" />
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-text-muted)]">
                  {event.description}
                </p>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        <div className="flex items-center justify-end gap-2 pt-1">
          {!event.readOnly ? (
            <AddEditEventDialog event={event}>
              <Button variant="outline" size="sm" className="h-8 px-3 text-[12.5px]">
                Edit
              </Button>
            </AddEditEventDialog>
          ) : null}
          {!event.readOnly ? (
            isRecurringEvent(event) ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="h-8 px-3 text-[12.5px]">
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete recurring event</AlertDialogTitle>
                    <AlertDialogDescription>
                      “{event.title}” repeats. Delete just this occurrence, or every event in the series?
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="gap-2 sm:justify-between">
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <div className="flex gap-2">
                      <AlertDialogAction
                        className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
                        onClick={() => {
                          removeEvent(event.id, { deleteSeries: false });
                          setOpen(false);
                        }}
                      >
                        This event
                      </AlertDialogAction>
                      <AlertDialogAction
                        onClick={() => {
                          removeEvent(event.id, { deleteSeries: true });
                          setOpen(false);
                        }}
                      >
                        All events in series
                      </AlertDialogAction>
                    </div>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <DialogClose asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-8 px-3 text-[12.5px]"
                  onClick={() => removeEvent(event.id)}
                >
                  Delete
                </Button>
              </DialogClose>
            )
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// A master event carries an RRULE (recurrence); an expanded occurrence carries
// a masterEventId. Either means "this belongs to a series."
function isRecurringEvent(event: IEvent): boolean {
  return Boolean(event.recurrence?.length || event.masterEventId);
}
