import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { normalizeSourceRefs, normalizeText } from './albatrossModel';
import { recordCompletionEvent } from './albatrossWork';
import { now, requireInternalSecret } from './lib';

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

export const createIntent = mutation({
  args: {
    ...callerArgs,
    externalId: v.optional(v.string()),
    rawText: v.string(),
    transcript: v.optional(v.string()),
    source: v.union(v.literal('text'), v.literal('voice'), v.literal('chat'), v.literal('import')),
    title: v.optional(v.string()),
    areaId: v.optional(v.string()),
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
      if (existing) return existing._id;
    }
    const ts = now();
    return ctx.db.insert('albatrossIntents', {
      userId,
      externalId,
      rawText,
      transcript: args.transcript ? preserveRaw(args.transcript) : undefined,
      source: args.source,
      title: bounded(args.title, 180),
      status: 'captured',
      areaId: bounded(args.areaId, 160),
      createdAt: ts,
      updatedAt: ts,
    });
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
    const plan = intent.latestPlanId ? await ctx.db.get(intent.latestPlanId) : null;
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
    if (args.areaId !== undefined) patch.areaId = bounded(args.areaId, 160) || undefined;
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
    areaId: v.optional(v.string()),
    priority: v.optional(v.number()),
    questions: v.optional(v.array(questionValidator)),
    proposedProjectTitle: v.optional(v.string()),
    digitalActions: v.array(v.any()),
    physicalActions: v.array(physicalActionValidator),
    assumptions: v.array(v.string()),
    sourceRefs: v.array(sourceRefValidator),
    artifactHtml: v.optional(v.string()),
    artifactTitle: v.optional(v.string()),
    model: v.optional(v.string()),
    mapQuery: v.optional(v.string()),
    places: v.optional(v.array(placeValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const intent = await requireIntent(ctx, args.intentId, userId);
    const ts = now();
    const openQuestions = (args.questions || []).filter((question) => !question.answer);
    const planStatus = openQuestions.length ? 'needs_answers' : 'ready';

    if (intent.latestPlanId) {
      const previous = await ctx.db.get(intent.latestPlanId);
      if (previous && previous.userId === userId && previous.status !== 'applied') {
        await ctx.db.patch(intent.latestPlanId, { status: 'superseded', updatedAt: ts });
      }
    }

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
      })),
      assumptions: args.assumptions.map((assumption) => bounded(assumption, 500)!).filter(Boolean),
      sourceRefs: normalizeSourceRefs(args.sourceRefs),
      artifactHtml: args.artifactHtml ? args.artifactHtml.slice(0, ARTIFACT_HTML_MAX) : undefined,
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

    await ctx.db.patch(args.intentId, {
      status: planStatus,
      title: bounded(args.title, 180) ?? intent.title,
      kind: args.kind !== undefined ? bounded(args.kind, 40) : intent.kind,
      areaId: args.areaId !== undefined ? bounded(args.areaId, 160) : intent.areaId,
      priority:
        args.priority !== undefined ? Math.min(Math.max(Math.round(args.priority), 1), 3) : intent.priority,
      questions: args.questions ?? intent.questions,
      latestPlanId: planId,
      planError: undefined,
      updatedAt: ts,
    });

    return planId;
  },
});

export const markPlanApplied = mutation({
  args: {
    ...callerArgs,
    planId: v.id('albatrossIntentPlans'),
    applicationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const plan = await requirePlan(ctx, args.planId, userId);
    const ts = now();
    await ctx.db.patch(args.planId, {
      status: 'applied',
      appliedApplicationId: bounded(args.applicationId, 180),
      appliedAt: ts,
      updatedAt: ts,
    });
    await ctx.db.patch(plan.intentId, { status: 'applied', appliedAt: ts, updatedAt: ts });
    // Completion history (issue #87/#18): applying a plan is the completion of
    // the intent_plan artifact. Only the first apply records an event.
    if (plan.status !== 'applied') {
      const intent = await ctx.db.get(plan.intentId);
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
      artifactTitle: plan.artifactTitle ?? null,
      status: plan.status,
    };
  },
});
