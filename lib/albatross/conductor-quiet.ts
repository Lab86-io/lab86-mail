// The conductor quiet rule.
//
// The conductor moves Work the user is working on. It does not move Work the
// user has not touched, unless a horizon woke it or the user asked for a plan.
// A quiet product is the point: Work that sits still is not a fault.

import { type HorizonWorkLike, isDormant } from './horizon';

/** How long one user touch keeps the conductor allowed to move the Work. */
export const USER_TOUCH_WINDOW_MS = 24 * 60 * 60_000;

export type AdvanceTrigger = 'user' | 'conductor' | 'evidence';

export interface QuietRuleWork extends HorizonWorkLike {
  createdAt: number;
  lastUserTouchAt?: number | null;
}

/** The last time the user acted. A capture is a touch, so rows without the field use createdAt. */
export function lastUserTouch(work: QuietRuleWork): number {
  return typeof work.lastUserTouchAt === 'number' ? work.lastUserTouchAt : work.createdAt;
}

/** True while the user acted on this Work inside the touch window. */
export function userTouchedRecently(work: QuietRuleWork, nowMs: number): boolean {
  return nowMs - lastUserTouch(work) <= USER_TOUCH_WINDOW_MS;
}

/** True while a wake fired inside the touch window. The wake stands in for one user touch. */
export function wokeRecently(work: QuietRuleWork, nowMs: number): boolean {
  const wokeAt = work.horizon?.wokeAt;
  return typeof wokeAt === 'number' && wokeAt <= nowMs && nowMs - wokeAt <= USER_TOUCH_WINDOW_MS;
}

export type QuietVerdict = 'move' | 'dormant' | 'quiet';

/**
 * Decide whether an advance may run for this trigger.
 *
 * - `user`: the user asked. Always move.
 * - `evidence`: proof arrived. Move unless the Work is dormant.
 * - `conductor`: move only Work the user touched recently or a wake returned.
 */
export function conductorVerdict(work: QuietRuleWork, trigger: AdvanceTrigger, nowMs: number): QuietVerdict {
  if (trigger === 'user') return 'move';
  if (isDormant(work, nowMs)) return 'dormant';
  if (trigger === 'evidence') return 'move';
  if (userTouchedRecently(work, nowMs) || wokeRecently(work, nowMs)) return 'move';
  return 'quiet';
}

export function conductorMayMove(work: QuietRuleWork, trigger: AdvanceTrigger, nowMs: number): boolean {
  return conductorVerdict(work, trigger, nowMs) === 'move';
}
