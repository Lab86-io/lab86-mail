import { v } from 'convex/values';
import type { NeedsYouSnapshot, ObligationClosedNote, ObligationView } from '../lib/obligations/contract';
import { startOfLocalDay } from '../lib/obligations/rules';
import {
  closedByItself,
  closedNoteOf,
  isClosedWork,
  isOpenObligation,
  threadTimeOrder,
  withSourceFields,
  workTitleOf,
} from '../lib/obligations/views';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';
import { needsYouEnabled, obligationView } from './obligations';

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
// LAB86_NEEDS_YOU before they call these functions.

type Obligation = Doc<'obligations'>;

const OPEN_READ = 200;
const SNOOZED_READ = 100;
const CLOSED_READ = 100;
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

/** The view of one row, with the source fields of phases 2 to 4. A code reads its value from the code store. */
async function viewOfRow(ctx: QueryCtx | MutationCtx, row: Obligation, at: number): Promise<ObligationView> {
  const code = row.kind === 'code' && row.codeId ? await ctx.db.get(row.codeId) : undefined;
  return withSourceFields(obligationView(row, code, at), row);
}

/**
 * The NeedsYouSnapshot of one user: the open and snoozed rows, and the rows
 * closed since the start of the user's day. It reads the same index ranges as
 * `api.obligations.needsYou`.
 */
export async function loadNeedsYouSnapshot(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<NeedsYouSnapshot> {
  const [enabled, timezone] = await Promise.all([
    needsYouEnabled(ctx, userId),
    preferenceTimezone(ctx, userId),
  ]);
  if (!enabled) return { enabled: false, timezone, items: [] };
  const at = now();
  const dayStart = startOfLocalDay(at, timezone);
  const [open, snoozed, closed] = await Promise.all([
    ctx.db
      .query('obligations')
      .withIndex('by_user_state', (q) => q.eq('userId', userId).eq('state', 'open'))
      .order('desc')
      .take(OPEN_READ),
    ctx.db
      .query('obligations')
      .withIndex('by_user_state', (q) => q.eq('userId', userId).eq('state', 'snoozed'))
      .order('desc')
      .take(SNOOZED_READ),
    ctx.db
      .query('obligations')
      .withIndex('by_user_closed', (q) => q.eq('userId', userId).gte('closedAt', dayStart))
      .order('desc')
      .take(CLOSED_READ),
  ]);
  const seen = new Set<string>();
  const items: ObligationView[] = [];
  for (const row of [...open, ...snoozed, ...closed]) {
    const id = String(row._id);
    if (seen.has(id)) continue;
    seen.add(id);
    const view = await viewOfRow(ctx, row, at);
    // A code that expired before today is not part of today's list.
    if (!isOpenObligation(view) && (view.closedAt ?? at) < dayStart) continue;
    items.push(view);
  }
  return { enabled: true, timezone, items };
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
      const view = await viewOfRow(ctx, row, at);
      if (isOpenObligation(view) || (view.closedAt ?? 0) >= dayStart) views.push(view);
    }
    return views.sort(threadTimeOrder);
  },
});

/** The NeedsYouSnapshot of one user, for `GET /api/mobile/v1/needs-you` (server secret). */
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
      notes.push(closedNoteOf(await viewOfRow(ctx, row, at)));
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
    return { ok: true, obligation: await viewOfRow(ctx, fresh, at), workTitle };
  },
});
