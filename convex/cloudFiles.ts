import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, mutation, query } from './_generated/server';
import { driveGoogleSub } from './googleSecurity';
import { now, requireInternalSecret } from './lib';

const providerValidator = v.union(v.literal('google_drive'), v.literal('onedrive'));
const CLEANUP_BATCH_SIZE = 100;

/**
 * The stored form of a Google Drive address: trimmed and in lower case, as
 * googleDirect.activateGoogleAccount stores a mail address. The Google revoke
 * guard (googleDirect.googleAccessUsesAddress) looks an address up in this
 * form, so it finds every connection of the address.
 */
export function driveAccountEmail(email: string | undefined) {
  return email?.trim().toLowerCase() || undefined;
}

export const saveOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    state: v.string(),
    provider: providerValidator,
    redirectTo: v.optional(v.string()),
    nativeCallback: v.optional(v.boolean()),
    codeVerifierEncrypted: v.optional(v.string()),
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
      codeVerifierEncrypted: args.codeVerifierEncrypted,
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
      codeVerifierEncrypted: row.codeVerifierEncrypted,
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

export const saveOAuthCompletion = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    completionToken: v.string(),
    provider: providerValidator,
    authorizationCodeEncrypted: v.string(),
    codeVerifierEncrypted: v.optional(v.string()),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('cloudFileOAuthCompletions')
      .withIndex('by_token', (q) => q.eq('completionToken', args.completionToken))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert('cloudFileOAuthCompletions', {
      userId: args.userId,
      completionToken: args.completionToken,
      provider: args.provider,
      authorizationCodeEncrypted: args.authorizationCodeEncrypted,
      codeVerifierEncrypted: args.codeVerifierEncrypted,
      expiresAt: args.expiresAt,
      createdAt: now(),
    });
    await ctx.scheduler.runAfter(
      Math.max(0, args.expiresAt - now()),
      internal.cloudFiles.sweepExpiredOAuthCompletions,
      {},
    );
    return { ok: true };
  },
});

export const consumeOAuthCompletion = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    completionToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('cloudFileOAuthCompletions')
      .withIndex('by_token', (q) => q.eq('completionToken', args.completionToken))
      .unique();
    if (!row || row.userId !== args.userId) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt < now()) return null;
    return {
      provider: row.provider,
      authorizationCodeEncrypted: row.authorizationCodeEncrypted,
      codeVerifierEncrypted: row.codeVerifierEncrypted,
    };
  },
});

export const sweepExpiredOAuthCompletions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query('cloudFileOAuthCompletions')
      .withIndex('by_expires', (q) => q.lte('expiresAt', now()))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cloudFiles.sweepExpiredOAuthCompletions, {});
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
    // Google Cross-Account Protection (convex/googleSecurity.ts).
    googleSub: v.optional(v.string()),
    refreshTokenPrefixHash: v.optional(v.string()),
    refreshTokenDoubleHash: v.optional(v.string()),
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
      accountEmail:
        args.provider === 'google_drive' ? driveAccountEmail(args.accountEmail) : args.accountEmail,
      displayName: args.displayName,
      status: 'connected' as const,
      scopes: args.scopes,
      error: undefined,
      // A new connection ends a security hold: Google let the user sign in.
      googleSub: args.googleSub || byAccount?.googleSub,
      securityHoldAt: undefined,
      securityEvent: undefined,
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
      // The identifiers follow the refresh token that the row keeps.
      refreshTokenPrefixHash: args.refreshTokenEncrypted
        ? args.refreshTokenPrefixHash
        : credentials?.refreshTokenPrefixHash,
      refreshTokenDoubleHash: args.refreshTokenEncrypted
        ? args.refreshTokenDoubleHash
        : credentials?.refreshTokenDoubleHash,
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

const DRIVE_EMAIL_PAGE = 100;

/**
 * One-time fix: stores the address of each Google Drive connection in the
 * form of driveAccountEmail, as upsertConnection does now. Before, a Drive
 * address kept the letter case of the provider, so the Google revoke guard
 * could miss a connection of the same address.
 *
 * Each call reads one page of the table (100 rows by default, at most 100)
 * and schedules the next page. It is idempotent: a stored address in the
 * correct form is skipped, so a second run changes nothing. `updatedAt` stays,
 * because the connection did not change. A dry run reads and counts, and
 * writes nothing. The totals are in the deployment logs.
 * Run a dry run first, then the real pass:
 *   CONVEX_DEPLOYMENT=prod:proficient-viper-594 npx convex run cloudFiles:normalizeDriveAccountEmails '{"dryRun": true}'
 *   CONVEX_DEPLOYMENT=prod:proficient-viper-594 npx convex run cloudFiles:normalizeDriveAccountEmails '{}'
 */
export const normalizeDriveAccountEmails = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    // Continuation state. The scheduler sets these; a caller leaves them out.
    cursor: v.optional(v.string()),
    scanned: v.optional(v.number()),
    changed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = Boolean(args.dryRun);
    let scanned = args.scanned ?? 0;
    let changed = args.changed ?? 0;
    const page = await ctx.db.query('cloudFileConnections').paginate({
      cursor: args.cursor ?? null,
      numItems: Math.min(Math.max(Math.floor(args.limit ?? DRIVE_EMAIL_PAGE), 1), DRIVE_EMAIL_PAGE),
    });
    for (const row of page.page) {
      scanned += 1;
      if (row.provider !== 'google_drive' || row.accountEmail === undefined) continue;
      const accountEmail = driveAccountEmail(row.accountEmail);
      if (accountEmail === row.accountEmail) continue;
      changed += 1;
      if (!dryRun) await ctx.db.patch(row._id, { accountEmail });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.cloudFiles.normalizeDriveAccountEmails, {
        dryRun: args.dryRun,
        limit: args.limit,
        cursor: page.continueCursor,
        scanned,
        changed,
      });
      return { scanned, changed, dryRun, done: false };
    }
    console.log(
      `[drive address case] scanned ${scanned} connections, changed ${changed}${dryRun ? ' (dry run)' : ''}`,
    );
    return { scanned, changed, dryRun, done: true };
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
    // The identifiers of the refresh token in use (convex/googleSecurity.ts).
    refreshTokenPrefixHash: v.optional(v.string()),
    refreshTokenDoubleHash: v.optional(v.string()),
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
      ...(args.refreshTokenPrefixHash ? { refreshTokenPrefixHash: args.refreshTokenPrefixHash } : {}),
      ...(args.refreshTokenDoubleHash ? { refreshTokenDoubleHash: args.refreshTokenDoubleHash } : {}),
      updatedAt: now(),
    });
    // A Google Drive connection from before `googleSub` gets it on its next
    // refresh. The Drive account key is the Google account id.
    if (credentials.provider === 'google_drive') {
      const connection = await ctx.db
        .query('cloudFileConnections')
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', args.userId).eq('connectionId', args.connectionId),
        )
        .unique();
      const sub = connection && !connection.googleSub ? driveGoogleSub(connection) : undefined;
      if (connection && sub) await ctx.db.patch(connection._id, { googleSub: sub });
    }
    return { ok: true };
  },
});

export const markAccessed = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    error: v.optional(v.string()),
    // True only when the user must reconnect (expired or revoked access).
    reconnect: v.optional(v.boolean()),
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
    if (!args.error && connection.securityEvent && connection.status === 'error') {
      // A Google security event asked for a reconnect. A good call does not
      // end that state; only a new connection does.
      await ctx.db.patch(connection._id, { lastAccessedAt: now() });
      return { ok: true };
    }
    if (args.error && !args.reconnect) {
      // A missing folder or a rate limit is not a broken connection. Content
      // sync and the Brief keep using it; the text stays in lastError.
      await ctx.db.patch(connection._id, { lastError: args.error, updatedAt: now() });
      return { ok: true };
    }
    await ctx.db.patch(connection._id, {
      status: args.error ? 'error' : 'connected',
      error: args.error,
      lastError: args.error,
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
    // Text extracted from this account must not stay searchable (CAL-10).
    await ctx.scheduler.runAfter(0, internal.cloudFiles.purgeConnectionContent, {
      userId: args.userId,
      connectionId: args.connectionId,
    });
    return { ok: true };
  },
});

const PURGE_BATCH_SIZE = 25;

// Deletes the indexed content of a disconnected account in bounded batches:
// the items, their embedding chunks, and the sync cursor.
export const purgeConnectionContent = internalMutation({
  args: { userId: v.string(), connectionId: v.string() },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query('contentItems')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .take(PURGE_BATCH_SIZE);
    for (const item of items) {
      const chunks = await ctx.db
        .query('contentChunks')
        .withIndex('by_item', (q) => q.eq('itemId', item._id))
        .collect();
      for (const chunk of chunks) await ctx.db.delete(chunk._id);
      await ctx.db.delete(item._id);
    }
    if (items.length === PURGE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cloudFiles.purgeConnectionContent, args);
      return { deleted: items.length, done: false };
    }
    const syncRows = await ctx.db
      .query('contentSync')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .collect();
    for (const row of syncRows) await ctx.db.delete(row._id);
    return { deleted: items.length, done: true };
  },
});
