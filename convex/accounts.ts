// @ts-nocheck
import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const providerValidator = v.union(
  v.literal('google'),
  v.literal('microsoft'),
  v.literal('icloud'),
  v.literal('imap'),
);

export const createOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    state: v.string(),
    provider: v.string(),
    redirectTo: v.optional(v.string()),
    ttlMs: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    await ctx.db.insert('nylasOAuthStates', {
      state: args.state,
      userId: args.userId,
      provider: args.provider,
      redirectTo: args.redirectTo,
      createdAt: ts,
      expiresAt: ts + args.ttlMs,
    });
    return { ok: true };
  },
});

export const consumeOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('nylasOAuthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (!row || row.consumedAt || row.expiresAt < now()) return null;
    await ctx.db.patch(row._id, { consumedAt: now() });
    return row;
  },
});

export const listConnectedAccounts = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
  },
});

export const getConnectedAccount = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
  },
});

export const getConnectedAccountByGrant = query({
  args: {
    internalSecret: v.optional(v.string()),
    grantId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.db
      .query('connectedAccounts')
      .withIndex('by_grant', (q) => q.eq('grantId', args.grantId))
      .unique();
  },
});

export const upsertConnectedAccount = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    email: v.string(),
    provider: providerValidator,
    grantId: v.string(),
    accessTokenEncrypted: v.optional(v.string()),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    scopes: v.array(v.string()),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const email = args.email.toLowerCase();
    const id = args.grantId;
    const ts = now();
    const existing = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', id))
      .unique();
    const accountPatch = {
      accountId: id,
      email,
      provider: args.provider,
      status: 'connected' as const,
      displayName: args.displayName,
      scopes: args.scopes,
      grantId: args.grantId,
      error: undefined,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, accountPatch);
    } else {
      await ctx.db.insert('connectedAccounts', {
        userId: args.userId,
        ...accountPatch,
        createdAt: ts,
      });
    }

    const grant = await ctx.db
      .query('providerGrants')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', id))
      .unique();
    const grantPatch = {
      provider: args.provider,
      grantId: args.grantId,
      email,
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      updatedAt: ts,
    };
    if (grant) {
      await ctx.db.patch(grant._id, grantPatch);
    } else {
      await ctx.db.insert('providerGrants', {
        userId: args.userId,
        accountId: id,
        ...grantPatch,
        createdAt: ts,
      });
    }

    const syncState = await ctx.db
      .query('mailSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', id))
      .unique();
    if (!syncState) {
      await ctx.db.insert('mailSyncStates', {
        userId: args.userId,
        accountId: id,
        grantId: args.grantId,
        provider: args.provider,
        status: 'idle' as const,
        corpusReady: false,
        error: undefined,
        createdAt: ts,
        updatedAt: ts,
      });
    } else if (syncState.grantId !== args.grantId) {
      // A new grant invalidates the old corpus cursors; restart from idle.
      await ctx.db.patch(syncState._id, {
        grantId: args.grantId,
        provider: args.provider,
        status: 'idle' as const,
        corpusReady: false,
        cursor: undefined,
        error: undefined,
        updatedAt: ts,
      });
    } else {
      // Same-grant reconnects/token refreshes must not revoke an
      // already-synced corpus or restart backfill.
      await ctx.db.patch(syncState._id, { provider: args.provider, updatedAt: ts });
    }
    return { accountId: id };
  },
});

export const updateConnectedAccountAlias = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (!row) throw new Error('Connected account not found');
    const displayName = (args.displayName || '').trim().slice(0, 80) || undefined;
    await ctx.db.patch(row._id, {
      displayName,
      updatedAt: now(),
    });
    return { ok: true };
  },
});

export const deleteConnectedAccount = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const tables = [
      'connectedAccounts',
      'providerGrants',
      'threads',
      'messages',
      'syncJobs',
      'mailCorpusThreads',
      'mailCorpusMessages',
      'mailSyncStates',
      'mailWebhookEvents',
    ] as const;
    for (const table of tables) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_user_account' as any, (q: any) =>
          q.eq('userId', args.userId).eq('accountId', args.accountId),
        )
        .collect()
        .catch(async () =>
          ctx.db
            .query(table)
            .withIndex('by_account' as any, (q: any) => q.eq('accountId', args.accountId))
            .collect(),
        );
      for (const row of rows) await ctx.db.delete(row._id);
    }

    const reports = await ctx.db
      .query('dailyReports')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const report of reports) {
      if (report.accountIds.includes(args.accountId)) await ctx.db.delete(report._id);
    }

    const memories = await ctx.db
      .query('memories')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const memory of memories) {
      if (!memory.sourceAccountIds.includes(args.accountId)) continue;
      const remaining = memory.sourceAccountIds.filter((id) => id !== args.accountId);
      if (memory.userPinned) {
        await ctx.db.patch(memory._id, { sourceAccountIds: remaining, updatedAt: now() });
      } else if (remaining.length) {
        await ctx.db.patch(memory._id, { sourceAccountIds: remaining, updatedAt: now() });
      } else {
        await ctx.db.delete(memory._id);
      }
    }
    return { ok: true };
  },
});

export const deleteUserCascade = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const counts: Record<string, number> = {};
    const userTables = [
      'connectedAccounts',
      'providerGrants',
      'nylasOAuthStates',
      'aiSettings',
      'aiProviderKeys',
      'aiEntitlements',
      'aiUsagePeriods',
      'aiUsageEvents',
      'threads',
      'messages',
      'dailyReports',
      'memories',
      'auditEvents',
      'syncJobs',
      'mailCorpusThreads',
      'mailCorpusMessages',
      'mailSyncStates',
      'mailWebhookEvents',
      'rateLimits',
    ] as const;

    for (const table of userTables) {
      const rows = await rowsByUser(ctx, table, args.userId);
      counts[table] = rows.length;
      for (const row of rows) await ctx.db.delete(row._id);
    }

    const userRows = await ctx.db
      .query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .collect();
    counts.users = userRows.length;
    for (const row of userRows) await ctx.db.delete(row._id);

    return { ok: true, counts };
  },
});

async function rowsByUser(ctx: any, table: string, userId: string) {
  return await ctx.db
    .query(table)
    .withIndex('by_user' as any, (q: any) => q.eq('userId', userId))
    .collect()
    .catch(async () =>
      ctx.db
        .query(table)
        .withIndex('by_user_account' as any, (q: any) => q.eq('userId', userId))
        .collect(),
    );
}
