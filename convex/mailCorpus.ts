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

const syncStatusValidator = v.union(
  v.literal('idle'),
  v.literal('backfilling'),
  v.literal('syncing'),
  v.literal('ready'),
  v.literal('error'),
);

const corpusThreadValidator = v.object({
  providerThreadId: v.string(),
  subject: v.string(),
  fromAddress: v.string(),
  lastDate: v.number(),
  snippet: v.string(),
  labels: v.array(v.string()),
  unread: v.boolean(),
  starred: v.optional(v.boolean()),
  messageCount: v.optional(v.number()),
});

const corpusMessageValidator = v.object({
  providerMessageId: v.string(),
  providerThreadId: v.string(),
  subject: v.string(),
  from: v.string(),
  to: v.string(),
  cc: v.optional(v.string()),
  bcc: v.optional(v.string()),
  receivedAt: v.number(),
  snippet: v.string(),
  textBody: v.optional(v.string()),
  searchText: v.string(),
  labels: v.array(v.string()),
  unread: v.optional(v.boolean()),
  starred: v.optional(v.boolean()),
  attachments: v.optional(v.array(v.any())),
  headers: v.optional(v.any()),
});

export const getSyncState = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.db
      .query('mailSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
  },
});

export const listSyncTargets = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.optional(v.string()),
    status: v.optional(syncStatusValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 50, 500);
    if (args.status) {
      // For user-scoped sweeps, walk the user's own (small) state set so the
      // status filter is never starved by other users' rows.
      if (args.userId) {
        const rows = await ctx.db
          .query('mailSyncStates')
          .withIndex('by_user', (q) => q.eq('userId', args.userId))
          .collect();
        return rows.filter((row) => row.status === args.status).slice(0, limit);
      }
      return await ctx.db
        .query('mailSyncStates')
        .withIndex('by_status', (q) => q.eq('status', args.status))
        .take(limit);
    }
    if (args.userId) {
      return await ctx.db
        .query('mailSyncStates')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .take(limit);
    }
    return await ctx.db.query('mailSyncStates').take(limit);
  },
});

export const markSyncState = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: providerValidator,
    status: v.optional(syncStatusValidator),
    cursor: v.optional(v.string()),
    historyId: v.optional(v.string()),
    deltaLink: v.optional(v.string()),
    corpusReady: v.optional(v.boolean()),
    progress: v.optional(v.any()),
    error: v.optional(v.string()),
    clearCursor: v.optional(v.boolean()),
    lastBackfillAt: v.optional(v.number()),
    lastIncrementalSyncAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await upsertSyncState(ctx, args);
  },
});

export const upsertCorpusBatch = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: providerValidator,
    threads: v.array(corpusThreadValidator),
    messages: v.array(corpusMessageValidator),
    cursor: v.optional(v.string()),
    corpusReady: v.optional(v.boolean()),
    progress: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    let insertedMessages = 0;
    for (const message of args.messages) {
      const existing = await ctx.db
        .query('mailCorpusMessages')
        .withIndex('by_account_message', (q) =>
          q.eq('accountId', args.accountId).eq('providerMessageId', message.providerMessageId),
        )
        .unique();
      const patch = {
        userId: args.userId,
        accountId: args.accountId,
        grantId: args.grantId,
        provider: args.provider,
        providerMessageId: message.providerMessageId,
        providerThreadId: message.providerThreadId,
        subject: message.subject,
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        receivedAt: message.receivedAt,
        snippet: message.snippet,
        textBody: trimCorpusText(message.textBody),
        searchText: trimCorpusText(message.searchText),
        labels: message.labels,
        unread: message.unread,
        starred: message.starred,
        attachments: message.attachments,
        headers: message.headers,
        yearMonth: yearMonth(message.receivedAt),
        updatedAt: ts,
      };
      if (existing) {
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert('mailCorpusMessages', { ...patch, createdAt: ts });
        insertedMessages += 1;
      }
    }

    // Thread aggregates are recomputed from STORED messages, not the batch:
    // an out-of-order backfill page or a single-message webhook must never
    // move lastDate backwards, shrink messageCount, or clear unread/starred.
    const threadIds = new Set<string>([
      ...args.threads.map((thread) => thread.providerThreadId),
      ...args.messages.map((message) => message.providerThreadId),
    ]);
    for (const providerThreadId of threadIds) {
      const AGGREGATE_WINDOW = 500;
      const stored = await ctx.db
        .query('mailCorpusMessages')
        .withIndex('by_account_thread', (q) =>
          q.eq('accountId', args.accountId).eq('providerThreadId', providerThreadId),
        )
        .take(AGGREGATE_WINDOW);
      if (!stored.length) continue;
      const windowCapped = stored.length >= AGGREGATE_WINDOW;
      const latest = stored.reduce((a, b) => (b.receivedAt > a.receivedAt ? b : a));
      const labels = [...new Set(stored.flatMap((message) => message.labels || []))];
      const patch = {
        userId: args.userId,
        accountId: args.accountId,
        grantId: args.grantId,
        provider: args.provider,
        providerThreadId,
        subject: latest.subject || '(no subject)',
        fromAddress: latest.from || '',
        lastDate: latest.receivedAt,
        snippet: latest.snippet || '',
        labels,
        unread: stored.some((message) => Boolean(message.unread)),
        starred: stored.some((message) => Boolean(message.starred)) || undefined,
        messageCount: stored.length,
        yearMonth: yearMonth(latest.receivedAt),
        updatedAt: ts,
      };
      const existing = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_account_thread', (q) =>
          q.eq('accountId', args.accountId).eq('providerThreadId', providerThreadId),
        )
        .unique();
      // For threads larger than the aggregate window, merge monotonically with
      // the existing row instead of trusting a truncated recompute.
      if (existing && windowCapped) {
        patch.lastDate = Math.max(existing.lastDate || 0, patch.lastDate);
        patch.messageCount = Math.max(existing.messageCount || 0, patch.messageCount);
        patch.unread = Boolean(existing.unread) || patch.unread;
        patch.starred = Boolean(existing.starred) || patch.starred || undefined;
        patch.labels = [...new Set([...(existing.labels || []), ...patch.labels])];
      }
      if (existing) await ctx.db.patch(existing._id, patch);
      else await ctx.db.insert('mailCorpusThreads', { ...patch, createdAt: ts });
    }

    // Backfill batches pass an explicit corpusReady boolean and own the
    // status/cursor/readiness fields. Incremental batches (webhooks,
    // reconcile) leave corpusReady undefined and must not disturb them.
    if (args.corpusReady === undefined) {
      await upsertSyncState(ctx, {
        userId: args.userId,
        accountId: args.accountId,
        grantId: args.grantId,
        provider: args.provider,
        progress: args.progress,
        messagesSyncedDelta: insertedMessages,
      });
    } else {
      await upsertSyncState(ctx, {
        userId: args.userId,
        accountId: args.accountId,
        grantId: args.grantId,
        provider: args.provider,
        status: args.corpusReady ? 'ready' : 'backfilling',
        cursor: args.cursor,
        clearCursor: Boolean(args.corpusReady) && args.cursor === undefined,
        corpusReady: Boolean(args.corpusReady),
        progress: args.progress,
        lastBackfillAt: ts,
        messagesSyncedDelta: insertedMessages,
      });
    }

    return { ok: true, threads: args.threads.length, messages: args.messages.length };
  },
});

export const recordWebhookEvent = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    eventId: v.string(),
    type: v.string(),
    userId: v.optional(v.string()),
    accountId: v.optional(v.string()),
    grantId: v.optional(v.string()),
    provider: v.optional(providerValidator),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('mailWebhookEvents')
      .withIndex('by_event', (q) => q.eq('eventId', args.eventId))
      .unique();
    if (existing) return { ok: true, duplicate: true, id: existing._id };
    const id = await ctx.db.insert('mailWebhookEvents', {
      eventId: args.eventId,
      type: args.type,
      userId: args.userId,
      accountId: args.accountId,
      grantId: args.grantId,
      provider: args.provider,
      payload: args.payload,
      status: 'received',
      receivedAt: now(),
    });
    return { ok: true, duplicate: false, id };
  },
});

export const markWebhookEventProcessed = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    eventId: v.string(),
    status: v.union(v.literal('processed'), v.literal('error')),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('mailWebhookEvents')
      .withIndex('by_event', (q) => q.eq('eventId', args.eventId))
      .unique();
    if (!row) return { ok: false, missing: true };
    await ctx.db.patch(row._id, {
      status: args.status,
      error: args.error,
      processedAt: now(),
    });
    return { ok: true };
  },
});

export const deleteCorpusMessage = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_account_message', (q) =>
        q.eq('accountId', args.accountId).eq('providerMessageId', args.providerMessageId),
      )
      .unique();
    if (row && row.userId === args.userId) {
      await ctx.db.delete(row._id);
      await upsertSyncState(ctx, {
        userId: args.userId,
        accountId: args.accountId,
        grantId: row.grantId,
        provider: row.provider,
        messagesSyncedDelta: -1,
      });
    }
    return { ok: true };
  },
});

export const deleteCorpusThread = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerThreadId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const thread = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_account_thread', (q) =>
        q.eq('accountId', args.accountId).eq('providerThreadId', args.providerThreadId),
      )
      .unique();
    if (thread && thread.userId === args.userId) await ctx.db.delete(thread._id);
    const messages = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_account_thread', (q) =>
        q.eq('accountId', args.accountId).eq('providerThreadId', args.providerThreadId),
      )
      .collect();
    let deleted = 0;
    for (const message of messages) {
      if (message.userId === args.userId) {
        await ctx.db.delete(message._id);
        deleted += 1;
      }
    }
    if (deleted && (thread || messages.length)) {
      const source = thread || messages[0];
      await upsertSyncState(ctx, {
        userId: args.userId,
        accountId: args.accountId,
        grantId: source.grantId,
        provider: source.provider,
        messagesSyncedDelta: -deleted,
      });
    }
    return { ok: true, messages: messages.length };
  },
});

export const searchCorpusMessages = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    query: v.optional(v.string()),
    provider: v.optional(providerValidator),
    yearMonth: v.optional(v.string()),
    after: v.optional(v.number()),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 25, 100);
    const text = (args.query || '').trim();
    if (!text) {
      const rows = await ctx.db
        .query('mailCorpusMessages')
        .withIndex('by_user_account_received', (q) =>
          applyReceivedAtBounds(q.eq('userId', args.userId).eq('accountId', args.accountId), args),
        )
        .order('desc')
        .take(limit * 2);
      return rows
        .filter(
          (row) =>
            (!args.provider || row.provider === args.provider) &&
            (!args.yearMonth || row.yearMonth === args.yearMonth),
        )
        .slice(0, limit);
    }
    const search = ctx.db.query('mailCorpusMessages').withSearchIndex('by_search_text', (q) => {
      let builder = q.search('searchText', text).eq('userId', args.userId).eq('accountId', args.accountId);
      if (args.provider) builder = builder.eq('provider', args.provider);
      if (args.yearMonth) builder = builder.eq('yearMonth', args.yearMonth);
      return builder;
    });
    const rows = await search.take(limit * 3);
    return rows
      .filter((row) => withinReceivedAtBounds(row, args))
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit);
  },
});

async function upsertSyncState(ctx: any, args: any) {
  const ts = now();
  const existing = await ctx.db
    .query('mailSyncStates')
    .withIndex('by_user_account', (q: any) => q.eq('userId', args.userId).eq('accountId', args.accountId))
    .unique();
  // Patch semantics: only fields the caller provided are overwritten, so a
  // status-only update can't silently clear cursors or revoke corpusReady.
  const patch: Record<string, unknown> = {
    userId: args.userId,
    accountId: args.accountId,
    grantId: args.grantId,
    provider: args.provider,
    error: args.error,
    updatedAt: ts,
  };
  if (args.status !== undefined) patch.status = args.status;
  if (args.cursor !== undefined) patch.cursor = args.cursor;
  // Provider page cursors expire; completed or restarted backfills must drop
  // them so a later resume can never replay a dead token.
  if (args.clearCursor) patch.cursor = undefined;
  if (args.historyId !== undefined) patch.historyId = args.historyId;
  if (args.deltaLink !== undefined) patch.deltaLink = args.deltaLink;
  if (args.corpusReady !== undefined) patch.corpusReady = Boolean(args.corpusReady);
  if (args.progress !== undefined) patch.progress = args.progress;
  if (args.lastBackfillAt !== undefined) patch.lastBackfillAt = args.lastBackfillAt;
  if (args.lastIncrementalSyncAt !== undefined) patch.lastIncrementalSyncAt = args.lastIncrementalSyncAt;
  if (typeof args.messagesSyncedDelta === 'number' && args.messagesSyncedDelta !== 0) {
    patch.messagesSynced = Math.max(0, (existing?.messagesSynced ?? 0) + args.messagesSyncedDelta);
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch);
    return { ok: true, id: existing._id };
  }
  const id = await ctx.db.insert('mailSyncStates', {
    ...patch,
    status: args.status ?? 'idle',
    corpusReady: Boolean(args.corpusReady),
    createdAt: ts,
  });
  return { ok: true, id };
}

function trimCorpusText(value: unknown) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32_000);
}

function yearMonth(ts: unknown) {
  const value = Number(ts);
  const date = new Date(Number.isFinite(value) && value > 0 ? value : now());
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function clampLimit(value: unknown, fallback: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function applyReceivedAtBounds(builder: any, args: any) {
  let next = builder;
  if (Number.isFinite(args.after)) next = next.gte('receivedAt', args.after);
  if (Number.isFinite(args.before)) next = next.lte('receivedAt', args.before);
  return next;
}

function withinReceivedAtBounds(row: any, args: any) {
  if (Number.isFinite(args.after) && row.receivedAt < args.after) return false;
  if (Number.isFinite(args.before) && row.receivedAt > args.before) return false;
  return true;
}
