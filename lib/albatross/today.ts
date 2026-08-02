// Today answers one question: what deserves attention today, given the life
// this person actually has today.
//
// The composition lives here, away from React, because the ordering rule is the
// product decision. Whatever needs the user comes first and largest; the day's
// fixed constraints come second; everything decorative comes last or not at
// all. Before this, the brief gave its biggest graphic to the weather and
// rendered "3 Work questions need you" at roughly 12px.

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

export interface TodayWork extends WorkStateInput {
  _id: string;
  title: string | null;
  rawText: string;
  areaName?: string | null;
  openQuestions: number;
  updatedAt: number;
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
export function needsYouToday(work: TodayWork[], approvals: TodayApproval[]) {
  const items = work.filter((row) => needsYou(row));
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
export function readyToMove(work: TodayWork[], capacity: Capacity): TodayWork[] {
  const open = work.filter(
    (row) =>
      !needsYou(row) &&
      row.workState !== 'waiting' &&
      row.workState !== 'blocked' &&
      row.workState !== 'paused' &&
      row.workState !== 'done' &&
      row.workState !== 'archived',
  );
  const sorted = open.sort((a, b) => b.updatedAt - a.updatedAt);
  // Capacity is the user's own statement about their day, so it changes how
  // much Albatross puts in front of them — never what it hides from them.
  const cap = capacity === 'low' ? 1 : capacity === 'high' ? 6 : 3;
  return sorted.slice(0, cap);
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
}): string {
  const { needsYouCount, eventCount, capacity } = input;
  if (needsYouCount === 0 && eventCount === 0) {
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
