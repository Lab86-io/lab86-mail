import { v } from 'convex/values';
import { classifierById } from '../lib/classifier/catalog';
import { internal } from './_generated/api';
import { internalMutation, mutation, query } from './_generated/server';
import { requireInternalSecret } from './lib';

const KEY = 'mailClassifier';
/** Threads this recent are re-assessed after a classifier switch; older ones keep their result. */
const REQUEUE_WINDOW_MS = 30 * 86_400_000;

async function selectionRow(ctx: any) {
  return ctx.db
    .query('deploymentSettings')
    .withIndex('by_key', (q: any) => q.eq('key', KEY))
    .unique();
}

export const selection = query({
  args: { internalSecret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await selectionRow(ctx);
    return {
      classifierId: typeof row?.value?.classifierId === 'string' ? (row.value.classifierId as string) : null,
      revision: row?.updatedAt || 0,
    };
  },
});

export const select = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    classifierId: v.string(),
    revision: v.number(),
    updatedBy: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!classifierById(args.classifierId)) throw new Error('UNKNOWN_CLASSIFIER');
    const row = await selectionRow(ctx);
    if ((row?.updatedAt || 0) !== args.revision) throw new Error('CLASSIFIER_SETTINGS_CONFLICT');
    const previous = row?.value?.classifierId;
    const ts = Math.max(Date.now(), args.revision + 1);
    const value = { classifierId: args.classifierId };
    if (row) await ctx.db.patch(row._id, { value, updatedAt: ts, updatedBy: args.updatedBy });
    else
      await ctx.db.insert('deploymentSettings', {
        key: KEY,
        value,
        updatedAt: ts,
        updatedBy: args.updatedBy,
      });
    const changed = previous !== args.classifierId;
    if (changed)
      await ctx.scheduler.runAfter(0, (internal as any).classifier.requeueAfterSwitch, { since: ts });
    return { classifierId: args.classifierId, revision: ts, requeued: changed };
  },
});

/**
 * Re-assess recent and open-obligation threads for every user after a switch.
 * Existing assessments stay readable until the new classifier replaces them,
 * so attention views and the Brief never go blank mid-switch.
 */
export const requeueAfterSwitch = internalMutation({
  args: { since: v.number(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query('users').paginate({ cursor: args.cursor ?? null, numItems: 4 });
    const after = args.since - REQUEUE_WINDOW_MS;
    for (const user of page.page) {
      const userId = user.clerkUserId;
      const batches = await Promise.all([
        ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_lastDate', (q) => q.eq('userId', userId).gt('lastDate', after))
          .order('desc')
          .take(400),
        ...(
          [
            ['by_user_jev_reply', 'jevNeedsReply'],
            ['by_user_jev_action', 'jevNeedsAction'],
            ['by_user_jev_waiting', 'jevWaiting'],
            ['by_user_jev_change', 'jevChange'],
          ] as const
        ).map(([index, field]) =>
          ctx.db
            .query('mailCorpusThreads')
            .withIndex(index as any, (q: any) => q.eq('userId', userId).eq(field, true))
            .order('desc')
            .take(100),
        ),
      ]);
      const rows = new Map(batches.flat().map((row: any) => [row._id, row]));
      for (const row of rows.values())
        await ctx.db.patch(row._id, {
          llmPending: true,
          jevStatus: 'pending',
          jevAttempts: 0,
          jevRetryAt: undefined,
          jevLeaseId: undefined,
          jevLeaseUntil: undefined,
        });
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(1_000, (internal as any).classifier.requeueAfterSwitch, {
        since: args.since,
        cursor: page.continueCursor,
      });
  },
});
