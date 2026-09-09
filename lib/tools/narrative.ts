import { z } from 'zod';
import {
  boundedNarrativeResult,
  getNarrativeTaskContext,
  readNarrative,
  recordNarrative,
  searchNarrative,
} from '@/lib/narrative/service';
import { defineTool } from './registry';

function owner(ctx: { userId?: string | null }) {
  if (!ctx.userId) throw new Error('Sign in required');
  return ctx.userId;
}
export const narrativeSearch = defineTool({
  name: 'narrative_search',
  description:
    'Search relevant narrative episodes, historical chapters, ongoing threads, and observations. Empty results are incomplete knowledge, not evidence of inactivity.',
  category: 'memory',
  mutating: false,
  input: z.object({
    query: z.string().max(300).default(''),
    topic: z.string().optional(),
    from: z.number().optional(),
    to: z.number().optional(),
    level: z.enum(['observation', 'day', 'week', 'month', 'thread']).optional(),
    limit: z.number().int().min(1).max(30).default(12),
  }),
  output: z.any(),
  handler: (args, ctx) => searchNarrative(owner(ctx), args).then(boundedNarrativeResult),
});
export const narrativeTaskContext = defineTool({
  name: 'narrative_task_context',
  description:
    'Retrieve a small, task-specific packet of current evidence for private chat, Work, Area planning, meeting preparation, search, or a brief. Rechecks ownership, consent, and source versions. Prefer this to loading the entire narrative. Does not authorize including private context in an outgoing email.',
  category: 'memory',
  mutating: false,
  input: z.object({
    purpose: z.enum(['chat', 'work', 'area', 'meeting', 'brief', 'search']),
    query: z.string().max(240).default(''),
    topic: z.string().max(500).optional(),
    since: z.number().optional(),
  }),
  output: z.any(),
  handler: (args, ctx) => getNarrativeTaskContext(owner(ctx), args),
});
export const narrativeRead = defineTool({
  name: 'narrative_read',
  description:
    'Expand a narrative entry into the observations supporting it. Summaries are interpretations, never independent corroboration.',
  category: 'memory',
  mutating: false,
  input: z.object({ id: z.string() }),
  output: z.any(),
  handler: (args, ctx) => readNarrative(owner(ctx), args.id).then(boundedNarrativeResult),
});
export const narrativeSources = defineTool({
  name: 'narrative_sources',
  description:
    'Read original source details behind a memory: email messages, meeting notes, repository summaries, or file content. Rechecks source consent and reports unavailable evidence.',
  category: 'memory',
  mutating: false,
  input: z.object({ id: z.string() }),
  output: z.any(),
  handler: (args, ctx) => readNarrative(owner(ctx), args.id, true).then(boundedNarrativeResult),
});
export const narrativeChangesSince = defineTool({
  name: 'narrative_changes_since',
  description:
    'Read new or corrected observations since a timestamp. This uses observation/update time, including late arrivals about earlier dates.',
  category: 'memory',
  mutating: false,
  input: z.object({ since: z.number(), topic: z.string().optional() }),
  output: z.any(),
  handler: (args, ctx) =>
    searchNarrative(owner(ctx), { changedSince: args.since, topic: args.topic, limit: 20 }).then(
      boundedNarrativeResult,
    ),
});
export const narrativeRecordChange = defineTool({
  name: 'narrative_record_change',
  description:
    'Link a meaningful interpretation to exact observed/user-reported evidence ids. Cannot declare your own suggestions or unverified actions as facts. Corrections to source observations belong to the user-facing memory editor.',
  category: 'memory',
  mutating: true,
  input: z.object({ text: z.string().min(1).max(4000), sourceIds: z.array(z.string()).min(1).max(12) }),
  output: z.any(),
  handler: (args, ctx) => recordNarrative(owner(ctx), args.text, args.sourceIds),
});
export const NARRATIVE_TOOLS = [
  narrativeTaskContext,
  narrativeSearch,
  narrativeRead,
  narrativeSources,
  narrativeChangesSince,
  narrativeRecordChange,
];
