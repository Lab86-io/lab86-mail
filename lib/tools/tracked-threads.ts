import { z } from 'zod';
import { updateTrackedThread } from '../store/tracked-threads';
import { defineTool } from './registry';

const StatusSchema = z.enum(['open', 'waiting', 'due_soon', 'resolved', 'snoozed', 'dismissed']);

export const updateTrackedThreadTool = defineTool({
  name: 'update_tracked_thread',
  description: 'Update a locally tracked conversation.',
  category: 'mail',
  risk: 'write_self',
  mutating: true,
  input: z.object({
    id: z.string(),
    status: StatusSchema.optional(),
    reason: z.string().optional(),
    openLoops: z.array(z.string()).optional(),
    nextAction: z.string().optional(),
    dueAt: z.number().nullable().optional(),
    snoozedUntil: z.number().nullable().optional(),
    importance: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  }),
  output: z.object({ tracked: z.any() }),
  async handler({ id, ...patch }) {
    const tracked = await updateTrackedThread(id, patch);
    return { tracked };
  },
});

export const resolveTrackedThread = defineTool({
  name: 'resolve_tracked_thread',
  description: 'Mark a tracked local conversation resolved.',
  category: 'mail',
  risk: 'write_self',
  mutating: true,
  input: z.object({ id: z.string(), reason: z.string().optional() }),
  output: z.object({ tracked: z.any() }),
  async handler({ id, reason }) {
    const tracked = await updateTrackedThread(id, {
      status: 'resolved',
      reason: reason || undefined,
      resolvedAt: Date.now(),
    });
    return { tracked };
  },
});
