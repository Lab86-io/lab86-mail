import { v } from 'convex/values';
import { truncateText } from '../lib/shared/text';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Many Albatross threads at once (docs/albatross-threads.md). The thread list
// is the Work list plus this activity: the newest run of each Work and the
// small per-thread state row. It reads no chat session document, so a live
// subscription stays cheap while runs write their log lines.

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

/** Finished runs read for the list: enough for the newest run of each recent thread. */
const RECENT_RUNS = 120;
const OPEN_RUNS = 50;
const STATE_ROWS = 300;
/** A chat reply that has not ended after this is no longer shown as running. */
export const ANSWERING_STALE_MS = 10 * 60_000;

type RunDoc = Doc<'albatrossStepRuns'>;

/** What the list needs from a run: no artifacts, no full log. */
export function runActivity(run: RunDoc) {
  return {
    runId: String(run._id),
    state: run.state,
    outcome: run.outcome ?? null,
    stepTitle: run.stepTitle,
    logLine: run.log.at(-1)?.text ?? null,
    nextKind: run.next?.kind ?? null,
    nextLabel: run.next?.label ?? null,
    nextDetail: run.next?.detail ?? null,
    nextBlanks: run.next?.blanks ?? [],
    allowAnswered: Boolean(run.next?.allowAnswer),
    summary: run.summary ?? null,
    error: run.error ?? null,
    stoppedBy: run.budget?.exhausted ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
export type RunActivity = ReturnType<typeof runActivity>;

function stateView(row: Doc<'albatrossThreadStates'>, ts: number) {
  const answering = Boolean(row.answeringSince && ts - row.answeringSince < ANSWERING_STALE_MS);
  return {
    answering,
    answeringSince: answering ? (row.answeringSince ?? null) : null,
    replyAt: row.replyAt ?? null,
    replyWaits: Boolean(row.replyWaits),
    replyPreview: row.replyPreview ?? null,
    seenAt: row.seenAt ?? null,
  };
}
export type ThreadStateView = ReturnType<typeof stateView>;

/** The newest run of each Work (open runs first) and every thread state row of the user. */
export const activity = query({
  args: callerArgs,
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const ts = now();
    const [open, recent, states] = await Promise.all([
      ctx.db
        .query('albatrossStepRuns')
        .withIndex('by_user_active', (q) => q.eq('userId', userId).eq('active', true))
        .take(OPEN_RUNS),
      ctx.db
        .query('albatrossStepRuns')
        .withIndex('by_user_active', (q) => q.eq('userId', userId).eq('active', false))
        .order('desc')
        .take(RECENT_RUNS),
      ctx.db
        .query('albatrossThreadStates')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .take(STATE_ROWS),
    ]);
    const runs: Record<string, RunActivity> = {};
    // An open run wins over a finished one; among the rest the newest wins.
    for (const run of [...open, ...[...recent].sort((a, b) => b.updatedAt - a.updatedAt)]) {
      if (!runs[run.workId]) runs[run.workId] = runActivity(run);
    }
    const threads: Record<string, ThreadStateView> = {};
    for (const row of states) threads[row.workId] = stateView(row, ts);
    return { runs, threads, now: ts };
  },
});

async function stateRow(ctx: MutationCtx, userId: string, workId: string) {
  return ctx.db
    .query('albatrossThreadStates')
    .withIndex('by_user_work', (q) => q.eq('userId', userId).eq('workId', workId))
    .unique();
}

async function upsertState(
  ctx: MutationCtx,
  userId: string,
  workId: string,
  patch: Partial<Omit<Doc<'albatrossThreadStates'>, '_id' | '_creationTime' | 'userId' | 'workId'>>,
) {
  const ts = now();
  const row = await stateRow(ctx, userId, workId);
  if (row) {
    await ctx.db.patch(row._id, { ...patch, updatedAt: ts });
    return;
  }
  await ctx.db.insert('albatrossThreadStates', { userId, workId, ...patch, updatedAt: ts });
}

function checkWorkId(workId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workId)) throw new Error('Invalid work id.');
}

/**
 * The user has the thread on screen (T2). Clients call it on open and while the
 * thread shows. `unread: true` is "Mark as unread": the newest activity counts
 * as new again.
 */
export const markSeen = mutation({
  args: { ...callerArgs, workId: v.string(), unread: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    checkWorkId(args.workId);
    const id = ctx.db.normalizeId('albatrossIntents', args.workId);
    const work = id ? await ctx.db.get(id) : null;
    if (!work || work.userId !== userId) throw new Error('Work not found.');
    // Marked unread: seen at 1, so any finished run or reply counts as new.
    const seenAt = args.unread ? 1 : now();
    await upsertState(ctx, userId, args.workId, { seenAt });
    return { seenAt };
  },
});

/** A chat reply starts on the server (T5). Server only. */
export const replyStarted = mutation({
  args: { internalSecret: v.string(), userId: v.string(), workId: v.string(), turn: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    checkWorkId(args.workId);
    await upsertState(ctx, args.userId, args.workId, {
      answeringSince: now(),
      answeringTurn: truncateText(args.turn, 120),
      replyWaits: false,
    });
  },
});

/**
 * A chat reply ends. Only the reply that started last clears "answering", so a
 * newer reply that overlaps an older one keeps its mark. Server only.
 */
export const replyEnded = mutation({
  args: {
    internalSecret: v.string(),
    userId: v.string(),
    workId: v.string(),
    turn: v.string(),
    waits: v.boolean(),
    preview: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    checkWorkId(args.workId);
    const row = await stateRow(ctx, args.userId, args.workId);
    const current = !row?.answeringTurn || row.answeringTurn === truncateText(args.turn, 120);
    await upsertState(ctx, args.userId, args.workId, {
      ...(current ? { answeringSince: undefined, answeringTurn: undefined } : {}),
      replyAt: now(),
      replyWaits: args.waits,
      ...(args.preview?.trim() ? { replyPreview: truncateText(args.preview.trim(), 160) } : {}),
    });
  },
});
