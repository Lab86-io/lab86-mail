import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { assertBriefJobOwner, briefJobFence } from './briefJobState';
import { now, requireInternalSecret } from './lib';
import { requestSmartReclassify } from './smart';

// Backing store for all per-user app state (see schema.ts userDocs). Every
// access path is scoped by userId — this is the tenancy boundary that the old
// NeDB file store did not have.

// Smart rules/labels feed the write-time thread classifier; editing one makes
// every stored verdict for that user stale, so changes ask for a background
// re-sweep of their corpus. Each user has at most one sweep chain at a time.
const RECLASSIFY_KINDS = new Set(['smartRule', 'smartLabel']);

async function maybeScheduleReclassify(ctx: any, kind: string, userId: string) {
  if (!RECLASSIFY_KINDS.has(kind)) return;
  await requestSmartReclassify(ctx, userId);
}

export const getDoc = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) =>
        q.eq('userId', args.userId).eq('kind', args.kind).eq('key', args.key),
      )
      .unique();
    return row ? { key: row.key, ref: row.ref, doc: row.doc, updatedAt: row.updatedAt } : null;
  },
});

export const compareAndSwapDoc = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
    key: v.string(),
    expectedRevision: v.union(v.string(), v.null()),
    doc: v.any(),
    ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    // This operation is intentionally restricted to brief input state.
    if (args.kind !== 'briefComponentState' || typeof args.doc?.revision !== 'string')
      throw new Error('Unsupported revisioned document');
    const row = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) =>
        q.eq('userId', args.userId).eq('kind', args.kind).eq('key', args.key),
      )
      .unique();
    if ((row?.doc?.revision ?? null) !== args.expectedRevision) return false;
    const values = {
      userId: args.userId,
      kind: args.kind,
      key: args.key,
      doc: args.doc,
      ref: args.ref,
      updatedAt: now(),
    };
    if (row) await ctx.db.patch(row._id, values);
    else await ctx.db.insert('userDocs', { ...values, createdAt: now() });
    return true;
  },
});

export const listDocs = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
    ref: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit =
      args.limit === undefined
        ? undefined
        : Math.min(Math.max(Math.floor(Number(args.limit) || 500), 1), 1000);
    const ref = args.ref;
    const query = ref
      ? ctx.db
          .query('userDocs')
          .withIndex('by_user_kind_ref_updatedAt', (q) =>
            q.eq('userId', args.userId).eq('kind', args.kind).eq('ref', ref),
          )
          .order('desc')
      : ctx.db
          .query('userDocs')
          .withIndex('by_user_kind_updatedAt', (q) => q.eq('userId', args.userId).eq('kind', args.kind))
          .order('desc');
    const rows = limit === undefined ? await query.collect() : await query.take(limit);
    return rows.map((row) => ({ key: row.key, ref: row.ref, doc: row.doc, updatedAt: row.updatedAt }));
  },
});

/** Read a bounded edition page in generation order, including existing stored reports. */
export const dailyReportPage = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    edition: v.optional(v.union(v.literal('morning'), v.literal('manual'), v.literal('weekly'))),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
    summaryOnly: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const editions = args.edition
      ? ctx.db
          .query('userDocs')
          .withIndex('by_user_kind_report_edition_generated', (q) =>
            q.eq('userId', args.userId).eq('kind', 'dailyReport').eq('doc.kind', args.edition),
          )
      : ctx.db
          .query('userDocs')
          .withIndex('by_user_kind_report_generated', (q) =>
            q.eq('userId', args.userId).eq('kind', 'dailyReport'),
          );
    // A Convex document can be 1 MiB. Eight records stay below the 16 MiB
    // execution read limit even when every edition carries a large HTML artifact.
    const result = await editions.order('desc').paginate({
      cursor: args.cursor,
      numItems: Math.min(8, Math.max(1, Math.floor(args.limit))),
    });
    return {
      ...result,
      page: result.page.map((row) =>
        args.summaryOnly
          ? {
              _id: row.key,
              kind: row.doc.kind || 'manual',
              generatedAt: row.doc.generatedAt || 0,
              title: row.doc.title || 'Daily Report',
              artifactStatus: row.doc.artifactStatus,
              editorial: row.doc.editorial ? { mode: row.doc.editorial.mode } : undefined,
            }
          : row.doc,
      ),
    };
  },
});

export const upsertDoc = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
    key: v.string(),
    ref: v.optional(v.string()),
    doc: v.any(),
    briefJob: v.optional(briefJobFence),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.briefJob) {
      if (args.kind !== 'dailyReport') throw new Error('Invalid brief job target');
      await assertBriefJobOwner(ctx, args.userId, args.briefJob, { reportId: args.key });
    }
    const ts = now();
    const existing = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) =>
        q.eq('userId', args.userId).eq('kind', args.kind).eq('key', args.key),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { doc: args.doc, ref: args.ref, updatedAt: ts });
      await maybeScheduleReclassify(ctx, args.kind, args.userId);
      return { ok: true, created: false };
    }
    await ctx.db.insert('userDocs', {
      userId: args.userId,
      kind: args.kind,
      key: args.key,
      ref: args.ref,
      doc: args.doc,
      createdAt: ts,
      updatedAt: ts,
    });
    await maybeScheduleReclassify(ctx, args.kind, args.userId);
    return { ok: true, created: true };
  },
});

export const createDocIfAbsent = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
    key: v.string(),
    ref: v.optional(v.string()),
    doc: v.any(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) =>
        q.eq('userId', args.userId).eq('kind', args.kind).eq('key', args.key),
      )
      .unique();
    if (existing) {
      return { ok: true, created: false, doc: existing.doc };
    }
    const ts = now();
    await ctx.db.insert('userDocs', {
      userId: args.userId,
      kind: args.kind,
      key: args.key,
      ref: args.ref,
      doc: args.doc,
      createdAt: ts,
      updatedAt: ts,
    });
    return { ok: true, created: true, doc: args.doc };
  },
});

export const deleteDoc = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) =>
        q.eq('userId', args.userId).eq('kind', args.kind).eq('key', args.key),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      await maybeScheduleReclassify(ctx, args.kind, args.userId);
    }
    return { ok: true, deleted: Boolean(existing) };
  },
});

export const deleteDocs = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
    ref: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ref = args.ref;
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 500), 1), 500);
    const rows = ref
      ? await ctx.db
          .query('userDocs')
          .withIndex('by_user_kind_ref', (q) =>
            q.eq('userId', args.userId).eq('kind', args.kind).eq('ref', ref),
          )
          .take(limit)
      : await ctx.db
          .query('userDocs')
          .withIndex('by_user_kind', (q) => q.eq('userId', args.userId).eq('kind', args.kind))
          .take(limit);
    for (const row of rows) await ctx.db.delete(row._id);
    return { ok: true, deleted: rows.length, hasMore: rows.length === limit };
  },
});
