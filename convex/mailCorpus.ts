import { v } from 'convex/values';
import { buildCorpusSearchText } from '../lib/mail/corpus';
import { pageEndsInTie, pageThroughTies } from '../lib/mail/search/page-ties';
import { matchingMailExcerpt } from '../lib/mail/search/ranking';
import { internal } from './_generated/api';
import { internalAction, internalQuery, mutation, query } from './_generated/server';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';
import {
  classificationFreshnessPatch,
  classifierContent,
  classifyCorpusThread,
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
function orderedContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedContent);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, orderedContent(entry)]),
    );
  return value;
}
function stableContent(value: unknown) {
  return JSON.stringify(orderedContent(value));
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
    const changedContentThreads = new Set<string>();
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
        textBody: String(message.textBody ?? '').slice(0, 32_000),
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
      // Partial metadata sync must not erase previously hydrated bodies/headers.
      for (const key of ['textBody', 'headers', 'attachments', 'cc', 'bcc'] as const)
        if (message[key] === undefined) delete patch[key];
      if (existing?.textBody && message.textBody === undefined) {
        const defined = Object.fromEntries(
          Object.entries(message).filter(([, value]) => value !== undefined),
        );
        patch.searchText = buildCorpusSearchText({ ...existing, ...defined, textBody: existing.textBody });
      }
      if (
        existing &&
        ['subject', 'from', 'to', 'cc', 'textBody', 'headers', 'attachments'].some(
          (key) =>
            Object.hasOwn(patch, key) && stableContent((existing as any)[key]) !== stableContent(patch[key]),
        )
      )
        changedContentThreads.add(message.providerThreadId);
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
      let classifyBody = classifierContent(latest);
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
        const fullContent = classifierContent(fullLatest);
        classifyBody = fullContent.bodyText ? fullContent : classifyBody;
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
      const freshnessPatch = classificationFreshnessPatch(
        changedContentThreads.has(providerThreadId) ? undefined : existing?.latestMessageId,
        patch.latestMessageId,
      );
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
      if (existing?.latestMessageId !== patch.latestMessageId || patch.lastDate > existing.lastDate) {
        const areaLinks = await ctx.db
          .query('areaArtifactLinks')
          .withIndex('by_user_account_artifact', (query) =>
            query
              .eq('userId', args.userId)
              .eq('accountId', args.accountId)
              .eq('artifactKind', 'mailThread')
              .eq('artifactId', providerThreadId),
          )
          .collect();
        for (const link of areaLinks) {
          if (link.status === 'verified' || link.status === 'candidate') {
            await ctx.db.patch(link._id, { updatedAt: ts });
          }
        }
      }
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

/** A failed webhook event is retried this many times, then abandoned. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
const WEBHOOK_RETRY_BASE_MS = 2 * 60_000;
const WEBHOOK_RETRY_MAX_MS = 6 * 60 * 60_000;

export function nextWebhookAttemptAt(attempts: number, at: number) {
  return at + Math.min(WEBHOOK_RETRY_MAX_MS, WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

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
    const ts = now();
    if (args.status === 'processed') {
      await ctx.db.patch(row._id, {
        status: 'processed',
        error: undefined,
        processedAt: ts,
        nextAttemptAt: undefined,
      });
      return { ok: true };
    }
    const attempts = (row.attempts ?? 0) + 1;
    const abandoned = attempts >= WEBHOOK_MAX_ATTEMPTS;
    await ctx.db.patch(row._id, {
      status: 'error',
      error: args.error,
      processedAt: ts,
      attempts,
      // Abandoned rows sort past every retry window, out of the index range.
      nextAttemptAt: abandoned ? Number.MAX_SAFE_INTEGER : nextWebhookAttemptAt(attempts, ts),
      retryAbandoned: abandoned || undefined,
    });
    return { ok: true, attempts, abandoned };
  },
});

// Failed events whose backoff has passed, plus events stuck in `received`
// (the process that took them restarted before it finished). Oldest first.
export const listRetryableWebhookEvents = query({
  args: {
    internalSecret: v.optional(v.string()),
    limit: v.optional(v.number()),
    stuckAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 25, 100);
    const ts = now();
    const failed = await ctx.db
      .query('mailWebhookEvents')
      .withIndex('by_status_next_attempt', (q) => q.eq('status', 'error').lte('nextAttemptAt', ts))
      .take(limit * 3);
    const stuckBefore = ts - Math.max(60_000, args.stuckAfterMs ?? 15 * 60_000);
    const stuck = await ctx.db
      .query('mailWebhookEvents')
      .withIndex('by_status_next_attempt', (q) => q.eq('status', 'received'))
      .take(limit * 3);
    return [
      ...failed.filter((row) => !row.retryAbandoned),
      ...stuck.filter((row) => row.receivedAt < stuckBefore),
    ]
      .slice(0, limit)
      .map((row) => ({
        eventId: row.eventId,
        type: row.type,
        grantId: row.grantId,
        attempts: row.attempts ?? 0,
        payload: row.payload,
      }));
  },
});

// Convex half of the repair cron (SYNC-3). The app owns Nylas, so this only
// asks it to (1) retry failed webhook events and (2) run the bounded per-user
// repair sweep. The app route ACKs at once and works in the background.
export const repairTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[mail-repair cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    const targets = await ctx.runQuery((internal as any).dailyReports.reportTargets, {});
    const bodies = [
      { kind: 'webhooks' },
      ...targets.map((target: { userId: string }) => ({ kind: 'sweep', userId: target.userId })),
    ];
    const ok = await fanOutInternalPost(`${appUrl}/api/cron/mail-repair`, secret, bodies, {
      label: 'mail-repair cron',
    });
    console.log(`[mail-repair cron] requested ${ok}/${bodies.length} repair runs`);
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
    return rows.filter((row) => withinReceivedAtBounds(row, args)).slice(0, limit);
  },
});

// Opaque relevance cursor: selective local filters can advance through the
// search index without replacing relevance with a received-at window.
export const searchCorpusMessagesPage = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    query: v.string(),
    after: v.optional(v.number()),
    before: v.optional(v.number()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    let source = ctx.db
      .query('mailCorpusMessages')
      .withSearchIndex('by_search_text', (q) =>
        q.search('searchText', args.query).eq('userId', args.userId).eq('accountId', args.accountId),
      );
    if (args.after !== undefined) source = source.filter((q) => q.gte(q.field('receivedAt'), args.after!));
    if (args.before !== undefined) source = source.filter((q) => q.lte(q.field('receivedAt'), args.before!));
    const page = await source.paginate({
      cursor: args.cursor ?? null,
      numItems: clampLimit(args.limit, 50, 50),
    });
    return {
      items: page.page.map(({ htmlBody: _html, textBody, ...row }) => ({
        ...row,
        textBody: textBody ? matchingMailExcerpt(textBody, args.query) : undefined,
      })),
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
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
    const MAX_READ_BYTES = 4_000_000;
    const text = (args.query || '').trim();
    const rows = text
      ? ctx.db
          .query('mailCorpusMessages')
          .withSearchIndex('by_search_text', (q) =>
            q.search('searchText', text).eq('userId', args.userId).eq('accountId', args.accountId),
          )
      : ctx.db
          .query('mailCorpusMessages')
          .withIndex('by_user_account_received', (q) =>
            applyReceivedAtBounds(q.eq('userId', args.userId).eq('accountId', args.accountId), args),
          );
    let count = 0;
    let scanned = 0;
    let readBytes = 0;
    const encoder = new TextEncoder();
    for await (const row of rows) {
      scanned += 1;
      readBytes += encoder.encode(JSON.stringify(row)).byteLength;
      if (withinReceivedAtBounds(row, args)) count += 1;
      if (scanned >= CAP || readBytes >= MAX_READ_BYTES) return { count, approximate: true };
    }
    return { count, approximate: false };
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
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const { items, nextBefore, nextCursor } = await queryCategoryThreads(ctx, {
      userId: args.userId,
      accountIds: args.accountId ? [args.accountId] : null,
      category: args.category,
      limit: clampLimit(args.limit, 50, 200),
      before: args.before,
      cursor: args.cursor,
    });
    return { items, nextBefore, nextCursor };
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
    const messages = rows.map(projectCorpusMessage);
    return {
      threadId: args.providerThreadId,
      subject: thread.subject || messages[0]?.subject || '(no subject)',
      messages,
      bodiesComplete: messages.length > 0 && rows.every((row) => row.htmlBody !== undefined),
    };
  },
});

// One message by provider id, for reply and forward anchors when the caller
// has no thread id. The index has no userId column; tenancy is a filter.
export const getCorpusMessage = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_account_message', (q) =>
        q.eq('accountId', args.accountId).eq('providerMessageId', args.providerMessageId),
      )
      .take(5);
    const row = rows.find((candidate) => candidate.userId === args.userId);
    return row ? projectCorpusMessage(row) : null;
  },
});

function projectCorpusMessage(row: any) {
  return {
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
  };
}

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

// Recent threads with stored verdicts, projected small, read without
// scanning message rows.
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

// Cursor-paged variant of listRecentCorpusThreads for the mobile v1 typed
// read path. Both branches cursor on lastDate (by_user_account_updated's
// third index column is lastDate despite the name), so one opaque numeric
// cursor works for account-scoped and unified listings alike.
export const pageRecentCorpusThreads = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.optional(v.string()),
    limit: v.optional(v.number()),
    before: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = clampLimit(args.limit, 50, 100);
    const before = Number.isFinite(args.before) ? Number(args.before) : undefined;
    const rows = args.accountId
      ? await ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_account_updated', (q) => {
            const eq = q.eq('userId', args.userId).eq('accountId', args.accountId as string);
            return before === undefined ? eq : eq.lt('lastDate', before);
          })
          .order('desc')
          .take(limit + 1)
      : await ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_lastDate', (q) => {
            const eq = q.eq('userId', args.userId);
            return before === undefined ? eq : eq.lt('lastDate', before);
          })
          .order('desc')
          .take(limit + 1);
    const dateOf = (row: any) => Number(row.lastDate ?? 0);
    // PAGE-1: a page that ends inside a group of same-second threads takes
    // the whole group, so the `lt` watermark on the next page skips nothing.
    let candidates = rows;
    if (pageEndsInTie(rows, limit, dateOf)) {
      const boundary = dateOf(rows[limit - 1]);
      const byTime = (range: (q: any) => any, take: number) =>
        (args.accountId
          ? ctx.db
              .query('mailCorpusThreads')
              .withIndex('by_user_account_updated', (q) =>
                range(q.eq('userId', args.userId).eq('accountId', args.accountId as string)),
              )
          : ctx.db
              .query('mailCorpusThreads')
              .withIndex('by_user_lastDate', (q) => range(q.eq('userId', args.userId)))
        )
          .order('desc')
          .take(take);
      const group = await byTime((q) => q.eq('lastDate', boundary), 200);
      // One older row tells the helper whether another page exists.
      const older = await byTime((q) => q.lt('lastDate', boundary), 1);
      candidates = [...rows.filter((row) => dateOf(row) > boundary), ...group, ...older];
    }
    // A row without a usable lastDate cannot anchor a `lt` watermark; the
    // helper reports that page as the last one.
    const { page, nextBefore } = pageThroughTies(candidates, limit, dateOf);
    return { items: page.map(normalizeCorpusThread), nextBefore };
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

// ---- Snooze (MUT-1) -------------------------------------------------------
// The app moves the thread at the provider; these rows only remember when to
// move it back. One active row per thread: a new snooze replaces the old.

const SNOOZE_MAX_ATTEMPTS = 5;

async function activeSnoozes(ctx: any, userId: string, accountId: string, threadId: string) {
  const rows = await ctx.db
    .query('mailSnoozes')
    .withIndex('by_user_account_thread', (q: any) =>
      q.eq('userId', userId).eq('accountId', accountId).eq('threadId', threadId),
    )
    .collect();
  return rows.filter((row: any) => row.status === 'active');
}

export const createSnooze = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    threadId: v.string(),
    messageId: v.optional(v.string()),
    untilTs: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    for (const row of await activeSnoozes(ctx, args.userId, args.accountId, args.threadId)) {
      await ctx.db.patch(row._id, { status: 'cancelled', updatedAt: ts });
    }
    const id = await ctx.db.insert('mailSnoozes', {
      userId: args.userId,
      accountId: args.accountId,
      threadId: args.threadId,
      messageId: args.messageId,
      untilTs: args.untilTs,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    });
    return { id };
  },
});

// Cancels the active snooze for a thread, or for the thread that holds the
// given message. Returns the thread ids it cancelled.
export const cancelSnooze = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    threadId: v.optional(v.string()),
    messageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    let rows: any[] = [];
    if (args.threadId) {
      rows = await activeSnoozes(ctx, args.userId, args.accountId, args.threadId);
    } else if (args.messageId) {
      const active = await ctx.db
        .query('mailSnoozes')
        .withIndex('by_status_until', (q) => q.eq('status', 'active'))
        .take(1000);
      rows = active.filter(
        (row) =>
          row.userId === args.userId && row.accountId === args.accountId && row.messageId === args.messageId,
      );
    }
    const ts = now();
    for (const row of rows) await ctx.db.patch(row._id, { status: 'cancelled', updatedAt: ts });
    return { threadIds: rows.map((row) => row.threadId) };
  },
});

export const listDueSnoozes = query({
  args: { internalSecret: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('mailSnoozes')
      .withIndex('by_status_until', (q) => q.eq('status', 'active').lte('untilTs', now()))
      .take(clampLimit(args.limit, 50, 200));
    return rows.map((row) => ({
      id: row._id,
      userId: row.userId,
      accountId: row.accountId,
      threadId: row.threadId,
      untilTs: row.untilTs,
      attempts: row.attempts ?? 0,
    }));
  },
});

export const settleSnooze = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    id: v.id('mailSnoozes'),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== 'active') return { ok: false };
    const ts = now();
    if (args.ok) {
      await ctx.db.patch(row._id, { status: 'restored', error: undefined, updatedAt: ts });
      return { ok: true, status: 'restored' };
    }
    const attempts = (row.attempts ?? 0) + 1;
    const status = attempts >= SNOOZE_MAX_ATTEMPTS ? 'failed' : 'active';
    await ctx.db.patch(row._id, { status, attempts, error: args.error?.slice(0, 300), updatedAt: ts });
    return { ok: true, status };
  },
});

export const hasDueSnoozes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query('mailSnoozes')
      .withIndex('by_status_until', (q) => q.eq('status', 'active').lte('untilTs', now()))
      .first();
    return Boolean(row);
  },
});

// Wakes due snoozes. The app owns Nylas, so this asks it to move the threads
// back; it posts only when a snooze is due.
export const snoozeTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.runQuery((internal as any).mailCorpus.hasDueSnoozes, {});
    if (!due) return;
    const appUrl = (process.env.LAB86_MAIL_PUBLIC_URL || '').replace(/\/$/, '');
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
    if (!appUrl || !secret) {
      console.error('[mail-snooze cron] missing LAB86_MAIL_PUBLIC_URL or LAB86_CONVEX_INTERNAL_SECRET');
      return;
    }
    await fanOutInternalPost(`${appUrl}/api/cron/mail-snooze`, secret, [{}], { label: 'mail-snooze cron' });
  },
});
