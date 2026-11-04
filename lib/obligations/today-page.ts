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
}

export interface TodayRows<T extends NeedsYouExtraLike = NeedsYouExtraLike> {
  rows: TodayRow<T>[];
  /** Open rows that the list does not show. */
  more: number;
  /** Every open item that the list stands for, bundled rows counted one by one. */
  open: number;
}

function senderKey(obligation: ObligationView): string {
  return obligation.asker.trim().toLocaleLowerCase();
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
  return { rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap), open: ordered.length };
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

/** One run of the note. A strong run is a name or a time: the words to find at a glance. */
export interface NoteRun {
  text: string;
  strong?: boolean;
}

export type NoteSentence = NoteRun[];

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

/** "9:30 AM", "3 PM", "noon": as a person says it. */
export function clockLabel(at: number, timezone: string): string {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
  if (text === '12:00 PM') return 'noon';
  return text.replace(':00', '');
}

/** A title this short can stand as a sentence of the note. A longer one stays on its row. */
const NOTE_TITLE_CHARS = 90;

/** The lead sentence: the news itself when a notice says it, or who waits and for what. */
function leadSentence(row: TodayRow): NoteSentence {
  const { entry, others } = row;
  if (entry.type === 'albatross') {
    if (entry.item.kind === 'approval') return [{ text: 'An Albatross waits for your approval.' }];
    if (entry.item.kind === 'checkin') return [{ text: 'Your daily check-in is ready.' }];
    return [{ text: 'An Albatross has a question for you.' }];
  }
  const { obligation } = entry;
  const asker: NoteRun = { text: obligation.asker, strong: true };
  const title = obligation.title.trim();
  switch (obligation.kind) {
    case 'reply':
      return [asker, { text: ' waits for your reply.' }];
    case 'rsvp':
      return [asker, { text: ' waits for your answer to an invitation.' }];
    case 'prepare':
      return [
        { text: 'Prepare for ' },
        { text: obligation.sourceLabel?.trim() || obligation.asker, strong: true },
        { text: '.' },
      ];
    case 'code':
      return [asker, { text: ' sent a sign-in code.' }];
    case 'change':
      if (others.length) return [asker, { text: ` sent ${others.length + 1} notices.` }];
      return title.length <= NOTE_TITLE_CHARS && /[.!?]$/.test(title)
        ? [{ text: title, strong: true }]
        : [asker, { text: ' sent a notice.' }];
    default:
      return [asker, { text: ' has a request for you.' }];
  }
}

function scheduleSentence(lines: readonly ScheduleLine[], now: number, timezone: string): NoteSentence {
  const events = lines.flatMap((line) => (line.type === 'event' ? [line] : []));
  const current = events.find((line) => line.state === 'now');
  const next = events.find((line) => line.state === 'next');
  if (current && next)
    return [
      { text: current.event.title, strong: true },
      { text: ' ends at ' },
      { text: clockLabel(current.event.endAt, timezone), strong: true },
      { text: ', then ' },
      { text: next.event.title, strong: true },
      { text: ' at ' },
      { text: clockLabel(next.event.startAt, timezone), strong: true },
      { text: '.' },
    ];
  if (current)
    return [
      { text: current.event.title, strong: true },
      { text: ' ends at ' },
      { text: clockLabel(current.event.endAt, timezone), strong: true },
      { text: '. Nothing else is on your calendar today.' },
    ];
  if (next) {
    const minutes = Math.round((next.event.startAt - now) / 60_000);
    if (minutes <= 30)
      return [
        { text: next.event.title, strong: true },
        { text: minutes <= 1 ? ' starts now.' : ` starts in ${minutes} minutes.` },
      ];
    return [
      { text: 'Next is ' },
      { text: next.event.title, strong: true },
      { text: ' at ' },
      { text: clockLabel(next.event.startAt, timezone), strong: true },
      { text: '.' },
    ];
  }
  return events.length
    ? [{ text: 'Your calendar is clear for the rest of today.' }]
    : [{ text: 'Nothing is on your calendar today.' }];
}

/**
 * The note: what leads the list, how much else waits, and what is next on the
 * calendar. Three short sentences at most. It reads the same data as the
 * sections under it, so it can never say something that they do not show.
 */
export function todayNote(input: {
  rows: readonly TodayRow[];
  open: number;
  lines: readonly ScheduleLine[];
  now: number;
  timezone: string;
}): NoteSentence[] {
  const { rows, open, lines, now, timezone } = input;
  const sentences: NoteSentence[] = [];
  const [first] = rows;
  if (!first) sentences.push([{ text: 'Nothing needs you right now.' }]);
  else {
    sentences.push(leadSentence(first));
    const rest = open - 1 - first.others.length;
    if (rest > 0)
      sentences.push([
        { text: `${rest} more`, strong: true },
        { text: plural(rest, ' thing needs you.', ' things need you.') },
      ]);
  }
  sentences.push(scheduleSentence(lines, now, timezone));
  return sentences;
}
