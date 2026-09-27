import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Brief item telemetry (brief round 2026-09-22). The app route authenticates
// the user and calls the mutation with the internal secret, so every row is
// owner scoped by the route, never by the browser.

export const OUTCOMES = ['done', 'failed', 'undone', 'opened'] as const;

export const record = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    reportId: v.optional(v.string()),
    surface: v.union(v.literal('daily'), v.literal('area')),
    regionId: v.string(),
    action: v.string(),
    refKind: v.string(),
    refId: v.string(),
    refAccount: v.optional(v.string()),
    outcome: v.union(v.literal('done'), v.literal('failed'), v.literal('undone'), v.literal('opened')),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const id = await ctx.db.insert('briefItemEvents', {
      userId: args.userId,
      reportId: args.reportId?.slice(0, 240),
      surface: args.surface,
      regionId: args.regionId.slice(0, 120),
      action: args.action.slice(0, 80),
      refKind: args.refKind.slice(0, 40),
      refId: args.refId.slice(0, 240),
      refAccount: args.refAccount?.slice(0, 320),
      outcome: args.outcome,
      createdAt: now(),
    });
    return { id };
  },
});
