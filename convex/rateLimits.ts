// @ts-nocheck
import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { now, requireInternalSecret } from './lib';

export const consume = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    key: v.string(),
    limit: v.number(),
    windowMs: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = Number.isFinite(args.now) ? args.now : now();
    const limit = Math.max(1, Math.floor(args.limit));
    const windowMs = Math.max(1000, Math.floor(args.windowMs));
    const windowStart = Math.floor(ts / windowMs) * windowMs;
    const expiresAt = windowStart + windowMs * 2;
    const row = await ctx.db
      .query('rateLimits')
      .withIndex('by_user_key_window', (q) =>
        q.eq('userId', args.userId).eq('key', args.key).eq('windowStart', windowStart),
      )
      .unique();

    if (row) {
      if (row.count >= limit) {
        return {
          ok: false,
          count: row.count,
          limit,
          retryAfterMs: Math.max(1000, windowStart + windowMs - ts),
          windowStart,
        };
      }
      await ctx.db.patch(row._id, {
        count: row.count + 1,
        expiresAt,
        updatedAt: ts,
      });
      return {
        ok: true,
        count: row.count + 1,
        limit,
        retryAfterMs: 0,
        windowStart,
      };
    }

    await ctx.db.insert('rateLimits', {
      userId: args.userId,
      key: args.key,
      windowStart,
      count: 1,
      expiresAt,
      updatedAt: ts,
    });
    return { ok: true, count: 1, limit, retryAfterMs: 0, windowStart };
  },
});
