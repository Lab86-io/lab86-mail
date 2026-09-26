import { v } from 'convex/values';
import { truncateText } from '../lib/shared/text';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { assertBriefJobOwner, briefJobFence } from './briefJobState';
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
  weekAhead: v.optional(v.string()),
  sinceLastBrief: v.optional(v.string()),
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
  return truncateText(value.trim(), max);
}

export const saveAreaPulse = mutation({
  args: {
    ...callerArgs,
    briefJob: v.optional(briefJobFence),
    areaId: v.id('areas'),
    pulse: areaPulseValidator,
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await assertBriefJobOwner(ctx, userId, args.briefJob, { areaId: args.areaId });
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
      ...(args.pulse.weekAhead ? { weekAhead: bounded(args.pulse.weekAhead, 600) } : {}),
      ...(args.pulse.sinceLastBrief ? { sinceLastBrief: bounded(args.pulse.sinceLastBrief, 400) } : {}),
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
    const limit = Math.min(Math.max(args.limit ?? 12, 1), 50);
    // Only active areas, newest pulse first: an unordered take could return
    // archived areas or old pulses and miss the areas the brief is about.
    const rows = await ctx.db
      .query('albatrossAreaBriefs')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(500);
    const withPulse = rows.filter((row) => row.pulse);
    const areas = await Promise.all(withPulse.map((row) => ctx.db.get(row.areaId)));
    return withPulse
      .filter((_, index) => areas[index]?.userId === userId && areas[index]?.status === 'active')
      .sort((a, b) => (b.pulseUpdatedAt ?? b.updatedAt) - (a.pulseUpdatedAt ?? a.updatedAt))
      .slice(0, limit)
      .map((row) => ({
        areaId: row.areaId,
        pulse: row.pulse ?? null,
        pulseUpdatedAt: row.pulseUpdatedAt ?? null,
      }));
  },
});
