import { z } from 'zod';
import {
  planPresentation,
  presentationEvidenceSchema,
  presentationPlanSchema,
} from '@/lib/documents/presentation-plan';
import { defineTool } from './registry';
export const presentationPlan = defineTool({
  name: 'presentation_plan',
  category: 'documents',
  mutating: false,
  description:
    'After gathering actual evidence, deeply plan a presentation slide by slide: audience takeaway, source coverage, chart/table/graphic choice, calculation requirements, art direction and concrete tool steps. This is a planning step, not a created file. Execute its research, spreadsheet and visual tasks before document_create; verify saved slides with document_get. Missing evidence is returned as remediation work, not invented data.',
  input: z.object({
    // Includes the bounded, serialized choices from the visual checkpoints.
    instruction: z.string().min(1).max(100000),
    audience: z.string().min(1).max(2000),
    evidence: z.array(presentationEvidenceSchema).max(80),
    slideCount: z.number().int().min(1).max(30).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    readyToBuild: z.boolean(),
    plan: presentationPlanSchema.optional(),
    issues: z.array(z.string()),
    nextStep: z.string(),
  }),
  handler: async (args, ctx) => {
    if (!ctx.userId) throw new Error('Not authenticated.');
    return planPresentation({ ...args, userId: ctx.userId, abortSignal: ctx.abortSignal });
  },
});
