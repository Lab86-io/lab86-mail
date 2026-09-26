import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, mutation, type QueryCtx, query } from './_generated/server';
import { requireInternalSecret } from './lib';

const identity = { internalSecret: v.string(), userId: v.string(), key: v.string() };
const internalApi = internal.mailOutbox;
const find = (ctx: QueryCtx, args: { userId: string; key: string }) =>
  ctx.db
    .query('mailOutbox')
    .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', args.key))
    .unique();
const receipt = (row: { key: string; fireAt: number; undoSeconds: number; status: string }) => ({
  id: row.key,
  fireAt: row.fireAt,
  undoSeconds: row.undoSeconds,
  status: row.status,
});

export const uploadUrl = mutation({
  args: { internalSecret: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.storage.generateUploadUrl();
  },
});

export const enqueue = mutation({
  args: { ...identity, payloadId: v.id('_storage'), undoSeconds: v.number() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!/^outbox:[a-f0-9-]{36}$/.test(args.key)) throw new Error('Invalid send key');
    const existing = await find(ctx, args);
    if (existing) {
      if (existing.payloadId !== args.payloadId) await ctx.storage.delete(args.payloadId);
      return receipt(existing);
    }
    // No provider request exists until this durable deadline has passed.
    const undoSeconds = Math.min(300, Math.max(1, Math.floor(args.undoSeconds)));
    const fireAt = Date.now() + undoSeconds * 1_000;
    const id = await ctx.db.insert('mailOutbox', {
      userId: args.userId,
      key: args.key,
      payloadId: args.payloadId,
      status: 'pending',
      fireAt,
      undoSeconds,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAt(fireAt, internalApi.dispatch, {
      userId: args.userId,
      key: args.key,
      attempt: 0,
    });
    await ctx.scheduler.runAfter(7 * 86400_000, internalApi.cleanup, { id });
    return { id: args.key, fireAt, undoSeconds, status: 'pending' };
  },
});

export const cancel = mutation({
  args: identity,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!/^outbox:[a-f0-9-]{36}$/.test(args.key)) throw new Error('Invalid send key');
    const row = await find(ctx, args);
    if (!row) {
      // Undo can win while an upload/prepare request is still in flight.
      const id = await ctx.db.insert('mailOutbox', {
        userId: args.userId,
        key: args.key,
        status: 'cancelled',
        fireAt: Date.now(),
        undoSeconds: 0,
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(7 * 86400_000, internalApi.cleanup, { id });
      return true;
    }
    if (row.status === 'cancelled') return true;
    if (row.status !== 'pending') return false;
    await ctx.db.patch(row._id, { status: 'cancelled', updatedAt: Date.now(), payloadId: undefined });
    if (row.payloadId) await ctx.storage.delete(row.payloadId);
    return true;
  },
});

export const status = query({
  args: identity,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await find(ctx, args);
    return row ? receipt(row) : { status: 'unknown' };
  },
});

export const claim = mutation({
  args: identity,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await find(ctx, args);
    if (!row || row.status !== 'pending' || row.fireAt > Date.now() || !row.payloadId) return null;
    const url = await ctx.storage.getUrl(row.payloadId);
    if (!url) {
      await ctx.db.patch(row._id, { status: 'failed', updatedAt: Date.now() });
      return null;
    }
    // Atomic with cancel: only one worker can cross the provider handoff.
    await ctx.db.patch(row._id, { status: 'sending', updatedAt: Date.now() });
    await ctx.scheduler.runAfter(120_000, internalApi.handoffExpired, { userId: args.userId, key: args.key });
    return { url };
  },
});

export const complete = mutation({
  args: {
    ...identity,
    status: v.union(v.literal('sent'), v.literal('failed'), v.literal('unknown')),
    messageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await find(ctx, args);
    if (!row || !['sending', 'unknown'].includes(row.status)) return;
    await ctx.db.patch(row._id, { status: args.status, messageId: args.messageId, updatedAt: Date.now() });
    if (args.status === 'sent' && row.payloadId) {
      await ctx.storage.delete(row.payloadId);
      await ctx.db.patch(row._id, { payloadId: undefined });
    }
  },
});

export const dispatch = internalAction({
  args: { userId: v.string(), key: v.string(), attempt: v.number() },
  handler: async (ctx, args) => {
    const origin = process.env.LAB86_MAIL_PUBLIC_URL;
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    try {
      if (!origin || !secret) throw new Error('Missing outbox configuration');
      const response = await fetch(`${origin.replace(/\/$/, '')}/api/cron/mail-outbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lab86-internal-secret': secret },
        body: JSON.stringify({ userId: args.userId, key: args.key }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Dispatch returned ${response.status}`);
    } catch {
      // Retrying the callback is safe: claim never releases a sending row, so
      // a lost response cannot trigger another provider send.
      if (args.attempt < 4)
        await ctx.scheduler.runAfter(5_000 * (args.attempt + 1), internalApi.dispatch, {
          ...args,
          attempt: args.attempt + 1,
        });
      else await ctx.runMutation(internalApi.dispatchFailed, { userId: args.userId, key: args.key });
    }
  },
});

export const dispatchFailed = internalMutation({
  args: { userId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const row = await find(ctx, args);
    if (row?.status === 'pending') await ctx.db.patch(row._id, { status: 'failed', updatedAt: Date.now() });
  },
});

export const cleanup = internalMutation({
  args: { id: v.id('mailOutbox') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row?.payloadId) await ctx.storage.delete(row.payloadId);
    if (row) await ctx.db.delete(row._id);
  },
});

export const handoffExpired = internalMutation({
  args: { userId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const row = await find(ctx, args);
    if (row?.status === 'sending') await ctx.db.patch(row._id, { status: 'unknown', updatedAt: Date.now() });
  },
});
