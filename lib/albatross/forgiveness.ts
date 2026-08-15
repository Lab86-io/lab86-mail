// Forgiveness, as behaviour rather than tone.
//
// Plenty of software can generate a plan. Very little is designed around the
// fact that people get tired, avoid things, change their minds, and disappear
// for two weeks. The rule underneath everything here: when a plan fails, the
// plan was wrong. Not the person.
//
// So nothing in this file counts what is undone, nothing turns red, and the
// word "overdue" does not appear anywhere in it.

export type LapseReason =
  | 'no_energy'
  | 'no_time'
  | 'something_else_came_first'
  | 'blocked'
  | 'need_help'
  | 'step_too_large'
  | 'matters_less_now'
  | 'forgot'
  | 'other';

export type Recovery = 'done' | 'move' | 'shrink' | 'wait' | 'delegate' | 'pause' | 'release' | 'rebuild';

/** What the user says happened. Every one of these is a normal thing. */
export const LAPSE_REASONS: Array<{ kind: LapseReason; label: string }> = [
  { kind: 'no_energy', label: 'No energy' },
  { kind: 'no_time', label: 'Not enough time' },
  { kind: 'something_else_came_first', label: 'Something else came first' },
  { kind: 'blocked', label: 'I am blocked' },
  { kind: 'need_help', label: 'I need help' },
  { kind: 'step_too_large', label: 'The step was too large' },
  { kind: 'matters_less_now', label: 'This matters less now' },
  { kind: 'forgot', label: 'I forgot' },
];

export const RECOVERY_LABEL: Record<Recovery, string> = {
  done: 'It happened',
  move: 'Find another time',
  shrink: 'Make it smaller',
  wait: 'Wait on somebody',
  delegate: 'Hand it to someone',
  pause: 'Pause this',
  release: 'Put it down',
  rebuild: 'Rebuild the plan',
};

export function recoveryWorkState(recovery: Recovery): 'waiting' | 'paused' | 'released' | null {
  if (recovery === 'wait') return 'waiting';
  if (recovery === 'pause') return 'paused';
  if (recovery === 'release') return 'released';
  return null;
}

/**
 * The recoveries worth offering for a given reason. Offering all seven every
 * time is its own kind of burden; the useful move is usually implied by what
 * the person just said.
 */
export function recoveriesFor(reason: LapseReason | null): Recovery[] {
  let choices: Recovery[];
  switch (reason) {
    case 'no_energy':
      choices = ['shrink', 'move', 'pause'];
      break;
    case 'no_time':
      choices = ['move', 'shrink', 'delegate'];
      break;
    case 'something_else_came_first':
      choices = ['move', 'pause'];
      break;
    case 'blocked':
      choices = ['wait', 'rebuild', 'pause'];
      break;
    case 'need_help':
      choices = ['delegate', 'rebuild', 'wait'];
      break;
    case 'step_too_large':
      choices = ['shrink', 'rebuild'];
      break;
    case 'matters_less_now':
      choices = ['pause', 'release'];
      break;
    case 'forgot':
      choices = ['move', 'shrink'];
      break;
    default:
      choices = ['move', 'shrink', 'pause', 'release'];
  }
  return [...choices, 'done'];
}

/**
 * What the interface says when a block passes.
 *
 * Never "overdue", never "missed", never "you". The block passed — that is a
 * fact about a plan, not a verdict on a person.
 */
export function lapseHeadline(stepTitle?: string | null): string {
  return stepTitle
    ? `"${stepTitle}" did not happen. What should happen now?`
    : 'That block passed. What should happen now?';
}

/**
 * A smaller version of a step, in words. The north star's example is exact:
 * "Complete the entire passport application" becomes "Find your current
 * passport and put it near your desk".
 */
export function shrinkSuggestion(stepTitle?: string | null): string {
  const title = (stepTitle || '').trim();
  if (!title) return 'Spend five minutes working out what the first move actually is.';
  return `Spend five minutes on the smallest part of "${title}" — enough to see what it really needs.`;
}

/** How Albatross acknowledges the answer. It agrees; it never consoles. */
export function recoveryAcknowledgement(recovery: Recovery): string {
  switch (recovery) {
    case 'done':
      return 'Recorded as done. Albatross will carry the next move forward.';
    case 'move':
      return 'Moved. Albatross will look for another opening.';
    case 'shrink':
      return 'Smaller it is. That is usually the right call.';
    case 'wait':
      return 'Waiting. Albatross will watch for the reply.';
    case 'delegate':
      return 'Handed off. Albatross will track it from here.';
    case 'pause':
      return 'Paused. It stays where you left it.';
    case 'release':
      return 'Put down. That is one less thing.';
    case 'rebuild':
      return 'The plan was wrong. Albatross will find another way through.';
  }
}

export type { WorkShape } from '@/lib/albatross/work-shape';

import type { WorkShape } from '@/lib/albatross/work-shape';

/**
 * How long a shape can sit still before it is worth asking about.
 *
 * A flat ninety days is too blunt: a small errand deserves a nudge in a
 * fortnight, a government application should not be nagged while it is
 * genuinely in processing, and a practice paused after an injury must not be
 * asked about repeatedly.
 */
export const STALE_AFTER_DAYS: Record<WorkShape, number> = {
  quick: 14,
  decision: 21,
  project: 45,
  recurring: 60,
  practice: 90,
  monitor: 120,
};

export interface StalenessInput {
  shape?: WorkShape | null;
  workState?: string | null;
  updatedAt: number;
  /** When the user last told Albatross to leave this alone. */
  reviewAt?: number | null;
}

export function isStale(work: StalenessInput, nowMs: number): boolean {
  // Nothing already put down or finished is ever asked about again.
  if (work.workState === 'released' || work.workState === 'done' || work.workState === 'archived') {
    return false;
  }
  // Waiting is an active state, not neglect. A government office taking eight
  // weeks is not the user failing to act.
  if (work.workState === 'waiting' || work.workState === 'blocked') return false;
  // The user asked to be left alone until a date. Honour it exactly.
  if (work.reviewAt && nowMs < work.reviewAt) return false;
  const days = STALE_AFTER_DAYS[(work.shape as WorkShape) || 'project'];
  return nowMs - work.updatedAt > days * 24 * 3_600_000;
}

/**
 * The review is batched on purpose. One prompt per item, arriving whenever each
 * happens to age out, is exactly the drip of small guilt the product exists to
 * remove.
 */
export function reviewBatch<T extends StalenessInput>(work: T[], nowMs: number, limit = 5): T[] {
  return work
    .filter((row) => isStale(row, nowMs))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, limit);
}

export function reviewHeadline(count: number): string {
  if (count === 1) return 'One thing has not moved in a while. Does it still deserve space?';
  return `${count} things have not moved in a while. Which still deserve space?`;
}

/**
 * Coming back after a while away.
 *
 * The rule is absolute: never a wall of accumulated overdue work. The product
 * exists to remove that feeling, so producing it at the exact moment somebody
 * returns would undo everything else.
 */
export function reEntryDaysAway(lastSeenAt: number | null, nowMs: number): number {
  if (!lastSeenAt) return 0;
  return Math.floor((nowMs - lastSeenAt) / (24 * 3_600_000));
}

export function shouldOfferReEntry(lastSeenAt: number | null, nowMs: number): boolean {
  return reEntryDaysAway(lastSeenAt, nowMs) >= 7;
}

export function reEntryLine(days: number): string {
  if (days >= 28) return 'Welcome back. It has been a while, and a lot may have changed.';
  if (days >= 14) return 'Welcome back. A couple of weeks is enough for things to move.';
  return 'Welcome back. Some of this may be out of date now.';
}
