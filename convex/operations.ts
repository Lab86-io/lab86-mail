import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Operation log backing the AI's act-then-undo trust model (see
// docs/productivity-platform-spec.md). Writes come from the Next server
// (internal secret); the change-set UI reads live via Clerk identity.

async function requireUserId(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

export const record = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    agent: v.union(v.literal('user'), v.literal('ai')),
    tool: v.string(),
    surface: v.union(v.literal('mail'), v.literal('calendar'), v.literal('tasks')),
    summary: v.string(),
    batchId: v.optional(v.string()),
    chatId: v.optional(v.string()),
    target: v.any(),
    inverse: v.optional(v.object({ kind: v.string(), payload: v.any() })),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const { internalSecret: _secret, ...doc } = args;
    return ctx.db.insert('aiOperations', { ...doc, status: 'applied', createdAt: now() });
  },
});

export const get = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    operationId: v.id('aiOperations'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.operationId);
    return row && row.userId === args.userId ? row : null;
  },
});

export const listRecent = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    batchId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    if (args.batchId !== undefined) {
      return ctx.db
        .query('aiOperations')
        .withIndex('by_user_batch', (q) => q.eq('userId', args.userId).eq('batchId', args.batchId))
        .order('desc')
        .take(limit);
    }
    return ctx.db
      .query('aiOperations')
      .withIndex('by_user_created', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(limit);
  },
});

// Live feed for the change-set UI: the most recent operations, Convex-pushed
// so an undo from anywhere updates every open pane.
export const liveRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    return ctx.db
      .query('aiOperations')
      .withIndex('by_user_created', (q) => q.eq('userId', userId))
      .order('desc')
      .take(limit);
  },
});

// Claim an undo: flips applied → undone before the inverse executes so two
// concurrent undo clicks can't both run it. The caller reverts via markUndoFailed
// if execution then fails.
export const claimUndo = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    operationId: v.id('aiOperations'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.operationId);
    if (!row || row.userId !== args.userId) throw new Error('Operation not found.');
    if (row.status !== 'applied') throw new Error(`Operation is already ${row.status}.`);
    if (!row.inverse) throw new Error('Operation is not undoable.');
    await ctx.db.patch(args.operationId, { status: 'undone', undoneAt: now() });
    return { tool: row.tool, surface: row.surface, summary: row.summary, inverse: row.inverse };
  },
});

export const markUndoFailed = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    operationId: v.id('aiOperations'),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.operationId);
    if (!row || row.userId !== args.userId) return;
    await ctx.db.patch(args.operationId, {
      status: 'undo_failed',
      error: args.error.slice(0, 500),
      undoneAt: undefined,
    });
  },
});
