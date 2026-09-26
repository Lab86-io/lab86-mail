import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, mutation, query } from './_generated/server';
import { recordDocumentEffect } from './agentExecution';
import { now, requireInternalSecret } from './lib';

const executionValidator = v.optional(v.object({ runId: v.string(), key: v.string() }));

const kindValidator = v.union(v.literal('doc'), v.literal('sheet'), v.literal('deck'));
const importSourceValidator = v.object({
  format: v.literal('xlsx'),
  filename: v.string(),
  mimeType: v.string(),
  size: v.number(),
  sha256: v.string(),
  storageId: v.id('_storage'),
  warnings: v.array(v.string()),
  importedAt: v.number(),
});

function modelVersion(model: unknown) {
  return typeof model === 'object' && model !== null ? (model as { version?: unknown }).version : undefined;
}

function isEngineWorkbook(model: unknown) {
  return (
    typeof model === 'object' &&
    model !== null &&
    (model as { kind?: unknown }).kind === 'sheet' &&
    modelVersion(model) === 2
  );
}

function isChangeSet(model: unknown) {
  return (
    typeof model === 'object' && model !== null && (model as { kind?: unknown }).kind === 'sheet-changes'
  );
}

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
    importSource: v.optional(importSourceValidator),
    execution: executionValidator,
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ownedDocument(ctx, args.userId, args.documentId);
    if (existing) return existing;
    if (args.importSource) {
      const cancelled = await ctx.db
        .query('documentImportCancellations')
        .withIndex('by_storage', (q) => q.eq('storageId', args.importSource!.storageId))
        .first();
      if (cancelled) throw new Error('This workbook import was cancelled. Import the original file again.');
    }
    const ts = now();
    const row = {
      userId: args.userId,
      documentId: args.documentId,
      kind: args.kind,
      title: args.title,
      model: args.model,
      currentRevision: 1,
      sourceRefs: args.sourceRefs || [],
      ...(args.importSource ? { importSource: { ...args.importSource, revision: 1 } } : {}),
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
    await recordDocumentEffect(ctx, args.userId, args.execution, {
      documentId: args.documentId,
      revision: 1,
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
    // Summaries without the model, for callers that show only names.
    metadataOnly: v.optional(v.boolean()),
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
    // Each row holds a full model, so the read is bounded by bytes as well as
    // rows; a list of large files stops early instead of failing (DOC-4).
    const page = await visible.paginate({
      cursor: null,
      numItems: limit,
      maximumBytesRead: LIST_MAX_BYTES_READ,
    });
    if (!args.metadataOnly) return page.page;
    return page.page.map(({ model: _model, ...summary }) => summary);
  },
});

const LIST_MAX_BYTES_READ = 6_000_000;
// Autosaves from one editing session share one revision row per window.
export const AUTOSAVE_REVISION_WINDOW_MS = 10 * 60_000;
const AUTOSAVE_REASONS = new Set(['inline_edit', 'autosave']);

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

export const generateImportUploadUrl = mutation({
  args: { internalSecret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Compensate an import failure without deleting an ambiguously committed file.
 * A cancellation commits atomically with deletion. A create that arrives later
 * sees the tombstone and cannot attach missing bytes; an earlier create wins
 * and its original is retained. Never exposed directly to the browser.
 */
export const cancelImport = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const attached = await ctx.db
      .query('documents')
      .withIndex('by_import_storage', (q) => q.eq('importSource.storageId', args.storageId))
      .first();
    if (attached) {
      return {
        status: 'attached' as const,
        ...(attached.userId === args.userId && attached.documentId === args.documentId
          ? { document: attached }
          : {}),
      };
    }
    const cancelled = await ctx.db
      .query('documentImportCancellations')
      .withIndex('by_storage', (q) => q.eq('storageId', args.storageId))
      .first();
    if (cancelled) return { status: 'cancelled' as const };
    await ctx.db.insert('documentImportCancellations', {
      userId: args.userId,
      documentId: args.documentId,
      storageId: args.storageId,
      cancelledAt: now(),
    });
    await ctx.storage.delete(args.storageId);
    return { status: 'cancelled' as const };
  },
});

export const getImportSource = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt || !document.importSource) return null;
    const url = await ctx.storage.getUrl(document.importSource.storageId);
    if (!url) return null;
    const { storageId: _storageId, ...source } = document.importSource;
    return { ...source, url, currentRevision: document.currentRevision };
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
    allowDowngrade: v.optional(v.boolean()),
    execution: executionValidator,
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt) return { ok: false, code: 'NOT_FOUND' };
    if (document.currentRevision !== args.expectedRevision) {
      return { ok: false, code: 'REVISION_CONFLICT', document };
    }
    // Old native clients decode rich slides as a v1 projection. Even an
    // ordinary rename sends that projection back. Never let it erase the
    // theme, images, charts, or fields this client cannot represent.
    if (
      args.model !== undefined &&
      document.kind === 'deck' &&
      modelVersion(document.model) === 2 &&
      modelVersion(args.model) !== 2
    ) {
      return { ok: false, code: 'RICH_DECK_REQUIRED', document };
    }
    // A grid-only client (older native build, v1 tooling) must not overwrite an
    // engine workbook with its lossy projection; it would silently drop
    // formatting, charts, and validation.
    if (
      args.model !== undefined &&
      !args.allowDowngrade &&
      isEngineWorkbook(document.model) &&
      !isEngineWorkbook(args.model)
    ) {
      return { ok: false, code: 'ENGINE_MODEL_REQUIRED', document };
    }
    const title = args.title ?? document.title;
    const model = args.model ?? document.model;
    const sourceRefs = args.sourceRefs ?? document.sourceRefs;
    const revision = document.currentRevision + 1;
    await recordDocumentEffect(ctx, args.userId, args.execution, { documentId: args.documentId, revision });
    const ts = now();
    await ctx.db.patch(document._id, {
      title,
      model,
      sourceRefs,
      currentRevision: revision,
      updatedAt: ts,
    });
    const reason = args.reason || 'edit';
    const actor = args.actor || 'user';
    // Autosave runs after each short pause. Rather than one full copy per
    // pause, the latest autosave row of the same window takes the new state;
    // the row before the window keeps the earlier state for restore.
    const latest =
      actor === 'user' && AUTOSAVE_REASONS.has(reason)
        ? await ctx.db
            .query('documentRevisions')
            .withIndex('by_user_document_revision', (q) =>
              q.eq('userId', args.userId).eq('documentId', args.documentId),
            )
            .order('desc')
            .first()
        : null;
    const windowStartedAt = latest ? (latest.windowStartedAt ?? latest.createdAt) : ts;
    if (
      latest &&
      latest.revision === document.currentRevision &&
      latest.actor === 'user' &&
      AUTOSAVE_REASONS.has(latest.reason) &&
      ts - windowStartedAt < AUTOSAVE_REVISION_WINDOW_MS
    ) {
      await ctx.db.patch(latest._id, { revision, title, model, reason, createdAt: ts, windowStartedAt });
    } else {
      await ctx.db.insert('documentRevisions', {
        userId: args.userId,
        documentId: args.documentId,
        revision,
        title,
        model,
        reason,
        actor,
        createdAt: ts,
      });
    }
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
    // Archive is final: nothing reads an archived file's history, import
    // bytes, or suggestions again, so their storage goes (DOC-4).
    await ctx.scheduler.runAfter(0, internal.documents.purgeArchivedDocument, {
      userId: args.userId,
      documentId: args.documentId,
    });
    return { ok: true };
  },
});

const PURGE_BATCH_SIZE = 50;

export const purgeArchivedDocument = internalMutation({
  args: { userId: v.string(), documentId: v.string() },
  handler: async (ctx, args) => {
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document?.archivedAt) return { done: true, deleted: 0 };
    const revisions = await ctx.db
      .query('documentRevisions')
      .withIndex('by_user_document_revision', (q) =>
        q.eq('userId', args.userId).eq('documentId', args.documentId),
      )
      .take(PURGE_BATCH_SIZE);
    const suggestions = await ctx.db
      .query('documentSuggestions')
      .withIndex('by_user_document', (q) => q.eq('userId', args.userId).eq('documentId', args.documentId))
      .take(PURGE_BATCH_SIZE);
    for (const row of [...revisions, ...suggestions]) await ctx.db.delete(row._id);
    if (revisions.length === PURGE_BATCH_SIZE || suggestions.length === PURGE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.documents.purgeArchivedDocument, args);
      return { done: false, deleted: revisions.length + suggestions.length };
    }
    if (document.importSource) {
      if (await ctx.db.system.get(document.importSource.storageId)) {
        await ctx.storage.delete(document.importSource.storageId);
      }
      await ctx.db.patch(document._id, { importSource: undefined });
    }
    return { done: true, deleted: revisions.length + suggestions.length };
  },
});

export const restoreRevision = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    documentId: v.string(),
    revision: v.number(),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await ownedDocument(ctx, args.userId, args.documentId);
    if (!document || document.archivedAt) return { ok: false, code: 'NOT_FOUND' };
    if (document.currentRevision !== args.expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
    const previous = await ctx.db
      .query('documentRevisions')
      .withIndex('by_user_document_revision', (q) =>
        q.eq('userId', args.userId).eq('documentId', args.documentId).eq('revision', args.revision),
      )
      .unique();
    if (!previous) return { ok: false, code: 'NOT_FOUND' };
    const revision = document.currentRevision + 1;
    const updatedAt = now();
    await ctx.db.patch(document._id, {
      title: previous.title,
      model: previous.model,
      currentRevision: revision,
      updatedAt,
    });
    await ctx.db.insert('documentRevisions', {
      userId: args.userId,
      documentId: args.documentId,
      revision,
      title: previous.title,
      model: previous.model,
      reason: `Restored revision ${args.revision}`,
      actor: 'user',
      createdAt: updatedAt,
    });
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
    execution: executionValidator,
    documentId: v.string(),
    title: v.string(),
    description: v.string(),
    proposedModel: v.any(),
    baseRevision: v.optional(v.number()),
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
    await recordDocumentEffect(ctx, args.userId, args.execution, {
      documentId: args.documentId,
      suggestionId: args.suggestionId,
    });
    const ts = now();
    await ctx.db.insert('documentSuggestions', {
      userId: args.userId,
      suggestionId: args.suggestionId,
      documentId: args.documentId,
      title: args.title,
      description: args.description,
      proposedModel: args.proposedModel,
      baseRevision: args.baseRevision ?? document.currentRevision,
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
    /**
     * For change-set suggestions the editor applies the engine commands and
     * sends the resulting full snapshot; the server cannot evaluate a workbook.
     */
    model: v.optional(v.any()),
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
    if (suggestion.baseRevision !== document.currentRevision) {
      return { ok: false, code: 'REVISION_CONFLICT', document };
    }
    let model = suggestion.proposedModel;
    if (isChangeSet(suggestion.proposedModel)) {
      if (!isEngineWorkbook(args.model)) return { ok: false, code: 'NEEDS_EDITOR', document };
      model = args.model;
    } else if (args.model !== undefined) {
      return { ok: false, code: 'NEEDS_EDITOR', document };
    }
    const revision = document.currentRevision + 1;
    const ts = now();
    await ctx.db.patch(document._id, {
      title: suggestion.title,
      model,
      currentRevision: revision,
      updatedAt: ts,
    });
    await ctx.db.insert('documentRevisions', {
      userId: args.userId,
      documentId: args.documentId,
      revision,
      title: suggestion.title,
      model,
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
        model,
        currentRevision: revision,
        updatedAt: ts,
      },
    };
  },
});
