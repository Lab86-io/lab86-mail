import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const owner = { internalSecret: v.optional(v.string()), userId: v.string() };
async function owned(ctx: QueryCtx | MutationCtx, userId: string, documentId: string) {
  return ctx.db
    .query('officeDocuments')
    .withIndex('by_user_document', (q) => q.eq('userId', userId).eq('documentId', documentId))
    .unique();
}

export const uploadUrl = mutation({
  args: owner,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.storage.generateUploadUrl();
  },
});

export const create = mutation({
  args: {
    ...owner,
    documentId: v.string(),
    title: v.string(),
    extension: v.union(v.literal('docx'), v.literal('xlsx'), v.literal('pptx')),
    storageId: v.id('_storage'),
    size: v.number(),
    sha256: v.string(),
    google: v.optional(
      v.object({
        connectionId: v.string(),
        fileId: v.string(),
        session: v.string(),
        syncedRevision: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await owned(ctx, args.userId, args.documentId);
    if (existing) {
      const original = await ctx.db
        .query('officeVersions')
        .withIndex('by_user_document_revision', (q) =>
          q.eq('userId', args.userId).eq('documentId', args.documentId).eq('revision', 1),
        )
        .unique();
      if (original && original.storageId !== args.storageId) await ctx.storage.delete(args.storageId);
      return existing;
    }
    const timestamp = now();
    const document = {
      userId: args.userId,
      documentId: args.documentId,
      title: args.title,
      extension: args.extension,
      currentRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(args.google ? { google: args.google } : {}),
    };
    await ctx.db.insert('officeDocuments', document);
    await ctx.db.insert('officeVersions', {
      userId: args.userId,
      documentId: args.documentId,
      revision: 1,
      storageId: args.storageId,
      size: args.size,
      sha256: args.sha256,
      recovery: false,
      createdAt: timestamp,
    });
    return document;
  },
});

export const list = query({
  args: owner,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.db
      .query('officeDocuments')
      .withIndex('by_user_updated', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(100);
  },
});

export const get = query({
  args: { ...owner, documentId: v.string(), revision: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await owned(ctx, args.userId, args.documentId);
    if (!document) return null;
    const revisions = await ctx.db
      .query('officeVersions')
      .withIndex('by_user_document_revision', (q) =>
        q.eq('userId', args.userId).eq('documentId', args.documentId),
      )
      .order('desc')
      .take(200);
    const selected = args.revision ?? document.currentRevision;
    const version = await ctx.db
      .query('officeVersions')
      .withIndex('by_user_document_revision', (q) =>
        q.eq('userId', args.userId).eq('documentId', args.documentId).eq('revision', selected),
      )
      .unique();
    return {
      ...document,
      versions: revisions.map(({ storageId: _storage, ...row }) => row),
      version: version ? { ...version, url: await ctx.storage.getUrl(version.storageId) } : null,
    };
  },
});

export const startSession = mutation({
  args: {
    ...owner,
    documentId: v.string(),
    sessionId: v.string(),
    key: v.string(),
    expectedRevision: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await owned(ctx, args.userId, args.documentId);
    if (!document) return { ok: false, code: 'NOT_FOUND' };
    if (document.currentRevision !== args.expectedRevision) return { ok: false, code: 'REVISION_CONFLICT' };
    const existing = await ctx.db
      .query('officeSessions')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .unique();
    if (existing) return { ok: false, code: 'SESSION_EXISTS' };
    const expiresAt = now() + 24 * 60 * 60 * 1000;
    await ctx.db.insert('officeSessions', {
      userId: args.userId,
      documentId: args.documentId,
      sessionId: args.sessionId,
      key: args.key,
      baseRevision: document.currentRevision,
      lastRevision: document.currentRevision,
      expiresAt,
    });
    return { ok: true, expiresAt };
  },
});

export const getSession = query({
  args: { ...owner, documentId: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const session = await ctx.db
      .query('officeSessions')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .unique();
    return session?.userId === args.userId &&
      session.documentId === args.documentId &&
      session.expiresAt > now()
      ? session
      : null;
  },
});

export const saveVersion = mutation({
  args: {
    ...owner,
    documentId: v.string(),
    sessionId: v.string(),
    key: v.string(),
    expectedRevision: v.number(),
    storageId: v.id('_storage'),
    size: v.number(),
    sha256: v.string(),
    wopiLock: v.optional(v.string()),
    saveRequestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const session = await ctx.db
      .query('officeSessions')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .unique();
    const document = await owned(ctx, args.userId, args.documentId);
    if (
      !document ||
      !session ||
      session.userId !== args.userId ||
      session.documentId !== args.documentId ||
      session.key !== args.key ||
      session.expiresAt <= now()
    )
      return { ok: false, code: 'SESSION_INVALID' };
    if (
      args.wopiLock !== undefined &&
      (!document.wopiLock ||
        document.wopiLock.value !== args.wopiLock ||
        document.wopiLock.expiresAt <= now())
    )
      return { ok: false, code: 'LOCK_CONFLICT' };
    const existing = await ctx.db
      .query('officeVersions')
      .withIndex('by_session_hash', (q) => q.eq('sessionId', args.sessionId).eq('sha256', args.sha256))
      .order('desc')
      .first();
    if (
      existing &&
      (existing.recovery ||
        (existing.revision === session.lastRevision && existing.revision === document.currentRevision))
    ) {
      if (args.saveRequestId && !existing.recovery)
        await ctx.db.patch(document._id, {
          lastWopiSave: { id: args.saveRequestId, revision: existing.revision },
        });
      if (existing.storageId !== args.storageId) await ctx.storage.delete(args.storageId);
      return {
        ok: !existing.recovery,
        code: existing.recovery ? 'REVISION_CONFLICT' : undefined,
        revision: existing.revision,
        updatedAt: document.updatedAt,
      };
    }
    const latest = await ctx.db
      .query('officeVersions')
      .withIndex('by_user_document_revision', (q) =>
        q.eq('userId', args.userId).eq('documentId', args.documentId),
      )
      .order('desc')
      .first();
    const revision = (latest?.revision || document.currentRevision) + 1;
    // A repeated older hash may be an out-of-order callback OR an intentional
    // A→B→A edit. Never acknowledge it as saved while B remains current.
    // Preserve the ambiguous content for recovery until the user resolves it.
    // The callback captures its expected revision before downloading/uploading
    // bytes. A slower, earlier callback must not overwrite a save that completed
    // while its transfer was in flight, even when both hashes are first-seen.
    const recovery =
      (Boolean(existing) && args.wopiLock === undefined) ||
      (args.wopiLock === undefined && document.currentRevision !== session.lastRevision) ||
      document.currentRevision !== args.expectedRevision;
    const createdAt = now();
    await ctx.db.insert('officeVersions', {
      userId: args.userId,
      documentId: args.documentId,
      revision,
      storageId: args.storageId,
      sha256: args.sha256,
      size: args.size,
      sessionId: args.sessionId,
      recovery,
      createdAt,
    });
    if (!recovery) {
      await ctx.db.patch(document._id, {
        currentRevision: revision,
        updatedAt: createdAt,
        ...(args.saveRequestId ? { lastWopiSave: { id: args.saveRequestId, revision } } : {}),
      });
      await ctx.db.patch(session._id, { lastRevision: revision });
    }
    return {
      ok: !recovery,
      code: recovery ? 'REVISION_CONFLICT' : undefined,
      revision,
      updatedAt: createdAt,
    };
  },
});

export const wopiLock = mutation({
  args: {
    ...owner,
    documentId: v.string(),
    sessionId: v.string(),
    operation: v.union(
      v.literal('LOCK'),
      v.literal('REFRESH_LOCK'),
      v.literal('UNLOCK'),
      v.literal('GET_LOCK'),
    ),
    value: v.string(),
    oldValue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await owned(ctx, args.userId, args.documentId);
    const session = await ctx.db
      .query('officeSessions')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .unique();
    if (
      !document ||
      session?.userId !== args.userId ||
      session.documentId !== args.documentId ||
      session.expiresAt <= now()
    )
      return { ok: false, value: '' };
    const lock = document.wopiLock && document.wopiLock.expiresAt > now() ? document.wopiLock : undefined;
    if (args.operation === 'GET_LOCK') return { ok: true, value: lock?.value || '' };
    if (lock && lock.value !== (args.oldValue ?? args.value)) return { ok: false, value: lock.value };
    if (!lock && args.operation !== 'LOCK') return { ok: false, value: '' };
    if (args.operation === 'UNLOCK') await ctx.db.patch(document._id, { wopiLock: undefined });
    else
      await ctx.db.patch(document._id, {
        wopiLock: { value: args.value, sessionId: args.sessionId, expiresAt: now() + 30 * 60_000 },
      });
    return { ok: true, value: args.operation === 'UNLOCK' ? '' : args.value };
  },
});

export const linkGoogle = mutation({
  args: {
    ...owner,
    documentId: v.string(),
    expectedSession: v.string(),
    session: v.string(),
    syncedRevision: v.number(),
    providerVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await owned(ctx, args.userId, args.documentId);
    if (!document?.google) return { ok: false };
    const validVersion = args.providerVersion && /^\d+$/.test(args.providerVersion);
    if (document.google.session !== args.expectedSession) {
      // A completed Google write must remain recoverable even if every CAS retry races.
      const pending = document.google.pendingSave;
      if (validVersion && (!pending || BigInt(args.providerVersion!) >= BigInt(pending.providerVersion)))
        await ctx.db.patch(document._id, {
          google: {
            ...document.google,
            pendingSave: {
              session: args.session,
              revision: args.syncedRevision,
              providerVersion: args.providerVersion!,
            },
          },
        });
      return { ok: false };
    }
    const pending = document.google.pendingSave;
    const clearPending =
      pending && validVersion && BigInt(args.providerVersion!) >= BigInt(pending.providerVersion);
    await ctx.db.patch(document._id, {
      google: {
        ...document.google,
        session: args.session,
        syncedRevision: args.syncedRevision,
        ...(clearPending ? { pendingSave: undefined } : {}),
      },
    });
    return { ok: true };
  },
});

/** Find a pre-existing Google working copy, including older etag-derived IDs. */
export const findGoogle = query({
  args: { ...owner, connectionId: v.string(), fileId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.db
      .query('officeDocuments')
      .withIndex('by_user_updated', (q) => q.eq('userId', args.userId))
      .filter((q) =>
        q.and(
          q.eq(q.field('google.connectionId'), args.connectionId),
          q.eq(q.field('google.fileId'), args.fileId),
        ),
      )
      .order('desc')
      .first();
  },
});

/** Import provider changes atomically only over a clean, unlocked working copy. */
export const refreshGoogle = mutation({
  args: {
    ...owner,
    documentId: v.string(),
    expectedSession: v.string(),
    expectedRevision: v.number(),
    session: v.string(),
    storageId: v.id('_storage'),
    sha256: v.string(),
    size: v.number(),
    title: v.string(),
    extension: v.union(v.literal('docx'), v.literal('xlsx'), v.literal('pptx')),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const document = await owned(ctx, args.userId, args.documentId);
    if (
      !document?.google ||
      document.google.session !== args.expectedSession ||
      document.currentRevision !== args.expectedRevision ||
      document.google.syncedRevision !== document.currentRevision ||
      (document.wopiLock && document.wopiLock.expiresAt > now())
    ) {
      await ctx.storage.delete(args.storageId);
      return { ok: false };
    }
    const latest = await ctx.db
      .query('officeVersions')
      .withIndex('by_user_document_revision', (q) =>
        q.eq('userId', args.userId).eq('documentId', args.documentId),
      )
      .order('desc')
      .first();
    const revision = (latest?.revision ?? document.currentRevision) + 1;
    const createdAt = now();
    await ctx.db.insert('officeVersions', {
      userId: args.userId,
      documentId: args.documentId,
      revision,
      storageId: args.storageId,
      sha256: args.sha256,
      size: args.size,
      recovery: false,
      createdAt,
    });
    await ctx.db.patch(document._id, {
      currentRevision: revision,
      title: args.title,
      extension: args.extension,
      updatedAt: createdAt,
      google: { ...document.google, session: args.session, syncedRevision: revision, pendingSave: undefined },
      lastWopiSave: undefined,
      wopiLock: undefined,
    });
    // Invalidate stale editors before they can reacquire a lock over the refreshed content.
    const sessions = await ctx.db
      .query('officeSessions')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .filter((q) => q.eq(q.field('documentId'), args.documentId))
      .collect();
    for (const session of sessions) await ctx.db.delete(session._id);
    return { ok: true, revision };
  },
});
