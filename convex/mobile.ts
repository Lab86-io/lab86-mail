import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const domainValidator = v.union(
  v.literal('accounts'),
  v.literal('mail'),
  v.literal('calendar'),
  v.literal('tasks'),
  v.literal('today'),
  v.literal('work'),
  v.literal('assistant'),
  v.literal('activity'),
);

type MobileDomain = 'accounts' | 'mail' | 'calendar' | 'tasks' | 'today' | 'work' | 'assistant' | 'activity';

async function syncHead(ctx: QueryCtx | MutationCtx, userId: string, domain: MobileDomain) {
  return ctx.db
    .query('mobileSyncHeads')
    .withIndex('by_user_domain', (q) => q.eq('userId', userId).eq('domain', domain))
    .unique();
}

async function nextRevision(ctx: MutationCtx, userId: string, domain: MobileDomain) {
  const head = await syncHead(ctx, userId, domain);
  const revision = (head?.revision ?? 0) + 1;
  if (head) {
    await ctx.db.patch(head._id, { revision, updatedAt: now() });
  } else {
    await ctx.db.insert('mobileSyncHeads', { userId, domain, revision, updatedAt: now() });
  }
  return revision;
}

async function recordUpsertChange(
  ctx: MutationCtx,
  input: {
    userId: string;
    domain: MobileDomain;
    entityKind: string;
    entityId: string;
    payload: unknown;
  },
) {
  const revision = await nextRevision(ctx, input.userId, input.domain);
  await ctx.db.insert('mobileSyncChanges', {
    ...input,
    revision,
    createdAt: now(),
  });
  return revision;
}

export const bootstrapState = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const [accounts, mailSync, preferences, heads] = await Promise.all([
      ctx.db
        .query('connectedAccounts')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect(),
      ctx.db
        .query('mailSyncStates')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect(),
      ctx.db
        .query('albatrossNotificationPreferences')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .unique(),
      ctx.db
        .query('mobileSyncHeads')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect(),
    ]);
    return { accounts, mailSync, preferences, heads };
  },
});

export const beginCommand = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    idempotencyKey: v.string(),
    payloadHash: v.string(),
    domain: domainValidator,
    kind: v.string(),
    payload: v.any(),
    baseRevision: v.optional(v.number()),
    clientCreatedAt: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('mobileCommands')
      .withIndex('by_user_idempotency', (q) =>
        q.eq('userId', args.userId).eq('idempotencyKey', args.idempotencyKey),
      )
      .unique();
    if (existing) {
      return { command: existing, keyReused: existing.payloadHash !== args.payloadHash, created: false };
    }
    const head = await syncHead(ctx, args.userId, args.domain);
    const currentRevision = head?.revision ?? 0;
    const conflicted = args.baseRevision !== undefined && args.baseRevision !== currentRevision;
    const ts = now();
    const commandId = await ctx.db.insert('mobileCommands', {
      userId: args.userId,
      idempotencyKey: args.idempotencyKey,
      payloadHash: args.payloadHash,
      domain: args.domain,
      kind: args.kind,
      payload: args.payload,
      baseRevision: args.baseRevision,
      clientCreatedAt: args.clientCreatedAt,
      status: conflicted ? 'conflicted' : 'queued',
      errorCode: conflicted ? 'STALE_REVISION' : undefined,
      errorMessage: conflicted
        ? `The ${args.domain} domain advanced from revision ${args.baseRevision} to ${currentRevision}.`
        : undefined,
      errorRetryable: conflicted ? false : undefined,
      createdAt: ts,
      updatedAt: ts,
    });
    const command = await ctx.db.get(commandId);
    return { command, keyReused: false, created: true };
  },
});

export const completeCommand = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    commandId: v.id('mobileCommands'),
    claimToken: v.string(),
    status: v.union(v.literal('applied'), v.literal('needsApproval'), v.literal('failed')),
    syncDomain: v.optional(domainValidator),
    entityKind: v.optional(v.string()),
    entityId: v.optional(v.string()),
    syncPayload: v.optional(v.any()),
    operationId: v.optional(v.string()),
    approvalId: v.optional(v.string()),
    undoExpiresAt: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    errorRetryable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userId !== args.userId) throw new Error('Mobile command not found.');
    if (command.status !== 'queued') return command;
    if (command.claimToken !== args.claimToken) throw new Error('Mobile command execution lease was lost.');
    let entityRevision: number | undefined;
    if (
      args.status !== 'failed' &&
      args.entityKind &&
      args.entityId &&
      args.syncPayload &&
      typeof args.syncPayload === 'object'
    ) {
      entityRevision = await recordUpsertChange(ctx, {
        userId: args.userId,
        domain: args.syncDomain ?? command.domain,
        entityKind: args.entityKind,
        entityId: args.entityId,
        payload: args.syncPayload,
      });
    }
    await ctx.db.patch(args.commandId, {
      status: args.status,
      entityRevision,
      operationId: args.operationId,
      approvalId: args.approvalId,
      undoExpiresAt: args.undoExpiresAt,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      errorRetryable: args.errorRetryable,
      claimToken: undefined,
      claimedAt: undefined,
      updatedAt: now(),
    });
    return ctx.db.get(args.commandId);
  },
});

export const claimCommand = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    commandId: v.id('mobileCommands'),
    claimToken: v.string(),
    leaseMs: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userId !== args.userId) throw new Error('Mobile command not found.');
    if (command.status !== 'queued') return { claimed: false, command };
    const ts = now();
    if (command.claimedAt && command.claimedAt + Math.max(args.leaseMs, 1_000) > ts) {
      return { claimed: false, command };
    }
    await ctx.db.patch(args.commandId, {
      claimToken: args.claimToken,
      claimedAt: ts,
      attemptCount: (command.attemptCount ?? 0) + 1,
      updatedAt: ts,
    });
    return { claimed: true, command: await ctx.db.get(args.commandId) };
  },
});

export const getCommand = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    commandId: v.id('mobileCommands'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const command = await ctx.db.get(args.commandId);
    return command && command.userId === args.userId ? command : null;
  },
});

export const listSync = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    domain: domainValidator,
    afterRevision: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 500);
    const [changes, tombstones, head] = await Promise.all([
      ctx.db
        .query('mobileSyncChanges')
        .withIndex('by_user_domain_revision', (q) =>
          q.eq('userId', args.userId).eq('domain', args.domain).gt('revision', args.afterRevision),
        )
        .order('asc')
        .take(limit + 1),
      ctx.db
        .query('mobileSyncTombstones')
        .withIndex('by_user_domain_revision', (q) =>
          q.eq('userId', args.userId).eq('domain', args.domain).gt('revision', args.afterRevision),
        )
        .order('asc')
        .take(limit + 1),
      syncHead(ctx, args.userId, args.domain),
    ]);
    const page = [
      ...changes.map((change) => ({ type: 'change' as const, revision: change.revision, row: change })),
      ...tombstones.map((tombstone) => ({
        type: 'tombstone' as const,
        revision: tombstone.revision,
        row: tombstone,
      })),
    ]
      .sort((left, right) => left.revision - right.revision)
      .slice(0, limit + 1);
    return {
      page: page.slice(0, limit),
      hasMore: page.length > limit,
      serverRevision: head?.revision ?? 0,
    };
  },
});

export const recordUpsert = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    domain: domainValidator,
    entityKind: v.string(),
    entityId: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return recordUpsertChange(ctx, args);
  },
});

export const recordDeletion = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    domain: domainValidator,
    entityKind: v.string(),
    entityId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const revision = await nextRevision(ctx, args.userId, args.domain);
    await ctx.db.insert('mobileSyncTombstones', {
      userId: args.userId,
      domain: args.domain,
      revision,
      entityKind: args.entityKind,
      entityId: args.entityId,
      createdAt: now(),
    });
    return revision;
  },
});

export const markCommandUndone = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    commandId: v.id('mobileCommands'),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userId !== args.userId) throw new Error('Mobile command not found.');
    if (!command.operationId) throw new Error('This mobile command is not undoable.');
    if (command.undoneAt) return command;
    const entityRevision = await recordUpsertChange(ctx, {
      userId: args.userId,
      domain: command.domain,
      entityKind: 'operation',
      entityId: command.operationId,
      payload: { operationID: command.operationId, undone: true },
    });
    await ctx.db.patch(args.commandId, { undoneAt: now(), entityRevision, updatedAt: now() });
    return ctx.db.get(args.commandId);
  },
});
