// The live Today page (docs/research/today-live-2026-11-04.md). Pure: the note
// at the top, the rows of the list, and the day's schedule. All of it reads
// the ledger and the calendar at this moment, so no sentence goes stale after
// the morning. No model writes these words.

import type { ObligationView } from './contract';
import type { NeedsYouEntry, NeedsYouExtraLike, NeedsYouGroup } from './groups';
import { isClosedObligation } from './groups';
import { TODAY_NEEDS_YOU_CAP } from './surfaces';

// ---- The rows of the list ---------------------------------------------------

export interface TodayRow<T extends NeedsYouExtraLike = NeedsYouExtraLike> {
  entry: NeedsYouEntry<T>;
  /** The other notices from the same sender. Done closes them with the row. */
  others: ObligationView[];
  /** Due now or today. The row's first action carries the accent only then. */
  urgent?: boolean;
}

export interface TodayRows<T extends NeedsYouExtraLike = NeedsYouExtraLike> {
  rows: TodayRow<T>[];
  /** Open rows that the list does not show. */
  more: number;
  /** Every open row, shown or not. The notices of one sender count once. */
  open: number;
  /** The open rows that are due now or today. */
  dueToday: number;
}

/**
 * One sender: the same name at the same domain. A company writes from more
 * than one mailbox, and two companies can show the same short name.
 */
function senderKey(obligation: ObligationView): string {
  const domain = obligation.askerAddress?.split('@')[1]?.trim() ?? '';
  return `${obligation.asker.trim()}|${domain}`.toLocaleLowerCase();
}

/** Only a notice bundles. Two questions from one person are two things to answer. */
function bundles(obligation: ObligationView): boolean {
  return obligation.kind === 'change' && !isClosedObligation(obligation);
}

/**
 * The first group holds what is due now and today, in the page order. After
 * it, a question from a person leads, then work, then notices. The later
 * groups otherwise put a notice with a due word above a question with none.
 */
function laterRank<T extends NeedsYouExtraLike>(entry: NeedsYouEntry<T>): number {
  if (entry.type === 'albatross') return 0;
  const { kind } = entry.obligation;
  if (kind === 'reply') return 0;
  return kind === 'change' ? 2 : 1;
}

/**
 * The rows of the Today list: the page groups without Waiting on others and
 * Closed today, with the notices of one sender in one row, cut at the cap.
 */
export function todayRows<T extends NeedsYouExtraLike>(
  groups: readonly NeedsYouGroup<T>[],
  cap = TODAY_NEEDS_YOU_CAP,
): TodayRows<T> {
  const active = groups.filter((group) => group.id !== 'closed_today' && group.id !== 'waiting');
  const urgent = active.filter((group) => group.id === 'now' || group.id === 'today');
  const later = active.filter((group) => group.id !== 'now' && group.id !== 'today');
  const ordered = [
    ...urgent.flatMap((group) => group.entries),
    ...later
      .flatMap((group) => group.entries)
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => laterRank(a.entry) - laterRank(b.entry) || a.index - b.index)
      .map(({ entry }) => entry),
  ];
  const urgentCount = urgent.reduce((count, group) => count + group.entries.length, 0);
  const rows: TodayRow<T>[] = [];
  const bySender = new Map<string, TodayRow<T>>();
  for (const entry of ordered) {
    if (entry.type === 'obligation' && bundles(entry.obligation)) {
      const key = senderKey(entry.obligation);
      const row = bySender.get(key);
      if (row) {
        row.others.push(entry.obligation);
        continue;
      }
      const lead = { entry, others: [] };
      bySender.set(key, lead);
      rows.push(lead);
      continue;
    }
    rows.push({ entry, others: [] });
  }
  const urgentIds = new Set(ordered.slice(0, urgentCount).map((entry) => entry.id));
  const marked = rows.map((row) => ({ ...row, urgent: urgentIds.has(row.entry.id) }));
  return {
    rows: marked.slice(0, cap),
    more: Math.max(0, rows.length - cap),
    open: rows.length,
    dueToday: marked.filter((row) => row.urgent).length,
  };
}

// ---- The schedule -----------------------------------------------------------

export interface TodayScheduleEvent {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  location?: string | null;
  status?: string | null;
}

export type ScheduleState = 'past' | 'now' | 'next' | 'later';

export type ScheduleLine =
  | { type: 'event'; event: TodayScheduleEvent; state: ScheduleState }
  | { type: 'open'; id: string; until: number | null };

/** A gap this long is worth a line: it is the room to do what the list asks. */
const OPEN_GAP_MS = 60 * 60_000;

function liveEvents(events: readonly TodayScheduleEvent[]) {
  return events.filter((event) => !/^cancel/i.test(String(event.status || '')));
}

/**
 * The lines of the schedule at this moment: timed events in order, with their
 * state. An open stretch of an hour or more after now gets its own line, so
 * the room in the day shows without a chart.
 */
export function scheduleLines(events: readonly TodayScheduleEvent[], now: number): ScheduleLine[] {
  const timed = liveEvents(events)
    .filter((event) => !event.allDay)
    .sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  const lines: ScheduleLine[] = [];
  let sawNext = false;
  let cursor = now;
  for (const event of timed) {
    if (event.endAt > now && event.startAt - cursor >= OPEN_GAP_MS)
      lines.push({ type: 'open', id: `open:${event.id}`, until: event.startAt });
    let state: ScheduleState;
    if (event.endAt <= now) state = 'past';
    else if (event.startAt <= now) state = 'now';
    else if (!sawNext) {
      state = 'next';
      sawNext = true;
    } else state = 'later';
    lines.push({ type: 'event', event, state });
    if (event.endAt > cursor) cursor = event.endAt;
  }
  return lines;
}

export function allDayEvents(events: readonly TodayScheduleEvent[]): TodayScheduleEvent[] {
  return liveEvents(events).filter((event) => event.allDay);
}

// ---- The note ---------------------------------------------------------------

/** The two lines of the note: what needs the person, and what the day does next. */
export interface TodayNoteLines {
  lead: string;
  day: string;
}

/** "9:30 AM", "3 PM": as a person says it. */
export function clockLabel(at: number, timezone: string): string {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
  return text.replace(':00', '');
}

/** Who to start with: the name that the first row leads with. */
function firstName(row: TodayRow): string {
  const { entry } = row;
  if (entry.type === 'albatross') {
    if (entry.item.kind === 'approval') return 'the approval for an Albatross';
    if (entry.item.kind === 'checkin') return 'your daily check-in';
    return 'the question from an Albatross';
  }
  const { obligation } = entry;
  if (obligation.kind === 'prepare') return obligation.sourceLabel?.trim() || obligation.asker.trim();
  return obligation.asker.trim();
}

function leadLine(rows: readonly TodayRow[], open: number, dueToday: number): string {
  const [first] = rows;
  if (!first) return 'Nothing needs you right now.';
  const start = `Start with ${firstName(first)}.`;
  if (open === 1) return `One thing needs you. ${start}`;
  if (dueToday === open) return `${open} things need you today. ${start}`;
  if (dueToday > 0) return `${open} things need you, ${dueToday} of them today. ${start}`;
  return `${open} things need you. ${start}`;
}

function dayLine(lines: readonly ScheduleLine[], now: number, timezone: string): string {
  const events = lines.flatMap((line) => (line.type === 'event' ? [line] : []));
  const current = events.find((line) => line.state === 'now')?.event;
  const next = events.find((line) => line.state === 'next')?.event;
  if (current && next)
    return `${current.title} ends at ${clockLabel(current.endAt, timezone)}. ${next.title} is next, at ${clockLabel(next.startAt, timezone)}.`;
  if (current)
    return `${current.title} ends at ${clockLabel(current.endAt, timezone)}. Nothing else is on your calendar today.`;
  if (next) {
    const minutes = Math.round((next.startAt - now) / 60_000);
    if (minutes <= 1) return `${next.title} starts now.`;
    if (minutes <= 30) return `${next.title} starts in ${minutes} minutes.`;
    return `No more events until ${next.title} at ${clockLabel(next.startAt, timezone)}.`;
  }
  return events.length
    ? 'Your calendar is clear for the rest of today.'
    : 'Nothing is on your calendar today.';
}

/**
 * The note: how much needs the person and where to start, then what the day
 * does next. It reads the same data as the sections under it, so it can never
 * say something that they do not show.
 */
export function todayNote(input: {
  rows: readonly TodayRow[];
  open: number;
  dueToday: number;
  lines: readonly ScheduleLine[];
  now: number;
  timezone: string;
}): TodayNoteLines {
  return {
    lead: leadLine(input.rows, input.open, input.dueToday),
    day: dayLine(input.lines, input.now, input.timezone),
  };
}

/**
 * The line of a row on the Today list, without the words that its first action
 * says: "Review: Move the export" beside a Review button reads "Move the export".
 */
export function todayRowLine(title: string): string {
  return title
    .replace(/^review:\s*/i, '')
    .replace(/^answer the invitation:\s*/i, 'Invitation: ')
    .replace(/\.$/, '');
}
