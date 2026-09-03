// Today answers one question: what deserves attention today, given the life
// this person actually has today.
//
// The composition lives here, away from React, because the ordering rule is the
// product decision. Whatever needs the user comes first and largest; the day's
// fixed constraints come second; everything decorative comes last or not at
// all. Before this, the brief gave its biggest graphic to the weather and
// rendered "3 Work questions need you" at roughly 12px.

import { type HorizonWorkLike, isDormant } from './horizon';
import { needsYou, type WorkStateInput } from './work-state';

export type Capacity = 'low' | 'normal' | 'high';

export const CAPACITY_LABEL: Record<Capacity, string> = {
  low: 'Low capacity',
  normal: 'Normal',
  high: 'High capacity',
};

export interface TodayEvent {
  _id: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location?: string | null;
  status?: string | null;
}

export interface TodayWork extends WorkStateInput, HorizonWorkLike {
  _id: string;
  title: string | null;
  rawText: string;
  areaName?: string | null;
  openQuestions: number;
  updatedAt: number;
  nextStep?: string | null;
  scheduledStartAt?: number | null;
  scheduledEndAt?: number | null;
}

export interface TodayApproval {
  _id: string;
  title: string;
  status: string;
  intentId?: string;
}

/** The window a day covers, in the viewer's own clock. */
export function dayWindow(nowMs: number): { startAt: number; endAt: number } {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startAt: start.getTime(), endAt: end.getTime() };
}

/** Cancelled events are not part of anybody's day. */
export function fixedSchedule(events: TodayEvent[]): TodayEvent[] {
  return (
    events
      .filter((event) => event.status !== 'cancelled')
      // All-day rows frame the day (a flight, a holiday), so they sit on top.
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt - b.startAt)
  );
}

export function eventWindowLabel(event: TodayEvent, locale = 'en-US'): string {
  if (event.allDay) return 'All day';
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `${time(event.startAt)} – ${time(event.endAt)}`;
}

/**
 * What Albatross cannot move without the user. Approvals rank above questions:
 * an approval is a decision already prepared and waiting on one word.
 */
export function needsYouToday(work: TodayWork[], approvals: TodayApproval[], nowMs = Date.now()) {
  // Dormant Work asks for nothing until it wakes.
  const items = work.filter((row) => !isDormant(row, nowMs) && needsYou(row));
  return {
    approvals: approvals.filter((row) => row.status === 'pending' || row.status === 'claiming'),
    work: items.sort((a, b) => b.openQuestions - a.openQuestions || b.updatedAt - a.updatedAt),
  };
}

/**
 * Work Albatross could advance today. This is not a promise and not a booking —
 * reserved time is a different idea, and it does not exist yet. Calling these
 * "scheduled" would be a lie the calendar could not back up.
 */
export function openWork(work: TodayWork[], nowMs = Date.now()): TodayWork[] {
  return work.filter(
    (row) =>
      !isDormant(row, nowMs) &&
      !needsYou(row) &&
      row.workState !== 'waiting' &&
      row.workState !== 'blocked' &&
      row.workState !== 'paused' &&
      row.workState !== 'done' &&
      row.workState !== 'archived',
  );
}

/** A real applied calendar hold, not a model's unsaved suggestion. */
export function hasUpcomingBooking(work: TodayWork, nowMs = Date.now()): boolean {
  return Boolean(work.scheduledEndAt && work.scheduledEndAt > nowMs);
}

export const CAPACITY_SHOWN: Record<Capacity, number> = { low: 1, normal: 3, high: 6 };

/**
 * Capacity is the user's own statement about their day, so it changes how much
 * Albatross puts in front of them. It must never quietly drop the rest: a cap
 * that hides without saying so is the same sin as a list of overdue work, just
 * politer. `heldBack` exists so the surface can offer the remainder.
 */
export function readyToMove(
  work: TodayWork[],
  capacity: Capacity,
  nowMs = Date.now(),
): { items: TodayWork[]; heldBack: number } {
  const sorted = openWork(work, nowMs)
    .filter((row) => !hasUpcomingBooking(row, nowMs))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const shown = sorted.slice(0, CAPACITY_SHOWN[capacity]);
  return { items: shown, heldBack: sorted.length - shown.length };
}

export function waitingOnSomebody(work: TodayWork[]): TodayWork[] {
  return work
    .filter((row) => row.workState === 'waiting' || row.workState === 'blocked')
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * One human sentence about the shape of the day. It never scolds, never counts
 * what is undone, and says plainly when there is nothing to do.
 */
export function dayShapeLine(input: {
  needsYouCount: number;
  eventCount: number;
  capacity: Capacity;
  /** Open Albatrosses Albatross is carrying but that need nothing from you. */
  carryingCount?: number;
}): string {
  const { needsYouCount, eventCount, capacity } = input;
  const carrying = input.carryingCount ?? 0;
  if (needsYouCount === 0 && eventCount === 0) {
    // "The day is yours" is only true when there is genuinely nothing in it.
    // Saying it while Albatross is visibly carrying work reads as a system
    // that has not looked at its own page.
    if (carrying === 1) return 'Nothing needs you today. Albatross is carrying one thing on its own.';
    if (carrying > 1) {
      return `Nothing needs you today. Albatross is carrying ${carrying} things on its own.`;
    }
    return 'Nothing needs you and nothing is booked. The day is yours.';
  }
  const parts: string[] = [];
  if (needsYouCount === 1) parts.push('One thing needs you');
  else if (needsYouCount > 1) parts.push(`${needsYouCount} things need you`);
  if (eventCount === 1) parts.push('one thing is booked');
  else if (eventCount > 1) parts.push(`${eventCount} things are booked`);
  const sentence = parts.length ? `${parts.join(', and ')}.` : 'Nothing needs you today.';
  if (capacity === 'low') return `${sentence} Keeping the rest light.`;
  if (capacity === 'high') return `${sentence} There is room for more.`;
  return sentence;
}

/** Human date line for the Today header. */
export function todayDateline(nowMs: number, locale = 'en-US'): string {
  return new Date(nowMs).toLocaleDateString(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * How old the generated brief is, said plainly. A brief that failed to
 * regenerate used to present itself as "Live" while being weeks stale.
 */
export function briefFreshness(generatedAt: number | null, nowMs: number): string | null {
  if (!generatedAt) return null;
  const hours = Math.floor((nowMs - generatedAt) / 3_600_000);
  if (hours < 1) return 'Written just now';
  if (hours < 24) return `Written ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Written yesterday';
  return `Written ${days} days ago`;
}

/** A brief this old is describing a different day, and should say so loudly. */
export function briefIsStale(generatedAt: number | null, nowMs: number): boolean {
  if (!generatedAt) return false;
  return nowMs - generatedAt > 36 * 3_600_000;
}

export interface TodayPractice {
  _id: string;
  title: string;
  cadence: string;
  nextRunAt: number | null;
  areaName?: string | null;
}

export const CADENCE_LABEL: Record<string, string> = {
  daily: 'Most days',
  weekdays: 'Weekdays',
  weekly: 'Once a week',
  custom: 'On your own rhythm',
};

/**
 * A practice is not a project and must never be scored. No streak, no percent,
 * no broken chain — the north star is explicit that consistency and recovery
 * matter and that perfect weeks do not.
 */
export function practiceLine(practice: TodayPractice, nowMs: number): string {
  const cadence = CADENCE_LABEL[practice.cadence] || CADENCE_LABEL.custom;
  if (!practice.nextRunAt) return cadence;
  if (practice.nextRunAt <= nowMs) return `${cadence} · there is room for it today`;
  const sameDay = new Date(practice.nextRunAt).toDateString() === new Date(nowMs).toDateString();
  return sameDay ? `${cadence} · later today` : cadence;
}

export interface TodayMail {
  id: string;
  subject: string;
  from: string;
  reason?: string | null;
}

/**
 * Only mail that bears on today. The north star is strict here: this section
 * is not an inbox digest, and every item in it should be something a person
 * would be annoyed to have missed.
 */
export function importantMailToday(items: TodayMail[], limit = 4): TodayMail[] {
  return items.slice(0, limit);
}
