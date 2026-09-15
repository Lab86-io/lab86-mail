import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const owner = { internalSecret: v.optional(v.string()), userId: v.string() };
const attribution = v.object({
  title: v.string(),
  artist: v.string(),
  date: v.string(),
  credit: v.string(),
  source: v.string(),
  sourceUrl: v.string(),
  license: v.string(),
  style: v.optional(v.string()),
});

export const uploadUrl = mutation({
  args: owner,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.storage.generateUploadUrl();
  },
});

/** Record an uploaded image. A duplicate by hash returns the existing asset and drops the new blob. */
export const create = mutation({
  args: {
    ...owner,
    storageId: v.id('_storage'),
    mime: v.string(),
    size: v.number(),
    width: v.number(),
    height: v.number(),
    sha256: v.string(),
    attribution: v.optional(attribution),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('documentAssets')
      .withIndex('by_user_hash', (q) => q.eq('userId', args.userId).eq('sha256', args.sha256))
      .first();
    if (existing) {
      if (existing.storageId !== args.storageId) await ctx.storage.delete(args.storageId);
      return {
        assetId: existing._id,
        url: await ctx.storage.getUrl(existing.storageId),
        width: existing.width,
        height: existing.height,
        mime: existing.mime,
        size: existing.size,
        attribution: existing.attribution,
      };
    }
    const id = await ctx.db.insert('documentAssets', {
      userId: args.userId,
      storageId: args.storageId,
      mime: args.mime,
      size: args.size,
      width: args.width,
      height: args.height,
      sha256: args.sha256,
      createdAt: now(),
      ...(args.attribution ? { attribution: args.attribution } : {}),
    });
    return {
      assetId: id,
      url: await ctx.storage.getUrl(args.storageId),
      width: args.width,
      height: args.height,
      mime: args.mime,
      size: args.size,
      attribution: args.attribution,
    };
  },
});

export const get = query({
  args: { ...owner, assetId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const id = ctx.db.normalizeId('documentAssets', args.assetId);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row || row.userId !== args.userId) return null;
    return {
      assetId: row._id,
      url: await ctx.storage.getUrl(row.storageId),
      width: row.width,
      height: row.height,
      mime: row.mime,
      size: row.size,
      attribution: row.attribution,
    };
  },
});

export const remove = mutation({
  args: { ...owner, assetId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const id = ctx.db.normalizeId('documentAssets', args.assetId);
    if (!id) return false;
    const row = await ctx.db.get(id);
    if (!row || row.userId !== args.userId) return false;
    await ctx.storage.delete(row.storageId);
    await ctx.db.delete(id);
    return true;
  },
});
