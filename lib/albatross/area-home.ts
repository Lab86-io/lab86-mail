// Pure helpers behind the Area home surface and the rail's areas list.
// No DOM, no React — everything here is bun:test-able in isolation.

export interface AreaHomeCountsLike {
  mail: number;
  events: number;
  tasks: number;
  facts: { verified: number; candidate: number };
}

export type AreaHomeSectionId = 'mail' | 'events' | 'tasks' | 'context';

export interface AreaHomeSection {
  id: AreaHomeSectionId;
  label: string;
  count: number;
}

// Fixed editorial order: the operational artifacts first (mail is the highest
// churn), the slow-moving context last. Sections always render — an empty
// section shows its own quiet empty state rather than vanishing, so the user
// learns what the classifier files here.
export function areaHomeSections(counts: AreaHomeCountsLike): AreaHomeSection[] {
  return [
    { id: 'mail', label: 'Mail', count: counts.mail },
    { id: 'events', label: 'Events', count: counts.events },
    { id: 'tasks', label: 'Tasks', count: counts.tasks },
    { id: 'context', label: 'Context', count: counts.facts.verified + counts.facts.candidate },
  ];
}

// True when the classifier has filed nothing at all — the page swaps the three
// artifact sections for one whole-page explanation (context still renders).
export function areaHasNoLinks(counts: AreaHomeCountsLike): boolean {
  return counts.mail + counts.events + counts.tasks === 0;
}

export const RAIL_AREA_CAP = 8;

// The rail shows at most `cap` areas; the rest collapse into one overflow row
// so a many-area life never turns the nav into a second inbox.
export function railAreaRows<T>(
  areas: T[] | undefined | null,
  cap = RAIL_AREA_CAP,
): {
  rows: T[];
  overflow: number;
} {
  const list = areas ?? [];
  if (list.length <= cap) return { rows: list, overflow: 0 };
  return { rows: list.slice(0, cap), overflow: list.length - cap };
}

// One quiet number per rail area row: facts awaiting the user's confirmation.
// Zero (or malformed counts) renders nothing — no ghost pill.
export function railAreaBadge(factCounts?: { candidate?: number } | null): string | null {
  const pending = Number(factCounts?.candidate ?? 0);
  if (!Number.isFinite(pending) || pending <= 0) return null;
  return pending >= 100 ? '99+' : String(Math.floor(pending));
}

const dayFormat = (locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' });
const timeFormat = (locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });

// One line of when: "Wed, Jul 8 · 2:00 PM – 3:30 PM", all-day and multi-day
// variants included. All-day events conventionally end at the next midnight,
// so the end is nudged back a minute before comparing days.
export function formatEventTime(startAt: number, endAt: number, allDay: boolean, locale = 'en-US'): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const day = dayFormat(locale);
  if (allDay) {
    const adjustedEnd = new Date(Math.max(startAt, endAt - 60_000));
    if (start.toDateString() === adjustedEnd.toDateString()) return `${day.format(start)} · all day`;
    return `${day.format(start)} – ${day.format(adjustedEnd)} · all day`;
  }
  const time = timeFormat(locale);
  if (start.toDateString() === end.toDateString()) {
    return `${day.format(start)} · ${time.format(start)} – ${time.format(end)}`;
  }
  return `${day.format(start)} ${time.format(start)} – ${day.format(end)} ${time.format(end)}`;
}

export type TaskRowState = 'done' | 'overdue' | 'due' | 'open';

export interface TaskRowMeta {
  state: TaskRowState;
  label: string;
}

// One meta string per task row: done beats due, overdue is called out with the
// original date so the miss is legible, open-with-no-date stays quiet.
export function taskRowMeta(
  task: { completedAt: number | null; dueAt: number | null },
  now = Date.now(),
  locale = 'en-US',
): TaskRowMeta {
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  if (task.completedAt) return { state: 'done', label: `Done ${date.format(new Date(task.completedAt))}` };
  if (task.dueAt != null) {
    if (task.dueAt < now)
      return { state: 'overdue', label: `Overdue · ${date.format(new Date(task.dueAt))}` };
    return { state: 'due', label: `Due ${date.format(new Date(task.dueAt))}` };
  }
  return { state: 'open', label: 'No due date' };
}
