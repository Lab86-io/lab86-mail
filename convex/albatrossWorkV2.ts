import { v } from 'convex/values';
import {
  areaArtifactHtmlForWrite,
  assertAreaArtifactDocumentSize,
} from '../lib/albatross/area-artifact-storage';
import { mayCloseAutomatically } from '../lib/albatross/contract';
import { type ExecutionWorkRow, selectExecutionSnapshot } from '../lib/albatross/execution';
import { isStale } from '../lib/albatross/forgiveness';
import { bindFrontierQuestionId } from '../lib/albatross/plan-frontier';
import {
  INTERACTIVE_CARD_READ_BUDGET,
  RECOVERY_CARD_READ_BUDGET_PER_USER,
  selectCardCompleteProjection,
} from '../lib/albatross/projection-budget';
import { matchingProofId } from '../lib/albatross/proof-match';
import { questionDedupeKey, shouldAdvanceWorkAfterAnswer } from '../lib/albatross/question-dedupe';
import {
  mergeStepProgress,
  planStepsForProgress,
  progressFromPlanCompletions,
  type StepProgressEntry,
} from '../lib/albatross/step-progress';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { recordCompletionEvent } from './albatrossWork';
import { completeCardForWork } from './boards';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

const EVIDENCE_RECONCILE_LEASE_MS = 10 * 60_000;
const MISSED_MOVE_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

const sourceRefValidator = v.object({
  kind: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
  accountId: v.optional(v.string()),
  url: v.optional(v.string()),
});

const workShapeValidator = v.union(
  v.literal('quick'),
  v.literal('project'),
  v.literal('practice'),
  v.literal('decision'),
  v.literal('monitor'),
  v.literal('recurring'),
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

async function requireWork(ctx: QueryCtx | MutationCtx, workId: Id<'albatrossIntents'>, userId: string) {
  const work = await ctx.db.get(workId);
  if (!work || work.userId !== userId) throw new Error('Work not found.');
  return work;
}

async function requireArea(ctx: QueryCtx | MutationCtx, areaId: Id<'areas'>, userId: string) {
  const area = await ctx.db.get(areaId);
  if (!area || area.userId !== userId || area.status !== 'active') throw new Error('Area not found.');
  return area;
}

function bounded(value: string | undefined | null, max: number) {
  const clean = String(value || '').trim();
  return clean ? clean.slice(0, max) : undefined;
}

type PlanStepAction = {
  key?: string;
  actionKey?: string;
  kind?: string;
  title?: string;
  description?: string;
  detail?: string;
  url?: string;
  startIso?: string;
  endIso?: string;
  sourceRefs?: Array<{ url?: string }>;
};

function keyedPlanActions(plan: Doc<'albatrossIntentPlans'>) {
  return planStepsForProgress(plan).map((step) => ({
    ...step,
    action: step.action as PlanStepAction,
  }));
}

function preserveRaw(value: string, max = 20_000) {
  return String(value || '')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, max);
}

export const beginCapture = mutation({
  args: {
    ...callerArgs,
    rawText: v.string(),
    transcript: v.optional(v.string()),
    source: v.union(v.literal('text'), v.literal('voice'), v.literal('chat'), v.literal('import')),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rawText = preserveRaw(args.rawText);
    if (!rawText) throw new Error('Capture text is required.');
    const ts = now();
    return ctx.db.insert('albatrossCaptures', {
      userId,
      rawText,
      transcript: args.transcript ? preserveRaw(args.transcript) : undefined,
      source: args.source,
      status: 'processing',
      workIds: [],
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

/**
 * The completion record for one finished albatross: shape, how many of its
 * tasks were checked, and capture-to-done time. This is the raw material for
 * the future progress page; it is stored on every finish, rendered nowhere yet.
 */
async function recordWorkCompletion(ctx: MutationCtx, work: Doc<'albatrossIntents'>, ts: number) {
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

export const updateWorkState = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    state: v.union(
      v.literal('active'),
      v.literal('paused'),
      v.literal('waiting'),
      v.literal('blocked'),
      v.literal('done'),
      v.literal('archived'),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const work = await requireWork(ctx, args.workId, userId);
    const ts = now();
    await ctx.db.patch(args.workId, {
      workState: args.state,
      status:
        args.state === 'done'
          ? 'done'
          : args.state === 'archived'
            ? 'archived'
            : work.status === 'done' || work.status === 'archived'
              ? 'ready'
              : work.status,
      // Picking released work back up clears the release, exactly like
      // reopenWork — a revived albatross must not keep a release reason.
      ...(args.state === 'active' && work.workState === 'released'
        ? {
            releaseReason: undefined,
            releaseProposedBy: undefined,
            releasedAt: undefined,
            reviewAt: undefined,
            status: 'ready' as const,
          }
        : {}),
      updatedAt: ts,
    });
    // The user's check is the completion. Record it once, on the transition.
    if (args.state === 'done' && work.workState !== 'done') {
      await recordWorkCompletion(ctx, work, ts);
    }
    return { previousState: work.workState || 'active', state: args.state };
  },
});

/**
 * Put an Albatross down on purpose.
 *
 * This is an ending, not a failure, and the data says so: it is its own state
 * with its own reason, and it records whether the user chose it or Albatross
 * suggested it. A release nobody proposed reads very differently from one the
 * system nudged.
 */
export const releaseWork = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    reason: v.optional(v.string()),
    proposedBy: v.optional(v.union(v.literal('user'), v.literal('system'))),
    reviewAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireWork(ctx, args.workId, userId);
    const ts = now();
    await ctx.db.patch(args.workId, {
      workState: 'released',
      status: 'archived',
      releaseReason: bounded(args.reason, 400),
      releaseProposedBy: args.proposedBy ?? 'user',
      releasedAt: ts,
      reviewAt: args.reviewAt,
      updatedAt: ts,
    });
    return { releasedAt: ts };
  },
});

/** Picking something back up is always allowed, and costs nothing to say. */
export const reopenWork = mutation({
  args: { ...callerArgs, workId: v.id('albatrossIntents') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireWork(ctx, args.workId, userId);
    const ts = now();
    await ctx.db.patch(args.workId, {
      workState: 'active',
      status: 'ready',
      releaseReason: undefined,
      releaseProposedBy: undefined,
      releasedAt: undefined,
      reviewAt: undefined,
      updatedAt: ts,
    });
    return { reopenedAt: ts };
  },
});

/**
 * A step did not happen. Record what came of that, not merely that it slipped.
 */
export const recordLapse = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    stepKey: v.optional(v.string()),
    stepTitle: v.optional(v.string()),
    plannedAt: v.optional(v.number()),
    reason: v.optional(v.string()),
    reasonKind: v.optional(
      v.union(
        v.literal('no_energy'),
        v.literal('no_time'),
        v.literal('something_else_came_first'),
        v.literal('blocked'),
        v.literal('need_help'),
        v.literal('step_too_large'),
        v.literal('matters_less_now'),
        v.literal('forgot'),
        v.literal('other'),
      ),
    ),
    reasonSource: v.optional(v.union(v.literal('user'), v.literal('inferred'))),
    recovery: v.optional(
      v.union(
        v.literal('done'),
        v.literal('move'),
        v.literal('shrink'),
        v.literal('wait'),
        v.literal('delegate'),
        v.literal('pause'),
        v.literal('release'),
        v.literal('rebuild'),
      ),
    ),
    revisedStep: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireWork(ctx, args.workId, userId);
    const ts = now();
    const lapseId = await ctx.db.insert('albatrossLapses', {
      userId,
      workId: args.workId,
      stepKey: bounded(args.stepKey, 200),
      stepTitle: bounded(args.stepTitle, 300),
      plannedAt: args.plannedAt,
      reason: bounded(args.reason, 400),
      reasonKind: args.reasonKind,
      reasonSource: args.reasonSource ?? 'user',
      recovery: args.recovery,
      revisedStep: bounded(args.revisedStep, 300),
      createdAt: ts,
      updatedAt: ts,
    });
    // The recovery the user picked is a statement about the work's state, so
    // apply it rather than only writing it down.
    if (args.recovery === 'pause') {
      await ctx.db.patch(args.workId, { workState: 'paused', updatedAt: ts });
    } else if (args.recovery === 'wait') {
      await ctx.db.patch(args.workId, { workState: 'waiting', updatedAt: ts });
    } else if (args.recovery === 'release') {
      await ctx.db.patch(args.workId, {
        workState: 'released',
        status: 'archived',
        releaseReason: bounded(args.reason, 400),
        releaseProposedBy: 'user',
        releasedAt: ts,
        updatedAt: ts,
      });
    }
    return lapseId;
  },
});

/** Did the smaller step actually happen? This is what makes the record teach. */
export const resolveLapse = mutation({
  args: { ...callerArgs, lapseId: v.id('albatrossLapses'), held: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const lapse = await ctx.db.get(args.lapseId);
    if (!lapse || lapse.userId !== userId) throw new Error('Lapse not found.');
    const ts = now();
    await ctx.db.patch(args.lapseId, { revisionHeld: args.held, resolvedAt: ts, updatedAt: ts });
  },
});

/** Mark the plan step itself complete; creating its artifact never counts as finishing it. */
export const completeStep = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    stepKey: v.string(),
    source: v.optional(v.union(v.literal('user'), v.literal('task'), v.literal('evidence'))),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const work = await requireWork(ctx, args.workId, userId);
    if (!work.latestPlanId) throw new Error('This Albatross does not have a plan yet.');
    const plan = await ctx.db.get(work.latestPlanId);
    if (!plan || plan.userId !== userId) throw new Error('Plan not found.');
    const planSteps = keyedPlanActions(plan);
    const selected = planSteps.find((step) => step.key === args.stepKey);
    if (!selected) throw new Error('Plan step not found.');
    const ts = now();
    const source = args.source ?? 'user';
    const completedSteps = plan.completedSteps || [];
    const baselineProgress = mergeStepProgress(
      work.stepProgress as StepProgressEntry[] | undefined,
      progressFromPlanCompletions(plan),
    );
    const transitioned = !baselineProgress.some((row) => row.identity === selected.identity);
    const nextProgress = transitioned
      ? mergeStepProgress(baselineProgress, [
          {
            identity: selected.identity,
            actionKey: selected.actionKey,
            kind: selected.kind === 'physical' ? 'physical' : selected.action.kind || 'task',
            title: selected.action.title!.trim().slice(0, 240),
            cardId: selected.cardId,
            completedAt: ts,
            source,
          },
        ])
      : baselineProgress;
    const progressWasMigrated =
      nextProgress.length !== (work.stepProgress || []).length ||
      nextProgress.some((row, index) => row.identity !== work.stepProgress?.[index]?.identity);
    if (progressWasMigrated || !work.stepProgressMigratedAt) {
      await ctx.db.patch(args.workId, {
        stepProgress: nextProgress,
        stepProgressMigratedAt: work.stepProgressMigratedAt ?? ts,
        updatedAt: ts,
      });
    }
    if (!completedSteps.some((step) => step.stepKey === args.stepKey)) {
      await ctx.db.patch(plan._id, {
        completedSteps: [
          ...completedSteps,
          { stepKey: args.stepKey.slice(0, 80), completedAt: ts, source },
        ].slice(-60),
        updatedAt: ts,
      });
    }
    const applied = plan.appliedSteps?.find((step) => step.stepKey === args.stepKey);
    if (applied?.cardId) {
      const cardId = ctx.db.normalizeId('cards', applied.cardId);
      if (!cardId) throw new Error('Plan card not found.');
      await completeCardForWork(ctx, userId, cardId, ts);
    }
    const completedIdentities = new Set(nextProgress.map((row) => row.identity));
    const cardSteps = plan.appliedSteps?.filter((step) => step.cardId) || [];
    const cards = await Promise.all(
      cardSteps.map(async (step) => {
        const cardId = ctx.db.normalizeId('cards', step.cardId!);
        return { stepKey: step.stepKey, card: cardId ? await ctx.db.get(cardId) : null };
      }),
    );
    const completedCardIds = new Set(
      cards.filter(({ card }) => Boolean(card?.completedAt)).map(({ card }) => String(card!._id)),
    );
    return {
      stepKey: args.stepKey,
      stepIdentity: selected.identity,
      stepTitle: selected.action.title!.trim(),
      planId: String(plan._id),
      cardId: applied?.cardId || null,
      allStepsComplete:
        planSteps.length > 0 &&
        planSteps.every(
          (step) =>
            completedIdentities.has(step.identity) ||
            Boolean(step.cardId && completedCardIds.has(step.cardId)),
        ),
      workState: work.workState || 'active',
      transitioned,
    };
  },
});

/** Write or correct what would settle an outcome. */
export const saveContract = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    outcome: v.string(),
    proofs: v.array(
      v.object({
        id: v.string(),
        what: v.string(),
        satisfiedBy: v.optional(v.string()),
        satisfiedAt: v.optional(v.number()),
      }),
    ),
    closeWhen: v.union(
      v.literal('action_succeeded'),
      v.literal('outcome_likely'),
      v.literal('outcome_confirmed'),
      v.literal('never_automatically'),
    ),
    contradictions: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireWork(ctx, args.workId, userId);
    const ts = now();
    await ctx.db.patch(args.workId, {
      contract: {
        outcome: args.outcome.slice(0, 600),
        // The contract lives inside the work document. Capping the array
        // lengths alone still lets twelve unbounded conditions grow the row
        // until a later patch of the same work fails, so every string inside
        // is bounded the way the rest of this file bounds free text.
        proofs: args.proofs.slice(0, 12).map((proof) => ({
          ...proof,
          id: proof.id.slice(0, 120),
          what: proof.what.slice(0, 300),
          satisfiedBy: bounded(proof.satisfiedBy, 300),
        })),
        closeWhen: args.closeWhen,
        contradictions: args.contradictions?.slice(0, 12).map((row) => row.slice(0, 300)),
        updatedAt: ts,
      },
      updatedAt: ts,
    });
  },
});

/**
 * Attach a piece of mail to an outcome as proof of a specific claim.
 *
 * The claim is the point. Storing "email 123" produces an attachment list;
 * storing what it is claimed to prove produces something that can actually
 * close an outcome.
 */
export const attachProof = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    claim: v.string(),
    title: v.string(),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
    limits: v.optional(v.string()),
    sourceKind: v.union(
      v.literal('mail_thread'),
      v.literal('calendar_event'),
      v.literal('task'),
      v.literal('chat'),
      v.literal('question_answer'),
      v.literal('area_fact'),
      v.literal('github_issue'),
      v.literal('github_pull_request'),
      v.literal('github_project'),
      v.literal('github_project_item'),
      v.literal('github_commit'),
      v.literal('mcp_item'),
      v.literal('manual'),
    ),
    sourceId: v.string(),
    connectionId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    trust: v.union(v.literal('observed'), v.literal('inferred'), v.literal('confirmed')),
    proofId: v.optional(v.string()),
    settleContract: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const work = await requireWork(ctx, args.workId, userId);
    const ts = now();
    let trust = args.trust;
    if (args.sourceKind === 'mail_thread') {
      const accountId = bounded(args.accountId, 320);
      if (!accountId) throw new Error('Mail proof requires an account.');
      const thread = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_account_thread', (q) =>
          q.eq('userId', userId).eq('accountId', accountId).eq('providerThreadId', args.sourceId),
        )
        .unique();
      if (!thread) throw new Error('Mail proof could not be verified.');
      trust = 'observed';
    }
    const sourceScope = [bounded(args.accountId, 320), bounded(args.connectionId, 180)]
      .filter(Boolean)
      .map((value) => encodeURIComponent(value as string))
      .join(':');
    const dedupeKey = `proof:${String(args.workId)}:${args.sourceKind}:${sourceScope ? `${sourceScope}:` : ''}${args.sourceId}`;
    const existing = await ctx.db
      .query('albatrossEvidence')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', userId).eq('dedupeKey', dedupeKey))
      .first();
    const row = {
      userId,
      targetKind: 'work' as const,
      targetId: String(args.workId),
      sourceKind: args.sourceKind,
      sourceId: args.sourceId,
      connectionId: bounded(args.connectionId, 180),
      accountId: bounded(args.accountId, 320),
      title: bounded(args.title, 300) || 'Untitled',
      summary: bounded(args.summary, 600),
      claim: bounded(args.claim, 400),
      limits: bounded(args.limits, 400),
      url: bounded(args.url, 2000),
      occurredAt: args.occurredAt ?? ts,
      weight: 1,
      // The user pointing at something is the strongest signal there is, so it
      // does not need a model's opinion attached to it.
      confidence: 0.95,
      trust,
      dedupeKey,
      searchText: [args.claim, args.title, args.summary].filter(Boolean).join(' ').slice(0, 4000),
      updatedAt: ts,
    };
    let evidenceId: Id<'albatrossEvidence'>;
    if (existing) {
      await ctx.db.patch(existing._id, row);
      evidenceId = existing._id;
    } else {
      evidenceId = await ctx.db.insert('albatrossEvidence', { ...row, createdAt: ts });
    }

    // Tick off the named condition this proof settles. Plan-step completion is
    // useful evidence, but it must not stand in for an external receipt or
    // reply merely because one contract condition remains.
    const proofId =
      work.contract && args.settleContract !== false
        ? args.proofId ||
          matchingProofId(
            work.contract.proofs,
            [args.claim, args.title, args.summary].filter(Boolean).join(' '),
          )
        : null;
    let updatedContract = work.contract;
    if (proofId && work.contract) {
      updatedContract = {
        ...work.contract,
        proofs: work.contract.proofs.map((proof) =>
          proof.id === proofId ? { ...proof, satisfiedBy: bounded(args.title, 300), satisfiedAt: ts } : proof,
        ),
        updatedAt: ts,
      };
      await ctx.db.patch(args.workId, {
        contract: updatedContract,
        lastEvidenceAt: ts,
        updatedAt: ts,
      });
    } else {
      await ctx.db.patch(args.workId, { lastEvidenceAt: ts, updatedAt: ts });
    }
    const evidence = await ctx.db
      .query('albatrossEvidence')
      .withIndex('by_user_target', (q) =>
        q.eq('userId', userId).eq('targetKind', 'work').eq('targetId', String(args.workId)),
      )
      .order('desc')
      .take(100);
    const currentState =
      work.workState || (['done', 'archived'].includes(work.status) ? work.status : 'active');
    if (
      !['done', 'released', 'archived', 'paused', 'waiting'].includes(currentState) &&
      mayCloseAutomatically(updatedContract, evidence) &&
      !evidence.some((item) => item.trust === 'rejected')
    ) {
      await ctx.db.patch(args.workId, {
        workState: 'done',
        status: 'done',
        agentState: 'idle',
        updatedAt: ts,
      });
      await recordWorkCompletion(
        ctx,
        { ...work, workState: 'done', status: 'done', agentState: 'idle', updatedAt: ts },
        ts,
      );
    }
    return evidenceId;
  },
});

/**
 * Claim newly attached evidence for a single advance pass. The evidence write
 * is authoritative and quick; this lease keeps plan generation off that write
 * path while ensuring a deploy cannot strand the follow-up forever.
 */
export const beginEvidenceReconcile = internalMutation({
  args: { workId: v.id('albatrossIntents') },
  handler: async (ctx, args) => {
    const work = await ctx.db.get(args.workId);
    if (!work?.lastEvidenceAt) return null;
    const ts = now();
    const state = work.workState || work.status;
    if (['done', 'released', 'archived'].includes(state)) return null;
    if ((work.lastEvidenceReconcileAt || 0) >= work.lastEvidenceAt) return null;
    if (
      work.evidenceReconcileClaimedAt &&
      ts - work.evidenceReconcileClaimedAt < EVIDENCE_RECONCILE_LEASE_MS
    ) {
      return null;
    }
    await ctx.db.patch(work._id, { evidenceReconcileClaimedAt: ts, updatedAt: ts });
    return {
      userId: work.userId,
      workId: String(work._id),
      evidenceAt: work.lastEvidenceAt,
    };
  },
});

export const completeEvidenceReconcile = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    evidenceAt: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const work = await requireWork(ctx, args.workId, userId);
    await ctx.db.patch(work._id, {
      lastEvidenceReconcileAt: Math.max(work.lastEvidenceReconcileAt || 0, args.evidenceAt),
      evidenceReconcileClaimedAt: undefined,
      updatedAt: now(),
    });
  },
});

export const releaseEvidenceReconcile = internalMutation({
  args: { workId: v.id('albatrossIntents') },
  handler: async (ctx, args) => {
    const work = await ctx.db.get(args.workId);
    if (work?.evidenceReconcileClaimedAt) {
      await ctx.db.patch(work._id, { evidenceReconcileClaimedAt: undefined, updatedAt: now() });
    }
  },
});

/** Open Albatrosses a thread could plausibly be proof for. */
export const openWorkForProof = query({
  args: { ...callerArgs, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const wanted = Math.min(Math.max(args.limit ?? 8, 1), 20);
    // Filtering after a fixed window can exhaust it: a user whose newest rows
    // are all finished would be offered nothing to attach proof to, while older
    // open Albatrosses sit just past the edge. Collect until there are enough.
    const rows: Doc<'albatrossIntents'>[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5 && rows.length < wanted; page += 1) {
      const batch = await ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
        .order('desc')
        .paginate({ numItems: 100, cursor });
      rows.push(
        ...batch.page.filter((row) => !['done', 'released', 'archived'].includes(row.workState || 'active')),
      );
      if (batch.isDone) break;
      cursor = batch.continueCursor;
    }
    return rows.slice(0, wanted).map((row) => ({
      _id: String(row._id),
      title: row.title || row.rawText.slice(0, 90),
      contract: row.contract ? { outcome: row.contract.outcome, proofs: row.contract.proofs } : null,
    }));
  },
});

export const lapsesForWork = query({
  args: { ...callerArgs, workId: v.id('albatrossIntents'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireWork(ctx, args.workId, userId);
    return ctx.db
      .query('albatrossLapses')
      .withIndex('by_work', (q) => q.eq('workId', args.workId))
      .order('desc')
      .take(Math.min(Math.max(args.limit ?? 20, 1), 100));
  },
});

export const finishCapture = mutation({
  args: {
    ...callerArgs,
    captureId: v.id('albatrossCaptures'),
    items: v.array(
      v.object({
        title: v.string(),
        rawText: v.string(),
        primaryAreaId: v.optional(v.id('areas')),
        relatedAreaIds: v.optional(v.array(v.id('areas'))),
        shape: v.optional(workShapeValidator),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const capture = await ctx.db.get(args.captureId);
    if (!capture || capture.userId !== userId) throw new Error('Capture not found.');
    if (capture.workIds.length) return capture.workIds;
    const ts = now();
    const workIds: Id<'albatrossIntents'>[] = [];
    for (const item of args.items.slice(0, 20)) {
      const rawText = preserveRaw(item.rawText);
      if (!rawText) continue;
      if (item.primaryAreaId) await requireArea(ctx, item.primaryAreaId, userId);
      for (const related of item.relatedAreaIds || []) await requireArea(ctx, related, userId);
      // Areas are opt-in. The splitter may leave Work unassigned; no system
      // catch-all is created behind the user's back.
      const primaryAreaId = item.primaryAreaId;
      const workId = await ctx.db.insert('albatrossIntents', {
        userId,
        rawText,
        transcript: capture.transcript,
        source: capture.source,
        title: bounded(item.title, 180),
        status: 'captured',
        areaId: primaryAreaId ? String(primaryAreaId) : undefined,
        areaAutoAssigned: undefined,
        captureId: args.captureId,
        primaryAreaId,
        shape: item.shape,
        workState: 'active',
        agentState: 'researching',
        lastAgentRunAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
      await ctx.db.patch(workId, { conversationId: `work_${String(workId)}` });
      workIds.push(workId);
      const areaIds = [item.primaryAreaId, ...(item.relatedAreaIds || [])].filter(
        (value, index, all): value is Id<'areas'> => Boolean(value) && all.indexOf(value) === index,
      );
      for (const areaId of areaIds) {
        await ctx.db.insert('areaArtifactLinks', {
          userId,
          areaId,
          artifactKind: 'intent',
          artifactId: String(workId),
          role: areaId === item.primaryAreaId ? 'primary' : 'secondary',
          status: 'candidate',
          confidence: areaId === item.primaryAreaId ? 0.8 : 0.65,
          reason: 'Inferred from the user capture; awaiting correction if needed.',
          sourceRefs: [{ kind: 'capture', id: String(args.captureId), label: capture.rawText.slice(0, 140) }],
          confirmationRefs: [],
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }
    if (!workIds.length) throw new Error('Capture produced no Work.');
    await ctx.db.patch(args.captureId, { status: 'split', workIds, error: undefined, updatedAt: ts });
    return workIds;
  },
});

export const failCapture = mutation({
  args: { ...callerArgs, captureId: v.id('albatrossCaptures'), error: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const capture = await ctx.db.get(args.captureId);
    if (!capture || capture.userId !== userId) return;
    await ctx.db.patch(args.captureId, {
      status: 'error',
      error: args.error.slice(0, 500),
      updatedAt: now(),
    });
  },
});

export const setAgentState = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    agentState: v.union(
      v.literal('idle'),
      v.literal('researching'),
      v.literal('needs_input'),
      v.literal('applying'),
      v.literal('error'),
    ),
    primaryProjectId: v.optional(v.id('albatrossProjects')),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireWork(ctx, args.workId, userId);
    const ts = now();
    await ctx.db.patch(args.workId, {
      agentState: args.agentState,
      lastAgentRunAt: ts,
      ...(args.primaryProjectId !== undefined ? { primaryProjectId: args.primaryProjectId } : {}),
      planError: bounded(args.error, 500),
      updatedAt: ts,
    });
  },
});

/**
 * The plan document's question gate is composed before the durable question
 * row exists, so it carries the planner's inline id. Once the row is real,
 * rewrite the gate to the id the answer endpoint expects.
 */
async function bindGateQuestionId(
  ctx: MutationCtx,
  workId: Id<'albatrossIntents'>,
  legacyQuestionId: string | undefined,
  durableQuestionId: string,
) {
  if (!legacyQuestionId || legacyQuestionId === durableQuestionId) return;
  const work = await ctx.db.get(workId);
  const targetPlanId = work?.pendingPlanId || work?.latestPlanId;
  if (!work || !targetPlanId) return;
  const plan = await ctx.db.get(targetPlanId);
  if (!plan || plan.userId !== work.userId || !plan.document) return;
  const { document, changed } = bindFrontierQuestionId(plan.document, legacyQuestionId, durableQuestionId);
  if (changed) await ctx.db.patch(targetPlanId, { document, updatedAt: now() });
}

export const upsertQuestion = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    legacyQuestionId: v.optional(v.string()),
    kind: v.union(v.literal('clarification'), v.literal('completion'), v.literal('correction')),
    prompt: v.string(),
    reason: v.optional(v.string()),
    options: v.optional(
      v.array(v.object({ id: v.string(), label: v.string(), description: v.optional(v.string()) })),
    ),
    sourceRefs: v.optional(v.array(sourceRefValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireWork(ctx, args.workId, userId);
    const dedupeKey = questionDedupeKey({
      workId: String(args.workId),
      kind: args.kind,
      prompt: args.prompt,
    });
    const duplicate = await ctx.db
      .query('albatrossWorkQuestions')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', userId).eq('dedupeKey', dedupeKey))
      .unique();
    if (duplicate) {
      const ts = now();
      const refreshed = {
        legacyQuestionId: bounded(args.legacyQuestionId, 80),
        prompt: args.prompt.slice(0, 500),
        reason: bounded(args.reason, 500),
        options: args.options?.slice(0, 6).map((option) => ({
          id: option.id.slice(0, 80),
          label: option.label.slice(0, 180),
          description: bounded(option.description, 400),
        })),
        sourceRefs: args.sourceRefs || duplicate.sourceRefs,
        updatedAt: ts,
      };
      if (duplicate.status === 'pending') {
        await ctx.db.patch(duplicate._id, refreshed);
        await ctx.db.patch(args.workId, {
          agentState: 'needs_input',
          status: 'needs_answers',
          updatedAt: ts,
        });
        await bindGateQuestionId(ctx, args.workId, args.legacyQuestionId, String(duplicate._id));
      } else if (duplicate.status === 'answered' && duplicate.answer) {
        await ctx.db.patch(duplicate._id, refreshed);
        const work = await requireWork(ctx, args.workId, userId);
        await ctx.db.patch(args.workId, {
          questions: (work.questions || []).map((entry) =>
            args.legacyQuestionId && entry.id === args.legacyQuestionId
              ? {
                  ...entry,
                  answer: duplicate.answer,
                  answeredOptionId: duplicate.answeredOptionId,
                  answeredAt: duplicate.answeredAt,
                }
              : entry,
          ),
          agentState: 'researching',
          status: work.status === 'needs_answers' ? 'captured' : work.status,
          updatedAt: ts,
        });
      } else {
        const pending = await ctx.db
          .query('albatrossWorkQuestions')
          .withIndex('by_user_work_status', (q) =>
            q.eq('userId', userId).eq('workId', args.workId).eq('status', 'pending'),
          )
          .collect();
        for (const row of pending) {
          if (row._id !== duplicate._id) {
            await ctx.db.patch(row._id, { status: 'superseded', updatedAt: ts });
          }
        }
        await ctx.db.patch(duplicate._id, {
          ...refreshed,
          status: 'pending',
          answer: undefined,
          answeredOptionId: undefined,
          answeredAt: undefined,
        });
        await ctx.db.patch(args.workId, {
          agentState: 'needs_input',
          status: 'needs_answers',
          updatedAt: ts,
        });
        await bindGateQuestionId(ctx, args.workId, args.legacyQuestionId, String(duplicate._id));
      }
      return duplicate._id;
    }
    const existing = await ctx.db
      .query('albatrossWorkQuestions')
      .withIndex('by_user_work_status', (q) =>
        q.eq('userId', userId).eq('workId', args.workId).eq('status', 'pending'),
      )
      .collect();
    const ts = now();
    for (const row of existing) await ctx.db.patch(row._id, { status: 'superseded', updatedAt: ts });
    const questionId = await ctx.db.insert('albatrossWorkQuestions', {
      userId,
      workId: args.workId,
      dedupeKey,
      legacyQuestionId: bounded(args.legacyQuestionId, 80),
      kind: args.kind,
      prompt: args.prompt.slice(0, 500),
      reason: bounded(args.reason, 500),
      options: args.options?.slice(0, 6).map((option) => ({
        id: option.id.slice(0, 80),
        label: option.label.slice(0, 180),
        description: bounded(option.description, 400),
      })),
      status: 'pending',
      sourceRefs: args.sourceRefs || [],
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.patch(args.workId, { agentState: 'needs_input', status: 'needs_answers', updatedAt: ts });
    await bindGateQuestionId(ctx, args.workId, args.legacyQuestionId, String(questionId));
    return questionId;
  },
});

export const answerQuestion = mutation({
  args: {
    ...callerArgs,
    questionId: v.id('albatrossWorkQuestions'),
    answer: v.string(),
    answeredOptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const question = await ctx.db.get(args.questionId);
    if (!question || question.userId !== userId) throw new Error('Question not found.');
    if (question.status !== 'pending') {
      return {
        workId: question.workId ? String(question.workId) : undefined,
        projectId: question.projectId ? String(question.projectId) : undefined,
        routineId: question.routineId ? String(question.routineId) : undefined,
        shouldAdvance: false,
      };
    }
    const answer = preserveRaw(args.answer, 2_000);
    if (!answer) throw new Error('Answer required.');
    const ts = now();
    await ctx.db.patch(args.questionId, {
      status: 'answered',
      answer,
      answeredOptionId: bounded(args.answeredOptionId, 80),
      answeredAt: ts,
      updatedAt: ts,
    });
    let shouldAdvance = false;
    if (question.workId) {
      const work = await requireWork(ctx, question.workId, userId);
      const legacyQuestions = (work.questions || []).map((entry) =>
        question.legacyQuestionId && entry.id === question.legacyQuestionId
          ? {
              ...entry,
              answer,
              answeredOptionId: bounded(args.answeredOptionId, 80),
              answeredAt: ts,
            }
          : entry,
      );
      if (!shouldAdvanceWorkAfterAnswer(question.kind, answer)) {
        await ctx.db.patch(question.workId, {
          workState: 'done',
          status: 'done',
          agentState: 'idle',
          questions: legacyQuestions,
          updatedAt: ts,
        });
        if (work.workState !== 'done') await recordWorkCompletion(ctx, work, ts);
      } else {
        shouldAdvance = true;
        await ctx.db.patch(question.workId, {
          agentState: 'researching',
          status: work.status === 'needs_answers' ? 'captured' : work.status,
          questions: legacyQuestions,
          updatedAt: ts,
        });
      }
    }
    if (
      question.kind === 'consent' &&
      question.routineId &&
      question.metadata?.action === 'routine_notification_consent'
    ) {
      const routine = await ctx.db.get(question.routineId);
      if (routine?.userId === userId) {
        const enabled = args.answeredOptionId
          ? args.answeredOptionId === 'enable'
          : /^(yes|enable|enabled|notify|yes, notify me)$/i.test(answer.trim());
        await ctx.db.patch(question.routineId, {
          notification: { ...routine.notification, enabled },
          updatedAt: ts,
        });
      }
    }
    const evidenceKey = `question-answer:${String(question._id)}`;
    const existingEvidence = await ctx.db
      .query('albatrossEvidence')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', userId).eq('dedupeKey', evidenceKey))
      .unique();
    const targetKind = question.routineId
      ? ('routine' as const)
      : question.projectId
        ? ('project' as const)
        : question.workId
          ? ('work' as const)
          : undefined;
    const targetId = question.routineId || question.projectId || question.workId;
    const evidence = {
      userId,
      targetKind,
      targetId: targetId ? String(targetId) : undefined,
      sourceKind: 'question_answer' as const,
      sourceId: String(question._id),
      title: question.prompt.slice(0, 500),
      summary: answer,
      occurredAt: ts,
      weight: 1,
      confidence: 1,
      trust: 'confirmed' as const,
      dedupeKey: evidenceKey,
      searchText: `${question.prompt} ${answer}`.slice(0, 4_000),
      metadata: { answeredOptionId: bounded(args.answeredOptionId, 80), kind: question.kind },
      updatedAt: ts,
    };
    if (existingEvidence) await ctx.db.patch(existingEvidence._id, evidence);
    else await ctx.db.insert('albatrossEvidence', { ...evidence, createdAt: ts });
    return {
      workId: question.workId ? String(question.workId) : undefined,
      projectId: question.projectId ? String(question.projectId) : undefined,
      routineId: question.routineId ? String(question.routineId) : undefined,
      shouldAdvance,
    };
  },
});

export const livePendingQuestions = query({
  args: { ...callerArgs, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const questions = await ctx.db
      .query('albatrossWorkQuestions')
      .withIndex('by_user_status_created', (q) => q.eq('userId', userId).eq('status', 'pending'))
      .order('asc')
      .take(100);
    const rows = await Promise.all(
      questions.map(async (question) => ({
        question,
        work: question.workId ? await ctx.db.get(question.workId) : null,
        project: question.projectId ? await ctx.db.get(question.projectId) : null,
        routine: question.routineId ? await ctx.db.get(question.routineId) : null,
      })),
    );
    const kindRank: Record<string, number> = {
      consent: 6,
      completion: 5,
      checkin: 4,
      correction: 3,
      reflection: 2,
      clarification: 1,
    };
    return rows
      .filter(
        (row) =>
          row.work?.userId === userId || row.project?.userId === userId || row.routine?.userId === userId,
      )
      .sort(
        (a, b) =>
          (kindRank[b.question.kind] || 0) - (kindRank[a.question.kind] || 0) ||
          (a.work?.priority || 3) - (b.work?.priority || 3) ||
          a.question.createdAt - b.question.createdAt,
      )
      .slice(0, limit);
  },
});

export const areaWork = query({
  args: {
    ...callerArgs,
    areaId: v.id('areas'),
    includeDone: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireArea(ctx, args.areaId, userId);
    const [primaryRows, areaLinks] = await Promise.all([
      ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_primary_area', (q) => q.eq('userId', userId).eq('primaryAreaId', args.areaId))
        .order('desc')
        .take(100),
      ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', args.areaId))
        .collect(),
    ]);
    const relatedIds = areaLinks
      .filter((link) => link.artifactKind === 'intent' && link.status !== 'rejected')
      .map((link) => ctx.db.normalizeId('albatrossIntents', link.artifactId))
      .filter((id): id is Id<'albatrossIntents'> => id !== null);
    const relatedRows = await Promise.all(relatedIds.map((id) => ctx.db.get(id)));
    const deduped = new Map(
      [...primaryRows, ...relatedRows]
        .filter((row): row is NonNullable<typeof row> => row !== null && row.userId === userId)
        .map((row) => [String(row._id), row] as const),
    );
    return [...deduped.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((row) => args.includeDone || !['done', 'archived'].includes(row.workState || 'active'));
  },
});

type ProjectedPlanStep = {
  key: string;
  kind: string;
  title: string;
  detail: string | null;
  url: string | null;
  done: boolean;
  cardId: string | null;
};

function projectedPlanSteps(
  plan: Doc<'albatrossIntentPlans'> | null | undefined,
  completedCardIds: Set<string>,
  workProgress?: readonly StepProgressEntry[],
): ProjectedPlanStep[] {
  if (!plan) return [];
  const appliedByKey = new Map((plan.appliedSteps || []).map((step) => [step.stepKey, step] as const));
  const completedIdentities = new Set(
    mergeStepProgress(workProgress, progressFromPlanCompletions(plan)).map((row) => row.identity),
  );
  const digital = keyedPlanActions(plan)
    .filter((step) => step.kind === 'digital')
    .map(({ action, key, identity }) => {
      const applied = appliedByKey.get(key);
      return {
        key,
        kind: action.kind || 'task',
        title: action.title!.trim(),
        detail: bounded(action.description || action.detail, 1_200) || null,
        url: bounded(action.url || action.sourceRefs?.find((ref) => ref.url)?.url, 2_000) || null,
        done:
          completedIdentities.has(identity) ||
          Boolean(applied?.cardId && completedCardIds.has(applied.cardId)),
        cardId: applied?.cardId || null,
      };
    });
  const physical = keyedPlanActions(plan)
    .filter((step) => step.kind === 'physical')
    .map(({ action, key, identity }) => {
      return {
        key,
        kind: 'physical',
        title: action.title!.trim(),
        detail: bounded(action.detail, 1_200) || null,
        url: bounded(action.url, 2_000) || null,
        done: completedIdentities.has(identity),
        cardId: null,
      };
    });
  return [...digital, ...physical];
}

function scheduledWindow(plan: Doc<'albatrossIntentPlans'> | null | undefined) {
  const action =
    plan?.status === 'applied'
      ? ((plan.digitalActions || []) as PlanStepAction[]).find(
          (candidate) => candidate.kind === 'calendar_event' && (candidate.startIso || candidate.endIso),
        )
      : undefined;
  const startAt = Date.parse(action?.startIso || '');
  const endAt = Date.parse(action?.endIso || '');
  return {
    scheduledStartAt: Number.isFinite(startAt) ? startAt : null,
    scheduledEndAt: Number.isFinite(endAt) ? endAt : null,
  };
}

function projectionPriority(row: Doc<'albatrossIntents'>) {
  const state = row.workState || 'active';
  if (state === 'active') return 0;
  if (state === 'waiting' || state === 'blocked') return 1;
  if (state === 'paused') return 2;
  return 3;
}

async function projectedWorkRows(
  ctx: QueryCtx,
  userId: string,
  limit: number,
  cardReadBudget = INTERACTIVE_CARD_READ_BUDGET,
) {
  const rows = await ctx.db
    .query('albatrossIntents')
    .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
    .order('desc')
    .take(limit);
  const [areas, pendingQuestions, plans] = await Promise.all([
    ctx.db
      .query('areas')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(500),
    ctx.db
      .query('albatrossWorkQuestions')
      .withIndex('by_user_status_created', (q) => q.eq('userId', userId).eq('status', 'pending'))
      .take(200),
    Promise.all(rows.map((row) => (row.latestPlanId ? ctx.db.get(row.latestPlanId) : null))),
  ]);
  const rowPlans = rows.map((row, index) => ({ row, plan: plans[index] }));
  const prioritized = [...rowPlans].sort(
    (left, right) => projectionPriority(left.row) - projectionPriority(right.row),
  );
  const boundedProjection = selectCardCompleteProjection(
    prioritized,
    ({ plan }) => {
      if (!plan || plan.userId !== userId) return [];
      const projectedKeys = new Set(keyedPlanActions(plan).map((step) => step.key));
      return (plan.appliedSteps || []).flatMap((step) =>
        step.cardId && projectedKeys.has(step.stepKey) ? [step.cardId] : [],
      );
    },
    cardReadBudget,
  );
  const selectedWorkIds = new Set(boundedProjection.items.map(({ row }) => String(row._id)));
  const projectedEntries = rowPlans.filter(({ row }) => selectedWorkIds.has(String(row._id)));

  const areaNames = new Map(areas.map((area) => [String(area._id), area.name]));
  const planByWork = new Map(
    projectedEntries
      .map(({ plan }) => plan)
      .filter((plan): plan is NonNullable<typeof plan> => Boolean(plan && plan.userId === userId))
      .map((plan) => [String(plan.intentId), plan] as const),
  );
  const cardIds = boundedProjection.cardIds;
  const cards: Array<Doc<'cards'> | null> = [];
  for (let index = 0; index < cardIds.length; index += 250) {
    cards.push(
      ...(await Promise.all(
        cardIds.slice(index, index + 250).map(async (rawId) => {
          const cardId = ctx.db.normalizeId('cards', rawId);
          return cardId ? ctx.db.get(cardId) : null;
        }),
      )),
    );
  }
  const completedCardIds = new Set(
    cards.filter((card) => Boolean(card?.completedAt)).map((card) => String(card!._id)),
  );
  const questionCounts = new Map<string, number>();
  for (const question of pendingQuestions) {
    if (!question.workId) continue;
    const key = String(question.workId);
    questionCounts.set(key, (questionCounts.get(key) || 0) + 1);
  }

  return projectedEntries.map(({ row }) => {
    const plan = planByWork.get(String(row._id));
    const steps = projectedPlanSteps(
      plan,
      completedCardIds,
      row.stepProgress as StepProgressEntry[] | undefined,
    );
    const nextStep = steps.find((step) => !step.done);
    const { scheduledStartAt, scheduledEndAt } = scheduledWindow(plan);
    return {
      _id: String(row._id),
      title: row.title || null,
      rawText: row.rawText,
      status: row.status,
      workState: row.workState || null,
      agentState: row.agentState || null,
      planError: row.planError || null,
      priority: row.priority || null,
      primaryAreaId: row.primaryAreaId ? String(row.primaryAreaId) : null,
      areaName: row.primaryAreaId ? areaNames.get(String(row.primaryAreaId)) || null : null,
      openQuestions:
        questionCounts.get(String(row._id)) ??
        (row.questions || []).filter((question) => !question.answeredAt).length,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      nextStep: nextStep?.title || null,
      nextStepKey: nextStep?.key || null,
      nextStepDetail: nextStep?.detail || null,
      nextStepUrl: nextStep?.url || null,
      remainingSteps: steps.filter((step) => !step.done).length,
      totalSteps: steps.length,
      guideSteps: steps,
      scheduledStartAt,
      scheduledEndAt,
    };
  });
}

// Every Albatross the user carries, newest movement first. The Albatrosses
// surface groups these by state; the query stays flat so the grouping rule
// lives in one place on the client and can change without a schema push.
export const allWork = query({
  args: {
    ...callerArgs,
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
    return projectedWorkRows(ctx, userId, limit);
  },
});

/** The one server-owned answer to "what now?", plus separate recovery and attention lanes. */
export const executionSnapshot = query({
  args: { ...callerArgs, limit: v.optional(v.number()), nowMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
    const rows = await projectedWorkRows(ctx, userId, limit);
    return selectExecutionSnapshot(rows satisfies ExecutionWorkRow[], args.nowMs ?? now());
  },
});

async function recentOpenWork(ctx: QueryCtx, limit = 500) {
  const rows = await ctx.db.query('albatrossIntents').withIndex('by_updatedAt').order('desc').take(limit);
  return rows.filter((row) => {
    const state = row.workState || row.status;
    return !['done', 'released', 'archived'].includes(state);
  });
}

/** Passed blocks that still need a human recovery choice. */
export const missedRecoveryCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    const users = [...new Set((await recentOpenWork(ctx, 240)).map((row) => row.userId))].slice(0, 12);
    const candidates = [];
    for (const userId of users) {
      const snapshot = selectExecutionSnapshot(
        (await projectedWorkRows(
          ctx,
          userId,
          60,
          RECOVERY_CARD_READ_BUDGET_PER_USER,
        )) satisfies ExecutionWorkRow[],
        ts,
      );
      for (const move of snapshot.missedMoves.slice(0, 8)) {
        if (!move.scheduledStartAt || !move.scheduledEndAt) continue;
        if (ts - move.scheduledEndAt > MISSED_MOVE_LOOKBACK_MS) continue;
        const workId = ctx.db.normalizeId('albatrossIntents', move.workId);
        if (!workId) continue;
        const lapses = await ctx.db
          .query('albatrossLapses')
          .withIndex('by_work', (q) => q.eq('workId', workId))
          .order('desc')
          .take(20);
        if (lapses.some((lapse) => lapse.plannedAt === move.scheduledStartAt)) continue;
        candidates.push({
          userId,
          workId: move.workId,
          workTitle: move.workTitle,
          stepKey: move.stepKey,
          stepTitle: move.stepTitle,
          scheduledStartAt: move.scheduledStartAt,
          scheduledEndAt: move.scheduledEndAt,
        });
      }
    }
    return candidates.slice(0, 50);
  },
});

/** Shape-aware reminders for Work that has genuinely stopped moving. */
export const stalenessReviewCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    const rows = await recentOpenWork(ctx);
    return rows
      .filter((row) => isStale(row, ts))
      .map((row) => ({
        userId: row.userId,
        workId: String(row._id),
        workTitle: row.title || row.rawText.slice(0, 180),
        updatedAt: row.updatedAt,
      }))
      .slice(0, 100);
  },
});

/** Newly attached proof that has not yet changed the plan. */
export const evidenceReconcileCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    const rows = await recentOpenWork(ctx);
    return rows
      .filter(
        (row) =>
          Boolean(row.lastEvidenceAt) &&
          (row.lastEvidenceReconcileAt || 0) < (row.lastEvidenceAt || 0) &&
          (!row.evidenceReconcileClaimedAt ||
            ts - row.evidenceReconcileClaimedAt >= EVIDENCE_RECONCILE_LEASE_MS),
      )
      .slice(0, 4);
  },
});

export const evidenceReconcileTick = internalAction({
  args: {},
  handler: async (ctx: ActionCtx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[evidence reconcile cron] missing LAB86_MAIL_PUBLIC_URL or internal secret');
      return;
    }
    const refs = (internal as any).albatrossWorkV2;
    const candidates = await ctx.runQuery(refs.evidenceReconcileCandidates, {});
    let completed = 0;
    for (const candidate of candidates) {
      const claim = await ctx.runMutation(refs.beginEvidenceReconcile, { workId: candidate._id });
      if (!claim) continue;
      let ok = false;
      try {
        ok =
          (await fanOutInternalPost(`${appUrl}/api/cron/evidence-reconcile`, secret, [claim], {
            label: 'evidence reconcile cron',
            timeoutMs: 90_000,
            concurrency: 1,
          })) === 1;
        if (ok) completed += 1;
      } finally {
        if (!ok) await ctx.runMutation(refs.releaseEvidenceReconcile, { workId: candidate._id });
      }
    }
    if (candidates.length) {
      console.log(`[evidence reconcile cron] completed ${completed}/${candidates.length}`);
    }
  },
});

export const workDetail = query({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const work = await requireWork(ctx, args.workId, userId);
    const [plan, project, questions, areaLinks, applications, evidence, lapses] = await Promise.all([
      work.latestPlanId ? ctx.db.get(work.latestPlanId) : null,
      work.primaryProjectId ? ctx.db.get(work.primaryProjectId) : null,
      ctx.db
        .query('albatrossWorkQuestions')
        .withIndex('by_work', (q) => q.eq('workId', args.workId))
        .collect(),
      ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_artifact', (q) =>
          q.eq('userId', userId).eq('artifactKind', 'intent').eq('artifactId', String(args.workId)),
        )
        .collect(),
      ctx.db
        .query('albatrossPlanApplications')
        .withIndex('by_user_intent', (q) => q.eq('userId', userId).eq('intentId', String(args.workId)))
        .collect(),
      // Proof that the outcome actually happened. The stored confidence stays
      // here; the client renders the trust ladder in words instead.
      ctx.db
        .query('albatrossEvidence')
        .withIndex('by_user_target', (q) =>
          q.eq('userId', userId).eq('targetKind', 'work').eq('targetId', String(args.workId)),
        )
        .order('desc')
        .take(40),
      ctx.db
        .query('albatrossLapses')
        .withIndex('by_work', (q) => q.eq('workId', args.workId))
        .order('desc')
        .take(20),
    ]);
    const cardIds = (plan?.appliedSteps || []).flatMap((step) => (step.cardId ? [step.cardId] : []));
    const cards = await Promise.all(
      cardIds.map(async (rawId) => {
        const cardId = ctx.db.normalizeId('cards', rawId);
        return cardId ? ctx.db.get(cardId) : null;
      }),
    );
    const completedCardIds = new Set(
      cards.filter((card) => Boolean(card?.completedAt)).map((card) => String(card!._id)),
    );
    const guideSteps = projectedPlanSteps(
      plan,
      completedCardIds,
      work.stepProgress as StepProgressEntry[] | undefined,
    );
    const { scheduledStartAt, scheduledEndAt } = scheduledWindow(plan);
    const application = applications.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    return {
      work,
      plan,
      project,
      questions,
      areaLinks,
      application,
      execution: {
        currentStep: guideSteps.find((step) => !step.done) || null,
        guideSteps,
        remainingSteps: guideSteps.filter((step) => !step.done).length,
        totalSteps: guideSteps.length,
        scheduledStartAt,
        scheduledEndAt,
      },
      lapses,
      contract: work.contract ?? null,
      evidence: evidence.map((row) => ({
        _id: String(row._id),
        title: row.title,
        summary: row.summary ?? null,
        claim: row.claim ?? null,
        limits: row.limits ?? null,
        url: row.url ?? null,
        sourceKind: row.sourceKind,
        occurredAt: row.occurredAt,
        trust: row.trust,
      })),
    };
  },
});

export const saveAreaBrief = mutation({
  args: {
    ...callerArgs,
    areaId: v.id('areas'),
    status: v.union(v.literal('generating'), v.literal('ready'), v.literal('error')),
    lede: v.string(),
    summary: v.string(),
    artifactHtml: v.optional(v.string()),
    document: v.optional(v.any()),
    artifactSource: v.optional(v.string()),
    sourceRefs: v.optional(v.array(sourceRefValidator)),
    basedOnRevision: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireArea(ctx, args.areaId, userId);
    const existing = await ctx.db
      .query('albatrossAreaBriefs')
      .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', args.areaId))
      .unique();
    const ts = now();
    const artifactHtml = areaArtifactHtmlForWrite(args.status, args.artifactHtml, existing?.artifactHtml);
    const doc = {
      userId,
      areaId: args.areaId,
      status: args.status,
      lede: args.lede.slice(0, 600),
      summary: args.summary.slice(0, 2_000),
      artifactHtml,
      document: args.document ?? existing?.document,
      artifactSource: args.artifactSource ?? existing?.artifactSource,
      sourceRefs: args.sourceRefs || [],
      basedOnRevision: args.basedOnRevision.slice(0, 160),
      generatedAt: args.status === 'ready' ? ts : existing?.generatedAt,
      error: bounded(args.error, 500),
      updatedAt: ts,
    };
    // Never truncate a complete document: doing so can persist syntactically
    // broken HTML and replace the last good edition. Measure the whole record,
    // including metadata/source refs, and reject before any patch or insert.
    assertAreaArtifactDocumentSize(existing ? doc : { ...doc, createdAt: ts });
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return ctx.db.insert('albatrossAreaBriefs', { ...doc, createdAt: ts });
  },
});

export const migrateLegacyBatch = internalMutation({
  args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('albatrossIntents')
      .paginate({ cursor: args.cursor ?? null, numItems: Math.min(Math.max(args.limit ?? 50, 1), 100) });
    const ts = now();
    for (const work of page.page) {
      const patch: Record<string, unknown> = {};
      if (!work.stepProgressMigratedAt) {
        const historicalPlans = await ctx.db
          .query('albatrossIntentPlans')
          .withIndex('by_user_intent', (q) => q.eq('userId', work.userId).eq('intentId', work._id))
          .order('desc')
          .take(20);
        let migratedProgress = mergeStepProgress(
          work.stepProgress as StepProgressEntry[] | undefined,
          historicalPlans.flatMap((plan) => progressFromPlanCompletions(plan)),
        );
        const currentPlan = historicalPlans.find((plan) => plan._id === work.latestPlanId);
        if (currentPlan) {
          const completedCards: StepProgressEntry[] = [];
          for (const step of planStepsForProgress(currentPlan)) {
            if (!step.cardId) continue;
            const cardId = ctx.db.normalizeId('cards', step.cardId);
            const card = cardId ? await ctx.db.get(cardId) : null;
            if (!card?.completedAt || card.userId !== work.userId) continue;
            completedCards.push({
              identity: step.identity,
              actionKey: step.actionKey,
              kind: step.action.kind || 'task',
              title: step.action.title!.trim().slice(0, 240),
              cardId: step.cardId,
              completedAt: card.completedAt,
              source: 'task',
            });
          }
          migratedProgress = mergeStepProgress(migratedProgress, completedCards);
        }
        patch.stepProgress = migratedProgress;
        patch.stepProgressMigratedAt = ts;
      }
      if (!work.captureId) {
        const captureId = await ctx.db.insert('albatrossCaptures', {
          userId: work.userId,
          rawText: work.rawText,
          transcript: work.transcript,
          source: work.source,
          status: 'split',
          workIds: [work._id],
          createdAt: work.createdAt,
          updatedAt: ts,
        });
        patch.captureId = captureId;
      }
      if (!work.workState)
        patch.workState =
          work.status === 'done' ? 'done' : work.status === 'archived' ? 'archived' : 'active';
      if (!work.agentState) {
        patch.agentState =
          work.status === 'planning'
            ? 'researching'
            : work.status === 'needs_answers'
              ? 'needs_input'
              : 'idle';
      }
      if (!work.conversationId) patch.conversationId = `work_${String(work._id)}`;
      if (!work.primaryAreaId && work.areaId) {
        const areaId = ctx.db.normalizeId('areas', work.areaId);
        if (areaId) {
          patch.primaryAreaId = areaId;
          const existingLinks = await ctx.db
            .query('areaArtifactLinks')
            .withIndex('by_user_artifact', (q) =>
              q.eq('userId', work.userId).eq('artifactKind', 'intent').eq('artifactId', String(work._id)),
            )
            .collect();
          if (!existingLinks.some((link) => link.areaId === areaId)) {
            await ctx.db.insert('areaArtifactLinks', {
              userId: work.userId,
              areaId,
              artifactKind: 'intent',
              artifactId: String(work._id),
              role: 'primary',
              status: 'candidate',
              confidence: 0.95,
              reason: 'Migrated from the Work item primary Area.',
              sourceRefs: [{ kind: 'intent', id: String(work._id), label: work.title }],
              confirmationRefs: [],
              createdAt: work.createdAt,
              updatedAt: ts,
            });
          }
        }
      }
      if (!work.primaryProjectId) {
        const project = await ctx.db
          .query('albatrossProjects')
          .withIndex('by_user_source_intent', (q) =>
            q.eq('userId', work.userId).eq('sourceIntentId', String(work._id)),
          )
          .first();
        if (project) patch.primaryProjectId = project._id;
      }
      const existingQuestions = await ctx.db
        .query('albatrossWorkQuestions')
        .withIndex('by_work', (q) => q.eq('workId', work._id))
        .collect();
      const knownLegacyIds = new Set(
        existingQuestions.map((question) => question.legacyQuestionId).filter(Boolean),
      );
      for (const question of work.questions || []) {
        if (question.answer || knownLegacyIds.has(question.id)) continue;
        await ctx.db.insert('albatrossWorkQuestions', {
          userId: work.userId,
          workId: work._id,
          dedupeKey: questionDedupeKey({
            workId: String(work._id),
            kind: 'clarification',
            prompt: question.prompt,
          }),
          legacyQuestionId: question.id,
          kind: 'clarification',
          prompt: question.prompt,
          reason: 'Migrated from the current plan question.',
          options: question.options?.map((option) => ({
            id: option.id,
            label: option.title,
            description: option.detail,
          })),
          status: 'pending',
          sourceRefs: [],
          createdAt: work.updatedAt,
          updatedAt: ts,
        });
      }
      if (Object.keys(patch).length) await ctx.db.patch(work._id, { ...patch, updatedAt: ts });
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.albatrossWorkV2.migrateLegacyBatch, {
        cursor: page.continueCursor,
        limit: args.limit,
      });
    return { migrated: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});
