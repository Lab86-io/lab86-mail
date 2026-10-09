// @ts-nocheck
import { v } from 'convex/values';
import { matchAreaContext } from '../lib/albatross/area-matching';
import { areaMcpArtifactId, mcpAreaTargetDecision } from '../lib/albatross/area-mcp-identity';
import { evidenceWeight, githubEvidenceKind } from '../lib/albatross/evidence-index';
import { isMcpReconnectMessage } from '../lib/mcp/connection-health';
import { detachedMcpSource } from '../lib/mcp/disconnect';
import { mcpConnectionSyncPatch, mcpSyncStateFields } from '../lib/mcp/sync-state';
import { truncateText } from '../lib/shared/text';
import { contentHash, sameFields } from '../lib/sync/content-hash';
import { internal } from './_generated/api';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const DISCONNECT_BATCH_SIZE = 100;
const DAY_MS = 86_400_000;
// An unchanged item moves its lastSeenAt at most this often.
export const MCP_SEEN_REFRESH_MS = DAY_MS;

/** The change hash of one synced item and the area inputs it was matched with. */
export function mcpItemSyncHash(server: string, item: Record<string, unknown>, areaDigest: string) {
  return contentHash({ server, item, areaDigest });
}

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
      // New credentials start a clean slate: no reconnect reason and no old
      // sync problem.
      error: undefined,
      lastSyncError: undefined,
      lastSyncErrorAt: undefined,
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
    nativeCallback: v.optional(v.boolean()),
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
      nativeCallback: args.nativeCallback,
      expiresAt: args.expiresAt,
      createdAt: now(),
    });
    return { ok: true };
  },
});

// Browser callbacks cannot rely on the app's Clerk cookie. The OAuth state is
// high-entropy, single-use, short-lived, and server-secret-gated, so native
// sessions consume it directly and recover the owning user from the row.
export const consumeOAuthStateFromCallback = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('mcpOAuthStates')
      .withIndex('by_state', (q) => q.eq('state', args.state))
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    if (row.expiresAt < now()) return null;
    return {
      userId: row.userId,
      server: row.server,
      payloadEncrypted: row.payloadEncrypted,
      nativeCallback: row.nativeCallback ?? false,
    };
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
      ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
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
    const active = rows.filter((row) => row.status !== 'disconnected');
    return await Promise.all(
      active.map(async (row) => {
        const sync = await ctx.db
          .query('mcpSyncStates')
          .withIndex('by_user_connection', (q) =>
            q.eq('userId', args.userId).eq('connectionId', row.connectionId),
          )
          .first();
        return {
          ...row,
          syncStatus: sync?.status,
          itemCount: sync?.itemCount,
          accountEmail: sync?.accountEmail,
          workspaceName: sync?.workspaceName,
          syncError: sync?.error,
        };
      }),
    );
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
    accountEmail: v.optional(v.string()),
    workspaceName: v.optional(v.string()),
    error: v.optional(v.string()),
    // What this run learned about the connection itself (AI-7): `ok` when
    // the source answered, `reconnect` when the sign-in failed.
    outcome: v.optional(v.union(v.literal('ok'), v.literal('reconnect'))),
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
    const { outcome, ...syncArgs } = args;
    const next = mcpSyncStateFields(syncArgs, ts);
    if (row) await ctx.db.patch(row._id, next);
    else await ctx.db.insert('mcpSyncStates', { ...next, createdAt: ts });
    // Surface the latest sync time and problem on the connection row too. A
    // sync problem stays out of `status`; only a failed sign-in asks the user
    // to reconnect.
    const connection = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .unique();
    const patch = connection ? mcpConnectionSyncPatch(connection, { ...args, outcome }, ts) : null;
    if (connection && patch) await ctx.db.patch(connection._id, patch);
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
    const matchAreas = activeAreas.map((area) => ({
      _id: String(area._id),
      name: area.name,
      kind: area.kind,
      description: area.description,
      primaryDomain: area.primaryDomain,
    }));
    // A change to the areas or their facts makes each item match again once.
    const areaDigest = contentHash({ areas: matchAreas, facts: matchFacts });
    let skipped = 0;
    for (const item of args.items) {
      const existing = await ctx.db
        .query('mcpItems')
        .withIndex('by_connection_external', (q) =>
          q.eq('connectionId', args.connectionId).eq('externalId', item.externalId),
        )
        .unique();
      const syncHash = mcpItemSyncHash(args.server, item, areaDigest);
      if (existing && existing.syncHash === syncHash) {
        // Unchanged: no item, evidence, or area write. Only the prune clock
        // moves, and at most once a day.
        if (!existing.lastSeenAt || ts - existing.lastSeenAt >= MCP_SEEN_REFRESH_MS) {
          await ctx.db.patch(existing._id, { lastSeenAt: ts });
        }
        skipped += 1;
        continue;
      }
      const row = {
        userId: args.userId,
        connectionId: args.connectionId,
        server: args.server,
        ...item,
        syncHash,
        lastSeenAt: ts,
        updatedAt: ts,
      };
      if (!existing) await ctx.db.insert('mcpItems', { ...row, createdAt: ts });
      else if (sameFields(existing, row, Object.keys(item))) {
        // Only the area inputs changed. Keep updatedAt, so the content
        // index does not read the item again.
        await ctx.db.patch(existing._id, { syncHash, lastSeenAt: ts });
      } else await ctx.db.patch(existing._id, row);

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
        areas: matchAreas,
        facts: matchFacts,
      });
      const artifactId = areaMcpArtifactId(args.connectionId, item.externalId);
      const existingLinks = await ctx.db
        .query('areaArtifactLinks')
        .withIndex('by_user_account_artifact', (q) =>
          q
            .eq('userId', args.userId)
            .eq('accountId', args.connectionId)
            .eq('artifactKind', 'mcpItem')
            .eq('artifactId', artifactId),
        )
        .collect();
      const target = mcpAreaTargetDecision({
        matchedAreaId: areaMatch?.areaId,
        existingTargetKind: existingEvidence?.targetKind,
        existingTargetId: existingEvidence?.targetId,
        rejectedAreaIds: existingLinks
          .filter((link) => link.status === 'rejected')
          .map((link) => String(link.areaId)),
      });
      const contradicted = target.contradicted;
      const evidenceRow = {
        userId: args.userId,
        ...target.patch,
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
      if (existingEvidence) {
        const evidenceKeys = Object.keys(evidenceRow).filter((key) => key !== 'updatedAt');
        if (!sameFields(existingEvidence, evidenceRow, evidenceKeys))
          await ctx.db.patch(existingEvidence._id, evidenceRow);
      } else await ctx.db.insert('albatrossEvidence', { ...evidenceRow, createdAt: ts });

      if (areaMatch) {
        const areaId = ctx.db.normalizeId('areas', areaMatch.areaId);
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
            accountId: args.connectionId,
            role: 'supporting',
            status: 'candidate',
            confidence: areaMatch.confidence,
            reason: areaMatch.reason,
            sourceRefs: [
              {
                kind: args.server === 'github' ? `github_${item.kind}` : 'mcpItem',
                id: item.externalId.slice(0, 500),
                label: truncateText(item.title, 200),
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
    return { ok: true, count: args.items.length, skipped };
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
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    server: v.optional(serverValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const connections = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    // A sync error (status 'error') keeps the items already indexed; only a
    // disconnect hides them. The error itself lives on the sync state row.
    const enabled = connections.filter(
      (connection) =>
        connection.status !== 'disconnected' &&
        connection.includeInBrief &&
        (!args.server || connection.server === args.server),
    );
    if (enabled.length === 0) return [];
    const rows = (
      await Promise.all(
        enabled.map((connection) =>
          ctx.db
            .query('mcpItems')
            .withIndex('by_user_connection_updated', (q) =>
              q.eq('userId', args.userId).eq('connectionId', connection.connectionId),
            )
            .order('desc')
            .take(args.limit ?? 40),
        ),
      )
    ).flat();
    return rows
      .sort(
        (left, right) =>
          (right.updatedAtSource ?? right.updatedAt) - (left.updatedAtSource ?? left.updatedAt),
      )
      .slice(0, args.limit ?? 40);
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
      connections.filter((c) => c.status !== 'disconnected' && c.includeInSearch).map((c) => c.connectionId),
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

// Distinct userIds with a connected or reconnect-needed connection. A
// reconnect-needed provider is still retried, so a short auth outage or a
// rate-limit 403 can self-heal: the next good sync sets `connected` again.
// internalQuery: called only from the sync action via runQuery, so no
// internal-secret gate (internal functions aren't client-exposed).
// A connection with both the Brief and search toggles off is not polled (X8):
// nothing reads its items, so a sync only costs reads and writes.
export function mcpConnectionWantsSync(row: {
  status?: string;
  includeInBrief?: boolean;
  includeInSearch?: boolean;
}) {
  if (row.status !== 'connected' && row.status !== 'error') return false;
  return row.includeInBrief !== false || row.includeInSearch !== false;
}

/** Users with an Atlassian sign-in, for the daily personal data report. */
export const listAtlassianSignInUserIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('mcpConnections').collect();
    return [
      ...new Set(
        rows
          .filter((row) => row.server === 'jira' && row.authKind === 'oauth' && row.status !== 'disconnected')
          .map((row) => row.userId),
      ),
    ];
  },
});

export const listSyncTargetUserIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('mcpConnections').collect();
    return [...new Set(rows.filter(mcpConnectionWantsSync).map((row) => row.userId))];
  },
});

// ---- Prune (X2) ------------------------------------------------------------

/** An item that no sync returned for this long is deleted, unless a task links it. */
export const MCP_ITEM_STALE_MS = 14 * DAY_MS;
export const MCP_PRUNE_BATCH = 25;

async function deleteMcpItemRows(ctx, item) {
  const evidence = await ctx.db
    .query('albatrossEvidence')
    .withIndex('by_user_dedupe', (q) =>
      q
        .eq('userId', item.userId)
        .eq('dedupeKey', `mcp:${item.server}:${item.connectionId}:${item.externalId}`),
    )
    .collect();
  for (const row of evidence) await ctx.db.delete(row._id);
  // Candidate area links go with the item. A link the user confirmed or
  // rejected is a decision, so it stays.
  const links = await ctx.db
    .query('areaArtifactLinks')
    .withIndex('by_user_account_artifact', (q) =>
      q
        .eq('userId', item.userId)
        .eq('accountId', item.connectionId)
        .eq('artifactKind', 'mcpItem')
        .eq('artifactId', areaMcpArtifactId(item.connectionId, item.externalId)),
    )
    .collect();
  for (const link of links) if (link.status === 'candidate') await ctx.db.delete(link._id);
  // The connected-content row and its vectors (key format: convex/content.ts).
  const content = await ctx.db
    .query('contentItems')
    .withIndex('by_user_key', (q) =>
      q.eq('userId', item.userId).eq('key', `${item.server}:${item.connectionId}:${item.externalId}`),
    )
    .unique();
  if (content) {
    const chunks = await ctx.db
      .query('contentChunks')
      .withIndex('by_item', (q) => q.eq('itemId', content._id))
      .collect();
    for (const chunk of chunks) await ctx.db.delete(chunk._id);
    await ctx.db.delete(content._id);
  }
  await ctx.db.delete(item._id);
}

/**
 * The time before which an item counts as not seen, or null when the prune
 * must not touch the connection. Only a connection that the sync still polls
 * is pruned. "Not seen" counts back from its last clean sync: a sync that
 * reached the source and had no failed query. A paused connection, or one
 * whose last sync failed or was partial, keeps its items, because its
 * lastSeenAt stops for a reason that is not the source.
 */
export function mcpPruneCutoff(
  connection:
    | {
        status?: string;
        includeInBrief?: boolean;
        includeInSearch?: boolean;
        lastSyncOkAt?: number;
        lastSyncErrorAt?: number;
      }
    | null
    | undefined,
  ts: number,
): number | null {
  if (!connection || !mcpConnectionWantsSync(connection)) return null;
  const cleanSyncAt = Number(connection.lastSyncOkAt) || 0;
  if (!cleanSyncAt || connection.lastSyncErrorAt !== undefined) return null;
  return Math.min(ts, cleanSyncAt) - MCP_ITEM_STALE_MS;
}

async function connectionById(ctx, connectionId: string) {
  return ctx.db
    .query('mcpConnections')
    .withIndex('by_connection', (q) => q.eq('connectionId', connectionId))
    .first();
}

/**
 * One bounded prune page for one connection. An item that no clean sync
 * returned for 14 days goes with its evidence, candidate area links, and
 * content row. An item that a task links stays, and its clock starts again.
 * Rows from before lastSeenAt existed use updatedAt, which the old sync moved
 * on every pass. The page schedules the next one while it finds work.
 */
export const pruneStaleItems = internalMutation({
  args: {
    connectionId: v.string(),
    now: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const ts = args.now ?? now();
    const cutoff = mcpPruneCutoff(await connectionById(ctx, args.connectionId), ts);
    if (cutoff === null)
      return { deleted: 0, kept: 0, dated: 0, more: false, skipped: true, dryRun: Boolean(args.dryRun) };
    const legacy = await ctx.db
      .query('mcpItems')
      .withIndex('by_connection_seen', (q) =>
        q.eq('connectionId', args.connectionId).eq('lastSeenAt', undefined),
      )
      .take(MCP_PRUNE_BATCH);
    const stale = await ctx.db
      .query('mcpItems')
      .withIndex('by_connection_seen', (q) =>
        q.eq('connectionId', args.connectionId).gte('lastSeenAt', 0).lt('lastSeenAt', cutoff),
      )
      .take(MCP_PRUNE_BATCH);
    let deleted = 0;
    let kept = 0;
    let dated = 0;
    for (const item of [...legacy, ...stale]) {
      const seenAt = item.lastSeenAt ?? item.updatedAt;
      if (seenAt >= cutoff) {
        // A legacy row that is not old yet gets its date, so it leaves the
        // legacy page and waits in the range.
        dated += 1;
        if (!args.dryRun) await ctx.db.patch(item._id, { lastSeenAt: seenAt });
        continue;
      }
      const link = await ctx.db
        .query('mcpTaskLinks')
        .withIndex('by_connection_external', (q) =>
          q.eq('connectionId', item.connectionId).eq('externalId', item.externalId),
        )
        .first();
      if (link) {
        kept += 1;
        if (!args.dryRun) await ctx.db.patch(item._id, { lastSeenAt: ts });
        continue;
      }
      deleted += 1;
      if (!args.dryRun) await deleteMcpItemRows(ctx, item);
    }
    const more = legacy.length === MCP_PRUNE_BATCH || stale.length === MCP_PRUNE_BATCH;
    if (more && !args.dryRun) {
      await ctx.scheduler.runAfter(0, internal.mcp.pruneStaleItems, {
        connectionId: args.connectionId,
        now: args.now,
      });
    }
    return { deleted, kept, dated, more, dryRun: Boolean(args.dryRun) };
  },
});

/** Daily: one prune chain for each connection that the sync polls and that last synced clean. */
export const pruneStaleItemsTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const connections = await ctx.db.query('mcpConnections').collect();
    const ts = now();
    let scheduled = 0;
    for (const connection of connections) {
      if (mcpPruneCutoff(connection, ts) === null) continue;
      await ctx.scheduler.runAfter(0, internal.mcp.pruneStaleItems, {
        connectionId: connection.connectionId,
      });
      scheduled += 1;
    }
    return { scheduled };
  },
});

// AI-7 repair: before the fix, any failed sync call set a connection's
// `status` to `error`, so a working connector read as broken. This moves each
// `error` row that still has usable credentials and no sign-in failure back
// to `connected`, and keeps its message as `lastSyncError`. Rows whose sign-in
// really failed keep the reconnect state. Idempotent: a second run finds only
// reconnect rows and changes nothing. Each page schedules the next one.
export const repairSyncErrorStatus = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ts = now();
    const page = await ctx.db
      .query('mcpConnections')
      .withIndex('by_status', (q) => q.eq('status', 'error'))
      .paginate({
        cursor: args.cursor ?? null,
        numItems: Math.min(Math.max(args.batchSize ?? DISCONNECT_BATCH_SIZE, 1), DISCONNECT_BATCH_SIZE),
      });
    let repaired = 0;
    let kept = 0;
    for (const row of page.page) {
      const credentials = await ctx.db
        .query('mcpCredentials')
        .withIndex('by_user_connection', (q) =>
          q.eq('userId', row.userId).eq('connectionId', row.connectionId),
        )
        .unique();
      const expired =
        row.authKind === 'oauth' &&
        typeof credentials?.expiresAt === 'number' &&
        credentials.expiresAt <= ts &&
        !credentials.refreshTokenEncrypted;
      const usable = Boolean(credentials?.accessTokenEncrypted) && !expired;
      if (!usable || isMcpReconnectMessage(row.error)) {
        kept += 1;
        continue;
      }
      repaired += 1;
      if (args.dryRun) continue;
      await ctx.db.patch(row._id, {
        status: 'connected',
        error: undefined,
        ...(row.error ? { lastSyncError: truncateText(row.error, 300), lastSyncErrorAt: row.updatedAt } : {}),
        updatedAt: ts,
      });
    }
    if (!page.isDone && !args.dryRun) {
      await ctx.scheduler.runAfter(0, internal.mcp.repairSyncErrorStatus, {
        cursor: page.continueCursor,
        batchSize: args.batchSize,
      });
    }
    return {
      scanned: page.page.length,
      repaired,
      kept,
      dryRun: Boolean(args.dryRun),
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
