import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { query } from './_generated/server';
import { requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

const targetKindValidator = v.union(
  v.literal('area'),
  v.literal('project'),
  v.literal('work'),
  v.literal('routine'),
);

async function resolveUserId(
  ctx: QueryCtx | MutationCtx,
  args: { internalSecret?: string; userId?: string },
) {
  if (args.internalSecret !== undefined) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('userId required with internal secret.');
    return args.userId;
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

function unit(value: number, fallback = 0) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

export const indexSummary = query({
  args: { ...callerArgs, targetKind: v.optional(targetKindValidator), targetId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows =
      args.targetKind && args.targetId
        ? await ctx.db
            .query('albatrossEvidence')
            .withIndex('by_user_target', (q) =>
              q.eq('userId', userId).eq('targetKind', args.targetKind).eq('targetId', args.targetId),
            )
            .order('desc')
            .take(500)
        : await ctx.db
            .query('albatrossEvidence')
            .withIndex('by_user_occurredAt', (q) => q.eq('userId', userId))
            .order('desc')
            .take(500);
    const sourceCounts: Record<string, number> = {};
    const trustCounts: Record<string, number> = {};
    let remaining = 1;
    for (const row of rows) {
      sourceCounts[row.sourceKind] = (sourceCounts[row.sourceKind] || 0) + 1;
      trustCounts[row.trust] = (trustCounts[row.trust] || 0) + 1;
      if (row.trust !== 'rejected') remaining *= 1 - unit(row.weight);
    }
    return {
      total: rows.length,
      bounded: rows.length >= 500,
      strength: Math.min(0.995, Math.max(0, 1 - remaining)),
      sourceCounts,
      trustCounts,
      latestAt: rows[0]?.occurredAt ?? null,
    };
  },
});
