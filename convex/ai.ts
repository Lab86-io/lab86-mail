// @ts-nocheck
import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { currentPeriod, now, requireInternalSecret } from './lib';

const providerValidator = v.union(v.literal('openrouter'), v.literal('openai'), v.literal('anthropic'));
const modeValidator = v.union(v.literal('lab86'), v.literal('byok'));

export const getRuntimeState = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    period: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const settings = await ctx.db
      .query('aiSettings')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    const key = settings?.provider
      ? await ctx.db
          .query('aiProviderKeys')
          .withIndex('by_user_provider', (q) =>
            q.eq('userId', args.userId).eq('provider', settings.provider!),
          )
          .unique()
      : null;
    const entitlement = await ctx.db
      .query('aiEntitlements')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    const period = args.period || currentPeriod();
    const lab86Usage = await ctx.db
      .query('aiUsagePeriods')
      .withIndex('by_user_period_source', (q) =>
        q.eq('userId', args.userId).eq('period', period).eq('source', 'lab86'),
      )
      .unique();
    return { settings, key, entitlement, lab86Usage, period };
  },
});

export const upsertSettings = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    mode: modeValidator,
    provider: v.optional(providerValidator),
    model: v.optional(v.string()),
    fastModel: v.optional(v.string()),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const existing = await ctx.db
      .query('aiSettings')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    const patch = {
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      fastModel: args.fastModel,
      enabled: args.enabled,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert('aiSettings', {
      userId: args.userId,
      ...patch,
      createdAt: ts,
    });
  },
});

export const upsertProviderKey = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    provider: providerValidator,
    encryptedKey: v.string(),
    fingerprint: v.string(),
    masked: v.string(),
    validatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const existing = await ctx.db
      .query('aiProviderKeys')
      .withIndex('by_user_provider', (q) => q.eq('userId', args.userId).eq('provider', args.provider))
      .unique();
    const patch = {
      encryptedKey: args.encryptedKey,
      fingerprint: args.fingerprint,
      masked: args.masked,
      validatedAt: args.validatedAt,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert('aiProviderKeys', {
      userId: args.userId,
      provider: args.provider,
      ...patch,
      createdAt: ts,
    });
  },
});

export const deleteProviderKey = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    provider: providerValidator,
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('aiProviderKeys')
      .withIndex('by_user_provider', (q) => q.eq('userId', args.userId).eq('provider', args.provider))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return { ok: true };
  },
});

export const upsertEntitlement = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    plan: v.union(v.literal('free'), v.literal('pro'), v.literal('admin')),
    status: v.union(
      v.literal('inactive'),
      v.literal('active'),
      v.literal('trialing'),
      v.literal('past_due'),
      v.literal('canceled'),
    ),
    source: v.union(v.literal('manual'), v.literal('stripe'), v.literal('clerk')),
    monthlyCredits: v.number(),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const existing = await ctx.db
      .query('aiEntitlements')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .unique();
    const patch = {
      plan: args.plan,
      status: args.status,
      source: args.source,
      monthlyCredits: args.monthlyCredits,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      currentPeriodEnd: args.currentPeriodEnd,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert('aiEntitlements', {
      userId: args.userId,
      ...patch,
      createdAt: ts,
    });
  },
});

export const recordUsage = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    feature: v.string(),
    source: v.union(v.literal('lab86'), v.literal('byok'), v.literal('legacy')),
    provider: v.string(),
    model: v.string(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    estimatedCredits: v.number(),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    await ctx.db.insert('aiUsageEvents', {
      userId: args.userId,
      feature: args.feature,
      source: args.source,
      provider: args.provider,
      model: args.model,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      totalTokens: args.totalTokens,
      estimatedCredits: args.estimatedCredits,
      ok: args.ok,
      error: args.error,
      createdAt: ts,
    });
    if (args.source === 'lab86' || args.source === 'byok') {
      const period = currentPeriod(ts);
      const existing = await ctx.db
        .query('aiUsagePeriods')
        .withIndex('by_user_period_source', (q) =>
          q.eq('userId', args.userId).eq('period', period).eq('source', args.source),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          creditsUsed: existing.creditsUsed + args.estimatedCredits,
          calls: existing.calls + 1,
          updatedAt: ts,
        });
      } else {
        await ctx.db.insert('aiUsagePeriods', {
          userId: args.userId,
          period,
          source: args.source,
          creditsUsed: args.estimatedCredits,
          calls: 1,
          updatedAt: ts,
        });
      }
    }
    return { ok: true };
  },
});
