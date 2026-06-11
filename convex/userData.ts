import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Backing store for all per-user app state (see schema.ts userDocs). Every
// access path is scoped by userId — this is the tenancy boundary that the old
// NeDB file store did not have.

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
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 500), 1), 1000);
    const ref = args.ref;
    const rows = ref
      ? await ctx.db
          .query('userDocs')
          .withIndex('by_user_kind_ref', (q) =>
            q.eq('userId', args.userId).eq('kind', args.kind).eq('ref', ref),
          )
          .order('desc')
          .take(limit)
      : await ctx.db
          .query('userDocs')
          .withIndex('by_user_kind', (q) => q.eq('userId', args.userId).eq('kind', args.kind))
          .order('desc')
          .take(limit);
    return rows.map((row) => ({ key: row.key, ref: row.ref, doc: row.doc, updatedAt: row.updatedAt }));
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
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const existing = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) =>
        q.eq('userId', args.userId).eq('kind', args.kind).eq('key', args.key),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { doc: args.doc, ref: args.ref, updatedAt: ts });
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
    return { ok: true, created: true };
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
    if (existing) await ctx.db.delete(existing._id);
    return { ok: true, deleted: Boolean(existing) };
  },
});

export const deleteDocs = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
    ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ref = args.ref;
    const rows = ref
      ? await ctx.db
          .query('userDocs')
          .withIndex('by_user_kind_ref', (q) =>
            q.eq('userId', args.userId).eq('kind', args.kind).eq('ref', ref),
          )
          .collect()
      : await ctx.db
          .query('userDocs')
          .withIndex('by_user_kind', (q) => q.eq('userId', args.userId).eq('kind', args.kind))
          .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return { ok: true, deleted: rows.length };
  },
});
