// @ts-nocheck
import { v } from 'convex/values';
import { matchAreaContext } from '../lib/albatross/area-matching';
import { evidenceWeight, githubEvidenceKind } from '../lib/albatross/evidence-index';
import { detachedMcpSource } from '../lib/mcp/disconnect';
import { internal } from './_generated/api';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const DISCONNECT_BATCH_SIZE = 100;

const serverValidator = v.union(
  v.literal('github'),
  v.literal('bitbucket'),
  v.literal('jira'),
  v.literal('slack'),
  v.literal('granola'),
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
    oauthClientInformationEncrypted: v.optional(v.string()),
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
      oauthClientInformationEncrypted: args.oauthClientInformationEncrypted,
      fingerprint: args.fingerprint,
      masked: args.masked,
      updatedAt: ts,
    };
    if (cred) await ctx.db.patch(cred._id, credRow);
    else await ctx.db.insert('mcpCredentials', { ...credRow, createdAt: ts });

    return { ok: true };
  },
});

export const saveOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    state: v.string(),
    server: serverValidator,
    payloadEncrypted: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('mcpOAuthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert('mcpOAuthStates', {
      userId: args.userId,
      state: args.state,
      server: args.server,
      payloadEncrypted: args.payloadEncrypted,
      expiresAt: args.expiresAt,
      createdAt: now(),
    });
    return { ok: true };
  },
});

export const consumeOAuthState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('mcpOAuthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (!row || row.userId !== args.userId) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt < now()) return null;
    return { server: row.server, payloadEncrypted: row.payloadEncrypted };
  },
});

export const sweepExpiredOAuthStates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db
      .query('mcpOAuthStates')
      .withIndex('by_expires', (q) => q.lte('expiresAt', now()))
      .take(DISCONNECT_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === DISCONNECT_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.mcp.sweepExpiredOAuthStates, {});
    }
    return { deleted: expired.length };
  },
});

export const updateOAuthCredentials = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    oauthClientInformationEncrypted: v.string(),
    scopes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const [connection, credentials] = await Promise.all([
      ctx.db
        .query('mcpConnections')
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', args.userId).eq('connectionId', args.connectionId),
        )
        .unique(),
      ctx.db
        .query('mcpCredentials')
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', args.userId).eq('connectionId', args.connectionId),
        )
        .unique(),
    ]);
    if (!connection || !credentials || connection.authKind !== 'oauth') return { ok: false };
    await ctx.db.patch(credentials._id, {
      accessTokenEncrypted: args.accessTokenEncrypted,
      ...(args.refreshTokenEncrypted ? { refreshTokenEncrypted: args.refreshTokenEncrypted } : {}),
      expiresAt: args.expiresAt,
      oauthClientInformationEncrypted: args.oauthClientInformationEncrypted,
      updatedAt: now(),
    });
    if (args.scopes) await ctx.db.patch(connection._id, { scopes: args.scopes, updatedAt: now() });
    return { ok: true };
  },
});

export const updateConnectionConfig = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    connectionId: v.string(),
    server: serverValidator,
    serverUrl: v.string(),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const connection = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    if (!connection || connection.server !== args.server) return { ok: false };
    await ctx.db.patch(connection._id, {
      serverUrl: args.serverUrl,
      scopes: args.scopes,
      updatedAt: now(),
    });
    return { ok: true };
  },
});

export const listConnections = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    return rows.filter((row) => row.status !== 'disconnected');
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
    const connection = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    if (!connection) return { ok: true, cleanupScheduled: false };

    await ctx.db.patch(connection._id, {
      status: 'disconnected',
      error: undefined,
      updatedAt: now(),
    });
    const credentials = await ctx.db
      .query('mcpCredentials')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .collect();
    for (const credential of credentials) await ctx.db.delete(credential._id);
    await ctx.scheduler.runAfter(0, internal.mcp.cleanupDisconnectedConnection, {
      userId: args.userId,
      connectionId: args.connectionId,
    });
    return { ok: true, cleanupScheduled: true };
  },
});

export const cleanupDisconnectedConnection = internalMutation({
  args: { userId: v.string(), connectionId: v.string() },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    if (connection && connection.status !== 'disconnected') return { ok: false, reason: 'active' };

    const links = await ctx.db
      .query('mcpTaskLinks')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .take(DISCONNECT_BATCH_SIZE);
    if (links.length) {
      const detachedAt = now();
      const enriched = await Promise.all(
        links.map(async (link) => {
          const item = await ctx.db
            .query('mcpItems')
            .withIndex('by_connection_external', (q) =>
              q.eq('connectionId', args.connectionId).eq('externalId', link.externalId),
            )
            .unique();
          const cardId = ctx.db.normalizeId('cards', link.cardId);
          const card = cardId ? await ctx.db.get(cardId) : null;
          return { link, item, card };
        }),
      );
      for (const { link, item, card } of enriched) {
        const detachedSource = card
          ? detachedMcpSource({
              source: card.source,
              connectionId: args.connectionId,
              server: link.server,
              externalId: link.externalId,
              itemTitle: item?.title,
              itemUrl: item?.url,
              fallbackTitle: card.title,
              disconnectedAt: detachedAt,
            })
          : null;
        if (card && card.userId === args.userId && detachedSource) {
          await ctx.db.patch(card._id, {
            source: detachedSource,
            updatedAt: detachedAt,
          });
        }
        await ctx.db.delete(link._id);
      }
      await ctx.scheduler.runAfter(0, internal.mcp.cleanupDisconnectedConnection, args);
      return { ok: true, remaining: true, phase: 'taskLinks' };
    }

    const evidence = await ctx.db
      .query('albatrossEvidence')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .take(DISCONNECT_BATCH_SIZE);
    if (evidence.length) {
      for (const row of evidence) await ctx.db.delete(row._id);
      await ctx.scheduler.runAfter(0, internal.mcp.cleanupDisconnectedConnection, args);
      return { ok: true, remaining: true, phase: 'evidence' };
    }

    const items = await ctx.db
      .query('mcpItems')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .take(DISCONNECT_BATCH_SIZE);
    if (items.length) {
      for (const item of items) await ctx.db.delete(item._id);
      await ctx.scheduler.runAfter(0, internal.mcp.cleanupDisconnectedConnection, args);
      return { ok: true, remaining: true, phase: 'items' };
    }

    const syncStates = await ctx.db
      .query('mcpSyncStates')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .collect();
    for (const state of syncStates) await ctx.db.delete(state._id);
    const credentials = await ctx.db
      .query('mcpCredentials')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .collect();
    for (const credential of credentials) await ctx.db.delete(credential._id);
    if (connection) await ctx.db.delete(connection._id);
    return { ok: true, remaining: false };
  },
});

export const sweepDisconnectedConnections = internalMutation({
  args: {},
  handler: async (ctx) => {
    const disconnected = await ctx.db
      .query('mcpConnections')
      .withIndex('by_status', (q) => q.eq('status', 'disconnected'))
      .take(DISCONNECT_BATCH_SIZE);
    for (const connection of disconnected) {
      await ctx.scheduler.runAfter(0, internal.mcp.cleanupDisconnectedConnection, {
        userId: connection.userId,
        connectionId: connection.connectionId,
      });
    }
    return { scheduled: disconnected.length };
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
        repository: v.optional(v.string()),
        organization: v.optional(v.string()),
        parentExternalId: v.optional(v.string()),
        sha: v.optional(v.string()),
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
    const [activeAreas, areaFacts] = await Promise.all([
      ctx.db
        .query('areas')
        .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'active'))
        .collect(),
      ctx.db
        .query('areaFacts')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect(),
    ]);
    const matchFacts = areaFacts.map((fact) => ({
      _id: String(fact._id),
      areaId: String(fact.areaId),
      kind: fact.kind,
      value: fact.value,
      status: fact.status,
    }));
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

      const evidenceKey = `mcp:${args.server}:${args.connectionId}:${item.externalId}`;
      const existingEvidence = await ctx.db
        .query('albatrossEvidence')
        .withIndex('by_user_dedupe', (q) => q.eq('userId', args.userId).eq('dedupeKey', evidenceKey))
        .unique();
      const sourceKind = args.server === 'github' ? githubEvidenceKind(item.kind) : 'mcp_item';
      const occurredAt = item.updatedAtSource ?? ts;
      const areaMatch = matchAreaContext({
        text: [item.searchText, item.repository, item.organization, item.title, item.summary]
          .filter(Boolean)
          .join(' '),
        areas: activeAreas.map((area) => ({
          _id: String(area._id),
          name: area.name,
          kind: area.kind,
          description: area.description,
          primaryDomain: area.primaryDomain,
        })),
        facts: matchFacts,
      });
      const evidenceRow = {
        userId: args.userId,
        ...(areaMatch && !existingEvidence?.targetKind
          ? { targetKind: 'area', targetId: areaMatch.areaId }
          : existingEvidence?.targetKind && existingEvidence?.targetId
            ? { targetKind: existingEvidence.targetKind, targetId: existingEvidence.targetId }
            : {}),
        sourceKind,
        sourceId: item.externalId,
        connectionId: args.connectionId,
        title: item.title,
        summary: item.summary,
        url: item.url,
        occurredAt,
        weight: evidenceWeight(sourceKind, 'observed', 1),
        confidence: 1,
        trust: 'observed',
        dedupeKey: evidenceKey,
        searchText: item.searchText,
        metadata: {
          server: args.server,
          kind: item.kind,
          state: item.state,
          repository: item.repository,
          organization: item.organization,
          parentExternalId: item.parentExternalId,
          sha: item.sha,
        },
        updatedAt: ts,
      };
      if (existingEvidence) await ctx.db.patch(existingEvidence._id, evidenceRow);
      else await ctx.db.insert('albatrossEvidence', { ...evidenceRow, createdAt: ts });

      if (areaMatch) {
        const artifactId = item.externalId.slice(0, 200);
        const existingLinks = await ctx.db
          .query('areaArtifactLinks')
          .withIndex('by_user_artifact', (q) =>
            q.eq('userId', args.userId).eq('artifactKind', 'mcpItem').eq('artifactId', artifactId),
          )
          .collect();
        const areaId = ctx.db.normalizeId('areas', areaMatch.areaId);
        const contradicted = existingLinks.some(
          (link) => String(link.areaId) === areaMatch.areaId && link.status === 'rejected',
        );
        if (
          areaId &&
          !contradicted &&
          !existingLinks.some((link) => String(link.areaId) === areaMatch.areaId)
        ) {
          await ctx.db.insert('areaArtifactLinks', {
            userId: args.userId,
            areaId,
            externalId: item.externalId,
            artifactKind: 'mcpItem',
            artifactId,
            role: 'supporting',
            status: 'candidate',
            confidence: areaMatch.confidence,
            reason: areaMatch.reason,
            sourceRefs: [
              {
                kind: args.server === 'github' ? `github_${item.kind}` : 'mcpItem',
                id: item.externalId.slice(0, 500),
                label: item.title.slice(0, 200),
                ...(item.url ? { url: item.url.slice(0, 1_200) } : {}),
              },
            ],
            confirmationRefs: [],
            createdAt: ts,
            updatedAt: ts,
          });
        }
      }

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
    kind: v.optional(v.string()),
    repository: v.optional(v.string()),
    organization: v.optional(v.string()),
    state: v.optional(v.string()),
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
      if (args.kind) expr = expr.eq('kind', args.kind);
      if (args.repository) expr = expr.eq('repository', args.repository);
      if (args.organization) expr = expr.eq('organization', args.organization);
      if (args.state) expr = expr.eq('state', args.state);
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

// Distinct userIds with a connected or errored connection — errored providers
// are retried so endpoint migrations and transient failures can self-heal.
// internalQuery: called only from the sync action via runQuery, so no
// internal-secret gate (internal functions aren't client-exposed).
export const listSyncTargetUserIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('mcpConnections').collect();
    return [
      ...new Set(
        rows.filter((row) => row.status === 'connected' || row.status === 'error').map((row) => row.userId),
      ),
    ];
  },
});
