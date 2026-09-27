import { allDayDisplayRange, allDayWriteDates } from './all-day';

// Pure mapping between the web calendar grid and the calendar tools. The grid
// works in local Date values; the tools take ISO strings, and all-day events
// take date-only strings with an exclusive end.

interface GridParticipant {
  email?: string;
  name?: string;
}

export interface GridEventDraft {
  startDate: string;
  endDate: string;
  title: string;
  description?: string;
  allDay?: boolean;
  recurrence?: string[];
  participants?: GridParticipant[];
}

// A synced row as the grid's start and end strings. All-day rows are stored as
// UTC-midnight dates; they must show on their own local date (CAL-3).
export function gridEventDates(row: { startAt: number; endAt: number; allDay?: boolean }): {
  startDate: string;
  endDate: string;
} {
  if (row.allDay) {
    const range = allDayDisplayRange(row.startAt, row.endAt);
    return { startDate: range.start.toISOString(), endDate: range.end.toISOString() };
  }
  return { startDate: new Date(row.startAt).toISOString(), endDate: new Date(row.endAt).toISOString() };
}

export function gridWriteTimes(event: Pick<GridEventDraft, 'startDate' | 'endDate' | 'allDay'>): {
  startIso: string;
  endIso: string;
} {
  if (event.allDay) return allDayWriteDates(new Date(event.startDate), new Date(event.endDate));
  return { startIso: event.startDate, endIso: event.endDate };
}

function inviteList(participants: GridParticipant[] | undefined) {
  return (participants || [])
    .filter((participant) => participant.email)
    .map((participant) => ({ email: participant.email as string, name: participant.name }));
}

// Arguments for calendar_update_event. Repeats and Invite go only when they
// changed (CAL-7): a new rule replaces the old one, and new invitees are sent
// with the whole list and get an email, the same as on create.
export function gridUpdateArgs(
  target: { account: string; calendarId: string; eventId: string },
  event: GridEventDraft,
  previous?: GridEventDraft,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    ...target,
    title: event.title,
    ...gridWriteTimes(event),
    description: event.description || undefined,
  };
  const rule = event.recurrence || [];
  if (rule.length && rule.join('\n') !== (previous?.recurrence || []).join('\n')) args.recurrence = rule;
  const known = new Set(inviteList(previous?.participants).map((p) => p.email.toLowerCase()));
  const invites = inviteList(event.participants);
  if (invites.some((p) => !known.has(p.email.toLowerCase()))) {
    args.attendees = invites;
    args.notifyParticipants = true;
  }
  return args;
}

export function gridCreateArgs(
  target: { account: string; calendarId: string },
  event: GridEventDraft,
): Record<string, unknown> {
  return {
    ...target,
    title: event.title,
    ...gridWriteTimes(event),
    allDay: Boolean(event.allDay),
    description: event.description || undefined,
    attendees: inviteList(event.participants),
    recurrence: event.recurrence,
  };
}
