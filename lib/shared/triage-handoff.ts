import { z } from 'zod';
import { BRIEF_DOCUMENT_LIMITS, BriefActionV2Schema, BriefSourceRefV2Schema } from './brief-document';

export const TRIAGE_HANDOFF_VERSION = 1 as const;

const triageItemSchema = z.object({
  sourceKey: z.string().trim().min(1).max(500),
  ref: BriefSourceRefV2Schema,
  situation: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  assessment: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  recommendation: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  dueAt: z.number().finite().nullable().optional(),
  startsAt: z.number().finite().nullable().optional(),
});

export const TriageHandoffV1Schema = z.object({
  version: z.literal(TRIAGE_HANDOFF_VERSION),
  id: z.string().trim().min(1).max(240),
  source: z.string().trim().min(1).max(80),
  sourceKey: z.string().trim().min(1).max(500),
  kind: z.enum(['conversation', 'task', 'event', 'area', 'work', 'connected', 'composite']),
  lane: z.enum(['needs_you', 'waiting', 'upcoming', 'focus', 'context']),
  status: z.enum(['open', 'waiting', 'scheduled']),
  priority: z.enum(['critical', 'high', 'normal', 'low']),
  protected: z.boolean().default(false),
  situation: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  background: z.array(z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText)).max(3).default([]),
  assessment: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  recommendation: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
  evidence: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(BRIEF_DOCUMENT_LIMITS.shortText),
        ref: BriefSourceRefV2Schema.optional(),
      }),
    )
    .max(4)
    .default([]),
  primaryRef: BriefSourceRefV2Schema,
  relatedRefs: z.array(BriefSourceRefV2Schema).max(8).default([]),
  items: z.array(triageItemSchema).min(1).max(8),
  actions: z.array(BriefActionV2Schema).max(BRIEF_DOCUMENT_LIMITS.actions).default([]),
  dueAt: z.number().finite().nullable().optional(),
  startsAt: z.number().finite().nullable().optional(),
  generatedAt: z.number().finite(),
});

export type TriageHandoffV1 = z.infer<typeof TriageHandoffV1Schema>;

export function parseTriageHandoffs(value: unknown): TriageHandoffV1[] {
  if (!Array.isArray(value)) return [];
  const records: TriageHandoffV1[] = [];
  const ids = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const candidate of value) {
    const parsed = TriageHandoffV1Schema.safeParse(candidate);
    if (!parsed.success) continue;
    if (ids.has(parsed.data.id) || sourceKeys.has(parsed.data.sourceKey)) continue;
    ids.add(parsed.data.id);
    sourceKeys.add(parsed.data.sourceKey);
    records.push(parsed.data);
  }
  return records.slice(0, 96);
}
