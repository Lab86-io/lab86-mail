import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const kindValidator = v.union(v.literal('doc'), v.literal('sheet'), v.literal('deck'));

async function ownedDocument(ctx: QueryCtx | MutationCtx, userId: string, documentId: string) {
  return ctx.db
    .query('documents')
    .withIndex('by_user_document', (q) => q.eq('userId', userId).eq('documentId', documentId))
    .unique();
}

export const create = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
    kind: kindValidator,
    title: v.string(),
    model: v.any(),
    sourceRefs: v.optional(v.array(v.any())),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ownedDocument(ctx, args.userId, args.documentId);
    if (existing) return existing;
    const ts = now();
    const row = {
      userId: args.userId,
      documentId: args.documentId,
      kind: args.kind,
      title: args.title,
      model: args.model,
      currentRevision: 1,
      sourceRefs: args.sourceRefs || [],
      createdAt: ts,
      updatedAt: ts,
    };
    await ctx.db.insert('documents', row);
    await ctx.db.insert('documentRevisions', {
      userId: args.userId,
      documentId: args.documentId,
      revision: 1,
      title: args.title,
      model: args.model,
      reason: args.reason || 'create',
      actor: 'user',
      createdAt: ts,
    });
    return row;
  },
});

export const list = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.optional(kindValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(args.limit || 200, 1), 500);
    const base = ctx.db
      .query('documents')
      .withIndex('by_user_updated', (q) => q.eq('userId', args.userId))
      .order('desc');
    const visible = args.kind
      ? base.filter((q) => q.and(q.eq(q.field('archivedAt'), undefined), q.eq(q.field('kind'), args.kind)))
      : base.filter((q) => q.eq(q.field('archivedAt'), undefined));
    return visible.take(limit);
  },
});

export const get = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt) return null;
    const suggestions = await ctx.db
      .query('documentSuggestions')
      .withIndex('by_user_document_status', (q) =>
        q.eq('userId', args.userId).eq('documentId', args.documentId).eq('status', 'proposed'),
      )
      .order('desc')
      .take(50);
    return {
      ...document,
      suggestions,
    };
  },
});

export const getKind = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    return document && !document.archivedAt ? document.kind : null;
  },
});

export const findByGoogleFile = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    fileId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const documents = await ctx.db
      .query('documents')
      .withIndex('by_user_google_file', (q) =>
        q
          .eq('userId', args.userId)
          .eq('googleConnectionId', args.connectionId)
          .eq('googleFileId', args.fileId),
      )
      .filter((q) => q.eq(q.field('archivedAt'), undefined))
      .order('desc')
      .take(1);
    const document = documents[0];
    return document && !document.archivedAt ? document : null;
  },
});

export const listRevisions = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt) return [];
    const rows = await ctx.db
      .query('documentRevisions')
      .withIndex('by_user_document_revision', (q) =>
        q.eq('userId', args.userId).eq('documentId', args.documentId),
      )
      .order('desc')
      .take(Math.min(Math.max(args.limit || 50, 1), 200));
    return rows;
  },
});

export const update = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
    expectedRevision: v.number(),
    title: v.optional(v.string()),
    model: v.optional(v.any()),
    sourceRefs: v.optional(v.array(v.any())),
    reason: v.optional(v.string()),
    actor: v.optional(v.union(v.literal('user'), v.literal('ai'), v.literal('system'))),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt) return { ok: false, code: 'NOT_FOUND' };
    if (document.currentRevision !== args.expectedRevision) {
      return { ok: false, code: 'REVISION_CONFLICT', document };
    }
    const title = args.title ?? document.title;
    const model = args.model ?? document.model;
    const sourceRefs = args.sourceRefs ?? document.sourceRefs;
    const revision = document.currentRevision + 1;
    const ts = now();
    await ctx.db.patch(document._id, {
      title,
      model,
      sourceRefs,
      currentRevision: revision,
      updatedAt: ts,
    });
    await ctx.db.insert('documentRevisions', {
      userId: args.userId,
      documentId: args.documentId,
      revision,
      title,
      model,
      reason: args.reason || 'edit',
      actor: args.actor || 'user',
      createdAt: ts,
    });
    return {
      ok: true,
      document: { ...document, title, model, sourceRefs, currentRevision: revision, updatedAt: ts },
    };
  },
});

export const archive = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document) return { ok: false };
    await ctx.db.patch(document._id, { archivedAt: now(), updatedAt: now() });
    return { ok: true };
  },
});

export const linkGoogleFile = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
    connectionId: v.string(),
    fileId: v.string(),
    mimeType: v.string(),
    webUrl: v.optional(v.string()),
    providerVersion: v.optional(v.string()),
    syncedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt) return { ok: false };
    const linked = await ctx.db
      .query('documents')
      .withIndex('by_user_google_file', (q) =>
        q
          .eq('userId', args.userId)
          .eq('googleConnectionId', args.connectionId)
          .eq('googleFileId', args.fileId),
      )
      .filter((q) => q.eq(q.field('archivedAt'), undefined))
      .collect();
    const conflict = linked.find((candidate) => candidate._id !== document._id);
    if (conflict) {
      return {
        ok: false,
        code: 'ALREADY_LINKED',
        documentId: conflict.documentId,
      };
    }
    const google = {
      connectionId: args.connectionId,
      fileId: args.fileId,
      mimeType: args.mimeType,
      webUrl: args.webUrl,
      providerVersion: args.providerVersion,
      syncedRevision: args.syncedRevision,
      lastSyncedAt: now(),
    };
    await ctx.db.patch(document._id, {
      google,
      googleFileId: args.fileId,
      googleConnectionId: args.connectionId,
      updatedAt: now(),
    });
    return { ok: true, google };
  },
});

export const createSuggestion = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    suggestionId: v.string(),
    documentId: v.string(),
    title: v.string(),
    description: v.string(),
    proposedModel: v.any(),
    sourceRefs: v.optional(v.array(v.any())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt) return { ok: false, code: 'NOT_FOUND' };
    const existing = await ctx.db
      .query('documentSuggestions')
      .withIndex('by_user_suggestion', (q) =>
        q.eq('userId', args.userId).eq('suggestionId', args.suggestionId),
      )
      .order('desc')
      .take(1);
    if (existing[0]) {
      return {
        ok: true,
        suggestionId: existing[0].suggestionId,
        createdAt: existing[0].createdAt,
      };
    }
    const ts = now();
    await ctx.db.insert('documentSuggestions', {
      userId: args.userId,
      suggestionId: args.suggestionId,
      documentId: args.documentId,
      title: args.title,
      description: args.description,
      proposedModel: args.proposedModel,
      sourceRefs: args.sourceRefs || [],
      status: 'proposed',
      createdAt: ts,
    });
    return { ok: true, suggestionId: args.suggestionId, createdAt: ts };
  },
});

export const resolveSuggestion = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
    suggestionId: v.string(),
    status: v.union(v.literal('applied'), v.literal('dismissed')),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('documentSuggestions')
      .withIndex('by_user_suggestion', (q) =>
        q.eq('userId', args.userId).eq('suggestionId', args.suggestionId),
      )
      .order('desc')
      .take(1);
    const row = rows[0];
    if (!row || row.documentId !== args.documentId) return { ok: false };
    if (row.status !== 'proposed') return { ok: false, code: 'ALREADY_RESOLVED' };
    await ctx.db.patch(row._id, { status: args.status, resolvedAt: now() });
    return { ok: true };
  },
});

export const applySuggestion = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
    suggestionId: v.string(),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt) return { ok: false, code: 'NOT_FOUND' };
    const suggestions = await ctx.db
      .query('documentSuggestions')
      .withIndex('by_user_suggestion', (q) =>
        q.eq('userId', args.userId).eq('suggestionId', args.suggestionId),
      )
      .order('desc')
      .take(1);
    const suggestion = suggestions[0];
    if (!suggestion || suggestion.documentId !== args.documentId) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (suggestion.status !== 'proposed') {
      return { ok: false, code: 'ALREADY_RESOLVED' };
    }
    if (document.currentRevision !== args.expectedRevision) {
      return { ok: false, code: 'REVISION_CONFLICT', document };
    }
    const revision = document.currentRevision + 1;
    const ts = now();
    await ctx.db.patch(document._id, {
      title: suggestion.title,
      model: suggestion.proposedModel,
      currentRevision: revision,
      updatedAt: ts,
    });
    await ctx.db.insert('documentRevisions', {
      userId: args.userId,
      documentId: args.documentId,
      revision,
      title: suggestion.title,
      model: suggestion.proposedModel,
      reason: suggestion.description,
      actor: 'ai',
      createdAt: ts,
    });
    await ctx.db.patch(suggestion._id, { status: 'applied', resolvedAt: ts });
    return {
      ok: true,
      document: {
        ...document,
        title: suggestion.title,
        model: suggestion.proposedModel,
        currentRevision: revision,
        updatedAt: ts,
      },
    };
  },
});
