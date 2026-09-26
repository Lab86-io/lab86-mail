import { v } from 'convex/values';
import { questionDedupeKey } from '../lib/albatross/question-dedupe';
import { SHAPE_POLICY } from '../lib/albatross/shape-policy';
import { preparedDraftSchema, sourceLink, validatePreparedEvidence } from '../lib/content/contract';
import { briefAttention } from '../lib/jev/brief';
import { assessmentIsCurrent, correctionForMail } from '../lib/jev/contract';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { contentAccess, contentPreferences } from './content';
import { loadJevSettings } from './jev';
import { requireInternalSecret } from './lib';
import { scheduleNarrativeSource } from './narrative';

const caller = { internalSecret: v.optional(v.string()), userId: v.string() };
async function eligible(
  ctx: any,
  userId: string,
  source: any,
  policy?: Awaited<ReturnType<typeof loadJevSettings>>,
) {
  if (!(await contentAccess(ctx, userId, source, 'brief'))) return false;
  if (source.source !== 'mail')
    return Boolean(
      source.labels?.actionable &&
        !source.labels?.resolved &&
        source.labels?.kind !== 'noise' &&
        !source.partial,
    );
  const thread = await ctx.db
    .query('mailCorpusThreads')
    .withIndex('by_user_account_thread', (q: any) =>
      q.eq('userId', userId).eq('accountId', source.connectionId).eq('providerThreadId', source.externalId),
    )
    .unique();
  if (!thread || !assessmentIsCurrent(thread.jev, thread.latestMessageId)) return false;
  policy ??= await loadJevSettings(ctx, userId);
  return briefAttention({
    assessment: thread.jev,
    smart: thread.smartCategory,
    preferences: policy.preferences,
    correction: correctionForMail(policy.corrections, {
      accountId: thread.accountId,
      threadId: thread.providerThreadId,
      sender: thread.jev.sender,
      listId: thread.jev.listId,
    }),
    now: Date.now(),
    waitingSince: thread.lastDate,
    fallbackReply: false,
    tracked: false,
  }).eligible;
}
async function owned(ctx: any, args: any) {
  const row = await ctx.db.get(args.id);
  if (!row || row.userId !== args.userId) throw new Error('Preparation not found.');
  return row;
}
async function currentSources(ctx: any, userId: string, row: any) {
  const sources = [];
  for (const saved of row.sources) {
    const source = await ctx.db.get(saved._id);
    if (!source || !(await contentAccess(ctx, userId, source, 'brief'))) return null;
    sources.push(source);
  }
  return sources;
}
async function relatedWorkIsActive(ctx: any, userId: string, workId?: string) {
  if (!workId) return true;
  const id = ctx.db.normalizeId('albatrossIntents', workId);
  const work = id ? await ctx.db.get(id) : null;
  return Boolean(
    work?.userId === userId && !['done', 'archived', 'released'].includes(work.workState || work.status),
  );
}
export const list = query({
  args: caller,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const policy = await loadJevSettings(ctx, args.userId);
    const rows = await ctx.db
      .query('briefPreparations')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'pending'))
      .take(20);
    const result = [];
    for (const row of rows) {
      if (!(await relatedWorkIsActive(ctx, args.userId, row.workId))) continue;
      const source = await ctx.db.get(row.seedId);
      if (!source || !(await contentAccess(ctx, args.userId, source, 'brief'))) continue;
      const pendingClassification = !source.labels && source.status === 'pending';
      if (!pendingClassification && !(await eligible(ctx, args.userId, source, policy))) continue;
      const sources = await currentSources(ctx, args.userId, row);
      if (!sources) continue;
      const changed = sources.some(
        (s) => row.sources.find((saved: any) => saved._id === s._id)?.version !== s.version,
      );
      result.push({
        ...row,
        lease: undefined,
        sources: sources.map((s) => ({
          _id: s._id,
          title: s.title,
          source: s.source,
          version: s.version,
          url: sourceLink(s),
          modifiedAt: s.modifiedAt,
          partial: s.partial,
        })),
        needsRefresh:
          pendingClassification || row.needsRefresh || changed || row.seedVersion !== source.version,
      });
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});
export const claim = mutation({
  args: caller,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const policy = await loadJevSettings(ctx, args.userId);
    const preferences = await contentPreferences(ctx, args.userId);
    if (!preferences.enabled || !preferences.prepare) return null;
    const existing = await ctx.db
      .query('briefPreparations')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'pending'))
      .take(20);
    let activeCount = existing.length;
    for (const row of existing) {
      if (!(await relatedWorkIsActive(ctx, args.userId, row.workId))) {
        await ctx.db.patch(row._id, {
          status: 'resolved',
          updatedAt: Date.now(),
          lease: undefined,
          leaseUntil: undefined,
        });
        activeCount--;
        continue;
      }
      const source = await ctx.db.get(row.seedId);
      if (!source || !(await eligible(ctx, args.userId, source, policy))) {
        // Pending reclassification does not resolve a proposal. Explicit current resolution does.
        const inaccessible = !source || !(await contentAccess(ctx, args.userId, source, 'brief'));
        const classified = Boolean(source?.labels);
        if (inaccessible || classified) {
          await ctx.db.patch(row._id, { status: 'resolved', updatedAt: Date.now(), lease: undefined });
          activeCount--;
        }
        continue;
      }
      if (
        (!row.draft || row.needsRefresh || row.seedVersion !== source.version) &&
        (row.leaseUntil || 0) <= Date.now() &&
        row.nextAttemptAt <= Date.now()
      ) {
        const lease = crypto.randomUUID();
        await ctx.db.patch(row._id, { lease, leaseUntil: Date.now() + 180_000 });
        return { ...row, seed: source, lease };
      }
    }
    const recent = await ctx.db
      .query('contentItems')
      .withIndex('by_user_updated', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(100);
    for (const seed of recent) {
      if (seed.modifiedAt < Date.now() - 14 * 86400_000 || !(await eligible(ctx, args.userId, seed, policy)))
        continue;
      if (seed.labels?.workId?.startsWith('proposal:')) {
        const proposalId = ctx.db.normalizeId(
          'briefPreparations',
          seed.labels.workId.slice('proposal:'.length),
        );
        const related = proposalId ? await ctx.db.get(proposalId) : null;
        if (
          related?.userId === args.userId &&
          related.status === 'pending' &&
          related.seedId !== seed._id &&
          seed.indexedAt > related.updatedAt
        )
          await ctx.db.patch(related._id, {
            seedId: seed._id,
            seedVersion: seed.version,
            needsRefresh: true,
            updatedAt: Date.now(),
          });
        continue;
      }
      let workId: any;
      if (seed.labels?.workId) {
        // A closed/deleted match must not turn back into a new-work suggestion.
        if (!(await relatedWorkIsActive(ctx, args.userId, seed.labels.workId))) continue;
        workId = ctx.db.normalizeId('albatrossIntents', seed.labels.workId);
      }
      const key = workId ? `work:${workId}` : `source:${seed.key}`;
      const prior = await ctx.db
        .query('briefPreparations')
        .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', key))
        .unique();
      if (prior) {
        if (prior.status === 'pending' && prior.seedId !== seed._id && seed.indexedAt > prior.updatedAt)
          await ctx.db.patch(prior._id, {
            seedId: seed._id,
            seedVersion: seed.version,
            needsRefresh: true,
            updatedAt: Date.now(),
          });
        continue;
      }
      if (activeCount >= 3) continue;
      const lease = crypto.randomUUID();
      const value = {
        userId: args.userId,
        key,
        seedId: seed._id,
        seedVersion: seed.version,
        workId,
        status: 'pending',
        sources: [],
        userNotes: '',
        revision: 1,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        lease,
        leaseUntil: Date.now() + 180_000,
        nextAttemptAt: 0,
        needsRefresh: false,
      };
      const id = await ctx.db.insert('briefPreparations', value);
      return { ...value, _id: id, seed };
    }
    return null;
  },
});
export const complete = mutation({
  args: {
    ...caller,
    id: v.id('briefPreparations'),
    lease: v.string(),
    revision: v.number(),
    seedVersion: v.string(),
    draft: v.any(),
    sources: v.array(v.object({ id: v.id('contentItems'), version: v.string() })),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const policy = await loadJevSettings(ctx, args.userId);
    const row = await owned(ctx, args);
    if (row.status !== 'pending' || row.lease !== args.lease) return false;
    const seed = await ctx.db.get(row.seedId as Id<'contentItems'>);
    const sources: any[] = [];
    let stale =
      row.revision !== args.revision ||
      !(await relatedWorkIsActive(ctx, args.userId, row.workId)) ||
      !seed ||
      seed.version !== args.seedVersion ||
      !(await eligible(ctx, args.userId, seed, policy));
    for (const ref of args.sources) {
      const source = await ctx.db.get(ref.id);
      if (
        !source ||
        source.version !== ref.version ||
        !(await contentAccess(ctx, args.userId, source, 'brief'))
      )
        stale = true;
      if (source) sources.push(source);
    }
    if (stale) {
      await ctx.db.patch(row._id, {
        lease: undefined,
        leaseUntil: undefined,
        needsRefresh: true,
        nextAttemptAt: Date.now() + 60_000,
      });
      return false;
    }
    const draft = validatePreparedEvidence(preparedDraftSchema.parse(args.draft), sources);
    if (!draft.evidence.some((e) => e.sourceId === String(seed!._id)))
      throw new Error('Preparation must cite its trigger.');
    await ctx.db.patch(row._id, {
      draft,
      sources: sources.map((s) => ({ _id: s._id, version: s.version })),
      seedVersion: args.seedVersion,
      revision: row.revision + 1,
      preparedAt: Date.now(),
      updatedAt: Date.now(),
      needsRefresh: false,
      lease: undefined,
      leaseUntil: undefined,
      nextAttemptAt: 0,
      error: undefined,
    });
    return true;
  },
});
export const fail = mutation({
  args: { ...caller, id: v.id('briefPreparations'), lease: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await owned(ctx, args);
    if (row.lease !== args.lease || row.status !== 'pending') return;
    await ctx.db.patch(row._id, {
      lease: undefined,
      leaseUntil: undefined,
      nextAttemptAt: Date.now() + 10 * 60_000,
      error: 'Preparation could not finish. It will retry.',
      updatedAt: Date.now(),
    });
  },
});
export const update = mutation({
  args: {
    ...caller,
    id: v.id('briefPreparations'),
    revision: v.number(),
    operation: v.union(v.literal('edit'), v.literal('dismiss'), v.literal('refresh'), v.literal('adopt')),
    notes: v.optional(v.string()),
    files: v.optional(v.array(v.object({ name: v.string(), content: v.string() }))),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await owned(ctx, args);
    if (row.status === 'adopted' && args.operation === 'adopt') return { workId: row.workId };
    if (row.revision !== args.revision || row.status !== 'pending') throw new Error('PREPARATION_CONFLICT');
    const patch = { revision: row.revision + 1, updatedAt: Date.now() };
    if (args.operation === 'dismiss') {
      await ctx.db.patch(row._id, { ...patch, status: 'dismissed', lease: undefined });
      return { dismissed: true };
    }
    if (args.operation === 'edit') {
      if (
        (args.notes?.length || 0) > 10_000 ||
        (args.files?.length || 0) > 3 ||
        args.files?.some((f) => f.content.length > 30_000 || f.name.length > 120)
      )
        throw new Error('Draft edit is too large.');
      const needsRefresh = row.needsRefresh || (args.notes !== undefined && args.notes !== row.userNotes);
      await ctx.db.patch(row._id, {
        ...patch,
        userNotes: args.notes ?? row.userNotes,
        userFiles: args.files ?? row.userFiles,
        needsRefresh,
        nextAttemptAt: needsRefresh ? 0 : row.nextAttemptAt,
      });
      return { saved: true };
    }
    if (args.operation === 'refresh') {
      await ctx.db.patch(row._id, { ...patch, needsRefresh: true, nextAttemptAt: 0 });
      return { queued: true };
    }
    const policy = await loadJevSettings(ctx, args.userId);
    const sources = await currentSources(ctx, args.userId, row);
    const seed = await ctx.db.get(row.seedId as Id<'contentItems'>);
    if (
      !row.draft ||
      row.needsRefresh ||
      !seed ||
      seed.version !== row.seedVersion ||
      !(await eligible(ctx, args.userId, seed, policy)) ||
      !sources ||
      sources.some((s) => row.sources.find((r: any) => r._id === s._id)?.version !== s.version)
    )
      throw new Error('Refresh this preparation before adopting it.');
    const draft = preparedDraftSchema.parse(row.draft);
    const ts = Date.now();
    const refs = sources.map((s) => ({
      kind: s.source === 'mail' ? 'thread' : 'content',
      id: s.source === 'mail' ? s.externalId : String(s._id),
      label: s.title,
      accountId: s.source === 'mail' ? s.connectionId : undefined,
      url: sourceLink(s) || undefined,
    }));
    const files = row.userFiles || draft.files;
    const documentRefs = [];
    for (const [i, file] of files.entries()) {
      const documentId = `prepared_${row._id}_${i}`;
      const model = {
        kind: 'doc',
        version: 1,
        blocks: [{ id: 'draft', type: 'paragraph', text: file.content }],
      };
      await ctx.db.insert('documents', {
        userId: args.userId,
        documentId,
        kind: 'doc',
        title: file.name,
        model,
        currentRevision: 1,
        sourceRefs: refs,
        createdAt: ts,
        updatedAt: ts,
      });
      await ctx.db.insert('documentRevisions', {
        userId: args.userId,
        documentId,
        revision: 1,
        title: file.name,
        model,
        reason: 'Adopted from Brief',
        actor: 'user',
        createdAt: ts,
      });
      documentRefs.push({ kind: 'document', id: documentId, label: file.name });
    }
    const summary = `${draft.situation}\n\nRelevant trail\n${draft.background}\n\nAssessment\n${draft.assessment}\n\nRecommendation\n${draft.recommendation}${row.userNotes ? `\n\nYour notes\n${row.userNotes}` : ''}`;
    let workId = row.workId as Id<'albatrossIntents'> | undefined;
    if (workId) {
      const work = await ctx.db.get(workId);
      if (
        !work ||
        work.userId !== args.userId ||
        ['done', 'released', 'archived'].includes(work.workState || work.status)
      )
        throw new Error('Related work is no longer active.');
      // Preserve the existing plan and user edits; append this research to its capture.
      await ctx.db.patch(workId, {
        rawText: `${work.rawText}\n\nBrief preparation: ${draft.title}\n${summary}\n${documentRefs.map((r) => `Document: ${r.id} (${r.label})`).join('\n')}`,
        lastUserTouchAt: ts,
        updatedAt: ts,
      });
    } else {
      workId = await ctx.db.insert('albatrossIntents', {
        userId: args.userId,
        externalId: `brief:${row._id}`,
        rawText: summary,
        title: draft.title,
        source: 'import',
        status: draft.questions.length ? 'needs_answers' : 'ready',
        workState: 'active',
        agentState: draft.questions.length ? 'needs_input' : 'idle',
        shape: draft.shape,
        questions: draft.questions.map((prompt, i) => ({ id: `prepared_${i}`, prompt })),
        ...(draft.shape === 'list'
          ? {
              listItems: draft.steps.map((text, i) => ({
                id: `prepared_${i}`,
                text,
                done: false,
                addedAt: ts,
              })),
            }
          : {}),
        ...(draft.shape === 'project'
          ? {
              milestones: draft.steps.map((title, order) => ({
                id: `prepared_${order}`,
                title,
                done: false,
                order,
              })),
            }
          : {}),
        createdAt: ts,
        updatedAt: ts,
        lastUserTouchAt: ts,
      });
      // Open questions reach the user as Work questions, the rows that chat,
      // the Brief, and notifications read. The Work v2 migration used to add
      // them in its 15-minute scan; adoption now writes them directly.
      for (const [i, prompt] of draft.questions.entries()) {
        await ctx.db.insert('albatrossWorkQuestions', {
          userId: args.userId,
          workId,
          dedupeKey: questionDedupeKey({ workId: String(workId), kind: 'clarification', prompt }),
          legacyQuestionId: `prepared_${i}`,
          kind: 'clarification',
          prompt,
          reason: 'Asked when this Work was prepared from the Brief.',
          status: 'pending',
          sourceRefs: [],
          createdAt: ts,
          updatedAt: ts,
        });
      }
      const planId =
        SHAPE_POLICY[draft.shape].plans === 'no'
          ? undefined
          : await ctx.db.insert('albatrossIntentPlans', {
              userId: args.userId,
              intentId: workId,
              status: draft.questions.length ? 'needs_answers' : 'ready',
              outcome: draft.title,
              summary,
              digitalActions: [],
              physicalActions: draft.steps.map((title) => ({ title, stepMode: 'you_do_offline' as const })),
              assumptions: draft.questions,
              sourceRefs: [...refs, ...documentRefs],
              createdAt: ts,
              updatedAt: ts,
            });
      await ctx.db.patch(workId, { latestPlanId: planId, conversationId: `work_${workId}` });
    }
    // Research and artifacts remain visible for every shape, including shapes
    // that deliberately have no plan. These are context, not completion proof.
    for (const [i, ref] of [
      ...refs,
      ...documentRefs.map((r) => ({ ...r, url: `/?view=files&document=${encodeURIComponent(r.id)}` })),
    ].entries()) {
      await ctx.db.insert('albatrossEvidence', {
        userId: args.userId,
        targetKind: 'work',
        targetId: String(workId),
        sourceKind: 'manual',
        sourceId: `brief:${row._id}:${i}`,
        title: ref.label,
        summary: 'Research or draft adopted from the Brief.',
        url: ref.url,
        claim: 'Context for this work.',
        limits: 'A prepared draft does not prove the task is complete.',
        occurredAt: ts,
        weight: 0.5,
        confidence: 1,
        trust: 'inferred',
        dedupeKey: `brief:${row._id}:${i}`,
        searchText: ref.label,
        metadata: { preparationId: row._id, source: ref },
        createdAt: ts,
        updatedAt: ts,
      });
    }
    await scheduleNarrativeSource(ctx, args.userId, 'albatrossIntents', String(workId));
    await ctx.db.patch(row._id, { ...patch, status: 'adopted', workId, lease: undefined });
    return { workId, documents: documentRefs };
  },
});
