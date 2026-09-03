import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// "Hold this" from a chat reply. One reply can be held once. The Work rows
// carry `externalId = chat:<conversationId>:<sourceMessageId>` so a second
// Hold on the same reply finds the first result instead of a duplicate.
// This module reads and stamps that id. It does not create Work; capture
// still runs through `albatrossWorkV2.beginCapture` and `finishCapture`.

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

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

function summary(work: {
  _id: Id<'albatrossIntents'>;
  title?: string;
  rawText: string;
  shape?: string;
  horizon?: unknown;
  captureId?: Id<'albatrossCaptures'>;
}) {
  return {
    id: String(work._id),
    title: work.title || work.rawText.slice(0, 180),
    shape: work.shape ?? 'quick',
    horizon: work.horizon ?? null,
    captureId: work.captureId ? String(work.captureId) : undefined,
  };
}

/** Work already held from one chat reply, or an empty list. */
export const findByExternalId = query({
  args: { ...callerArgs, externalId: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_user_external', (q) => q.eq('userId', userId).eq('externalId', args.externalId))
      .collect();
    return rows.map(summary);
  },
});

/** Short summaries for a list of Work ids. Unknown or foreign ids are skipped. */
export const summariesByIds = query({
  args: { ...callerArgs, workIds: v.array(v.id('albatrossIntents')) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const out: ReturnType<typeof summary>[] = [];
    for (const workId of args.workIds.slice(0, 50)) {
      const work = await ctx.db.get(workId);
      if (!work || work.userId !== userId) continue;
      out.push(summary(work));
    }
    return out;
  },
});

/** Stamp the chat source id on freshly captured Work rows. */
export const stampExternalId = mutation({
  args: { ...callerArgs, workIds: v.array(v.id('albatrossIntents')), externalId: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const externalId = args.externalId.trim().slice(0, 400);
    if (!externalId) throw new Error('externalId required.');
    const ts = now();
    let stamped = 0;
    for (const workId of args.workIds.slice(0, 50)) {
      const work = await ctx.db.get(workId);
      if (!work || work.userId !== userId) continue;
      await ctx.db.patch(workId, { externalId, updatedAt: ts });
      stamped += 1;
    }
    return { stamped };
  },
});
