import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, mutation } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Native OAuth callbacks (mailbox and tool connections) arrive in the system
// browser with no Clerk session. The callback keeps the provider result here,
// bound to the user who started the flow, and sends the app a single-use
// token. The signed-in app redeems the token through an authenticated
// finalize route. A link that an attacker starts and a victim approves thus
// never attaches the victim's account to the attacker.

const kindValidator = v.union(v.literal('mail'), v.literal('mcp'));
const SWEEP_BATCH_SIZE = 100;

export const save = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: kindValidator,
    tokenHash: v.string(),
    payloadEncrypted: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('oauthCompletions')
      .withIndex('by_token', (q) => q.eq('tokenHash', args.tokenHash))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert('oauthCompletions', {
      userId: args.userId,
      kind: args.kind,
      tokenHash: args.tokenHash,
      payloadEncrypted: args.payloadEncrypted,
      expiresAt: args.expiresAt,
      createdAt: now(),
    });
    await ctx.scheduler.runAfter(
      Math.max(0, args.expiresAt - now()),
      internal.oauthCompletions.sweepExpired,
      {},
    );
    return { ok: true };
  },
});

// A token of another user or another flow does not match and stays in place,
// so a wrong caller cannot burn the completion of the real owner.
export const consume = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: kindValidator,
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('oauthCompletions')
      .withIndex('by_token', (q) => q.eq('tokenHash', args.tokenHash))
      .unique();
    if (!row || row.userId !== args.userId || row.kind !== args.kind) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt < now()) return null;
    return { payloadEncrypted: row.payloadEncrypted };
  },
});

export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query('oauthCompletions')
      .withIndex('by_expires', (q) => q.lte('expiresAt', now()))
      .take(SWEEP_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === SWEEP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.oauthCompletions.sweepExpired, {});
    }
    return { deleted: expired.length };
  },
});
