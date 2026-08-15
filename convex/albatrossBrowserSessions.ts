import { v } from 'convex/values';
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

const statusValidator = v.union(
  v.literal('starting'),
  v.literal('agent'),
  v.literal('user'),
  v.literal('verifying'),
  v.literal('ended'),
  v.literal('failed'),
);

/**
 * The ledger of shared browser sessions. The web and iOS panes subscribe to
 * the active row, so status flips (agent working, your turn, verifying) reach
 * every client without polling.
 */
export const openSession = mutation({
  args: {
    ...callerArgs,
    workId: v.string(),
    stepKey: v.optional(v.string()),
    stepIdentity: v.optional(v.string()),
    sessionId: v.string(),
    liveViewUrl: v.string(),
    replayUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const ts = now();
    // One active session per Work: an older live row is superseded, never left
    // dangling in a client subscription.
    const existing = await ctx.db
      .query('albatrossBrowserSessions')
      .withIndex('by_user', (q) => q.eq('userId', userId).eq('workId', args.workId))
      .order('desc')
      .take(5);
    for (const row of existing) {
      if (row.status !== 'ended' && row.status !== 'failed') {
        await ctx.db.patch(row._id, { status: 'ended', endedAt: ts, updatedAt: ts });
      }
    }
    return ctx.db.insert('albatrossBrowserSessions', {
      userId,
      workId: args.workId,
      stepKey: args.stepKey,
      stepIdentity: args.stepIdentity,
      sessionId: args.sessionId,
      liveViewUrl: args.liveViewUrl,
      replayUrl: args.replayUrl,
      status: 'starting',
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const setSessionStatus = mutation({
  args: {
    ...callerArgs,
    sessionId: v.string(),
    status: statusValidator,
    statusDetail: v.optional(v.string()),
    stepKey: v.optional(v.string()),
    stepIdentity: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const row = await ctx.db
      .query('albatrossBrowserSessions')
      .withIndex('by_user_session', (q) => q.eq('userId', userId).eq('sessionId', args.sessionId))
      .unique();
    if (!row) throw new Error('Session not found.');
    // Terminal rows stay terminal, or a late status write from a slower
    // request revives a dead session in every subscribed pane.
    if (row.status === 'ended' || row.status === 'failed') return { status: row.status };
    const ts = now();
    await ctx.db.patch(row._id, {
      status: args.status,
      statusDetail: args.statusDetail?.slice(0, 300),
      ...(args.stepKey !== undefined ? { stepKey: args.stepKey } : {}),
      ...(args.stepIdentity !== undefined ? { stepIdentity: args.stepIdentity } : {}),
      ...(args.status === 'ended' || args.status === 'failed' ? { endedAt: ts } : {}),
      updatedAt: ts,
    });
    return { status: args.status };
  },
});

/** The pane's subscription: the one live session for this Work, if any. */
export const activeSessionForWork = query({
  args: { ...callerArgs, workId: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows = await ctx.db
      .query('albatrossBrowserSessions')
      .withIndex('by_user', (q) => q.eq('userId', userId).eq('workId', args.workId))
      .order('desc')
      .take(5);
    const live = rows.find((row) => row.status !== 'ended' && row.status !== 'failed');
    if (!live) return null;
    return {
      sessionId: live.sessionId,
      status: live.status,
      statusDetail: live.statusDetail ?? null,
      stepKey: live.stepKey ?? null,
      liveViewUrl: live.liveViewUrl,
      replayUrl: live.replayUrl,
      updatedAt: live.updatedAt,
    };
  },
});
