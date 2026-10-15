// Validators for goal runs (docs/albatross-goal-runs.md). The shapes match
// lib/albatross/goal-run-contract.ts; the schema and the run mutations share them.

import { v } from 'convex/values';

export const runArtifactKindValidator = v.union(
  v.literal('document'),
  v.literal('draft'),
  v.literal('event'),
  v.literal('card'),
  v.literal('approval'),
  v.literal('page'),
  v.literal('deck'),
  v.literal('file'),
);

export const runSourceValidator = v.object({
  kind: v.union(
    v.literal('web'),
    v.literal('mail'),
    v.literal('file'),
    v.literal('calendar'),
    v.literal('jira'),
    v.literal('document'),
  ),
  title: v.string(),
  url: v.optional(v.string()),
  id: v.optional(v.string()),
  accountId: v.optional(v.string()),
  detail: v.optional(v.string()),
});

export const runMessageValidator = v.object({
  id: v.string(),
  at: v.number(),
  text: v.string(),
  sources: v.array(runSourceValidator),
});

export const checklistItemValidator = v.object({
  id: v.string(),
  text: v.string(),
  state: v.union(v.literal('todo'), v.literal('doing'), v.literal('done'), v.literal('yours')),
});

export const handoffItemValidator = v.object({
  kind: v.union(
    v.literal('draft'),
    v.literal('document'),
    v.literal('sheet'),
    v.literal('deck'),
    v.literal('file'),
    v.literal('approval'),
    v.literal('event'),
    v.literal('page'),
  ),
  id: v.optional(v.string()),
  url: v.optional(v.string()),
  accountId: v.optional(v.string()),
  title: v.string(),
  state: v.union(v.literal('ready'), v.literal('blanks'), v.literal('check')),
  blanks: v.optional(v.array(v.string())),
  note: v.optional(v.string()),
});

/** The optional goal-run fields of an albatrossStepRuns row. */
export const goalRunFields = {
  goal: v.optional(v.boolean()),
  messages: v.optional(v.array(runMessageValidator)),
  checklist: v.optional(v.array(checklistItemValidator)),
  items: v.optional(v.array(handoffItemValidator)),
  unsure: v.optional(v.array(v.string())),
};
