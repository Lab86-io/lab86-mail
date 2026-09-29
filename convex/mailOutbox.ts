import { v } from 'convex/values';
import { internal } from './_generated/api';
import {
  internalAction,
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from './_generated/server';
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

/** The held sends that one pass cancels. One pass is one bounded transaction. */
export const HELD_SEND_BATCH = 50;

/**
 * The pending held sends of one mailbox, oldest first. With `until`, only the
 * sends that were made at that time or before.
 */
const heldSends = (ctx: MutationCtx, userId: string, accountId: string, until?: number) =>
  ctx.db.query('mailOutbox').withIndex('by_user_account_scheduled_status', (q) => {
    const range = q
      .eq('userId', userId)
      .eq('accountId', accountId)
      .eq('scheduled', true)
      .eq('status', 'pending');
    return until === undefined ? range : range.lte('_creationTime', until);
  });

/** Cancels one batch of held sends and deletes their stored messages. */
async function cancelHeldSendsPass(ctx: MutationCtx, userId: string, accountId: string, until?: number) {
  const rows = await heldSends(ctx, userId, accountId, until).take(HELD_SEND_BATCH);
  for (const send of rows) {
    await ctx.db.patch(send._id, { status: 'cancelled', payloadId: undefined, updatedAt: Date.now() });
    if (send.payloadId) await ctx.storage.delete(send.payloadId).catch(() => undefined);
  }
  return rows.length;
}

/**
 * Schedules the next pass when held sends are left. The pass gets the
 * creation time of the newest send that is left now, so it cancels only the
 * sends of the connection that goes. A send of a later connection of the same
 * mailbox stays.
 */
async function continueWhenSendsAreLeft(ctx: MutationCtx, userId: string, accountId: string, until?: number) {
  const newest = await heldSends(ctx, userId, accountId, until).order('desc').first();
  if (!newest) return false;
  await ctx.scheduler.runAfter(0, internalApi.cancelHeldSendsBatch, {
    userId,
    accountId,
    until: newest._creationTime,
  });
  return true;
}

/**
 * Cancels the held scheduled sends of one mailbox and deletes their stored
 * messages. A direct Google account holds a scheduled send here until
 * `fireAt` (Gmail has no scheduled send). Each disconnect path calls this:
 * the grant removal (googleDirect.removeGrant) and the account removal
 * (accounts.deleteConnectedAccount), so no message stays stored when one of
 * them fails. A message that is gone already does not stop the disconnect.
 *
 * The design: this call cancels the first batch (HELD_SEND_BATCH) in the
 * transaction of the caller, which is all the sends of a usual mailbox. When
 * more are left, it schedules cancelHeldSendsBatch in the same transaction.
 * Convex runs a scheduled mutation exactly one time after the transaction
 * commits, so a disconnect that commits always gets the rest of the chain,
 * and a disconnect that fails schedules nothing. Each pass does at most one
 * batch of writes and storage deletes. A cancelled send leaves the index
 * range, so the chain always ends. A loop in one transaction would not be
 * simpler: it needs a cap and a continuation too.
 * Returns the count of sends that this call cancelled (the first batch).
 */
export async function cancelHeldSends(ctx: MutationCtx, userId: string, accountId: string) {
  const cancelled = await cancelHeldSendsPass(ctx, userId, accountId);
  if (cancelled === HELD_SEND_BATCH) await continueWhenSendsAreLeft(ctx, userId, accountId);
  return cancelled;
}

/** One later pass of cancelHeldSends. A pass schedules the next while sends are left. */
export const cancelHeldSendsBatch = internalMutation({
  args: { userId: v.string(), accountId: v.string(), until: v.number() },
  handler: async (ctx, args) => {
    const cancelled = await cancelHeldSendsPass(ctx, args.userId, args.accountId, args.until);
    const more =
      cancelled === HELD_SEND_BATCH &&
      (await continueWhenSendsAreLeft(ctx, args.userId, args.accountId, args.until));
    return { cancelled, done: !more };
  },
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
