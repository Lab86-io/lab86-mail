import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Proactive-agent suggestion queue (see docs/productivity-platform-spec.md).
// Detectors and the morning sweep write here from the Next server; the review
// tray reads live via Clerk identity. Accepting a suggestion happens in the
// tool layer (which records an aiOperation), then resolves the row here.

async function requireUserId(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

export const upsert = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.union(v.literal('task'), v.literal('event'), v.literal('automation')),
    title: v.string(),
    payload: v.any(),
    provenance: v.any(),
    dedupeKey: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.dedupeKey) {
      const existing = await ctx.db
        .query('suggestions')
        .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', args.dedupeKey))
        .first();
      // A still-pending duplicate gets refreshed in place; a resolved one
      // means the user already decided — don't nag again.
      if (existing) {
        if (existing.status === 'pending') {
          await ctx.db.patch(existing._id, {
            title: args.title,
            payload: args.payload,
            provenance: args.provenance,
            expiresAt: args.expiresAt,
          });
        }
        return existing._id;
      }
    }
    const { internalSecret: _secret, ...doc } = args;
    return ctx.db.insert('suggestions', { ...doc, status: 'pending', createdAt: now() });
  },
});

export const get = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    suggestionId: v.id('suggestions'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.suggestionId);
    return row && row.userId === args.userId ? row : null;
  },
});

export const resolve = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    suggestionId: v.id('suggestions'),
    status: v.union(v.literal('accepted'), v.literal('dismissed')),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.suggestionId);
    if (!row || row.userId !== args.userId) throw new Error('Suggestion not found.');
    if (row.status !== 'pending') return;
    await ctx.db.patch(args.suggestionId, { status: args.status, resolvedAt: now() });
  },
});

export const listPending = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query('suggestions')
      .withIndex('by_user_status_created', (q) => q.eq('userId', args.userId).eq('status', 'pending'))
      .order('desc')
      .take(limit);
    const ts = now();
    return rows.filter((row) => !row.expiresAt || row.expiresAt > ts);
  },
});

// Live tray feed + rail badge count.
export const livePending = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query('suggestions')
      .withIndex('by_user_status_created', (q) => q.eq('userId', userId).eq('status', 'pending'))
      .order('desc')
      .take(limit);
    const ts = now();
    const pending = rows.filter((row) => !row.expiresAt || row.expiresAt > ts);
    return { count: pending.length, suggestions: pending };
  },
});
