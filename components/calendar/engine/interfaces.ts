import type { TEventColor } from '@/components/calendar/engine/types';

// Repurposed from the upstream component: a "user" is one synced calendar
// (id = providerCalendarId). The filter UI thus filters by calendar.
export interface IUser {
  id: string;
  name: string;
  picturePath: string | null;
}

export interface IEvent {
  id: string;
  startDate: string;
  endDate: string;
  title: string;
  color: TEventColor;
  description: string;
  user: IUser;
  // lab86 provenance: which account/calendar the event belongs to, so
  // persistence callbacks can route writes back through Nylas.
  accountId?: string;
  calendarId?: string;
  readOnly?: boolean;
  allDay?: boolean;
  location?: string;
  masterEventId?: string;
  // Rich metadata for the event viewer.
  participants?: Array<{ email?: string; name?: string; status?: string }>;
  organizer?: { email?: string; name?: string };
  conferencing?: any;
  recurrence?: string[];
}

export interface ICalendarCell {
  day: number;
  currentMonth: boolean;
  date: Date;
}
