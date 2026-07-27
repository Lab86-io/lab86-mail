// @ts-nocheck
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const providerValidator = v.union(v.literal('google_drive'), v.literal('onedrive'));
const CLEANUP_BATCH_SIZE = 100;

export const saveOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    state: v.string(),
    provider: providerValidator,
    redirectTo: v.optional(v.string()),
    nativeCallback: v.optional(v.boolean()),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('cloudFileOAuthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert('cloudFileOAuthStates', {
      userId: args.userId,
      state: args.state,
      provider: args.provider,
      redirectTo: args.redirectTo,
      nativeCallback: args.nativeCallback,
      expiresAt: args.expiresAt,
      createdAt: now(),
    });
    await ctx.scheduler.runAfter(
      Math.max(0, args.expiresAt - now()),
      internal.cloudFiles.sweepExpiredOAuthStates,
      {},
    );
    return { ok: true };
  },
});

// OAuth callbacks may return without a Clerk cookie. The high-entropy state is
// single-use, short-lived, and this mutation is gated by the server secret.
export const consumeOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('cloudFileOAuthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt < now()) return null;
    return {
      userId: row.userId,
      provider: row.provider,
      redirectTo: row.redirectTo,
      nativeCallback: row.nativeCallback,
    };
  },
});

export const sweepExpiredOAuthStates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query('cloudFileOAuthStates')
      .withIndex('by_expires', (q) => q.lte('expiresAt', now()))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cloudFiles.sweepExpiredOAuthStates, {});
    }
    return { deleted: expired.length };
  },
});

export const upsertConnection = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    provider: providerValidator,
    accountKey: v.string(),
    accountEmail: v.optional(v.string()),
    displayName: v.optional(v.string()),
    scopes: v.array(v.string()),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const byAccount = await ctx.db
      .query('cloudFileConnections')
      .withIndex('by_user_provider_account', (q) =>
        q.eq('userId', args.userId).eq('provider', args.provider).eq('accountKey', args.accountKey),
      )
      .unique();
    const connectionId = byAccount?.connectionId || args.connectionId;
    const connectionRow = {
      userId: args.userId,
      connectionId,
      provider: args.provider,
      accountKey: args.accountKey,
      accountEmail: args.accountEmail,
      displayName: args.displayName,
      status: 'connected',
      scopes: args.scopes,
      error: undefined,
      updatedAt: ts,
    };
    if (byAccount) await ctx.db.patch(byAccount._id, connectionRow);
    else {
      await ctx.db.insert('cloudFileConnections', {
        ...connectionRow,
        createdAt: ts,
      });
    }

    const credentials = await ctx.db
      .query('cloudFileCredentials')
      .withIndex('by_user_connection', (q) => q.eq('userId', args.userId).eq('connectionId', connectionId))
      .unique();
    const credentialRow = {
      userId: args.userId,
      connectionId,
      provider: args.provider,
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted || credentials?.refreshTokenEncrypted,
      expiresAt: args.expiresAt,
      updatedAt: ts,
    };
    if (credentials) await ctx.db.patch(credentials._id, credentialRow);
    else {
      await ctx.db.insert('cloudFileCredentials', {
        ...credentialRow,
        createdAt: ts,
      });
    }
    return { ok: true, connectionId };
  },
});

export const listConnections = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('cloudFileConnections')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    return rows
      .filter((row) => row.status !== 'disconnected')
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ accountKey: _accountKey, ...row }) => row);
  },
});

export const getConnectionWithCredentials = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const [connection, credentials] = await Promise.all([
      ctx.db
        .query('cloudFileConnections')
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', args.userId).eq('connectionId', args.connectionId),
        )
        .unique(),
      ctx.db
        .query('cloudFileCredentials')
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', args.userId).eq('connectionId', args.connectionId),
        )
        .unique(),
    ]);
    if (!connection || connection.status === 'disconnected' || !credentials) {
      return null;
    }
    return { connection, credentials };
  },
});

export const updateCredentials = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const credentials = await ctx.db
      .query('cloudFileCredentials')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    if (!credentials) return { ok: false };
    await ctx.db.patch(credentials._id, {
      accessTokenEncrypted: args.accessTokenEncrypted,
      ...(args.refreshTokenEncrypted ? { refreshTokenEncrypted: args.refreshTokenEncrypted } : {}),
      ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
      updatedAt: now(),
    });
    return { ok: true };
  },
});

export const markAccessed = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const connection = await ctx.db
      .query('cloudFileConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    if (!connection) return { ok: false };
    await ctx.db.patch(connection._id, {
      status: args.error ? 'error' : 'connected',
      error: args.error,
      lastAccessedAt: args.error ? connection.lastAccessedAt : now(),
      updatedAt: now(),
    });
    return { ok: true };
  },
});

export const disconnect = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const [connection, credentials] = await Promise.all([
      ctx.db
        .query('cloudFileConnections')
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', args.userId).eq('connectionId', args.connectionId),
        )
        .unique(),
      ctx.db
        .query('cloudFileCredentials')
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', args.userId).eq('connectionId', args.connectionId),
        )
        .unique(),
    ]);
    if (credentials) await ctx.db.delete(credentials._id);
    if (connection) await ctx.db.delete(connection._id);
    return { ok: true };
  },
});
