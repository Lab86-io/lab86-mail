// @ts-nocheck
import { v } from 'convex/values';
import { internalQuery, mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const serverValidator = v.union(
  v.literal('github'),
  v.literal('bitbucket'),
  v.literal('jira'),
  v.literal('slack'),
);

// A "the work is done" state across connected-tool vocabularies.
function isTerminalState(state) {
  if (!state) return false;
  return /^(closed|merged|done|resolved|completed|complete|cancelled|canceled)$/i.test(String(state).trim());
}

// Display row + encrypted credentials, written together so re-connecting a
// server replaces the secret in place instead of orphaning rows (mirrors
// accounts.upsertConnectedAccount).
export const upsertConnection = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    server: serverValidator,
    serverUrl: v.string(),
    authKind: v.union(v.literal('token'), v.literal('oauth')),
    displayName: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
    accessTokenEncrypted: v.optional(v.string()),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    fingerprint: v.optional(v.string()),
    masked: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const existing = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    const base = {
      userId: args.userId,
      connectionId: args.connectionId,
      server: args.server,
      serverUrl: args.serverUrl,
      authKind: args.authKind,
      status: 'connected' as const,
      displayName: args.displayName,
      scopes: args.scopes ?? [],
      error: undefined,
      updatedAt: ts,
    };
    if (existing) {
      await ctx.db.patch(existing._id, base);
    } else {
      await ctx.db.insert('mcpConnections', {
        ...base,
        includeInBrief: true,
        includeInSearch: true,
        createdAt: ts,
      });
    }

    const cred = await ctx.db
      .query('mcpCredentials')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    const credRow = {
      userId: args.userId,
      connectionId: args.connectionId,
      server: args.server,
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      expiresAt: args.expiresAt,
      fingerprint: args.fingerprint,
      masked: args.masked,
      updatedAt: ts,
    };
    if (cred) await ctx.db.patch(cred._id, credRow);
    else await ctx.db.insert('mcpCredentials', { ...credRow, createdAt: ts });

    return { ok: true };
  },
});

export const listConnections = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.db
      .query('mcpConnections')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
  },
});

// Server-only: includes the encrypted token so the sync layer can decrypt and
// reach the remote MCP server. Never expose this to the client.
export const getConnectionWithCredentials = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), connectionId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const connection = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    if (!connection) return null;
    const credentials = await ctx.db
      .query('mcpCredentials')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    return { connection, credentials };
  },
});

export const setConnectionToggles = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    includeInBrief: v.optional(v.boolean()),
    includeInSearch: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    if (!row) return { ok: false };
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (args.includeInBrief !== undefined) patch.includeInBrief = args.includeInBrief;
    if (args.includeInSearch !== undefined) patch.includeInSearch = args.includeInSearch;
    await ctx.db.patch(row._id, patch);
    return { ok: true };
  },
});

export const disconnectConnection = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), connectionId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const drop = async (table: string) => {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', args.userId).eq('connectionId', args.connectionId),
        )
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    };
    await drop('mcpConnections');
    await drop('mcpCredentials');
    await drop('mcpItems');
    await drop('mcpSyncStates');
    // mcpTaskLinks has no by_user_connection index — sweep by user and filter so
    // links don't outlive the connection they point at.
    const links = await ctx.db
      .query('mcpTaskLinks')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    for (const link of links) {
      if (link.connectionId === args.connectionId) await ctx.db.delete(link._id);
    }
    return { ok: true };
  },
});

export const setSyncState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    server: v.string(),
    status: v.union(v.literal('idle'), v.literal('syncing'), v.literal('ready'), v.literal('error')),
    lastSyncedAt: v.optional(v.number()),
    lastCursor: v.optional(v.string()),
    itemCount: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const row = await ctx.db
      .query('mcpSyncStates')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    const next = {
      userId: args.userId,
      connectionId: args.connectionId,
      server: args.server,
      status: args.status,
      lastSyncedAt: args.lastSyncedAt,
      lastCursor: args.lastCursor,
      itemCount: args.itemCount,
      error: args.error,
      updatedAt: ts,
    };
    if (row) await ctx.db.patch(row._id, next);
    else await ctx.db.insert('mcpSyncStates', { ...next, createdAt: ts });
    // Surface the latest sync time/error on the connection row too.
    const connection = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    if (connection) {
      await ctx.db.patch(connection._id, {
        lastSyncedAt: args.lastSyncedAt ?? connection.lastSyncedAt,
        status: args.status === 'error' ? 'error' : 'connected',
        error: args.error,
        updatedAt: ts,
      });
    }
    return { ok: true };
  },
});

// Bulk upsert normalized items from one sync run, deduped per (connection,
// externalId).
export const upsertItems = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    server: serverValidator,
    items: v.array(
      v.object({
        externalId: v.string(),
        kind: v.string(),
        title: v.string(),
        summary: v.optional(v.string()),
        url: v.optional(v.string()),
        state: v.optional(v.string()),
        author: v.optional(v.string()),
        assignedToUser: v.optional(v.boolean()),
        updatedAtSource: v.optional(v.number()),
        raw: v.optional(v.any()),
        searchText: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    for (const item of args.items) {
      const existing = await ctx.db
        .query('mcpItems')
        .withIndex('by_connection_external', (q) =>
          q.eq('connectionId', args.connectionId).eq('externalId', item.externalId),
        )
        .unique();
      const row = {
        userId: args.userId,
        connectionId: args.connectionId,
        server: args.server,
        ...item,
        updatedAt: ts,
      };
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert('mcpItems', { ...row, createdAt: ts });

      // "External wins for status": when an item transitions INTO a terminal
      // state, auto-complete any task created from it. Only act on a real
      // transition so reopening a task (user intent) isn't clobbered every sync.
      if (isTerminalState(item.state) && !isTerminalState(existing?.state)) {
        const links = await ctx.db
          .query('mcpTaskLinks')
          .withIndex('by_connection_external', (q) =>
            q.eq('connectionId', args.connectionId).eq('externalId', item.externalId),
          )
          .collect();
        for (const link of links) {
          // Defense-in-depth: only ever touch a card that belongs to the same
          // user as this sync run (link AND card must match).
          if (link.userId !== args.userId) continue;
          const cardId = ctx.db.normalizeId('cards', link.cardId);
          if (cardId) {
            const card = await ctx.db.get(cardId);
            if (card && card.userId === args.userId && !card.completedAt) {
              await ctx.db.patch(cardId, { completedAt: ts });
            }
          }
          await ctx.db.patch(link._id, { lastSyncedState: item.state, updatedAt: ts });
        }
      }
    }
    return { ok: true, count: args.items.length };
  },
});

// Record a link between an external MCP item and a Lab86 task card.
export const linkTask = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    server: v.string(),
    externalId: v.string(),
    cardId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    // The card must belong to this user — a link is what later lets a sync
    // complete the card, so never link a card the caller doesn't own.
    const cardId = ctx.db.normalizeId('cards', args.cardId);
    const card = cardId ? await ctx.db.get(cardId) : null;
    if (!card || card.userId !== args.userId) {
      throw new Error('Cannot link a task that does not belong to you.');
    }
    const existing = await ctx.db
      .query('mcpTaskLinks')
      .withIndex('by_connection_external', (q) =>
        q.eq('connectionId', args.connectionId).eq('externalId', args.externalId),
      )
      .collect();
    if (existing.some((row) => row.cardId === args.cardId)) return { ok: true };
    await ctx.db.insert('mcpTaskLinks', {
      userId: args.userId,
      connectionId: args.connectionId,
      server: args.server,
      externalId: args.externalId,
      cardId: args.cardId,
      createdAt: ts,
      updatedAt: ts,
    });
    return { ok: true };
  },
});

// Recent items across the user's brief-enabled connections, newest first.
export const listItemsForBrief = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const connections = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const enabled = new Set(
      connections.filter((c) => c.status === 'connected' && c.includeInBrief).map((c) => c.connectionId),
    );
    if (enabled.size === 0) return [];
    const rows = await ctx.db
      .query('mcpItems')
      .withIndex('by_user_updated', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(400);
    return rows.filter((r) => enabled.has(r.connectionId)).slice(0, args.limit ?? 40);
  },
});

export const searchItems = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    query: v.string(),
    server: v.optional(serverValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const connections = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const searchable = new Set(
      connections.filter((c) => c.status === 'connected' && c.includeInSearch).map((c) => c.connectionId),
    );
    if (searchable.size === 0) return [];
    const trimmed = args.query.trim();
    if (!trimmed) return [];
    const q = ctx.db.query('mcpItems').withSearchIndex('by_search_text', (s) => {
      let expr = s.search('searchText', trimmed).eq('userId', args.userId);
      if (args.server) expr = expr.eq('server', args.server);
      return expr;
    });
    const limit = args.limit ?? 25;
    // Over-fetch before filtering: the search index is ranked across ALL the
    // user's items, so a search-DISABLED connection's items could otherwise fill
    // the top `limit` and starve enabled matches. Pull a wider pool, drop
    // disabled connections, then slice to the requested count.
    const rows = await q.take(Math.min(200, limit * 5 + 20));
    return rows.filter((r) => searchable.has(r.connectionId)).slice(0, limit);
  },
});

// Distinct userIds with at least one connected connection — the cron fans out
// over these. internalQuery: called only from the sync action via runQuery, so
// no internal-secret gate (internal functions aren't client-exposed).
export const listSyncTargetUserIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('mcpConnections')
      .filter((q) => q.eq(q.field('status'), 'connected'))
      .collect();
    return [...new Set(rows.map((r) => r.userId))];
  },
});
