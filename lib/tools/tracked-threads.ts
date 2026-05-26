import { z } from 'zod';
import { getThread } from '../store/threads';
import {
  getTrackedThread,
  listTrackedThreads as listTrackedThreadsStore,
  updateTrackedThread,
  upsertTrackedThread,
} from '../store/tracked-threads';
import { defineTool } from './registry';

const StatusSchema = z.enum(['open', 'waiting', 'due_soon', 'resolved', 'snoozed', 'dismissed']);

export const trackThread = defineTool({
  name: 'track_thread',
  description: 'Track an important local email conversation with reason, status, open loops, and due date.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    reason: z.string().min(1),
    status: StatusSchema.default('open'),
    openLoops: z.array(z.string()).default([]),
    nextAction: z.string().optional(),
    dueAt: z.number().nullable().optional(),
    importance: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  }),
  output: z.object({ tracked: z.any() }),
  async handler(args) {
    const thread = await getThread(args.account, args.threadId);
    const tracked = await upsertTrackedThread({
      account: args.account,
      threadId: args.threadId,
      subject: thread?.subject || '(no subject)',
      participants: thread?.fromAddress ? [thread.fromAddress] : [],
      status: args.status,
      reason: args.reason,
      openLoops: args.openLoops,
      nextAction: args.nextAction,
      dueAt: args.dueAt ?? null,
      importance: args.importance,
      source: 'manual',
    });
    return { tracked };
  },
});

export const updateTrackedThreadTool = defineTool({
  name: 'update_tracked_thread',
  description: 'Update a locally tracked conversation.',
  category: 'mail',
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

export const listTrackedThreadsTool = defineTool({
  name: 'list_tracked_threads',
  description: 'List locally tracked important email conversations.',
  category: 'mail',
  mutating: false,
  input: z.object({
    status: StatusSchema.optional(),
    includeResolved: z.boolean().default(false),
    limit: z.number().int().min(1).max(300).default(120),
  }),
  output: z.object({ tracked: z.array(z.any()) }),
  async handler(args) {
    return { tracked: await listTrackedThreadsStore(args) };
  },
});

export const getTrackedThreadTool = defineTool({
  name: 'get_tracked_thread',
  description: 'Get a tracked thread by account/thread id.',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), threadId: z.string() }),
  output: z.object({ tracked: z.any().nullable() }),
  async handler({ account, threadId }) {
    return { tracked: await getTrackedThread(account, threadId) };
  },
});
