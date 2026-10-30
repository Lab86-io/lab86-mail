// Needs you (docs/needs-you.md, phase 1 W1): the page groups. Pure: the
// server gives the items, this file sorts them into the groups of
// NEEDS_YOU_GROUP_ORDER for one moment in the user's time zone.

import { horizonClock } from '@/lib/albatross/horizon';
import {
  CLOSED_STATES,
  NEEDS_YOU_GROUP_LABELS,
  NEEDS_YOU_GROUP_ORDER,
  type NeedsYouGroupId,
  type ObligationView,
} from './contract';

/** The Albatross items that the Notifications model already projects. */
export interface NeedsYouExtraLike {
  id: string;
  kind: 'question' | 'approval' | 'checkin' | 'update';
  attention: boolean;
  createdAt?: number;
}

export type NeedsYouEntry<T extends NeedsYouExtraLike = NeedsYouExtraLike> =
  | { type: 'obligation'; id: string; obligation: ObligationView }
  | { type: 'albatross'; id: string; item: T };

export interface NeedsYouGroup<T extends NeedsYouExtraLike = NeedsYouExtraLike> {
  id: NeedsYouGroupId;
  label: string;
  entries: NeedsYouEntry<T>[];
}

const HOUR_MS = 60 * 60 * 1000;
const MORNING_HOUR = 9;

export function isClosedObligation(obligation: Pick<ObligationView, 'state'>): boolean {
  return CLOSED_STATES.includes(obligation.state);
}

interface DayBounds {
  startOfToday: number;
  startOfTomorrow: number;
  startOfWeekAfter: number;
}

function dayBounds(now: number, timezone: string): DayBounds {
  const clock = horizonClock(timezone);
  const today = clock.today(now);
  return {
    startOfToday: clock.midnight(today.year, today.month, today.day),
    startOfTomorrow: clock.midnight(today.year, today.month, today.day + 1),
    startOfWeekAfter: clock.midnight(today.year, today.month, today.day + 7),
  };
}

/**
 * The group of one obligation, or null when the page hides it: closed before
 * today, or snoozed until a later time.
 */
export function obligationGroup(
  obligation: ObligationView,
  now: number,
  timezone: string,
): NeedsYouGroupId | null {
  return groupWithBounds(obligation, now, dayBounds(now, timezone));
}

function groupWithBounds(obligation: ObligationView, now: number, bounds: DayBounds): NeedsYouGroupId | null {
  if (isClosedObligation(obligation)) {
    return (obligation.closedAt ?? obligation.updatedAt) >= bounds.startOfToday ? 'closed_today' : null;
  }
  if (obligation.state === 'snoozed' && (obligation.snoozedUntil ?? 0) > now) return null;
  if (obligation.kind === 'waiting') return 'waiting';
  if (obligation.kind === 'code' || obligation.pushLevel === 'time_sensitive') return 'now';
  if (obligation.dueAt !== undefined) {
    if (obligation.dueAt < now) return 'now';
    if (obligation.dueAt < bounds.startOfTomorrow) return 'today';
    if (obligation.dueAt < bounds.startOfWeekAfter) return 'this_week';
    return 'after_this_week';
  }
  if (obligation.due === 'today') return 'today';
  if (obligation.due === 'soon') return 'this_week';
  if (obligation.due === 'later') return 'after_this_week';
  return 'no_date';
}

function extraGroup(item: NeedsYouExtraLike): NeedsYouGroupId | null {
  if (!item.attention) return null;
  if (item.kind === 'question' || item.kind === 'approval') return 'now';
  if (item.kind === 'checkin') return 'today';
  return null;
}

/** A code's expiry is its due time: the soonest to expire comes first. */
function dueOf<T extends NeedsYouExtraLike>(entry: NeedsYouEntry<T>): number | undefined {
  if (entry.type !== 'obligation') return undefined;
  const { obligation } = entry;
  if (obligation.kind === 'code' && !isClosedObligation(obligation)) return obligation.code?.expiresAt;
  return obligation.dueAt;
}

function recencyOf<T extends NeedsYouExtraLike>(entry: NeedsYouEntry<T>): number {
  if (entry.type === 'albatross') return entry.item.createdAt ?? 0;
  const { obligation } = entry;
  if (isClosedObligation(obligation)) return obligation.closedAt ?? obligation.updatedAt;
  return obligation.createdAt;
}

/** Dated entries first, by date; then the newest first. */
export function compareEntries<T extends NeedsYouExtraLike>(
  a: NeedsYouEntry<T>,
  b: NeedsYouEntry<T>,
): number {
  const dueA = dueOf(a);
  const dueB = dueOf(b);
  if (dueA !== undefined && dueB !== undefined && dueA !== dueB) return dueA - dueB;
  if (dueA !== undefined && dueB === undefined) return -1;
  if (dueA === undefined && dueB !== undefined) return 1;
  const recency = recencyOf(b) - recencyOf(a);
  return recency || a.id.localeCompare(b.id);
}

/**
 * The groups of the page, in display order, without the empty ones. `extras`
 * are the Albatross questions, approvals, and check-ins: questions and
 * approvals sit in Now, check-ins in Today.
 */
export function groupNeedsYou<T extends NeedsYouExtraLike>(
  items: readonly ObligationView[],
  extras: readonly T[],
  now: number,
  timezone: string,
): NeedsYouGroup<T>[] {
  const bounds = dayBounds(now, timezone);
  const buckets = new Map<NeedsYouGroupId, NeedsYouEntry<T>[]>();
  const put = (group: NeedsYouGroupId | null, entry: NeedsYouEntry<T>) => {
    if (!group) return;
    const bucket = buckets.get(group);
    if (bucket) bucket.push(entry);
    else buckets.set(group, [entry]);
  };
  for (const obligation of items) {
    put(groupWithBounds(obligation, now, bounds), { type: 'obligation', id: obligation.id, obligation });
  }
  for (const item of extras) put(extraGroup(item), { type: 'albatross', id: item.id, item });
  return NEEDS_YOU_GROUP_ORDER.flatMap((id) => {
    const entries = buckets.get(id);
    if (!entries?.length) return [];
    return [{ id, label: NEEDS_YOU_GROUP_LABELS[id], entries: entries.sort(compareEntries) }];
  });
}

export interface NeedsYouSummary {
  now: number;
  open: number;
  closedToday: number;
}

/** "3 now · 9 open · 3 closed today": `open` counts every group but Closed today. */
export function needsYouSummary(groups: readonly NeedsYouGroup<NeedsYouExtraLike>[]): NeedsYouSummary {
  let now = 0;
  let open = 0;
  let closedToday = 0;
  for (const group of groups) {
    if (group.id === 'closed_today') closedToday += group.entries.length;
    else {
      open += group.entries.length;
      if (group.id === 'now') now += group.entries.length;
    }
  }
  return { now, open, closedToday };
}

export type LaterOptionId = 'later_today' | 'tomorrow_morning' | 'next_week';

export interface LaterOption {
  id: LaterOptionId;
  label: string;
  until: number;
}

/**
 * The Later menu: in three hours (only while that is still today), tomorrow
 * at 9, and next Monday at 9, in the user's time zone.
 */
export function laterOptions(now: number, timezone: string): LaterOption[] {
  const clock = horizonClock(timezone);
  const today = clock.today(now);
  const startOfTomorrow = clock.midnight(today.year, today.month, today.day + 1);
  const daysToMonday = (1 - today.weekday + 7) % 7 || 7;
  const nextMonday = clock.midnight(today.year, today.month, today.day + daysToMonday);
  const options: LaterOption[] = [];
  const laterToday = now + 3 * HOUR_MS;
  if (laterToday < startOfTomorrow)
    options.push({ id: 'later_today', label: 'Later today', until: laterToday });
  options.push({
    id: 'tomorrow_morning',
    label: 'Tomorrow morning',
    until: startOfTomorrow + MORNING_HOUR * HOUR_MS,
  });
  options.push({ id: 'next_week', label: 'Next week', until: nextMonday + MORNING_HOUR * HOUR_MS });
  return options;
}
