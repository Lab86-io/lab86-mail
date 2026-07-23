import { v } from 'convex/values';
import {
  areaArtifactHtmlForWrite,
  assertAreaArtifactDocumentSize,
} from '../lib/albatross/area-artifact-storage';
import { questionDedupeKey, shouldAdvanceWorkAfterAnswer } from '../lib/albatross/question-dedupe';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

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

export const updateWorkState = mutation({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
    state: v.union(v.literal('active'), v.literal('paused'), v.literal('done'), v.literal('archived')),
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
      updatedAt: ts,
    });
    return { previousState: work.workState || 'active', state: args.state };
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

export const workDetail = query({
  args: {
    ...callerArgs,
    workId: v.id('albatrossIntents'),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const work = await requireWork(ctx, args.workId, userId);
    const [plan, project, questions, areaLinks, applications] = await Promise.all([
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
    ]);
    const application = applications.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    return { work, plan, project, questions, areaLinks, application };
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
