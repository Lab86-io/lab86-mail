import { z } from 'zod';
import { BRIEF_QUERY_NAMES, BriefQuerySchema, BriefSourceRefV2Schema } from './brief-document';

export const BriefHydratedEntitySchema = z.object({
  kind: z.enum(['thread', 'task', 'event', 'card', 'work']),
  id: z.string().min(1).max(240),
  account: z.string().max(320).optional(),
  title: z.string().max(500),
  subtitle: z.string().max(1_000).optional(),
  status: z.string().max(120).optional(),
  updatedAt: z.number().finite().optional(),
  startAt: z.number().finite().optional(),
  endAt: z.number().finite().optional(),
  dueAt: z.number().finite().optional(),
  completed: z.boolean().optional(),
  unread: z.boolean().optional(),
  gone: z.boolean().default(false),
});

export const BriefResolveRequestSchema = z.object({
  refs: z.array(BriefSourceRefV2Schema).min(1).max(100),
});

export const BriefResolveResponseSchema = z.object({
  ok: z.literal(true),
  entities: z.array(BriefHydratedEntitySchema).max(100),
});

export const BriefQueryRequestSchema = z.object({
  query: BriefQuerySchema,
  limit: z.number().int().min(1).max(48).default(12),
});

export const BriefQueryResponseSchema = z.object({
  ok: z.literal(true),
  query: BriefQuerySchema,
  items: z.array(BriefHydratedEntitySchema).max(48),
  count: z.number().int().nonnegative(),
});

export type BriefHydratedEntity = z.infer<typeof BriefHydratedEntitySchema>;
export type BriefResolveRequest = z.infer<typeof BriefResolveRequestSchema>;
export type BriefQueryRequest = z.infer<typeof BriefQueryRequestSchema>;

export const briefHydrationKeys = {
  ref: (kind: string, account: string | undefined, id: string) =>
    ['brief', 'ref', kind, account ?? '', id] as const,
  query: (name: (typeof BRIEF_QUERY_NAMES)[number], areaId?: string) =>
    ['brief', 'query', name, areaId ?? ''] as const,
};
