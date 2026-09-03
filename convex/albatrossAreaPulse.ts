import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// The structured area pulse (2026-09-03). It lives on the existing
// albatrossAreaBriefs row so area_home readers keep one record per area.

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

export const areaPulseValidator = v.object({
  lastChange: v.string(),
  nextMove: v.string(),
  openQuestion: v.string(),
  prose: v.string(),
  model: v.optional(v.string()),
});

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

function bounded(value: string, max: number) {
  return value.trim().slice(0, max);
}

export const saveAreaPulse = mutation({
  args: {
    ...callerArgs,
    areaId: v.id('areas'),
    pulse: areaPulseValidator,
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const area = await ctx.db.get(args.areaId);
    if (!area || area.userId !== userId) throw new Error('Area not found.');
    const existing = await ctx.db
      .query('albatrossAreaBriefs')
      .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', args.areaId))
      .unique();
    const ts = now();
    const pulse = {
      lastChange: bounded(args.pulse.lastChange, 400),
      nextMove: bounded(args.pulse.nextMove, 400),
      openQuestion: bounded(args.pulse.openQuestion, 400),
      prose: bounded(args.pulse.prose, 900),
      ...(args.pulse.model ? { model: bounded(args.pulse.model, 120) } : {}),
    };
    if (existing) {
      await ctx.db.patch(existing._id, { pulse, pulseUpdatedAt: ts, updatedAt: ts });
      return existing._id;
    }
    return ctx.db.insert('albatrossAreaBriefs', {
      userId,
      areaId: args.areaId,
      status: 'ready',
      lede: pulse.lastChange,
      summary: pulse.prose,
      pulse,
      pulseUpdatedAt: ts,
      sourceRefs: [],
      basedOnRevision: 'pulse',
      generatedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const listAreaPulses = query({
  args: {
    ...callerArgs,
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows = await ctx.db
      .query('albatrossAreaBriefs')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(Math.min(Math.max(args.limit ?? 12, 1), 50));
    return rows
      .filter((row) => row.pulse)
      .map((row) => ({
        areaId: row.areaId,
        pulse: row.pulse ?? null,
        pulseUpdatedAt: row.pulseUpdatedAt ?? null,
      }));
  },
});
