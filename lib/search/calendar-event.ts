import type { IEvent } from '../../components/calendar/engine/interfaces';
import type { CalendarSearchTarget } from './global-search';

export type SearchEventDetail = CalendarSearchTarget &
  Omit<IEvent, 'id' | 'startDate' | 'endDate' | 'color' | 'user'> & { endIso: string };

/** A search may temporarily shift the loaded range; clearing it restores today. */
export function calendarSearchWindow(normal: { startAt: number; endAt: number }, startIso?: string) {
  const date = startIso ? Date.parse(startIso) : Number.NaN;
  return Number.isFinite(date) && (date < normal.startAt || date > normal.endAt)
    ? { startAt: date - 92 * 86400000, endAt: date + 366 * 86400000 }
    : normal;
}

export function calendarSearchEvent(event: SearchEventDetail): IEvent {
  if (!Number.isFinite(Date.parse(event.startIso)) || !Number.isFinite(Date.parse(event.endIso))) {
    throw new Error('This event has an invalid date. Try syncing its calendar.');
  }
  return {
    ...event,
    id: event.eventId,
    startDate: event.startIso,
    endDate: event.endIso,
    color: 'blue',
    description: event.description || '',
    user: { id: event.calendarId, name: event.calendarId, picturePath: null },
  };
}
