import { paginationOptsValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { isReplyCandidate, mailAddresses, type ReplyWatch } from '../lib/albatross/reply-watch';
import { isTerminalWork, workLifecycle } from '../lib/albatross/work-lifecycle';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';
import { scheduleNarrativeSource } from './narrative';

const callerArgs = { internalSecret: v.optional(v.string()), userId: v.optional(v.string()) };
async function caller(ctx: QueryCtx | MutationCtx, args: { internalSecret?: string; userId?: string }) {
  if (args.internalSecret !== undefined) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new ConvexError('Sign in to update this Albatross.');
    return args.userId;
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError('Sign in to update this Albatross.');
  return identity.subject;
}

async function ownedWork(ctx: QueryCtx | MutationCtx, userId: string, rawId: string) {
  const id = ctx.db.normalizeId('albatrossIntents', rawId);
  const work = id ? await ctx.db.get(id) : null;
  if (!work || work.userId !== userId)
    throw new ConvexError('Albatross not found. Refresh its context and try again.');
  return work;
}

/** A user report is progress, not outcome proof. Saving it never runs completion logic. */
export const recordProgress = mutation({
  args: {
    ...callerArgs,
    workId: v.string(),
    claim: v.string(),
    detail: v.optional(v.string()),
    limits: v.optional(v.string()),
    sourceId: v.string(),
    waitingForReply: v.optional(
      v.object({
        accountId: v.string(),
        threadId: v.string(),
        requirement: v.string(),
        senderEmail: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await caller(ctx, args);
    const work = await ownedWork(ctx, userId, args.workId);
    if (isTerminalWork(work))
      throw new ConvexError('This Albatross is closed. Reopen it before recording progress.');
    const claim = args.claim.trim().slice(0, 2_000);
    if (!claim) throw new ConvexError('Describe the progress to save.');
    const ts = now();
    let replyWatch: ReplyWatch | undefined;
    if (args.waitingForReply) {
      const request = args.waitingForReply;
      const accounts = await ctx.db
        .query('connectedAccounts')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect();
      const account = accounts.find(
        (row) => row.accountId === request.accountId && row.status === 'connected',
      );
      if (!account) throw new ConvexError('Choose a connected mail account for the reply watch.');
      const thread = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_account_thread', (q) =>
          q.eq('userId', userId).eq('accountId', request.accountId).eq('providerThreadId', request.threadId),
        )
        .unique();
      if (!thread)
        throw new ConvexError(
          'Find the sent email first, then use its account and thread for the reply watch.',
        );
      const self = accounts.flatMap((row) => mailAddresses(row.email));
      const messages = await ctx.db
        .query('mailCorpusMessages')
        .withIndex('by_user_account_thread_received', (q) =>
          q.eq('userId', userId).eq('accountId', request.accountId).eq('providerThreadId', request.threadId),
        )
        .order('desc')
        .take(100);
      const sent = messages.find(
        (message) =>
          mailAddresses(message.from).some((email) => self.includes(email)) &&
          !message.labels.some((label) => /^drafts?$/i.test(label)),
      );
      const recipients = sent
        ? mailAddresses(`${sent.to},${sent.cc || ''}`).filter((email) => !self.includes(email))
        : [];
      const senderEmails = request.senderEmail
        ? mailAddresses(request.senderEmail).filter((email) => !self.includes(email))
        : recipients;
      if (!senderEmails.length)
        throw new ConvexError('Specify the email address of the person whose reply you are waiting for.');
      const requirement = request.requirement.trim().slice(0, 600);
      if (!requirement) throw new ConvexError('Describe which reply will let this Albatross move forward.');
      const sameWatch =
        work.replyWatch &&
        work.workState === 'waiting' &&
        work.replyWatch.accountId === request.accountId &&
        work.replyWatch.threadId === request.threadId &&
        work.replyWatch.requirement === requirement &&
        work.replyWatch.senderEmails.join(',') === senderEmails.join(',');
      replyWatch = sameWatch
        ? work.replyWatch
        : {
            id: `${args.sourceId}:${ts}:${Math.random().toString(36).slice(2)}`,
            accountId: request.accountId,
            threadId: request.threadId,
            senderEmails,
            requirement,
            after: sent?.receivedAt ?? ts,
            startedAt: ts,
          };
    }
    const dedupeKey = `progress:${work._id}:${args.sourceId}`;
    const existing = await ctx.db
      .query('albatrossEvidence')
      .withIndex('by_user_dedupe', (q) => q.eq('userId', userId).eq('dedupeKey', dedupeKey))
      .first();
    if (!existing)
      await ctx.db.insert('albatrossEvidence', {
        userId,
        targetKind: 'work',
        targetId: String(work._id),
        sourceKind: 'chat',
        sourceId: args.sourceId,
        title: 'Progress reported in Albatross chat',
        claim,
        summary: (args.detail || claim).slice(0, 2_000),
        limits: (args.limits || 'User-confirmed partial progress; not proof of the entire outcome.').slice(
          0,
          600,
        ),
        trust: 'confirmed',
        weight: 1,
        confidence: 1,
        occurredAt: ts,
        dedupeKey,
        searchText: claim,
        createdAt: ts,
        updatedAt: ts,
      });
    await ctx.db.patch(work._id, {
      lastEvidenceAt: ts,
      lastUserTouchAt: ts,
      updatedAt: ts,
      ...(replyWatch
        ? {
            replyWatch,
            workState: 'waiting' as const,
            agentState: 'idle' as const,
            planError: undefined,
            mailWatchAt: ts,
            mailWatchClaimedAt: undefined,
            replyArrived: undefined,
            replyReceivedAt: undefined,
          }
        : {}),
    });
    await scheduleNarrativeSource(ctx, userId, 'albatrossIntents', String(work._id));
    return { state: replyWatch ? 'waiting' : workLifecycle(work), waitingForReply: replyWatch ?? null };
  },
});

async function waitingRows(ctx: QueryCtx | MutationCtx, userId: string, workId?: string) {
  const rows = workId
    ? [await ownedWork(ctx, userId, workId)]
    : await ctx.db
        .query('albatrossIntents')
        .withIndex('by_user_work_state', (q) => q.eq('userId', userId).eq('workState', 'waiting'))
        .collect();
  return rows.filter((row) => row.workState === 'waiting' && row.replyWatch);
}
function scanWatchKey(rows: Awaited<ReturnType<typeof waitingRows>>) {
  return JSON.stringify(
    rows.map((row) => [String(row._id), row.replyWatch!.id]).sort((a, b) => a[0].localeCompare(b[0])),
  );
}
async function scanRow(ctx: QueryCtx | MutationCtx, userId: string, workId?: string) {
  return ctx.db
    .query('userDocs')
    .withIndex('by_user_kind_key', (q) =>
      q
        .eq('userId', userId)
        .eq('kind', 'replyScan')
        .eq('key', workId || 'all'),
    )
    .unique();
}
export const waiting = query({
  args: { ...callerArgs, workId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await caller(ctx, args);
    const rows = await waitingRows(ctx, userId, args.workId);
    const watchKey = scanWatchKey(rows);
    const scan = await scanRow(ctx, userId, args.workId);
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    return {
      watchKey,
      scanCursor: scan?.doc?.watchKey === watchKey ? scan.doc.cursor : null,
      selfEmails: accounts.flatMap((row) => mailAddresses(row.email)),
      watches: rows
        .filter((row) => row.workState === 'waiting' && row.replyWatch)
        .map((row) => ({
          workId: String(row._id),
          title: row.title || row.rawText,
          watch: row.replyWatch!,
        })),
    };
  },
});

/** Keep bounded scans resumable; an older concurrent scan cannot rewind newer progress. */
export const checkpoint = mutation({
  args: {
    ...callerArgs,
    workId: v.optional(v.string()),
    watchKey: v.string(),
    previousCursor: v.union(v.string(), v.null()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const userId = await caller(ctx, args);
    if (scanWatchKey(await waitingRows(ctx, userId, args.workId)) !== args.watchKey) return false;
    const row = await scanRow(ctx, userId, args.workId);
    const current = row?.doc?.watchKey === args.watchKey ? row.doc.cursor : null;
    if (current !== args.previousCursor) return false;
    const doc = { watchKey: args.watchKey, cursor: args.cursor };
    if (row) await ctx.db.patch(row._id, { doc, updatedAt: now() });
    else
      await ctx.db.insert('userDocs', {
        userId,
        kind: 'replyScan',
        key: args.workId || 'all',
        doc,
        createdAt: now(),
        updatedAt: now(),
      });
    return true;
  },
});

/** Page the entire incoming interval, including read and archived mail; never just the top 40 threads. */
export const messages = query({
  args: { ...callerArgs, after: v.number(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await caller(ctx, args);
    const result = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_received', (q) => q.eq('userId', userId).gt('receivedAt', args.after))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 100),
        maximumBytesRead: 1_000_000,
      });
    return {
      ...result,
      page: result.page.map((row) => ({
        _id: row._id,
        accountId: row.accountId,
        providerThreadId: row.providerThreadId,
        from: row.from,
        receivedAt: row.receivedAt,
        subject: row.subject,
        snippet: row.snippet,
        labels: row.labels,
        headers: row.headers,
        textBody: row.textBody?.slice(0, 4_000),
      })),
    };
  },
});

/** Compare-and-set protects against a late scan overriding a pause, completion, or replacement watch. */
export const resume = mutation({
  args: {
    ...callerArgs,
    workId: v.string(),
    watchId: v.string(),
    messageId: v.id('mailCorpusMessages'),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await caller(ctx, args);
    const work = await ownedWork(ctx, userId, args.workId);
    if (work.workState !== 'waiting' || work.replyWatch?.id !== args.watchId) return { resumed: false };
    const message = await ctx.db.get(args.messageId);
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    if (
      !message ||
      message.userId !== userId ||
      !isReplyCandidate(
        work.replyWatch,
        message,
        accounts.flatMap((row) => mailAddresses(row.email)),
      )
    ) {
      throw new ConvexError('The reply no longer matches this watch.');
    }
    const ts = now();
    const reason = args.reason.trim().slice(0, 600) || 'The reply you were waiting for arrived.';
    await ctx.db.insert('albatrossEvidence', {
      userId,
      targetKind: 'work',
      targetId: String(work._id),
      sourceKind: 'mail_thread',
      sourceId: message.providerThreadId,
      accountId: message.accountId,
      title: message.subject || 'Reply received',
      claim: reason,
      summary: message.snippet.slice(0, 600),
      limits: 'This reply resumes the work; it does not complete the outcome.',
      trust: 'observed',
      weight: 1,
      confidence: 0.95,
      occurredAt: message.receivedAt,
      dedupeKey: `reply:${work._id}:${work.replyWatch.id}:${message._id}`,
      searchText: `${message.subject} ${reason}`,
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.patch(work._id, {
      replyWatch: undefined,
      workState: 'active',
      agentState: 'idle',
      planError: undefined,
      replyReceivedAt: ts,
      replyArrived: {
        accountId: message.accountId,
        threadId: message.providerThreadId,
        messageId: message.providerMessageId,
        from: message.from,
        subject: message.subject,
        reason,
      },
      horizon: { kind: 'now', by: work.horizon?.by, wokeAt: ts },
      lastEvidenceAt: ts,
      mailWatchClaimedAt: undefined,
      updatedAt: ts,
    });
    await scheduleNarrativeSource(ctx, userId, 'albatrossIntents', String(work._id));
    return { resumed: true };
  },
});
