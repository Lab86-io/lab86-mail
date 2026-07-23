import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
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

async function finalizeCommandUndo(ctx: MutationCtx, command: Doc<'mobileCommands'>, timestamp: number) {
  if (command.undoneAt) return command;
  if (!command.operationId) throw new Error('This mobile command is not undoable.');
  const entityRevision = await recordUpsertChange(ctx, {
    userId: command.userId,
    domain: command.domain,
    entityKind: 'operation',
    entityId: command.operationId,
    payload: { operationID: command.operationId, undone: true },
  });
  await ctx.db.patch(command._id, {
    undoneAt: timestamp,
    entityRevision,
    undoClaimToken: undefined,
    undoClaimedAt: undefined,
    undoClaimExpiresAt: undefined,
    updatedAt: timestamp,
  });
  return ctx.db.get(command._id);
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

const briefRefValidator = v.object({
  kind: v.union(
    v.literal('thread'),
    v.literal('task'),
    v.literal('event'),
    v.literal('card'),
    v.literal('work'),
  ),
  id: v.string(),
  account: v.optional(v.string()),
});

function goneBriefEntity(ref: { kind: string; id: string; account?: string }) {
  return {
    kind: ref.kind === 'event' ? 'event' : ref.kind === 'thread' ? 'thread' : ref.kind,
    id: ref.id,
    account: ref.account,
    title: 'No longer available',
    status: 'gone',
    gone: true,
  };
}

export const resolveBriefRefs = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    refs: v.array(briefRefValidator),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const entities: any[] = [];
    for (const ref of args.refs.slice(0, 100)) {
      if (ref.kind === 'thread') {
        if (!ref.account) {
          entities.push(goneBriefEntity(ref));
          continue;
        }
        const thread = await ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_account_thread', (q) =>
            q.eq('userId', args.userId).eq('accountId', ref.account!).eq('providerThreadId', ref.id),
          )
          .unique();
        entities.push(
          thread
            ? {
                kind: 'thread',
                id: ref.id,
                account: thread.accountId,
                title: thread.subject || '(no subject)',
                subtitle: thread.fromAddress || thread.snippet || undefined,
                status: thread.labels.includes('TRASH')
                  ? 'trashed'
                  : thread.labels.includes('ARCHIVE')
                    ? 'archived'
                    : 'active',
                unread: thread.unread,
                updatedAt: thread.updatedAt,
                gone: false,
              }
            : goneBriefEntity(ref),
        );
        continue;
      }

      if (ref.kind === 'event') {
        let event: any = null;
        if (ref.account) {
          event = await ctx.db
            .query('calendarEvents')
            .withIndex('by_account_event', (q) =>
              q.eq('accountId', ref.account!).eq('providerEventId', ref.id),
            )
            .unique();
        } else {
          const events = await ctx.db
            .query('calendarEvents')
            .withIndex('by_user', (q) => q.eq('userId', args.userId))
            .take(1_000);
          event = events.find((row) => row.providerEventId === ref.id) ?? null;
        }
        entities.push(
          event && event.userId === args.userId
            ? {
                kind: 'event',
                id: ref.id,
                account: event.accountId,
                title: event.title || 'Untitled event',
                subtitle: event.location || undefined,
                status: event.status || 'confirmed',
                startAt: event.startAt,
                endAt: event.endAt,
                updatedAt: event.updatedAt,
                gone: false,
              }
            : goneBriefEntity(ref),
        );
        continue;
      }

      if (ref.kind === 'work') {
        const workId = ctx.db.normalizeId('albatrossIntents', ref.id);
        const work = workId ? await ctx.db.get(workId) : null;
        entities.push(
          work && work.userId === args.userId
            ? {
                kind: 'work',
                id: ref.id,
                title: work.title || work.rawText.slice(0, 160) || 'Untitled work',
                subtitle: work.rawText || undefined,
                status: work.agentState || work.workState || work.status,
                updatedAt: work.updatedAt,
                gone: false,
              }
            : goneBriefEntity(ref),
        );
        continue;
      }

      const cardId = ctx.db.normalizeId('cards', ref.id);
      const card = cardId ? await ctx.db.get(cardId) : null;
      entities.push(
        card && card.userId === args.userId
          ? {
              kind: ref.kind,
              id: ref.id,
              title: card.title || 'Untitled task',
              subtitle: card.description || undefined,
              status: card.completedAt ? 'completed' : 'open',
              dueAt: card.dueAt,
              completed: Boolean(card.completedAt),
              updatedAt: card.updatedAt,
              gone: false,
            }
          : goneBriefEntity(ref),
      );
    }
    return entities;
  },
});

const briefQueryValidator = v.union(
  v.literal('tasks_due_today'),
  v.literal('tasks_overdue'),
  v.literal('events_today'),
  v.literal('events_next_7d'),
  v.literal('unresolved_tracked_threads'),
  v.literal('area_open_work'),
);

export const queryBriefCatalog = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    name: briefQueryValidator,
    areaId: v.optional(v.string()),
    startAt: v.number(),
    endAt: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 48);
    if (args.name === 'tasks_due_today' || args.name === 'tasks_overdue') {
      const cards = await ctx.db
        .query('cards')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .take(1_000);
      return cards
        .filter((card) => !card.completedAt && typeof card.dueAt === 'number')
        .filter((card) =>
          args.name === 'tasks_overdue'
            ? card.dueAt! < args.startAt
            : card.dueAt! >= args.startAt && card.dueAt! < args.endAt,
        )
        .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0))
        .slice(0, limit)
        .map((card) => ({
          kind: 'task',
          id: String(card._id),
          title: card.title,
          subtitle: card.description || undefined,
          status: 'open',
          dueAt: card.dueAt,
          completed: false,
          updatedAt: card.updatedAt,
          gone: false,
        }));
    }

    if (args.name === 'events_today' || args.name === 'events_next_7d') {
      const events = await ctx.db
        .query('calendarEvents')
        .withIndex('by_user_start', (q) =>
          q.eq('userId', args.userId).gte('startAt', args.startAt).lt('startAt', args.endAt),
        )
        .take(limit);
      return events.map((event) => ({
        kind: 'event',
        id: event.providerEventId,
        account: event.accountId,
        title: event.title || 'Untitled event',
        subtitle: event.location || undefined,
        status: event.status || 'confirmed',
        startAt: event.startAt,
        endAt: event.endAt,
        updatedAt: event.updatedAt,
        gone: false,
      }));
    }

    if (args.name === 'unresolved_tracked_threads') {
      const rows = await ctx.db
        .query('userDocs')
        .withIndex('by_user_kind_updatedAt', (q) => q.eq('userId', args.userId).eq('kind', 'trackedThread'))
        .order('desc')
        .take(200);
      return rows
        .map((row) => row.doc as any)
        .filter((thread) => thread.status !== 'resolved' && thread.status !== 'dismissed')
        .slice(0, limit)
        .map((thread) => ({
          kind: 'thread',
          id: String(thread.threadId || thread._id),
          account: thread.account ? String(thread.account) : undefined,
          title: String(thread.subject || '(no subject)'),
          subtitle: thread.reason ? String(thread.reason) : undefined,
          status: String(thread.status || 'open'),
          dueAt: typeof thread.dueAt === 'number' ? thread.dueAt : undefined,
          updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined,
          gone: false,
        }));
    }

    const areaId = args.areaId ? ctx.db.normalizeId('areas', args.areaId) : null;
    if (!areaId) return [];
    const work = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_user_primary_area', (q) => q.eq('userId', args.userId).eq('primaryAreaId', areaId))
      .order('desc')
      .take(200);
    return work
      .filter((item) => item.workState !== 'done' && item.workState !== 'archived')
      .slice(0, limit)
      .map((item) => ({
        kind: 'work',
        id: String(item._id),
        title: item.title || item.rawText.slice(0, 160) || 'Untitled work',
        subtitle: item.rawText || undefined,
        status: item.agentState || item.workState || item.status,
        updatedAt: item.updatedAt,
        gone: false,
      }));
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
    return recordUpsertChange(ctx, {
      userId: args.userId,
      domain: args.domain,
      entityKind: args.entityKind,
      entityId: args.entityId,
      payload: args.payload,
    });
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

export const claimCommandUndo = mutation({
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
    if (!command || command.userId !== args.userId) {
      return { claimed: false, reason: 'not_found' as const, command: null };
    }
    if (command.undoneAt) {
      return { claimed: false, reason: 'already_undone' as const, command };
    }
    if (!command.operationId) {
      return { claimed: false, reason: 'not_undoable' as const, command };
    }
    const ts = now();
    const operation = await ctx.db.get(command.operationId as Id<'aiOperations'>);
    if (operation?.userId === args.userId && operation.status === 'undone') {
      return {
        claimed: false,
        reason: 'already_undone' as const,
        command: await finalizeCommandUndo(ctx, command, ts),
      };
    }
    if (operation?.userId === args.userId && operation.status === 'undoing') {
      return { claimed: false, reason: 'in_progress' as const, command };
    }
    if (command.undoExpiresAt !== undefined && ts > command.undoExpiresAt) {
      return { claimed: false, reason: 'expired' as const, command };
    }
    if (
      command.undoClaimToken &&
      command.undoClaimExpiresAt !== undefined &&
      command.undoClaimExpiresAt > ts
    ) {
      return { claimed: false, reason: 'in_progress' as const, command };
    }
    const undoClaimExpiresAt = ts + Math.max(args.leaseMs, 1_000);
    await ctx.db.patch(args.commandId, {
      undoClaimToken: args.claimToken,
      undoClaimedAt: ts,
      undoClaimExpiresAt,
      updatedAt: ts,
    });
    return { claimed: true, reason: 'claimed' as const, command: await ctx.db.get(args.commandId) };
  },
});

export const completeCommandUndo = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    commandId: v.id('mobileCommands'),
    claimToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userId !== args.userId) throw new Error('Mobile command not found.');
    if (command.undoneAt) return command;
    if (!command.operationId) throw new Error('This mobile command is not undoable.');
    if (command.undoClaimToken !== args.claimToken) throw new Error('Mobile command undo lease was lost.');
    const operation = await ctx.db.get(command.operationId as Id<'aiOperations'>);
    if (!operation || operation.userId !== args.userId || operation.status !== 'undone') {
      throw new Error('Operation undo has not completed.');
    }
    // The user action was accepted atomically before undoExpiresAt. The
    // provider inverse may finish after the mobile lease timestamp, so the
    // durable operation's `undone` state—not wall-clock drift—is the safe
    // completion authority.
    return finalizeCommandUndo(ctx, command, now());
  },
});

export const releaseCommandUndo = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    commandId: v.id('mobileCommands'),
    claimToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userId !== args.userId || command.undoClaimToken !== args.claimToken) return;
    await ctx.db.patch(args.commandId, {
      undoClaimToken: undefined,
      undoClaimedAt: undefined,
      undoClaimExpiresAt: undefined,
      updatedAt: now(),
    });
  },
});
