import { v } from 'convex/values';
import { type MutationCtx, mutation, query } from './_generated/server';
import { requireInternalSecret } from './lib';

const identity = { internalSecret: v.optional(v.string()), userId: v.string(), runId: v.string() };

// Claim before invoking a tool. A lost response never grants permission to replay a write.
export const beginTool = mutation({
  args: { ...identity, key: v.string(), toolName: v.string(), mutating: v.boolean() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('agentToolExecutions')
      .withIndex('by_user_run_key', (q) =>
        q.eq('userId', args.userId).eq('runId', args.runId).eq('key', args.key),
      )
      .unique();
    if (existing) return { claimed: false, ...existing };
    await ctx.db.insert('agentToolExecutions', {
      userId: args.userId,
      runId: args.runId,
      key: args.key,
      toolName: args.toolName,
      mutating: args.mutating,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { claimed: true };
  },
});

export const finishTool = mutation({
  args: {
    ...identity,
    key: v.string(),
    status: v.union(v.literal('succeeded'), v.literal('failed'), v.literal('unknown')),
    output: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const record = await ctx.db
      .query('agentToolExecutions')
      .withIndex('by_user_run_key', (q) =>
        q.eq('userId', args.userId).eq('runId', args.runId).eq('key', args.key),
      )
      .unique();
    if (!record || record.status === 'succeeded' || record.status === 'failed') return;
    await ctx.db.patch(record._id, {
      status: args.status,
      output: args.output,
      error: args.error,
      updatedAt: Date.now(),
    });
  },
});

export const readRun = query({
  args: { ...identity, cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.db
      .query('agentToolExecutions')
      .withIndex('by_user_run_created', (q) => q.eq('userId', args.userId).eq('runId', args.runId))
      .order('desc')
      .paginate({ numItems: 100, cursor: args.cursor ?? null });
  },
});

/** Commit document acknowledgement in the same transaction as the revision/proposal. */
export async function recordDocumentEffect(
  ctx: MutationCtx,
  userId: string,
  execution: { runId: string; key: string } | undefined,
  effect: { documentId: string; revision?: number; suggestionId?: string },
) {
  if (!execution) return;
  const record = await ctx.db
    .query('agentToolExecutions')
    .withIndex('by_user_run_key', (q) =>
      q.eq('userId', userId).eq('runId', execution.runId).eq('key', execution.key),
    )
    .unique();
  if (!record || record.status !== 'running')
    throw new Error('Document execution is no longer active. Read the saved file before continuing.');
  if (record.effect)
    throw new Error('This document operation already committed. Read the saved file before continuing.');
  await ctx.db.patch(record._id, { effect, updatedAt: Date.now() });
}
