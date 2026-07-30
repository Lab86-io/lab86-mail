import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Codes are only useful for minutes and are dangerous for longer, so every read
// path re-checks the expiry rather than trusting the stored status. A sweep
// eventually flips the row, but a lagging sweep must never hand out a live
// secret past its window.
const MAX_ACTIVE_CODES = 20;

async function authenticatedUserId(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

async function callerUserId(ctx: QueryCtx | MutationCtx, args: { internalSecret?: string; userId?: string }) {
  if (args.internalSecret !== undefined) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('userId required with internal secret.');
    return args.userId;
  }
  return authenticatedUserId(ctx);
}

export const recordCode = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerMessageId: v.string(),
    providerThreadId: v.string(),
    code: v.string(),
    label: v.string(),
    issuer: v.string(),
    serviceIdentifiers: v.array(v.string()),
    confidence: v.number(),
    receivedAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    if (args.expiresAt <= ts) return { codeId: null, created: false, reason: 'already_expired' as const };

    // A redelivered webhook re-ingests the same message. One code per message
    // keeps that idempotent without needing the event id here.
    const existing = await ctx.db
      .query('mailOneTimeCodes')
      .withIndex('by_user_message', (q) =>
        q.eq('userId', args.userId).eq('providerMessageId', args.providerMessageId),
      )
      .unique();
    if (existing) return { codeId: existing._id, created: false, reason: 'duplicate' as const };

    const codeId = await ctx.db.insert('mailOneTimeCodes', {
      userId: args.userId,
      accountId: args.accountId,
      providerMessageId: args.providerMessageId,
      providerThreadId: args.providerThreadId,
      code: args.code,
      label: args.label,
      issuer: args.issuer,
      serviceIdentifiers: args.serviceIdentifiers,
      confidence: args.confidence,
      receivedAt: args.receivedAt,
      expiresAt: args.expiresAt,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    });
    return { codeId, created: true, reason: 'created' as const };
  },
});

export const activeCodes = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await callerUserId(ctx, args);
    const ts = now();
    const rows = await ctx.db
      .query('mailOneTimeCodes')
      .withIndex('by_user_status_expires', (q) =>
        q.eq('userId', userId).eq('status', 'active').gt('expiresAt', ts),
      )
      .order('desc')
      .take(MAX_ACTIVE_CODES);
    return rows.map((row) => ({
      id: String(row._id),
      code: row.code,
      label: row.label,
      issuer: row.issuer,
      serviceIdentifiers: row.serviceIdentifiers,
      accountId: row.accountId,
      providerMessageId: row.providerMessageId,
      providerThreadId: row.providerThreadId,
      receivedAt: row.receivedAt,
      expiresAt: row.expiresAt,
    }));
  },
});

/**
 * Marks a code used and reports the message that carried it so the caller can
 * clean it up. Idempotent: a retried consume returns the same locator instead
 * of failing, because the extension cannot reliably observe its own success.
 */
export const markUsed = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.optional(v.string()),
    codeId: v.id('mailOneTimeCodes'),
  },
  handler: async (ctx, args) => {
    const userId = await callerUserId(ctx, args);
    const row = await ctx.db.get(args.codeId);
    if (!row || row.userId !== userId) throw new Error('Code not found.');
    const ts = now();
    if (row.status === 'active') {
      await ctx.db.patch(args.codeId, { status: 'used', usedAt: ts, updatedAt: ts });
    }
    return {
      accountId: row.accountId,
      providerMessageId: row.providerMessageId,
      providerThreadId: row.providerThreadId,
      alreadyUsed: row.status !== 'active',
      cleanup: row.cleanup ?? null,
    };
  },
});

export const recordCleanup = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.optional(v.string()),
    codeId: v.id('mailOneTimeCodes'),
    cleanup: v.union(v.literal('pending'), v.literal('archived'), v.literal('trashed'), v.literal('failed')),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await callerUserId(ctx, args);
    const row = await ctx.db.get(args.codeId);
    if (!row || row.userId !== userId) throw new Error('Code not found.');
    await ctx.db.patch(args.codeId, {
      cleanup: args.cleanup,
      cleanupError: args.error?.slice(0, 300),
      updatedAt: now(),
    });
    return { ok: true };
  },
});

/**
 * Flips lapsed rows and drops long-dead ones. Expiry is enforced on read, so
 * this is housekeeping rather than a correctness guarantee.
 */
export const purgeExpired = mutation({
  args: { internalSecret: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const limit = Math.min(500, Math.max(1, Math.round(args.limit ?? 200)));
    const lapsed = await ctx.db
      .query('mailOneTimeCodes')
      .withIndex('by_expires', (q) => q.lt('expiresAt', ts))
      .take(limit);
    let expired = 0;
    let deleted = 0;
    for (const row of lapsed) {
      // Keep a used or freshly-expired row briefly so a retried consume still
      // finds its locator, then remove the secret entirely.
      if (row.expiresAt < ts - 86_400_000) {
        await ctx.db.delete(row._id);
        deleted += 1;
        continue;
      }
      if (row.status === 'active') {
        await ctx.db.patch(row._id, { status: 'expired', updatedAt: ts });
        expired += 1;
      }
    }
    return { expired, deleted };
  },
});
