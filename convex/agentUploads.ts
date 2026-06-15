import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

async function resolveUserId(
  ctx: QueryCtx | MutationCtx,
  args: { internalSecret?: string; userId?: string },
): Promise<string> {
  if (args.internalSecret) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('userId required with internal secret.');
    return args.userId;
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

export const generateUploadUrl = mutation({
  args: { ...callerArgs },
  handler: async (ctx, args) => {
    await resolveUserId(ctx, args);
    return ctx.storage.generateUploadUrl();
  },
});

export const registerUpload = mutation({
  args: {
    ...callerArgs,
    storageId: v.id('_storage'),
    name: v.string(),
    contentType: v.optional(v.string()),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    return ctx.db.insert('agentUploads', {
      userId,
      storageId: args.storageId,
      name: args.name.trim() || 'attachment',
      contentType: args.contentType,
      size: args.size,
      createdAt: now(),
    });
  },
});

export const getUpload = query({
  args: { ...callerArgs, uploadId: v.id('agentUploads') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const row = await ctx.db.get(args.uploadId);
    return row && row.userId === userId ? row : null;
  },
});

export const listRecent = query({
  args: { ...callerArgs, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    return ctx.db
      .query('agentUploads')
      .withIndex('by_user_created', (q) => q.eq('userId', userId))
      .order('desc')
      .take(Math.min(Math.max(args.limit ?? 20, 1), 50));
  },
});

export type AgentUploadId = Id<'agentUploads'>;
