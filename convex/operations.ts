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
    surface: v.union(v.literal('mail'), v.literal('calendar'), v.literal('tasks'), v.literal('albatross')),
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

// Claim an undo before the inverse executes. `undoing` is deliberately
// distinct from `undone`: retries can reconcile a completed inverse without
// treating a still-running (and potentially failing) provider call as success.
export const claimUndo = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    operationId: v.id('aiOperations'),
    claimToken: v.string(),
    leaseMs: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.operationId);
    if (!row || row.userId !== args.userId) throw new Error('Operation not found.');
    if (!row.inverse) throw new Error('Operation is not undoable.');
    if (row.status === 'undone') {
      return {
        state: 'already_undone' as const,
        tool: row.tool,
        surface: row.surface,
        summary: row.summary,
      };
    }
    const ts = now();
    if (row.status === 'undoing' && row.undoClaimExpiresAt !== undefined && row.undoClaimExpiresAt > ts) {
      return {
        state: 'in_progress' as const,
        tool: row.tool,
        surface: row.surface,
        summary: row.summary,
      };
    }
    await ctx.db.patch(args.operationId, {
      status: 'undoing',
      undoClaimToken: args.claimToken,
      undoClaimExpiresAt: ts + Math.max(args.leaseMs, 1_000),
      error: undefined,
      undoneAt: undefined,
    });
    return {
      state: 'claimed' as const,
      tool: row.tool,
      surface: row.surface,
      summary: row.summary,
      inverse: row.inverse,
    };
  },
});

export const completeUndo = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    operationId: v.id('aiOperations'),
    claimToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.operationId);
    if (!row || row.userId !== args.userId) throw new Error('Operation not found.');
    if (row.status === 'undone') return row;
    if (row.status !== 'undoing' || row.undoClaimToken !== args.claimToken) {
      throw new Error('Operation undo lease was lost.');
    }
    await ctx.db.patch(args.operationId, {
      status: 'undone',
      undoneAt: now(),
      undoClaimToken: undefined,
      undoClaimExpiresAt: undefined,
      error: undefined,
    });
    return ctx.db.get(args.operationId);
  },
});

export const markUndoFailed = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    operationId: v.id('aiOperations'),
    claimToken: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.operationId);
    if (!row || row.userId !== args.userId) return;
    if (row.status !== 'undoing' || row.undoClaimToken !== args.claimToken) return;
    await ctx.db.patch(args.operationId, {
      status: 'undo_failed',
      error: args.error.slice(0, 500),
      undoneAt: undefined,
      undoClaimToken: undefined,
      undoClaimExpiresAt: undefined,
    });
  },
});
