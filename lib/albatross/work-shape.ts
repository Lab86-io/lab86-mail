/**
 * The kind of outcome an albatross is. The shape decides which brief form the
 * work gets and how long it can sit still before a review. A practice is not a
 * project waiting to be finished; a monitor is never "done" at all; a list is
 * a collection with no finish line.
 */
export const WORK_SHAPES = [
  'quick',
  'list',
  'project',
  'practice',
  'decision',
  'monitor',
  'recurring',
] as const;

export type WorkShape = (typeof WORK_SHAPES)[number];

/**
 * The classification contract shared by the capture splitter and the planner.
 * One wording, so the two passes cannot drift apart.
 */
export const WORK_SHAPE_GUIDE = `Classify the shape of each outcome:
- quick: one-time, finishable in one sitting or a few errand steps.
- list: a collection of items to keep, with no steps and no finish line (a movie list, books to read, gift ideas).
- project: one-time, but needs several dependent steps over days or weeks.
- practice: a repeated behavior the user wants to keep up, often with a number to track. It has no finish line.
- decision: the outcome is a choice. Work ends when the user decides.
- monitor: watch something and react. No finish line.
- recurring: a finishable task that comes back on a schedule.`;
