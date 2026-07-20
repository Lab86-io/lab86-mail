import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';
import {
  classificationFreshnessPatch,
  classifyCorpusThread,
  computeCategoryUnreadCounts,
  latestThreadBody,
  loadSmartContext,
  normalizeCorpusThread,
  queryCategoryThreads,
} from './smart';

const providerValidator = v.union(
  v.literal('google'),
  v.literal('microsoft'),
  v.literal('icloud'),
  v.literal('imap'),
);

function latestCorpusMessage(a: any, b: any) {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt > b.receivedAt ? a : b;
  if (a._creationTime !== b._creationTime) return a._creationTime > b._creationTime ? a : b;
  return String(a.providerMessageId).localeCompare(String(b.providerMessageId)) >= 0 ? a : b;
}

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
  htmlBody: v.optional(v.string()),
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
    // Hoisted so TypeScript keeps the narrowing inside the index callbacks.
    const { userId, status } = args;
    if (status) {
      // For user-scoped sweeps, walk the user's own (small) state set so the
      // status filter is never starved by other users' rows.
      if (userId) {
        const rows = await ctx.db
          .query('mailSyncStates')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect();
        return rows.filter((row) => row.status === status).slice(0, limit);
      }
      return await ctx.db
        .query('mailSyncStates')
        .withIndex('by_status', (q) => q.eq('status', status))
        .take(limit);
    }
    if (userId) {
      return await ctx.db
        .query('mailSyncStates')
        .withIndex('by_user', (q) => q.eq('userId', userId))
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

// Atomic cross-instance claim for a backfill run. Convex mutations are
// serializable transactions, so two app instances racing here cannot both
// win: the second sees the first's fresh 'backfilling' stamp and backs off.
export const claimCorpusBackfill = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    grantId: v.string(),
    provider: providerValidator,
    activeWindowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const activeWindowMs = Math.max(60_000, Number(args.activeWindowMs) || 5 * 60_000);
    const existing = await ctx.db
      .query('mailSyncStates')
      .withIndex('by_user_account', (q) => q.eq('userId', args.userId).eq('accountId', args.accountId))
      .unique();
    if (existing?.corpusReady) return { claimed: false, reason: 'ready' };
    if (existing && existing.status === 'backfilling' && ts - existing.updatedAt < activeWindowMs) {
      return { claimed: false, reason: 'active' };
    }
    if (existing) {
      await ctx.db.patch(existing._id, {
        grantId: args.grantId,
        provider: args.provider,
        status: 'backfilling',
        progress: { stage: 'claimed' },
        updatedAt: ts,
      });
    } else {
      await ctx.db.insert('mailSyncStates', {
        userId: args.userId,
        accountId: args.accountId,
        grantId: args.grantId,
        provider: args.provider,
        status: 'backfilling',
        corpusReady: false,
        progress: { stage: 'claimed' },
        createdAt: ts,
        updatedAt: ts,
      });
    }
    return { claimed: true };
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
      const patch: Record<string, unknown> = {
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
      // Preserve markup verbatim (no whitespace collapse). The key is only set
      // when the batch carried a body: patch(.., {htmlBody: undefined}) would
      // strip a body an earlier hydration already stored.
      if (message.htmlBody !== undefined) patch.htmlBody = trimCorpusHtml(message.htmlBody);
      if (existing) {
        await ctx.db.patch(existing._id, patch);
      } else {
        await ctx.db.insert('mailCorpusMessages', { ...patch, createdAt: ts } as any);
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
    // Classify at write time so category listing is an indexed read. One
    // context load serves the whole batch.
    const smartContext = threadIds.size ? await loadSmartContext(ctx, args.userId) : null;
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
      const latest = stored.reduce(latestCorpusMessage);
      let classifyBody = String(latest.textBody || latest.searchText || '').slice(0, 4000);
      const labels = [...new Set(stored.flatMap((message) => message.labels || []))];
      const patch = {
        userId: args.userId,
        accountId: args.accountId,
        grantId: args.grantId,
        provider: args.provider,
        providerThreadId,
        latestMessageId: latest.providerMessageId,
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
      if (windowCapped) {
        const fullThread = await ctx.db
          .query('mailCorpusMessages')
          .withIndex('by_account_thread', (q) =>
            q.eq('accountId', args.accountId).eq('providerThreadId', providerThreadId),
          )
          .collect();
        const fullLatest = fullThread.reduce(latestCorpusMessage, latest);
        patch.lastDate = fullLatest.receivedAt;
        patch.messageCount = fullThread.length;
        patch.labels = [...new Set(fullThread.flatMap((message) => message.labels || []))];
        patch.unread = fullThread.some((message) => Boolean(message.unread));
        patch.starred = fullThread.some((message) => Boolean(message.starred)) || undefined;
        patch.subject = fullLatest.subject || patch.subject;
        patch.latestMessageId = fullLatest.providerMessageId;
        patch.fromAddress = fullLatest.from || patch.fromAddress;
        patch.snippet = fullLatest.snippet || patch.snippet;
        patch.yearMonth = yearMonth(fullLatest.receivedAt);
        classifyBody =
          String(fullLatest.textBody || fullLatest.searchText || '').slice(0, 4000) || classifyBody;
      }
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
      // A verdict belongs to one concrete latest message. Preserve it for
      // idempotent re-syncs, but clear it when a new message becomes latest so
      // both Smart Categories and sparse Area routing reconsider the thread.
      const freshnessPatch = classificationFreshnessPatch(existing?.latestMessageId, patch.latestMessageId);
      const classifyRow = existing
        ? { ...existing, ...patch, ...freshnessPatch }
        : { ...patch, ...freshnessPatch };
      const classified = smartContext ? classifyCorpusThread(classifyRow, smartContext, classifyBody) : {};
      if (existing) await ctx.db.patch(existing._id, { ...patch, ...freshnessPatch, ...classified });
      else
        await ctx.db.insert('mailCorpusThreads', {
          ...patch,
          ...freshnessPatch,
          ...classified,
          createdAt: ts,
        });
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
      // The horizon only moves on backfill batches: backfill pages walk the
      // mailbox newest -> oldest contiguously, so min(receivedAt) is a valid
      // "everything newer than this is indexed" bound. Webhook re-fetches of
      // old messages must NOT extend it — one old message is not coverage.
      const batchOldest = args.messages.length
        ? Math.min(...args.messages.map((message) => message.receivedAt))
        : undefined;
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
        oldestIndexedCandidate: batchOldest,
      });
    }

    // Every imported or changed thread is classified through its own freshness
    // flags above and drained by the ingest kick. Never turn a backfill batch
    // into a full-mailbox Area reindex: for a large corpus that changes O(batch)
    // work into O(mailbox), while producing the same routing result. Full
    // reindexes remain reserved for Area topology/identity changes and explicit
    // repair operations, where untouched historical threads really can change.

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
      // provider/yearMonth are applied in memory, so a single window can be
      // starved by non-matching rows; advance the receivedAt cursor until the
      // limit fills or the account is exhausted (bounded passes).
      const matched: any[] = [];
      let before = args.before;
      for (let pass = 0; pass < 6 && matched.length < limit; pass += 1) {
        const window = { ...args, before };
        const rows = await ctx.db
          .query('mailCorpusMessages')
          .withIndex('by_user_account_received', (q) =>
            applyReceivedAtBounds(q.eq('userId', args.userId).eq('accountId', args.accountId), window),
          )
          .order('desc')
          .take(limit * 2);
        matched.push(
          ...rows.filter(
            (row) =>
              (!args.provider || row.provider === args.provider) &&
              (!args.yearMonth || row.yearMonth === args.yearMonth),
          ),
        );
        if (rows.length < limit * 2) break;
        before = rows[rows.length - 1].receivedAt - 1;
      }
      return matched.slice(0, limit);
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
  if (typeof args.oldestIndexedCandidate === 'number') {
    patch.oldestIndexedAt =
      typeof existing?.oldestIndexedAt === 'number'
        ? Math.min(existing.oldestIndexedAt, args.oldestIndexedCandidate)
        : args.oldestIndexedCandidate;
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

export const countCorpusMessages = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    query: v.optional(v.string()),
    after: v.optional(v.number()),
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const CAP = 1000;
    const text = (args.query || '').trim();
    if (text) {
      const rows = await ctx.db
        .query('mailCorpusMessages')
        .withSearchIndex('by_search_text', (q) =>
          q.search('searchText', text).eq('userId', args.userId).eq('accountId', args.accountId),
        )
        .take(CAP);
      const matched = rows.filter((row) => withinReceivedAtBounds(row, args));
      return { count: matched.length, approximate: rows.length >= CAP && matched.length >= CAP };
    }
    const rows = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_account_received', (q) =>
        applyReceivedAtBounds(q.eq('userId', args.userId).eq('accountId', args.accountId), args),
      )
      .take(CAP);
    return { count: rows.length, approximate: rows.length >= CAP };
  },
});

export const listCorpusThreadMessages = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerThreadId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 100, 500);
    const rows = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_account_thread', (q) =>
        q.eq('accountId', args.accountId).eq('providerThreadId', args.providerThreadId),
      )
      .take(limit);
    // The index has no userId column; enforce tenancy in the filter.
    return rows.filter((row) => row.userId === args.userId).sort((a, b) => a.receivedAt - b.receivedAt);
  },
});

// Server-side (internal-secret) category listing for the HTTP tool layer:
// same indexed plan as the browser's live query, plus a lastDate cursor for
// pagination. Replaces the old provider-search-per-category path entirely.
export const listSmartCategoryThreads = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.optional(v.string()),
    category: v.string(),
    limit: v.optional(v.number()),
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const { items, nextBefore } = await queryCategoryThreads(ctx, {
      userId: args.userId,
      accountIds: args.accountId ? [args.accountId] : null,
      category: args.category,
      limit: clampLimit(args.limit, 50, 200),
      before: args.before,
    });
    return { items, nextBefore };
  },
});

// Full thread read for the tool layer: row + ordered messages with bodies.
// bodiesComplete tells the caller whether a provider hydration pass is still
// needed (rows synced before htmlBody existed).
export const getCorpusThreadBundle = query({
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
      .withIndex('by_user_account_thread', (q) =>
        q
          .eq('userId', args.userId)
          .eq('accountId', args.accountId)
          .eq('providerThreadId', args.providerThreadId),
      )
      .unique();
    if (!thread) return null;
    const rows = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_account_thread_received', (q) =>
        q
          .eq('userId', args.userId)
          .eq('accountId', args.accountId)
          .eq('providerThreadId', args.providerThreadId),
      )
      .order('asc')
      .collect();
    const messages = rows.map((row) => ({
      _id: row.providerMessageId,
      threadId: row.providerThreadId,
      account: row.accountId,
      subject: row.subject || '(no subject)',
      from: row.from || '',
      to: row.to || '',
      cc: row.cc || '',
      bcc: row.bcc || '',
      date: row.receivedAt || 0,
      snippet: row.snippet || '',
      textBody: row.textBody || '',
      htmlBody: row.htmlBody ?? null,
      labels: row.labels || [],
      unread: Boolean(row.unread),
      starred: Boolean(row.starred),
      attachments: row.attachments || [],
      headers: row.headers || {},
      cachedAt: row.updatedAt || row.receivedAt || 0,
    }));
    return {
      threadId: args.providerThreadId,
      subject: thread.subject || messages[0]?.subject || '(no subject)',
      messages,
      bodiesComplete: messages.length > 0 && rows.every((row) => row.htmlBody !== undefined),
    };
  },
});

// Recent threads with stored verdicts, projected small. Feeds the category
// stat counters and the command-palette seeds without scanning message rows.
// Server-tool variant of liveMail.categoryCounts (internal secret instead of
// Clerk identity) — backs the agent-facing get_smart_category_stats tool.
export const categoryCountsInternal = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const counts = await computeCategoryUnreadCounts(ctx, args.userId, args.accountIds);
    return { counts };
  },
});

// LLM-once classification queue. Rows the write-time deterministic pass
// flagged uncertain, newest first, with the body excerpt the model needs —
// the Next server runs the sweep (it owns the AI gateway and billing).
export const listLlmPending = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 40), 1), 60);
    const maxScanned = Math.max(limit * 5, 120);
    const pending: any[] = [];
    const orphanIds: any[] = [];
    const sourceRows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_llm_pending', (q) => q.eq('userId', args.userId).eq('llmPending', true))
      .order('desc')
      .take(maxScanned + 1);
    let processedRows = 0;
    for (const row of sourceRows.slice(0, maxScanned)) {
      processedRows += 1;
      const latest = await ctx.db
        .query('mailCorpusMessages')
        .withIndex('by_user_account_thread_received', (q) =>
          q
            .eq('userId', row.userId)
            .eq('accountId', row.accountId)
            .eq('providerThreadId', row.providerThreadId),
        )
        .order('desc')
        .first();
      const messageId = latest?.providerMessageId;
      if (!messageId) {
        // A legacy aggregate with no message row cannot be grounded. Close it
        // out until a future sync supplies a concrete message identity, which
        // will reopen both classifiers through classificationFreshnessPatch.
        orphanIds.push(row._id);
        continue;
      }
      if (row.latestMessageId !== messageId) {
        await ctx.db.patch(row._id, {
          latestMessageId: messageId,
          ...classificationFreshnessPatch(row.latestMessageId, messageId),
          llmPending: true,
          updatedAt: now(),
        });
      }
      pending.push({
        accountId: row.accountId,
        providerThreadId: row.providerThreadId,
        messageId,
        subject: latest.subject,
        fromAddress: latest.from,
        snippet: latest.snippet,
        labels: latest.labels || [],
        unread: Boolean(latest.unread),
        lastDate: latest.receivedAt,
        bodyText: String(latest.textBody || latest.searchText || '').slice(0, 4000),
      });
      if (pending.length >= limit) {
        break;
      }
    }
    for (const id of orphanIds) {
      await ctx.db.patch(id, { llmPending: undefined, updatedAt: now() });
    }
    return {
      items: pending,
      moreRemaining: processedRows < sourceRows.length || sourceRows.length > maxScanned,
    };
  },
});

// Persist one model verdict per thread and recompute the merged write-time
// classification. Rows listed without a verdict (model returned garbage) are
// closed out too — LLM-once means one attempt, not a retry loop; they keep
// their deterministic verdict.
export const storeLlmVerdicts = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    items: v.array(
      v.object({
        accountId: v.string(),
        providerThreadId: v.string(),
        messageId: v.string(),
        verdict: v.optional(v.any()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const context = await loadSmartContext(ctx, args.userId);
    const ts = now();
    let stored = 0;
    for (const item of args.items.slice(0, 60)) {
      const row = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_account_thread', (q) =>
          q
            .eq('userId', args.userId)
            .eq('accountId', item.accountId)
            .eq('providerThreadId', item.providerThreadId),
        )
        .unique();
      if (!row || !item.messageId || row.latestMessageId !== item.messageId) continue;
      const llmCategory = item.verdict ?? undefined;
      const merged = classifyCorpusThread(
        {
          ...row,
          llmCategory,
          llmClassifiedMessageId: item.messageId,
        },
        context,
        await latestThreadBody(ctx, row),
      );
      await ctx.db.patch(row._id, {
        llmCategory,
        llmClassifiedAt: ts,
        llmClassifiedMessageId: item.messageId,
        ...merged,
        llmPending: undefined,
      });
      if (llmCategory) stored += 1;
    }
    return { stored };
  },
});

// One thread row in client shape. Light corpus-first identity lookup for
// tools that act on a thread the UI is showing (quick-fix corrections etc.);
// the KV thread cache only ever held provider-transport reads, so corpus rows
// were invisible to it.
export const getCorpusThread = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerThreadId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_account_thread', (q) =>
        q
          .eq('userId', args.userId)
          .eq('accountId', args.accountId)
          .eq('providerThreadId', args.providerThreadId),
      )
      .unique();
    return row ? normalizeCorpusThread(row) : null;
  },
});

// Batched latest-message body excerpts, keyed `${accountId}:${providerThreadId}`.
// Feeds body-grounded classification in the Next tool layer (deterministic +
// LLM passes) without shipping full message docs over the wire.
export const threadBodyExcerpts = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    items: v.array(v.object({ accountId: v.string(), providerThreadId: v.string() })),
    maxChars: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const cap = Math.min(Math.max(Math.floor(args.maxChars ?? 2500), 200), 4000);
    const out: Record<string, string> = {};
    for (const item of args.items.slice(0, 100)) {
      const latest = await ctx.db
        .query('mailCorpusMessages')
        .withIndex('by_user_account_thread_received', (q) =>
          q
            .eq('userId', args.userId)
            .eq('accountId', item.accountId)
            .eq('providerThreadId', item.providerThreadId),
        )
        .order('desc')
        .take(1);
      const body = String(latest[0]?.textBody || latest[0]?.searchText || '').slice(0, cap);
      if (body) out[`${item.accountId}:${item.providerThreadId}`] = body;
    }
    return out;
  },
});

export const listRecentCorpusThreads = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 200, 1000);
    const rows = args.accountId
      ? await ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_account_updated', (q) =>
            q.eq('userId', args.userId).eq('accountId', args.accountId as string),
          )
          .order('desc')
          .take(limit)
      : await ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_lastDate', (q) => q.eq('userId', args.userId))
          .order('desc')
          .take(limit);
    return rows.map((row) => ({
      _id: row.providerThreadId,
      account: row.accountId,
      subject: row.subject || '(no subject)',
      fromAddress: row.fromAddress || '',
      lastDate: row.lastDate || 0,
      snippet: (row.snippet || '').slice(0, 200),
      labels: row.labels || [],
      unread: Boolean(row.unread),
      starred: Boolean(row.starred),
      smartCategory: row.smartCategory || undefined,
      cachedAt: row.updatedAt || row.lastDate || 0,
    }));
  },
});

function trimCorpusText(value: unknown) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32_000);
}

// HTML keeps its whitespace (markup-significant) and gets a larger budget
// than search text; 200KB covers effectively all real emails while staying
// far under the Convex document limit.
function trimCorpusHtml(value: unknown) {
  return String(value ?? '').slice(0, 200_000);
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
