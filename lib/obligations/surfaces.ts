// Needs you where the owner does the work (docs/research/needs-you-web-2-design-2026-11-02.md).
// Pure rules for the surfaces outside the page: the Today list, the mail
// reader and the inbox list, the Albatross areas, the calendar, the palette,
// and the browser tab. One snapshot feeds them all; these functions build the
// lookups and the words.

import type { NeedsYouRow as AreaNeedsYouRow } from '../albatross/area-home';
import type { ObligationView } from './contract';
import {
  isClosedObligation,
  type NeedsYouEntry,
  type NeedsYouExtraLike,
  type NeedsYouGroup,
  type NeedsYouSummary,
} from './groups';

/** The Today list shows at most this many rows. The rest is a link to the page. */
export const TODAY_NEEDS_YOU_CAP = 6;

/** True while the item still waits for the user: open, or snoozed until a time that has passed. */
export function isOpenObligation(obligation: ObligationView, now: number): boolean {
  if (isClosedObligation(obligation)) return false;
  if (obligation.state === 'snoozed' && (obligation.snoozedUntil ?? 0) > now) return false;
  return true;
}

export interface TodayNeedsYouList<T extends NeedsYouExtraLike = NeedsYouExtraLike> {
  entries: NeedsYouEntry<T>[];
  /** How many open entries the list does not show. */
  more: number;
  /** The entries that are due today or sooner, for the head sentence. */
  dueToday: number;
}

/**
 * The rows of the Today list: the page groups in their order, without
 * Waiting on others and Closed today, cut at the cap. Now and due today
 * come first because the groups do.
 */
export function todayNeedsYouList<T extends NeedsYouExtraLike>(
  groups: readonly NeedsYouGroup<T>[],
  cap = TODAY_NEEDS_YOU_CAP,
): TodayNeedsYouList<T> {
  const active = groups.filter((group) => group.id !== 'closed_today' && group.id !== 'waiting');
  const all = active.flatMap((group) => group.entries);
  const dueToday = active
    .filter((group) => group.id === 'now' || group.id === 'today')
    .reduce((count, group) => count + group.entries.length, 0);
  return { entries: all.slice(0, cap), more: Math.max(0, all.length - cap), dueToday };
}

/**
 * The head of the Today list: "3 things need you now. 2 more are due today."
 * Empty when nothing is open, so the list takes no space.
 */
export function todayNeedsYouHead(summary: Pick<NeedsYouSummary, 'now' | 'open'>, dueToday: number): string {
  const open = summary.open;
  if (open === 0) return '';
  const now = summary.now;
  const later = dueToday - now;
  if (now === 0) {
    if (later === 0) return open === 1 ? '1 thing needs you.' : `${open} things need you.`;
    const rest = open - later;
    const head = later === 1 ? '1 thing is due today.' : `${later} things are due today.`;
    return rest > 0 ? `${head} ${rest} more ${rest === 1 ? 'waits' : 'wait'} for you.` : head;
  }
  const head = now === 1 ? '1 thing needs you now.' : `${now} things need you now.`;
  if (later > 0) return `${head} ${later} more ${later === 1 ? 'is' : 'are'} due today.`;
  const rest = open - now;
  return rest > 0 ? `${head} ${rest} more ${rest === 1 ? 'waits' : 'wait'} for you.` : head;
}

/** "4 more are on the Needs you page." Empty when the list shows everything. */
export function todayNeedsYouFoot(more: number): string {
  if (more <= 0) return '';
  return more === 1 ? '1 more is on the Needs you page.' : `${more} more are on the Needs you page.`;
}

// ---- Lookups ---------------------------------------------------------------

export function mailThreadKey(accountId: string, threadId: string): string {
  return `${accountId}:${threadId}`;
}

/** The open items of each mail thread, by `accountId:threadId`. Codes stay out: the code row is the only place for a code. */
export function obligationsByThread(
  items: readonly ObligationView[],
  now: number,
): Map<string, ObligationView[]> {
  const map = new Map<string, ObligationView[]>();
  for (const item of items) {
    if (item.source !== 'mail' || item.kind === 'code' || !item.accountId || !item.threadId) continue;
    if (!isOpenObligation(item, now)) continue;
    const key = mailThreadKey(item.accountId, item.threadId);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  for (const list of map.values()) list.sort(compareByCreated);
  return map;
}

export function calendarEventKey(accountId: string, eventId: string): string {
  return `${accountId}:${eventId}`;
}

/** The open calendar items (`rsvp`, `prepare`) of each event, by `accountId:eventId`. Two accounts can share an event id. */
export function obligationsByEvent(
  items: readonly ObligationView[],
  now: number,
): Map<string, ObligationView[]> {
  const map = new Map<string, ObligationView[]>();
  for (const item of items) {
    if (item.source !== 'calendar' || !item.eventId || !item.accountId) continue;
    if (item.kind !== 'rsvp' && item.kind !== 'prepare') continue;
    if (!isOpenObligation(item, now)) continue;
    const key = calendarEventKey(item.accountId, item.eventId);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  for (const list of map.values()) list.sort(compareByCreated);
  return map;
}

export interface CalendarOccurrence {
  accountId?: string;
  /** The provider event id of this occurrence. */
  id: string;
  masterEventId?: string;
  startDate?: string;
}

/**
 * The open items of one displayed event. A `prepare` item names the occurrence.
 * The `rsvp` item of a series names its master event and the next start, so it
 * belongs only to the occurrence that starts at that time.
 */
export function occurrenceObligations(
  byEvent: ReadonlyMap<string, ObligationView[]>,
  event: CalendarOccurrence | undefined,
): ObligationView[] {
  if (!event?.accountId || !event.id) return [];
  const own = byEvent.get(calendarEventKey(event.accountId, event.id)) ?? [];
  if (!event.masterEventId || event.masterEventId === event.id) return own;
  const start = event.startDate ? Date.parse(event.startDate) : Number.NaN;
  const series = (byEvent.get(calendarEventKey(event.accountId, event.masterEventId)) ?? []).filter(
    (item) => item.eventStart === start,
  );
  return series.length ? [...series, ...own] : own;
}

/** The open items of each Albatross, by `workId`. */
export function obligationsByWork(
  items: readonly ObligationView[],
  now: number,
): Map<string, ObligationView[]> {
  const map = new Map<string, ObligationView[]>();
  for (const item of items) {
    if (!item.workId || !isOpenObligation(item, now)) continue;
    const list = map.get(item.workId);
    if (list) list.push(item);
    else map.set(item.workId, [item]);
  }
  for (const list of map.values()) list.sort(compareByCreated);
  return map;
}

/** The items of each Albatross that the user owes: an item that waits on someone else is not one. */
export function owedByWork(items: readonly ObligationView[], now: number): Map<string, ObligationView[]> {
  return obligationsByWork(
    items.filter((item) => item.kind !== 'waiting'),
    now,
  );
}

function compareByCreated(a: ObligationView, b: ObligationView): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

// ---- Albatross areas -------------------------------------------------------

/**
 * The ledger items of an area, as rows of its "Needs you" section: the items
 * whose Albatross is one of the area's Albatrosses. The asker leads the
 * detail, so the row reads "Priya Raman asks ...".
 */
export function obligationNeedsYouRows(
  byWork: ReadonlyMap<string, readonly ObligationView[]>,
  workIds: readonly string[],
  titles: ReadonlyMap<string, string> = new Map(),
): AreaNeedsYouRow[] {
  const rows: AreaNeedsYouRow[] = [];
  for (const workId of workIds) {
    for (const item of byWork.get(workId) ?? []) {
      const work = titles.get(workId) ?? item.workTitle?.trim();
      rows.push({
        id: `obligation:${item.id}`,
        kind: 'obligation',
        title: item.title,
        detail: work ? `${item.asker}, in ${work}` : item.asker,
        workId,
        obligationId: item.id,
      });
    }
  }
  return rows;
}

/** The chooser sentence counts plans and tasks, not the ledger. It says so. */
export function areaChooserSentence(needsYou: number): string {
  if (needsYou <= 0) return '';
  return needsYou === 1
    ? '1 plan or task needs you across your areas.'
    : `${needsYou} plans and tasks need you across your areas.`;
}

// ---- The browser tab -------------------------------------------------------

/** "(3) Albatross" while something needs the user now; the plain name otherwise. */
export function tabTitle(base: string, now: number): string {
  return now > 0 ? `(${now}) ${base}` : base;
}

// ---- The palette -----------------------------------------------------------

export interface NeedsYouSearchHit {
  id: string;
  title: string;
  detail: string;
  obligationId: string;
}

function matches(text: string, query: string): boolean {
  const haystack = text.toLocaleLowerCase();
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((word) => haystack.includes(word));
}

/**
 * The open items whose title, asker, or place matches the query, in list
 * order, at most `limit`. A code never matches: its value stays on the code row.
 */
export function searchNeedsYouItems(
  entries: readonly NeedsYouEntry[],
  query: string,
  limit = 6,
): NeedsYouSearchHit[] {
  const hits: NeedsYouSearchHit[] = [];
  for (const entry of entries) {
    if (entry.type !== 'obligation') continue;
    const { obligation } = entry;
    if (obligation.kind === 'code' || isClosedObligation(obligation)) continue;
    const place = obligation.sourceLabel?.trim() || '';
    if (!matches(`${obligation.title} ${obligation.asker} ${place}`, query)) continue;
    hits.push({
      id: `needs-you:${obligation.id}`,
      title: obligation.title,
      detail: place ? `${obligation.asker}, ${place}` : obligation.asker,
      obligationId: obligation.id,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** The "Jump to" pages with the bell's page under the name a flag user knows. */
export function needsYouPages<T extends { id: string; title: string; detail: string }>(
  pages: readonly T[],
  enabled: boolean,
): T[] {
  if (!enabled) return [...pages];
  return pages.map((page) =>
    page.id === 'page:notifications'
      ? { ...page, title: 'Needs you', detail: 'What needs you, in one list' }
      : page,
  );
}

// ---- The reader strip ------------------------------------------------------

/** The first open item of a thread leads the strip; the rest is a count. */
export function threadStripWords(
  items: readonly ObligationView[],
): { lead: ObligationView; others: number } | null {
  if (!items.length) return null;
  return { lead: items[0], others: items.length - 1 };
}
