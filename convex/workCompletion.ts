import { workLifecycle } from '../lib/albatross/work-lifecycle';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { recordCompletionEvent } from './albatrossWork';
import { scheduleNarrativeSource } from './narrative';

export async function recordWorkCompletion(ctx: MutationCtx, work: Doc<'albatrossIntents'>, ts: number) {
  let tasksTotal: number | undefined;
  let tasksCompleted: number | undefined;
  if (work.primaryProjectId) {
    // Bounded read: a metrics record is not worth an unbounded scan of a
    // link-heavy project. 400 links comfortably covers 200 task links.
    const links = await ctx.db
      .query('albatrossProjectLinks')
      .withIndex('by_user_project', (q) =>
        q.eq('userId', work.userId).eq('projectId', work.primaryProjectId!),
      )
      .take(400);
    const taskLinks = links.filter((link) => link.artifactKind === 'task').slice(0, 200);
    if (taskLinks.length) {
      const cards = await Promise.all(
        taskLinks.map(async (link) => {
          const cardId = ctx.db.normalizeId('cards', link.artifactId);
          const card = cardId ? await ctx.db.get(cardId) : null;
          return card && card.userId === work.userId ? card : null;
        }),
      );
      const present = cards.filter((card) => card !== null);
      tasksTotal = present.length;
      tasksCompleted = present.filter((card) => card!.completedAt).length;
    }
  }
  await recordCompletionEvent(ctx, {
    userId: work.userId,
    artifactKind: 'intent',
    artifactId: String(work._id),
    completedAt: ts,
    areaId: work.areaId,
    intentId: String(work._id),
    projectId: work.primaryProjectId,
    shape: work.shape,
    tasksTotal,
    tasksCompleted,
    msToComplete: Math.max(0, ts - (work.createdAt ?? work._creationTime)),
  });
}

/**
 * Conductor flags that no closed Work may keep. Each cron reads one of these
 * indexes with a bounded take, so a closed row that keeps its flag takes a
 * slot from open Work (WRK-9). Every terminal transition spreads this patch.
 */
export const TERMINAL_WORK_FLAG_CLEAR = {
  mailWatchAt: undefined,
  mailWatchClaimedAt: undefined,
  replyWatch: undefined,
  evidenceReconcileClaimedAt: undefined,
  horizonWakeAt: undefined,
  pendingStepEvidenceAt: undefined,
  pendingStepEvidence: undefined,
  planRetryAt: undefined,
} as const;

/** The plan cards of one Work, found through the card's `source.intentId`. */
async function workCards(ctx: MutationCtx, work: Doc<'albatrossIntents'>) {
  return ctx.db
    .query('cards')
    .withIndex('by_user_source_intent', (q) =>
      q.eq('userId', work.userId).eq('source.intentId', String(work._id)),
    )
    .collect();
}

/** Open cards leave the boards when their Work closes. A reopen restores them. */
export async function retireOpenWorkCards(
  ctx: MutationCtx,
  work: Doc<'albatrossIntents'>,
  ts: number,
  cards?: Doc<'cards'>[],
) {
  let retired = 0;
  for (const card of cards ?? (await workCards(ctx, work))) {
    if (card.completedAt || card.retiredAt) continue;
    await ctx.db.patch(card._id, { retiredByWorkId: String(work._id), retiredAt: ts, updatedAt: ts });
    retired += 1;
  }
  return retired;
}

/**
 * The side effects every close path shares: a pending question or approval
 * for closed Work can only mislead (WRK-11), and its open cards retire.
 */
export async function closeWorkArtifacts(
  ctx: MutationCtx,
  work: Doc<'albatrossIntents'>,
  ts: number,
  cards?: Doc<'cards'>[],
) {
  const questions = await ctx.db
    .query('albatrossWorkQuestions')
    .withIndex('by_user_work_status', (q) =>
      q.eq('userId', work.userId).eq('workId', work._id).eq('status', 'pending'),
    )
    .collect();
  for (const question of questions) await ctx.db.patch(question._id, { status: 'superseded', updatedAt: ts });
  const approvals = await ctx.db
    .query('albatrossApprovals')
    .withIndex('by_user_intent', (q) => q.eq('userId', work.userId).eq('intentId', String(work._id)))
    .collect();
  for (const approval of approvals)
    if (approval.status === 'pending')
      await ctx.db.patch(approval._id, { status: 'rejected', updatedAt: ts });
  await retireOpenWorkCards(ctx, work, ts, cards);
}

/** Shared, idempotent terminal transition. Called inside the evidence transaction too. */
export async function completeWorkInMutation(ctx: MutationCtx, work: Doc<'albatrossIntents'>, ts: number) {
  if (workLifecycle(work) !== 'done') await recordWorkCompletion(ctx, work, ts);
  await ctx.db.patch(work._id, {
    workState: 'done',
    status: 'done',
    agentState: 'idle',
    planError: undefined,
    pendingPlanId: undefined,
    ...TERMINAL_WORK_FLAG_CLEAR,
    lastEvidenceReconcileAt: work.lastEvidenceAt,
    lastUserTouchAt: ts,
    updatedAt: ts,
  });
  const cards = await workCards(ctx, work);
  // A project can also contain independent work. Only its own outcome may close it.
  if (work.primaryProjectId) {
    const project = await ctx.db.get(work.primaryProjectId);
    const links = await ctx.db
      .query('albatrossProjectLinks')
      .withIndex('by_user_project', (q) =>
        q.eq('userId', work.userId).eq('projectId', work.primaryProjectId!),
      )
      .collect();
    const ownedCards = new Set(cards.map((card) => String(card._id)));
    const shared = links.some((link) =>
      link.artifactKind === 'intent'
        ? link.artifactId !== String(work._id)
        : link.artifactKind === 'task' && !ownedCards.has(link.artifactId),
    );
    if (
      project?.userId === work.userId &&
      project.sourceIntentId === String(work._id) &&
      !shared &&
      project.status === 'active'
    ) {
      await ctx.db.patch(project._id, {
        status: 'done',
        completedAt: ts,
        completedByWorkId: String(work._id),
        updatedAt: ts,
      });
    }
  }
  await closeWorkArtifacts(ctx, work, ts, cards);
  await scheduleNarrativeSource(ctx, work.userId, 'albatrossIntents', String(work._id));
  return { previousState: workLifecycle(work), state: 'done' as const };
}

/** Restore only artifacts retired by this completion, preserving independently completed tasks. */
export async function restoreWorkArtifacts(ctx: MutationCtx, work: Doc<'albatrossIntents'>, ts: number) {
  const cards = await workCards(ctx, work);
  for (const card of cards)
    if (card.retiredByWorkId === String(work._id))
      await ctx.db.patch(card._id, { retiredByWorkId: undefined, retiredAt: undefined, updatedAt: ts });
  if (work.primaryProjectId) {
    const project = await ctx.db.get(work.primaryProjectId);
    if (
      project?.userId === work.userId &&
      project.status === 'done' &&
      project.completedByWorkId === String(work._id)
    )
      await ctx.db.patch(project._id, {
        status: 'active',
        completedAt: undefined,
        completedByWorkId: undefined,
        updatedAt: ts,
      });
  }
  await scheduleNarrativeSource(ctx, work.userId, 'albatrossIntents', String(work._id));
}
