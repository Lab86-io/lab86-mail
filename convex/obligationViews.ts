import { v } from 'convex/values';
import type { NeedsYouSnapshot, ObligationClosedNote, ObligationView } from '../lib/obligations/contract';
import { startOfLocalDay } from '../lib/obligations/rules';
import {
  closedByItself,
  closedNoteOf,
  isClosedWork,
  isOpenObligation,
  threadTimeOrder,
  workTitleOf,
} from '../lib/obligations/views';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';
import { loadNeedsYouSnapshot, needsYouEnabled, viewOf } from './obligations';

// Needs you, phases 3 and 5 (docs/needs-you-phases-2-5.md, S2): the readers
// of the ledger that convex/obligations.ts does not hold.
//
//   forWork        the items of one Albatross, for its Work thread (web)
//   snapshotFor    NeedsYouSnapshot for the mobile routes (server secret)
//   closedSinceFor the items that closed by themselves, for the brief
//   linkWork       "Start in Albatross": put an item into an Albatross
//
// The rollout flag is the userDocs record that the Jev claim writes
// (convex/obligations.ts needsYouEnabled). The Node routes also check
// LAB86_NEEDS_YOU before they call these functions. The rows read as the
// page reads them (convex/obligations.ts viewOf and loadNeedsYouSnapshot).

const WORK_READ = 100;
const CLOSED_SINCE_READ = 100;
const CLOSED_SINCE_MAX = 20;

async function preferenceTimezone(ctx: QueryCtx | MutationCtx, userId: string) {
  const row = await ctx.db
    .query('albatrossNotificationPreferences')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique();
  return row?.timezone || 'UTC';
}

/**
 * `api.obligationViews.forWork` (signed-in user): the items of one Albatross
 * for its Work thread. The open and snoozed items, and the items closed since
 * the start of the user's day, oldest first, so the newest is last.
 */
export const forWork = query({
  args: { workId: v.string() },
  handler: async (ctx, args): Promise<ObligationView[]> => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.subject;
    const workId = args.workId.trim();
    if (!userId || !workId || !(await needsYouEnabled(ctx, userId))) return [];
    const at = now();
    const dayStart = startOfLocalDay(at, await preferenceTimezone(ctx, userId));
    const rows = await ctx.db
      .query('obligations')
      .withIndex('by_user_work', (q) => q.eq('userId', userId).eq('workId', workId))
      .take(WORK_READ);
    const views: ObligationView[] = [];
    for (const row of rows) {
      const view = await viewOf(ctx, row, at);
      if (isOpenObligation(view) || (view.closedAt ?? 0) >= dayStart) views.push(view);
    }
    return views.sort(threadTimeOrder);
  },
});

/**
 * The NeedsYouSnapshot of one user, for `GET /api/mobile/v1/needs-you` and
 * the brief (server secret). The same loader as `api.obligations.needsYou`.
 */
export const snapshotFor = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args): Promise<NeedsYouSnapshot> => {
    requireInternalSecret(args.internalSecret);
    return loadNeedsYouSnapshot(ctx, args.userId);
  },
});

/**
 * The items that closed by themselves since `since` (the previous edition),
 * newest first, for the brief's "Closed by itself" line (server secret). No
 * codes and no user closes.
 */
export const closedSinceFor = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    since: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ObligationClosedNote[]> => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 5), 1), CLOSED_SINCE_MAX);
    const at = now();
    const rows = await ctx.db
      .query('obligations')
      .withIndex('by_user_closed', (q) => q.eq('userId', args.userId).gte('closedAt', args.since))
      .order('desc')
      .take(CLOSED_SINCE_READ);
    const notes: ObligationClosedNote[] = [];
    for (const row of rows) {
      if (!closedByItself(row)) continue;
      notes.push(closedNoteOf(await viewOf(ctx, row, at)));
      if (notes.length >= limit) break;
    }
    return notes;
  },
});

export type LinkWorkResult =
  | { ok: true; obligation: ObligationView; workTitle: string }
  | { ok: false; error: 'not_found' | 'work_missing' | 'work_closed' };

/**
 * "Start in Albatross" (server secret): sets the `workId` and the
 * `workTitle` of one row of the user. The Albatross must be the user's and
 * must be open.
 */
export const linkWork = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    id: v.string(),
    workId: v.string(),
  },
  handler: async (ctx, args): Promise<LinkWorkResult> => {
    requireInternalSecret(args.internalSecret);
    const obligationId = ctx.db.normalizeId('obligations', args.id);
    const row = obligationId ? await ctx.db.get(obligationId) : null;
    if (!row || row.userId !== args.userId) return { ok: false, error: 'not_found' };
    const workRowId = ctx.db.normalizeId('albatrossIntents', args.workId);
    const work = workRowId ? await ctx.db.get(workRowId) : null;
    if (!work || work.userId !== args.userId) return { ok: false, error: 'work_missing' };
    if (isClosedWork(work)) return { ok: false, error: 'work_closed' };
    const at = now();
    const workTitle = workTitleOf(work);
    await ctx.db.patch(row._id, { workId: String(work._id), workTitle, updatedAt: at });
    const fresh = (await ctx.db.get(row._id))!;
    return { ok: true, obligation: await viewOf(ctx, fresh, at), workTitle };
  },
});
