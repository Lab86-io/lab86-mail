// The shape policy.
//
// Each shape has its own contract. A list is never planned, never verified,
// and never stale. A practice logs a metric. A project holds milestones and
// artifact evidence. Every conductor candidate query reads this table, so a
// shape that says "no" is never touched by that pass.

import type { WorkShape } from '@/lib/albatross/work-shape';

export type ShapePlans = 'yes' | 'no' | 'milestones' | 'options';
export type ShapeVerifies = 'yes' | 'no' | 'artifacts' | 'metric' | 'choice' | 'condition' | 'run';
export type ShapeDetail = 'guided' | 'list' | 'milestones' | 'practice' | 'decision' | 'monitor' | 'routine';
export type ShapeConductorPass = 'mailWatch' | 'staleness' | 'missedMove';

export interface ShapePolicyEntry {
  /** How the planner treats the shape. `no` means no plan is ever written. */
  plans: ShapePlans;
  /** What counts as proof. `no` means nothing is verified. */
  verifies: ShapeVerifies;
  /** Days of stillness before a review. `null` means the shape is never stale. */
  staleAfterDays: number | null;
  /** May the mail watcher poll this shape. */
  mailWatch: boolean;
  /** May the staleness review name this shape. */
  staleness: boolean;
  /** May the missed-move scan name this shape. */
  missedMove: boolean;
  /** Which detail body the clients render. */
  detail: ShapeDetail;
}

export const SHAPE_POLICY: Record<WorkShape, ShapePolicyEntry> = {
  quick: {
    plans: 'yes',
    verifies: 'yes',
    staleAfterDays: 14,
    mailWatch: true,
    staleness: true,
    missedMove: true,
    detail: 'guided',
  },
  list: {
    plans: 'no',
    verifies: 'no',
    staleAfterDays: null,
    mailWatch: false,
    staleness: false,
    missedMove: false,
    detail: 'list',
  },
  project: {
    plans: 'milestones',
    verifies: 'artifacts',
    staleAfterDays: 45,
    mailWatch: false,
    staleness: true,
    missedMove: false,
    detail: 'milestones',
  },
  practice: {
    plans: 'no',
    verifies: 'metric',
    staleAfterDays: null,
    mailWatch: false,
    staleness: false,
    missedMove: false,
    detail: 'practice',
  },
  decision: {
    plans: 'options',
    verifies: 'choice',
    staleAfterDays: 21,
    mailWatch: false,
    staleness: true,
    missedMove: false,
    detail: 'decision',
  },
  monitor: {
    plans: 'no',
    verifies: 'condition',
    staleAfterDays: null,
    mailWatch: true,
    staleness: false,
    missedMove: false,
    detail: 'monitor',
  },
  recurring: {
    plans: 'no',
    verifies: 'run',
    staleAfterDays: null,
    mailWatch: false,
    staleness: false,
    missedMove: false,
    detail: 'routine',
  },
};

/**
 * The shape a row without one is read as. Work from before shapes existed was
 * planned, watched, and reviewed, and `quick` is the shape with that contract.
 */
export const DEFAULT_WORK_SHAPE: WorkShape = 'quick';

/** Resolve a stored shape. Unknown or missing values fall back to the default. */
export function resolveShape(shape: string | null | undefined): WorkShape {
  return shape && shape in SHAPE_POLICY ? (shape as WorkShape) : DEFAULT_WORK_SHAPE;
}

/** True when the named conductor pass may touch Work of this shape. */
export function shapeAllows(shape: string | null | undefined, pass: ShapeConductorPass): boolean {
  return SHAPE_POLICY[resolveShape(shape)][pass];
}

/** How the planner treats this shape. */
export function shapePlans(shape: string | null | undefined): ShapePlans {
  return SHAPE_POLICY[resolveShape(shape)].plans;
}

/** Which detail body the clients render for this shape. */
export function shapeDetail(shape: string | null | undefined): ShapeDetail {
  return SHAPE_POLICY[resolveShape(shape)].detail;
}

/** What counts as proof for this shape. */
export function shapeVerifies(shape: string | null | undefined): ShapeVerifies {
  return SHAPE_POLICY[resolveShape(shape)].verifies;
}

/** One short line per shape, for a shape picker. The shape word is the key. */
export const SHAPE_MEANING: Record<WorkShape, string> = {
  quick: 'One thing to finish. Steps and checks.',
  list: 'Items to keep. No steps, no checks.',
  project: 'Milestones and a log.',
  practice: 'Log a number over time.',
  decision: 'Options, then one choice.',
  monitor: 'Watch for a change.',
  recurring: 'A task that comes back.',
};
