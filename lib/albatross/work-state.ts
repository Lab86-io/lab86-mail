// One definition of what state an Albatross is in, and one definition of what
// "needs you" means. Today, the rail, the list and the notification centre all
// read from here — before this, each surface decided for itself and they
// disagreed (the Areas pane said "0 active" while three questions waited in a
// popover).

export type WorkStateKey =
  | 'needs_you'
  | 'in_progress'
  | 'waiting'
  | 'unresolved'
  | 'paused'
  | 'done'
  | 'archived';

export interface WorkStateInput {
  workState?: string | null;
  agentState?: string | null;
  status?: string | null;
  openQuestions?: number;
  planError?: string | null;
}

/**
 * True when the system cannot move without the user: an open question, a
 * failed run awaiting a decision, or an explicit needs-input agent state.
 */
export function needsYou(work: WorkStateInput): boolean {
  if (isClosed(work)) return false;
  if ((work.openQuestions ?? 0) > 0) return true;
  if (work.agentState === 'needs_input') return true;
  if (work.agentState === 'error' || work.planError) return true;
  return work.status === 'needs_answers';
}

export function isClosed(work: WorkStateInput): boolean {
  const state = work.workState || work.status;
  return state === 'done' || state === 'archived';
}

/** Closed on paper, but Albatross is still waiting on an answer. */
export function isUnresolved(work: WorkStateInput): boolean {
  return isClosed(work) && (work.openQuestions ?? 0) > 0;
}

export function workStateKey(work: WorkStateInput): WorkStateKey {
  if (isUnresolved(work)) return 'unresolved';
  if (work.workState === 'archived' || work.status === 'archived') return 'archived';
  if (work.workState === 'done' || work.status === 'done') return 'done';
  if (needsYou(work)) return 'needs_you';
  if (work.workState === 'paused') return 'paused';
  if (work.workState === 'waiting' || work.workState === 'blocked') return 'waiting';
  return 'in_progress';
}

export const WORK_STATE_LABEL: Record<WorkStateKey, string> = {
  needs_you: 'Needs you',
  in_progress: 'In progress',
  waiting: 'Waiting',
  unresolved: 'Still asking',
  paused: 'Paused',
  done: 'Done',
  archived: 'Put down',
};

// Group order on the Albatrosses surface. What needs the user comes first;
// what is finished comes last.
export const WORK_STATE_ORDER: WorkStateKey[] = [
  'needs_you',
  'in_progress',
  'waiting',
  'unresolved',
  'paused',
  'done',
  'archived',
];

export const WORK_STATE_HINT: Record<WorkStateKey, string> = {
  needs_you: 'Albatross cannot move these without you.',
  in_progress: 'Albatross is working on these.',
  waiting: 'These depend on somebody or something else.',
  unresolved: 'You put these down, but Albatross never got an answer.',
  paused: 'You stopped these on purpose.',
  done: 'These reached the outcome you wanted.',
  archived: 'You put these down.',
};

/**
 * The rail badge. A count of open Albatrosses is a count of weights, so the
 * badge says what is waiting instead, and says nothing when nothing is.
 */
export function railWorkBadge(items: WorkStateInput[]): string | null {
  const count = items.filter((item) => needsYou(item)).length;
  if (count === 0) return null;
  if (count === 1) return 'One needs you';
  return `${count} need you`;
}
