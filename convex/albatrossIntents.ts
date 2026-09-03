import { v } from 'convex/values';
import { conductorMayMove } from '../lib/albatross/conductor-quiet';
import { planNeedsConductor } from '../lib/albatross/execution';
import { bindPlanDocumentSteps } from '../lib/albatross/plan-frontier';
import {
  mergeStepProgress,
  progressFromPlanCompletions,
  type StepProgressEntry,
} from '../lib/albatross/step-progress';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { normalizeSourceRefs, normalizeText } from './albatrossModel';
import { recordCompletionEvent } from './albatrossWork';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

const RAW_TEXT_MAX = 20_000;
const ARTIFACT_HTML_MAX = 400_000;

const intentStatusValidator = v.union(
  v.literal('captured'),
  v.literal('planning'),
  v.literal('needs_answers'),
  v.literal('ready'),
  v.literal('applied'),
  v.literal('done'),
  v.literal('archived'),
);

const questionOptionValidator = v.object({
  id: v.string(),
  title: v.string(),
  detail: v.optional(v.string()),
  address: v.optional(v.string()),
  hoursText: v.optional(v.string()),
  website: v.optional(v.string()),
});

const questionValidator = v.object({
  id: v.string(),
  prompt: v.string(),
  options: v.optional(v.array(questionOptionValidator)),
  answer: v.optional(v.string()),
  answeredOptionId: v.optional(v.string()),
  answeredAt: v.optional(v.number()),
});

const physicalActionValidator = v.object({
  title: v.string(),
  detail: v.optional(v.string()),
  url: v.optional(v.string()),
  stepMode: v.optional(
    v.union(
      v.literal('agent_does'),
      v.literal('agent_drafts'),
      v.literal('you_do_observed'),
      v.literal('you_do_offline'),
    ),
  ),
  doneWhen: v.optional(v.string()),
  evidence: v.optional(
    v.object({
      kind: v.union(
        v.literal('mail_confirmation'),
        v.literal('artifact'),
        v.literal('observation'),
        v.literal('attestation'),
      ),
      hint: v.optional(v.string()),
    }),
  ),
});

const placeValidator = v.object({
  name: v.string(),
  detail: v.optional(v.string()),
  address: v.optional(v.string()),
  hoursText: v.optional(v.string()),
  phone: v.optional(v.string()),
  website: v.optional(v.string()),
  mapsQuery: v.optional(v.string()),
});

// Recorded at apply time: which plan step ("step-1"…) became which artifact.
// Card-backed steps carry the board cardId so the plan dossier's task cards
// can toggle completion on the real board; calendar/draft steps carry the
// created eventId/draftId for provenance.
const appliedStepValidator = v.object({
  stepKey: v.string(),
  kind: v.string(),
  cardId: v.optional(v.string()),
  eventId: v.optional(v.string()),
  draftId: v.optional(v.string()),
});

const outcomeContractValidator = v.object({
  outcome: v.string(),
  proofs: v.array(v.object({ id: v.string(), what: v.string() })),
  closeWhen: v.union(
    v.literal('action_succeeded'),
    v.literal('outcome_likely'),
    v.literal('outcome_confirmed'),
    v.literal('never_automatically'),
  ),
  contradictions: v.optional(v.array(v.string())),
});

const sourceRefValidator = v.object({
  kind: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
  accountId: v.optional(v.string()),
  url: v.optional(v.string()),
});

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

function bounded(value: string | undefined, max: number, fallback = '') {
  if (value === undefined) return undefined;
  return normalizeText(value, fallback).slice(0, max);
}

function normalizedProofRequirement(value: string) {
  return normalizeText(value, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Raw dumps are always preserved (epic non-negotiable #6): trim the ends and cap
// length, but never collapse internal whitespace or line breaks the user typed.
function preserveRaw(value: string, max = RAW_TEXT_MAX): string {
  return value.replace(/^\s+|\s+$/g, '').slice(0, max);
}

async function requireIntent(ctx: QueryCtx | MutationCtx, intentId: Id<'albatrossIntents'>, userId: string) {
  const intent = await ctx.db.get(intentId);
  if (!intent || intent.userId !== userId) throw new Error('Intent not found.');
  return intent;
}

async function requirePlan(ctx: QueryCtx | MutationCtx, planId: Id<'albatrossIntentPlans'>, userId: string) {
  const plan = await ctx.db.get(planId);
  if (!plan || plan.userId !== userId) throw new Error('Plan not found.');
  return plan;
}

async function normalizeIntentAreaId(
  ctx: MutationCtx,
  userId: string,
  areaId: string | undefined,
): Promise<string | undefined> {
  const raw = bounded(areaId, 160);
  if (!raw) return undefined;
  const docId = ctx.db.normalizeId('areas', raw);
  if (!docId) throw new Error('Area not found.');
  const area = await ctx.db.get(docId);
  if (!area || area.userId !== userId || area.status !== 'active') throw new Error('Area not found.');
  return String(area._id);
}

export const createIntent = mutation({
  args: {
    ...callerArgs,
    externalId: v.optional(v.string()),
    rawText: v.string(),
    transcript: v.optional(v.string()),
    source: v.union(v.literal('text'), v.literal('voice'), v.literal('chat'), v.literal('import')),
    title: v.optional(v.string()),
    areaId: v.optional(v.string()),
    replaceRawText: v.optional(v.boolean()),
    returnMetadata: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rawText = preserveRaw(args.rawText);
    if (!rawText) throw new Error('Intent text is required.');
    const externalId = bounded(args.externalId, 160);
    if (externalId) {
      const existing = await ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_external', (q) => q.eq('userId', userId).eq('externalId', externalId))
        .unique();
      if (existing) {
        const changed = args.replaceRawText === true && existing.rawText !== rawText;
        const revivingArchivedWork =
          args.replaceRawText === true &&
          (existing.status === 'archived' || existing.workState === 'archived');
        await ctx.db.patch(existing._id, {
          ...(args.replaceRawText
            ? {
                rawText,
                title: bounded(args.title, 180) || existing.title,
                status:
                  existing.status === 'done' || existing.status === 'archived' ? 'ready' : existing.status,
                workState:
                  existing.workState === 'done' ||
                  existing.workState === 'released' ||
                  existing.workState === 'archived'
                    ? ('active' as const)
                    : existing.workState || ('active' as const),
                ...(revivingArchivedWork
                  ? {
                      releaseReason: undefined,
                      releaseProposedBy: undefined,
                      releasedAt: undefined,
                      reviewAt: undefined,
                    }
                  : {}),
              }
            : {}),
          ...(!existing.areaId ? { areaId: await normalizeIntentAreaId(ctx, userId, args.areaId) } : {}),
          areaAutoAssigned: undefined,
          conversationId: existing.conversationId || `work_${String(existing._id)}`,
          ...(!args.replaceRawText ? { workState: existing.workState || ('active' as const) } : {}),
          agentState: existing.agentState || 'researching',
          updatedAt: now(),
        });
        return args.returnMetadata ? { workId: existing._id, changed } : existing._id;
      }
    }
    const ts = now();
    const areaId = await normalizeIntentAreaId(ctx, userId, args.areaId);
    const intentId = await ctx.db.insert('albatrossIntents', {
      userId,
      externalId,
      rawText,
      transcript: args.transcript ? preserveRaw(args.transcript) : undefined,
      source: args.source,
      title: bounded(args.title, 180),
      status: 'captured',
      areaId,
      areaAutoAssigned: undefined,
      workState: 'active',
      agentState: 'researching',
      lastAgentRunAt: ts,
      // A capture is a user touch.
      lastUserTouchAt: ts,
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.patch(intentId, { conversationId: `work_${String(intentId)}` });
    return args.returnMetadata ? { workId: intentId, changed: true } : intentId;
  },
});

/**
 * External ids form families, for example one check-in's tomorrow siblings.
 * A prefix scan on the exact-id index finds the whole family so a caller can
 * reconcile instead of duplicate. Rows report whether work has started; the
 * caller must never remove started work.
 */
export const listByExternalPrefix = query({
  args: {
    ...callerArgs,
    prefix: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const prefix = bounded(args.prefix, 160);
    if (!prefix) return [];
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 24), 1), 40);
    const rows = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_user_external', (q) =>
        q.eq('userId', userId).gte('externalId', prefix).lt('externalId', `${prefix}\uffff`),
      )
      .take(limit);
    return rows.map((row) => ({
      _id: row._id,
      externalId: row.externalId ?? null,
      title: row.title,
      workState: row.workState ?? 'active',
      started: (row.stepProgress?.length ?? 0) > 0 || Boolean(row.lastEvidenceAt),
    }));
  },
});

export const listIntents = query({
  args: {
    ...callerArgs,
    status: v.optional(intentStatusValidator),
    includeArchived: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    if (args.status) {
      return ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_status', (q) => q.eq('userId', userId).eq('status', args.status!))
        .order('desc')
        .take(limit);
    }
    const rows = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_user_updatedAt', (q) => q.eq('userId', userId))
      .order('desc')
      .take(limit + 50);
    const visible = args.includeArchived ? rows : rows.filter((row) => row.status !== 'archived');
    return visible.slice(0, limit);
  },
});

export const getIntentWorkbench = query({
  args: { ...callerArgs, intentId: v.id('albatrossIntents') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const intent = await requireIntent(ctx, args.intentId, userId);
    const workbenchPlanId = intent.pendingPlanId || intent.latestPlanId;
    const plan = workbenchPlanId ? await ctx.db.get(workbenchPlanId) : null;
    return { intent, plan: plan && plan.userId === userId ? plan : null };
  },
});

export const updateIntent = mutation({
  args: {
    ...callerArgs,
    intentId: v.id('albatrossIntents'),
    title: v.optional(v.string()),
    kind: v.optional(v.string()),
    areaId: v.optional(v.string()),
    priority: v.optional(v.number()),
    status: v.optional(intentStatusValidator),
    planError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const intent = await requireIntent(ctx, args.intentId, userId);
    const ts = now();
    const patch: Record<string, unknown> = { updatedAt: ts };
    if (args.title !== undefined) patch.title = bounded(args.title, 180);
    if (args.kind !== undefined) patch.kind = bounded(args.kind, 40);
    if (args.areaId !== undefined) {
      patch.areaId = await normalizeIntentAreaId(ctx, userId, args.areaId);
      // The user picked (or explicitly cleared to Personal) — stop auto-sorting.
      patch.areaAutoAssigned = false;
    }
    if (args.priority !== undefined) patch.priority = Math.min(Math.max(Math.round(args.priority), 1), 3);
    if (args.status !== undefined) {
      patch.status = args.status;
      if (args.status === 'applied') patch.appliedAt = ts;
    }
    if (args.planError !== undefined) patch.planError = bounded(args.planError, 500) || undefined;
    await ctx.db.patch(args.intentId, patch);
    // Completion history (issue #87/#18): only a real transition into 'done'
    // records an event; re-saving an already-done intent does not.
    if (args.status === 'done' && intent.status !== 'done') {
      await recordCompletionEvent(ctx, {
        userId,
        artifactKind: 'intent',
        artifactId: String(args.intentId),
        completedAt: ts,
        intentId: String(args.intentId),
        areaId: args.areaId !== undefined ? bounded(args.areaId, 160) || undefined : intent.areaId,
      });
    }
    return args.intentId;
  },
});

// Intents still carrying a defaulted (Personal) area — the intent half of the
// classifier's work queue. Internal-secret-gated: only the cron path reads it.
export const listAutoAssigned = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
    // Indexed on the flag itself: a flagged intent kept for retry (model
    // outage) can never fall out of a recency window and strand.
    const rows = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_user_autoassigned', (q) => q.eq('userId', args.userId).eq('areaAutoAssigned', true))
      .order('desc')
      .take(limit + 50);
    return rows
      .filter((row) => row.status !== 'archived')
      .slice(0, limit)
      .map((row) => ({
        intentId: String(row._id),
        title: row.title ?? null,
        rawText: row.rawText.slice(0, 500),
        source: row.source,
      }));
  },
});

// Apply fast-model area verdicts to auto-assigned intents. A verdict with an
// areaId re-homes the intent (candidate trust — the link records the model's
// reasoning); without one the intent stays in Personal. Either way the
// auto-assigned flag clears so the intent is classified exactly once. Intents
// the user re-homed between the read and this write are left untouched.
export const applyAreaVerdicts = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    verdicts: v.array(
      v.object({
        intentId: v.id('albatrossIntents'),
        areaId: v.optional(v.id('areas')),
        reason: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const userId = args.userId;
    const ts = now();
    let assigned = 0;
    let kept = 0;
    let skipped = 0;
    for (const verdict of args.verdicts.slice(0, 50)) {
      const intent = await ctx.db.get(verdict.intentId);
      if (!intent || intent.userId !== userId || intent.areaAutoAssigned !== true) {
        skipped += 1;
        continue;
      }
      if (!verdict.areaId) {
        await ctx.db.patch(intent._id, { areaAutoAssigned: false, updatedAt: ts });
        kept += 1;
        continue;
      }
      const area = await ctx.db.get(verdict.areaId);
      if (!area || area.userId !== userId || area.status !== 'active') {
        skipped += 1;
        continue;
      }
      await ctx.db.patch(intent._id, {
        areaId: String(area._id),
        primaryAreaId: area._id,
        areaAutoAssigned: false,
        updatedAt: ts,
      });
      const existingLink = await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_artifact', (q) =>
          q.eq('userId', userId).eq('artifactKind', 'intent').eq('artifactId', String(intent._id)),
        )
        .collect();
      if (!existingLink.some((row) => row.areaId === area._id)) {
        await ctx.db.insert('areaArtifactLinks', {
          userId,
          areaId: area._id,
          artifactKind: 'intent',
          artifactId: String(intent._id),
          role: 'primary',
          status: 'candidate',
          confidence: 0.6,
          reason: bounded(verdict.reason, 700) || 'fast-model area classification',
          sourceRefs: [{ kind: 'system', id: 'area-classifier', label: 'Automatic intent sorting' }],
          confirmationRefs: [],
          createdAt: ts,
          updatedAt: ts,
        });
      }
      assigned += 1;
    }
    return { assigned, kept, skipped };
  },
});

export const answerQuestions = mutation({
  args: {
    ...callerArgs,
    intentId: v.id('albatrossIntents'),
    answers: v.array(
      v.object({ id: v.string(), answer: v.string(), answeredOptionId: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const intent = await requireIntent(ctx, args.intentId, userId);
    const ts = now();
    const byId = new Map(
      args.answers.map((entry) => [
        entry.id,
        { answer: preserveRaw(entry.answer, 2000), answeredOptionId: entry.answeredOptionId },
      ]),
    );
    const questions = (intent.questions || []).map((question) => {
      const entry = byId.get(question.id);
      return entry
        ? {
            ...question,
            answer: entry.answer,
            answeredOptionId: entry.answeredOptionId,
            answeredAt: ts,
          }
        : question;
    });
    const unanswered = questions.some((question) => !question.answer);
    await ctx.db.patch(args.intentId, {
      questions,
      status: unanswered ? 'needs_answers' : intent.status === 'needs_answers' ? 'captured' : intent.status,
      updatedAt: ts,
    });
    return { questions, unanswered };
  },
});

export const savePlan = mutation({
  args: {
    ...callerArgs,
    intentId: v.id('albatrossIntents'),
    outcome: v.optional(v.string()),
    summary: v.optional(v.string()),
    title: v.optional(v.string()),
    kind: v.optional(v.string()),
    shape: v.optional(
      v.union(
        v.literal('quick'),
        v.literal('project'),
        v.literal('practice'),
        v.literal('decision'),
        v.literal('monitor'),
        v.literal('recurring'),
      ),
    ),
    areaId: v.optional(v.string()),
    priority: v.optional(v.number()),
    questions: v.optional(v.array(questionValidator)),
    proposedProjectTitle: v.optional(v.string()),
    digitalActions: v.array(v.any()),
    physicalActions: v.array(physicalActionValidator),
    assumptions: v.array(v.string()),
    sourceRefs: v.array(sourceRefValidator),
    artifactHtml: v.optional(v.string()),
    document: v.optional(v.any()),
    artifactSource: v.optional(v.string()),
    artifactTitle: v.optional(v.string()),
    model: v.optional(v.string()),
    mapQuery: v.optional(v.string()),
    places: v.optional(v.array(placeValidator)),
    contract: v.optional(outcomeContractValidator),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const intent = await requireIntent(ctx, args.intentId, userId);
    const ts = now();
    const openQuestions = (args.questions || []).filter((question) => !question.answer);
    const planStatus = openQuestions.length ? 'needs_answers' : 'ready';
    const previousProofs = new Map(
      (intent.contract?.proofs || []).map(
        (proof) => [normalizedProofRequirement(proof.what), proof] as const,
      ),
    );
    const nextContract = args.contract
      ? {
          outcome: bounded(args.contract.outcome, 600, 'Outcome')!,
          proofs: args.contract.proofs.slice(0, 12).map((proof, index) => {
            const what = bounded(proof.what, 300, 'Something confirms it happened')!;
            const settled = previousProofs.get(normalizedProofRequirement(what));
            return {
              id: bounded(proof.id, 120, `proof-${index + 1}`)!,
              what,
              ...(settled?.satisfiedAt
                ? { satisfiedBy: settled.satisfiedBy, satisfiedAt: settled.satisfiedAt }
                : {}),
            };
          }),
          closeWhen: args.contract.closeWhen,
          contradictions: args.contract.contradictions
            ?.slice(0, 12)
            .map((row) => bounded(row, 300)!)
            .filter(Boolean),
          updatedAt: ts,
        }
      : intent.contract;

    const [visiblePlan, pendingPlan] = await Promise.all([
      intent.latestPlanId ? ctx.db.get(intent.latestPlanId) : null,
      intent.pendingPlanId ? ctx.db.get(intent.pendingPlanId) : null,
    ]);
    const previousCandidate = pendingPlan || (visiblePlan?.status !== 'applied' ? visiblePlan : null);
    if (previousCandidate && previousCandidate.userId === userId && previousCandidate.status !== 'applied') {
      await ctx.db.patch(previousCandidate._id, { status: 'superseded', updatedAt: ts });
    }
    const carriedProgress = mergeStepProgress(
      intent.stepProgress as StepProgressEntry[] | undefined,
      [visiblePlan, pendingPlan]
        .filter((plan): plan is NonNullable<typeof plan> => Boolean(plan && plan.userId === userId))
        .flatMap((plan) => progressFromPlanCompletions(plan)),
    );
    const preserveLastGood = Boolean(
      visiblePlan && visiblePlan.userId === userId && visiblePlan.status === 'applied',
    );

    const planId = await ctx.db.insert('albatrossIntentPlans', {
      userId,
      intentId: args.intentId,
      status: planStatus,
      outcome: bounded(args.outcome, 1200),
      summary: bounded(args.summary, 2000),
      proposedProjectTitle: bounded(args.proposedProjectTitle, 180),
      digitalActions: args.digitalActions,
      physicalActions: args.physicalActions.map((action) => ({
        title: bounded(action.title, 200, 'Step')!,
        detail: bounded(action.detail, 1200),
        url: bounded(action.url, 500),
        stepMode: action.stepMode,
        doneWhen: bounded(action.doneWhen, 300),
        evidence: action.evidence
          ? { kind: action.evidence.kind, hint: bounded(action.evidence.hint, 300) }
          : undefined,
      })),
      assumptions: args.assumptions.map((assumption) => bounded(assumption, 500)!).filter(Boolean),
      sourceRefs: normalizeSourceRefs(args.sourceRefs),
      artifactHtml: args.artifactHtml ? args.artifactHtml.slice(0, ARTIFACT_HTML_MAX) : undefined,
      document: args.document,
      artifactSource: args.artifactSource,
      artifactTitle: bounded(args.artifactTitle, 180),
      model: bounded(args.model, 120),
      mapQuery: bounded(args.mapQuery, 200),
      places: args.places?.map((place) => ({
        name: bounded(place.name, 160, 'Place')!,
        detail: bounded(place.detail, 300),
        address: bounded(place.address, 300),
        hoursText: bounded(place.hoursText, 300),
        phone: bounded(place.phone, 40),
        website: bounded(place.website, 500),
        mapsQuery: bounded(place.mapsQuery, 200),
      })),
      createdAt: ts,
      updatedAt: ts,
    });

    // A plan with an expected mail receipt arms the mail watcher; a revision
    // without one disarms it.
    const hasMailStep = [...args.digitalActions, ...args.physicalActions].some(
      (action: any) => action?.evidence?.kind === 'mail_confirmation',
    );
    await ctx.db.patch(args.intentId, {
      status: planStatus,
      mailWatchAt: hasMailStep ? (intent.mailWatchAt ?? ts) : undefined,
      ...(hasMailStep ? {} : { mailWatchClaimedAt: undefined }),
      title: bounded(args.title, 180) ?? intent.title,
      kind: args.kind !== undefined ? bounded(args.kind, 40) : intent.kind,
      // The planner saw research the capture splitter never had, so its
      // shape verdict overwrites the capture guess when it offers one.
      shape: args.shape ?? intent.shape,
      areaId:
        args.areaId !== undefined ? await normalizeIntentAreaId(ctx, userId, args.areaId) : intent.areaId,
      priority:
        args.priority !== undefined ? Math.min(Math.max(Math.round(args.priority), 1), 3) : intent.priority,
      questions: args.questions ?? intent.questions,
      contract: nextContract,
      latestPlanId: preserveLastGood ? visiblePlan!._id : planId,
      pendingPlanId: preserveLastGood ? planId : undefined,
      ...(carriedProgress.length ? { stepProgress: carriedProgress } : {}),
      planError: undefined,
      planAttempts: 0,
      updatedAt: ts,
    });

    return planId;
  },
});

// --- Plan reconcile: unstick generations killed by deploys/restarts. ---
// A generation that dies between "status: planning" and savePlan leaves the
// intent planning forever with no planError (SIGTERM skips the catch). The
// cron re-kicks stale ones through the Next app, then gives up gracefully.

export const PLAN_STALE_AFTER_MS = 5 * 60_000;
export const PLAN_MAX_ATTEMPTS = 3;

export const stalePlanningIntents = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = now() - PLAN_STALE_AFTER_MS;
    // Cross-user scan; the intents table is small and 'planning' is a
    // transient state, so a filtered take stays cheap.
    const rows = await ctx.db
      .query('albatrossIntents')
      .filter((q) => q.eq(q.field('status'), 'planning'))
      .take(100);
    return rows
      .filter((row) => row.updatedAt < cutoff)
      .slice(0, 25)
      .map((row) => ({
        intentId: row._id,
        userId: row.userId,
        attempts: row.planAttempts ?? 0,
      }));
  },
});

// Marks one reconcile attempt (bumps the counter and refreshes updatedAt so
// the next tick does not double-kick while a retry is still running).
export const beginPlanReconcile = internalMutation({
  args: { intentId: v.id('albatrossIntents') },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.status !== 'planning') return null;
    const attempts = (intent.planAttempts ?? 0) + 1;
    await ctx.db.patch(args.intentId, { planAttempts: attempts, updatedAt: now() });
    return attempts;
  },
});

// Terminal give-up: surface the interruption instead of spinning forever.
export const failStalePlan = internalMutation({
  args: { intentId: v.id('albatrossIntents') },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    if (!intent || intent.status !== 'planning') return;
    const unanswered = (intent.questions ?? []).some((question) => !question.answer);
    await ctx.db.patch(args.intentId, {
      status: unanswered ? 'needs_answers' : 'captured',
      planError: 'Planning was interrupted. Regenerate to try again.',
      updatedAt: now(),
    });
  },
});

export const planReconcileTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[plan-reconcile cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    const stale = await ctx.runQuery(internal.albatrossIntents.stalePlanningIntents, {});
    if (!stale.length) return;
    const retry: Array<{ userId: string; intentId: string }> = [];
    for (const row of stale) {
      if (row.attempts >= PLAN_MAX_ATTEMPTS) {
        await ctx.runMutation(internal.albatrossIntents.failStalePlan, { intentId: row.intentId });
        continue;
      }
      const attempts = await ctx.runMutation(internal.albatrossIntents.beginPlanReconcile, {
        intentId: row.intentId,
      });
      if (attempts !== null) retry.push({ userId: row.userId, intentId: String(row.intentId) });
    }
    if (!retry.length) {
      console.log(`[plan-reconcile cron] ${stale.length} stale, all past max attempts`);
      return;
    }
    const ok = await fanOutInternalPost(`${appUrl}/api/cron/plan-reconcile`, secret, retry, {
      label: 'plan-reconcile cron',
      timeoutMs: 240_000,
      concurrency: 2,
    });
    console.log(`[plan-reconcile cron] re-kicked ${ok}/${retry.length} stale plans`);
  },
});

const CONDUCTOR_RETRY_AFTER_MS = 6 * 60 * 60_000;
const CONDUCTOR_IN_FLIGHT_MS = 5 * 60_000;

/** Find active Work whose plan has a concrete step but no calendar block. */
export const conductorCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    // Order by the lease so each tick moves claimed rows behind untouched
    // candidates. A creation-time window would starve older Work forever once
    // the table grew past its fixed limit.
    const rows = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_work_state_conductor', (q) => q.eq('workState', 'active'))
      .take(250);
    const open = rows.filter((row) => {
      const state = row.workState || (['done', 'archived'].includes(row.status) ? row.status : 'active');
      if (state !== 'active') return false;
      if (row.planError || row.status === 'needs_answers') return false;
      if ((row.questions || []).some((question) => !question.answer)) return false;
      // The quiet rule: dormant Work sleeps, and untouched Work is left alone.
      if (!conductorMayMove(row, 'conductor', ts)) return false;
      if (row.lastConductorAt && row.lastConductorAt > ts - CONDUCTOR_RETRY_AFTER_MS) return false;
      if (
        ['researching', 'applying'].includes(row.agentState || '') &&
        (row.lastAgentRunAt || row.updatedAt) > ts - CONDUCTOR_IN_FLIGHT_MS
      )
        return false;
      return row.status !== 'planning';
    });
    const withPlans = await Promise.all(
      open.map(async (row) => ({ row, plan: row.latestPlanId ? await ctx.db.get(row.latestPlanId) : null })),
    );
    return (
      withPlans
        .filter(({ row, plan }) => {
          if (plan && plan.userId !== row.userId) return false;
          return planNeedsConductor(plan);
        })
        // Each advance may use the full four-minute app timeout. Keep one tick
        // bounded to four concurrent requests so it always fits the cron cadence.
        .slice(0, 4)
        .map(({ row }) => ({ workId: row._id, userId: row.userId }))
    );
  },
});

/** Acquire the conductor lease after candidate selection so overlapping ticks cannot double-run. */
export const beginConductor = internalMutation({
  args: { workId: v.id('albatrossIntents') },
  handler: async (ctx, args) => {
    const work = await ctx.db.get(args.workId);
    if (!work) return false;
    const ts = now();
    if (work.lastConductorAt && work.lastConductorAt > ts - CONDUCTOR_RETRY_AFTER_MS) return false;
    await ctx.db.patch(args.workId, { lastConductorAt: ts, updatedAt: ts });
    return true;
  },
});

/** Release failed conductor claims immediately instead of hiding them for six hours. */
export const releaseConductor = internalMutation({
  args: { workIds: v.array(v.id('albatrossIntents')) },
  handler: async (ctx, args) => {
    for (const workId of args.workIds.slice(0, 4)) {
      const work = await ctx.db.get(workId);
      if (work) await ctx.db.patch(workId, { lastConductorAt: undefined });
    }
  },
});

export const conductorTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[work-conductor cron] missing LAB86_MAIL_PUBLIC_URL or internal secret');
      return;
    }
    // Backfill the first legacy page before relying on the workState index;
    // the mutation schedules the remaining pages until the migration is done.
    await ctx.runMutation(internal.albatrossWorkV2.migrateLegacyBatch, { limit: 100 });
    const candidates = await ctx.runQuery(internal.albatrossIntents.conductorCandidates, {});
    const claimed: Array<{ userId: string; workId: Id<'albatrossIntents'> }> = [];
    for (const candidate of candidates) {
      const ok = await ctx.runMutation(internal.albatrossIntents.beginConductor, {
        workId: candidate.workId,
      });
      if (ok) claimed.push({ userId: candidate.userId, workId: candidate.workId });
    }
    if (!claimed.length) return;
    const results = await Promise.all(
      claimed.map(
        async (candidate) =>
          (await fanOutInternalPost(`${appUrl}/api/cron/work-conductor`, secret, [candidate], {
            label: 'work-conductor cron',
            timeoutMs: 240_000,
            concurrency: 1,
          })) === 1,
      ),
    );
    const failed = claimed.filter((_, index) => !results[index]);
    if (failed.length) {
      await ctx.runMutation(internal.albatrossIntents.releaseConductor, {
        workIds: failed.map((row) => row.workId),
      });
    }
    const completed = results.filter(Boolean).length;
    console.log(`[work-conductor cron] advanced ${completed}/${claimed.length} Work items`);
  },
});

export const markPlanApplied = mutation({
  args: {
    ...callerArgs,
    planId: v.id('albatrossIntentPlans'),
    applicationId: v.optional(v.string()),
    appliedSteps: v.optional(v.array(appliedStepValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const plan = await requirePlan(ctx, args.planId, userId);
    const intent = await ctx.db.get(plan.intentId);
    if (!intent || intent.userId !== userId) throw new Error('Intent not found.');
    if (intent.pendingPlanId && intent.pendingPlanId !== plan._id) {
      throw new Error('A newer plan revision is waiting to be applied.');
    }
    if (plan.status === 'superseded') {
      throw new Error('This plan revision was replaced by a newer one.');
    }
    const ts = now();
    // Apply turned plan steps into real cards. Bind the document's keyed
    // checklist items to them so every checkbox is the live task record.
    const boundDocument = args.appliedSteps?.length
      ? bindPlanDocumentSteps(plan.document, args.appliedSteps)
      : { document: plan.document, bound: 0 };
    await ctx.db.patch(args.planId, {
      status: 'applied',
      appliedApplicationId: bounded(args.applicationId, 180),
      ...(boundDocument.bound ? { document: boundDocument.document } : {}),
      ...(args.appliedSteps
        ? {
            appliedSteps: args.appliedSteps.slice(0, 60).map((step) => ({
              stepKey: step.stepKey.slice(0, 80),
              kind: step.kind.slice(0, 40),
              cardId: step.cardId ? step.cardId.slice(0, 120) : undefined,
              eventId: step.eventId ? step.eventId.slice(0, 240) : undefined,
              draftId: step.draftId ? step.draftId.slice(0, 240) : undefined,
            })),
          }
        : {}),
      appliedAt: ts,
      updatedAt: ts,
    });
    await ctx.db.patch(plan.intentId, {
      status: 'applied',
      latestPlanId: plan._id,
      pendingPlanId: undefined,
      appliedAt: ts,
      updatedAt: ts,
    });
    // Completion history (issue #87/#18): applying a plan is the completion of
    // the intent_plan artifact. Only the first apply records an event.
    if (plan.status !== 'applied') {
      await recordCompletionEvent(ctx, {
        userId,
        artifactKind: 'intent_plan',
        artifactId: String(args.planId),
        completedAt: ts,
        intentId: String(plan.intentId),
        areaId: intent?.areaId,
      });
    }
    return args.planId;
  },
});

export const getPlanArtifact = query({
  args: { ...callerArgs, planId: v.id('albatrossIntentPlans') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const plan = await requirePlan(ctx, args.planId, userId);
    return {
      planId: plan._id,
      intentId: plan.intentId,
      artifactHtml: plan.artifactHtml ?? null,
      document: plan.document ?? null,
      artifactSource: plan.artifactSource ?? null,
      artifactTitle: plan.artifactTitle ?? null,
      status: plan.status,
    };
  },
});
