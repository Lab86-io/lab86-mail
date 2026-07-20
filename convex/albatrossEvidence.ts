import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

const targetKindValidator = v.union(
  v.literal('area'),
  v.literal('project'),
  v.literal('work'),
  v.literal('routine'),
);

const sourceKindValidator = v.union(
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
);

const trustValidator = v.union(
  v.literal('observed'),
  v.literal('inferred'),
  v.literal('confirmed'),
  v.literal('rejected'),
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

function unit(value: number, fallback = 0) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

export const upsertEvidence = mutation({
  args: {
    ...callerArgs,
    targetKind: v.optional(targetKindValidator),
    targetId: v.optional(v.string()),
    sourceKind: sourceKindValidator,
    sourceId: v.string(),
    connectionId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    title: v.string(),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
    occurredAt: v.number(),
    weight: v.number(),
    confidence: v.number(),
    trust: trustValidator,
    dedupeKey: v.string(),
    searchText: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const dedupeKey = args.dedupeKey.trim();
    if (!dedupeKey || dedupeKey.length > 600) {
      throw new Error('dedupeKey must contain between 1 and 600 characters.');
    }
    const existing = await ctx.db
      .query('albatrossEvidence')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', userId).eq('dedupeKey', dedupeKey))
      .unique();
    const ts = now();
    const doc = {
      userId,
      targetKind: args.targetKind,
      targetId: args.targetId?.slice(0, 200),
      sourceKind: args.sourceKind,
      sourceId: args.sourceId.slice(0, 500),
      connectionId: args.connectionId?.slice(0, 200),
      accountId: args.accountId?.slice(0, 200),
      title: args.title.trim().slice(0, 500) || 'Untitled evidence',
      summary: args.summary?.trim().slice(0, 2_000),
      url: /^https?:\/\//i.test(args.url || '') ? args.url?.slice(0, 1_200) : undefined,
      occurredAt: args.occurredAt,
      weight: unit(args.weight),
      confidence: unit(args.confidence, 0.5),
      trust: args.trust,
      dedupeKey,
      searchText: args.searchText.trim().slice(0, 4_000),
      metadata: args.metadata,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return ctx.db.insert('albatrossEvidence', { ...doc, createdAt: ts });
  },
});

export const linkEvidence = mutation({
  args: {
    ...callerArgs,
    evidenceId: v.id('albatrossEvidence'),
    targetKind: targetKindValidator,
    targetId: v.string(),
    trust: v.optional(trustValidator),
    confidence: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const row = await ctx.db.get(args.evidenceId);
    if (!row || row.userId !== userId) throw new Error('Evidence not found.');
    await ctx.db.patch(args.evidenceId, {
      targetKind: args.targetKind,
      targetId: args.targetId.slice(0, 200),
      ...(args.trust ? { trust: args.trust } : {}),
      ...(args.confidence !== undefined ? { confidence: unit(args.confidence, 0.5) } : {}),
      updatedAt: now(),
    });
    return { ok: true };
  },
});

export const forTarget = query({
  args: {
    ...callerArgs,
    targetKind: targetKindValidator,
    targetId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const limit = Math.min(Math.max(args.limit ?? 80, 1), 200);
    return ctx.db
      .query('albatrossEvidence')
      .withIndex('by_user_target', (q) =>
        q.eq('userId', userId).eq('targetKind', args.targetKind).eq('targetId', args.targetId),
      )
      .order('desc')
      .take(limit);
  },
});

export const search = query({
  args: {
    ...callerArgs,
    query: v.string(),
    sourceKind: v.optional(sourceKindValidator),
    targetKind: v.optional(targetKindValidator),
    targetId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const text = args.query.trim();
    if (!text) return [];
    const search = ctx.db.query('albatrossEvidence').withSearchIndex('by_search_text', (q) => {
      let cursor = q.search('searchText', text).eq('userId', userId);
      if (args.sourceKind) cursor = cursor.eq('sourceKind', args.sourceKind);
      if (args.targetKind) cursor = cursor.eq('targetKind', args.targetKind);
      if (args.targetId) cursor = cursor.eq('targetId', args.targetId);
      return cursor;
    });
    return search.take(Math.min(Math.max(args.limit ?? 30, 1), 100));
  },
});

export const indexSummary = query({
  args: { ...callerArgs, targetKind: v.optional(targetKindValidator), targetId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows =
      args.targetKind && args.targetId
        ? await ctx.db
            .query('albatrossEvidence')
            .withIndex('by_user_target', (q) =>
              q.eq('userId', userId).eq('targetKind', args.targetKind).eq('targetId', args.targetId),
            )
            .order('desc')
            .take(500)
        : await ctx.db
            .query('albatrossEvidence')
            .withIndex('by_user_occurredAt', (q) => q.eq('userId', userId))
            .order('desc')
            .take(500);
    const sourceCounts: Record<string, number> = {};
    const trustCounts: Record<string, number> = {};
    let remaining = 1;
    for (const row of rows) {
      sourceCounts[row.sourceKind] = (sourceCounts[row.sourceKind] || 0) + 1;
      trustCounts[row.trust] = (trustCounts[row.trust] || 0) + 1;
      if (row.trust !== 'rejected') remaining *= 1 - unit(row.weight);
    }
    return {
      total: rows.length,
      bounded: rows.length >= 500,
      strength: Math.min(0.995, Math.max(0, 1 - remaining)),
      sourceCounts,
      trustCounts,
      latestAt: rows[0]?.occurredAt ?? null,
    };
  },
});
