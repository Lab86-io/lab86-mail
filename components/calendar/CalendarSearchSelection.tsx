'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useCalendar } from '@/components/calendar/engine/calendar-context';
import { EventDetailsDialog } from '@/components/calendar/engine/event-details-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { callTool } from '@/lib/api-client';
import { useClientStore } from '@/lib/client-state';
import { calendarSearchEvent, type SearchEventDetail } from '@/lib/search/calendar-event';

export function CalendarSearchSelection() {
  const target = useClientStore((s) => s.calendarSearchTarget);
  const setTarget = useClientStore((s) => s.setCalendarSearchTarget);
  const calendar = useCalendar();
  // Context actions are not stable references. Apply each selection only once.
  const applied = useRef<typeof target>(null);
  const detail = useQuery({
    queryKey: ['calendar-search-detail', target?.accountId, target?.calendarId, target?.eventId],
    enabled: !!target,
    retry: false,
    queryFn: async ({ signal }) => {
      const data = await callTool<{ event: SearchEventDetail }>(
        'calendar_event_detail',
        {
          account: target!.accountId,
          calendarId: target!.calendarId,
          eventId: target!.eventId,
        },
        {},
        signal,
      );
      return calendarSearchEvent(data.event);
    },
  });
  useEffect(() => {
    if (!target || applied.current === target) return;
    applied.current = target;
    const date = new Date(target.startIso);
    if (!Number.isFinite(date.getTime())) return;
    calendar.setSelectedDate(date);
    calendar.setView('day');
  }, [target, calendar]);
  if (!target) return null;
  const onOpenChange = (open: boolean) => {
    if (!open) setTarget(null);
  };
  if (detail.data)
    return (
      <EventDetailsDialog
        key={`${target.accountId}:${target.calendarId}:${target.eventId}`}
        event={detail.data}
        open
        onOpenChange={onOpenChange}
      />
    );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{detail.error ? 'Could not open this event' : 'Opening event'}</DialogTitle>
        <DialogDescription>
          {detail.error ? detail.error.message : 'Loading the details from its calendar.'}
        </DialogDescription>
        {detail.isFetching ? (
          <Loader2 className="size-5 animate-spin" aria-label="Loading event" />
        ) : (
          <button
            type="button"
            className="text-sm text-[var(--color-accent)]"
            onClick={() => void detail.refetch()}
          >
            Try again
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}
