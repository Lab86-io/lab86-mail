import { v } from 'convex/values';
import {
  assessmentIsCurrent,
  hasObligation,
  JEV_VERSION,
  jevAssessmentSchema,
  jevCorrectionSchema,
  jevPreferencesSchema,
  normalizeJevPreferences,
} from '../lib/jev/contract';
import { type JevMailInput, type JevMailMessage, mailSourceRevision } from '../lib/jev/mail';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import { internalAction, internalMutation, mutation, query } from './_generated/server';
import { nextConnectedUsers } from './content';
import { fanOutInternalPost, requireInternalSecret } from './lib';
import {
  classifyCorpusThread,
  latestThreadContent,
  loadSmartContext,
  normalizeCorpusThread,
  syncLabelMembership,
} from './smart';

async function preferencesRow(ctx: any, userId: string) {
  return ctx.db
    .query('userDocs')
    .withIndex('by_user_kind_key', (q: any) =>
      q.eq('userId', userId).eq('kind', 'jevPreferences').eq('key', 'default'),
    )
    .unique();
}
export async function loadJevSettings(ctx: any, userId: string) {
  const row = await preferencesRow(ctx, userId);
  return {
    preferences: normalizeJevPreferences(row?.doc?.preferences),
    corrections: (Array.isArray(row?.doc?.corrections) ? row.doc.corrections : []).flatMap(
      (value: unknown) => {
        const parsed = jevCorrectionSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      },
    ),
    revision: row?.updatedAt || 0,
  };
}
export const policy = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return loadJevSettings(ctx, args.userId);
  },
});
export const settings = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const state = await loadJevSettings(ctx, args.userId);
    const recent = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_lastDate', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(500);
    const counts = { accepted: 0, uncertain: 0, pending: 0, unavailable: 0 };
    let lastEvaluatedAt = 0;
    for (const row of recent) {
      const status =
        row.jevStatus === 'pending'
          ? 'pending'
          : assessmentIsCurrent(row.jev, row.latestMessageId)
            ? row.jev.status
            : row.jevStatus === 'unavailable'
              ? 'unavailable'
              : 'pending';
      counts[status]++;
      lastEvaluatedAt = Math.max(lastEvaluatedAt, row.jev?.evaluatedAt || 0);
    }
    return {
      ...state,
      counts,
      sampledThreads: recent.length,
      sampleLimit: 500,
      lastEvaluatedAt: lastEvaluatedAt || null,
    };
  },
});
export const saveSettings = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    preferences: v.any(),
    corrections: v.array(v.any()),
    revision: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const preferences = jevPreferencesSchema.parse(args.preferences);
    if (args.corrections.length > 100) throw new Error('At most 100 corrections are supported.');
    const corrections = args.corrections.map((value) => jevCorrectionSchema.parse(value));
    if (new Set(corrections.map((rule) => rule.id)).size !== corrections.length)
      throw new Error('Duplicate correction identifier.');
    const row = await preferencesRow(ctx, args.userId);
    if ((row?.updatedAt || 0) !== args.revision) throw new Error('JEV_SETTINGS_CONFLICT');
    const ts = Math.max(Date.now(), args.revision + 1);
    const doc = { preferences, corrections };
    if (row) await ctx.db.patch(row._id, { doc, updatedAt: ts });
    else
      await ctx.db.insert('userDocs', {
        userId: args.userId,
        kind: 'jevPreferences',
        key: 'default',
        doc,
        createdAt: ts,
        updatedAt: ts,
      });
    return { ...doc, revision: ts };
  },
});

async function threadInput(ctx: any, row: any, knownAccounts?: any[]): Promise<JevMailInput | null> {
  const [recent, accounts] = await Promise.all([
    ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_account_thread_received', (q: any) =>
        q
          .eq('userId', row.userId)
          .eq('accountId', row.accountId)
          .eq('providerThreadId', row.providerThreadId),
      )
      .order('desc')
      .take(17),
    knownAccounts
      ? Promise.resolve(knownAccounts)
      : ctx.db
          .query('connectedAccounts')
          .withIndex('by_user', (q: any) => q.eq('userId', row.userId))
          .collect(),
  ]);
  if (!recent.length) return null;
  const byId = new Map<string, any>(
    recent.slice(0, 16).map((message: any) => [message.providerMessageId, message]),
  );
  // Retain evidence of older open obligations when the recent window moves.
  for (const id of [
    row.latestMessageId,
    ...(row.jevEvidenceMessageIds ||
      row.jev?.obligations?.map((obligation: any) => obligation.evidence.messageId) ||
      []),
  ]) {
    if (!id || byId.has(id)) continue;
    const message = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_account_message', (q: any) =>
        q.eq('accountId', row.accountId).eq('providerMessageId', id),
      )
      .unique();
    if (message?.userId === row.userId && message.providerThreadId === row.providerThreadId)
      byId.set(id, message);
  }
  if (row.latestMessageId && !byId.has(row.latestMessageId)) return null;
  const messages: JevMailMessage[] = [...byId.values()]
    .sort((a, b) => a.receivedAt - b.receivedAt || a.providerMessageId.localeCompare(b.providerMessageId))
    .map((message) => ({
      id: message.providerMessageId,
      from: message.from,
      to: message.to,
      cc: message.cc || '',
      subject: message.subject,
      body: truncateText(String(message.textBody || message.snippet || ''), 2400),
      date: message.receivedAt,
      headers: Object.fromEntries(
        Object.entries(message.headers || {})
          .filter(
            ([key, value]) =>
              typeof value === 'string' &&
              /^(list-id|list-unsubscribe|precedence|auto-submitted)$/i.test(key),
          )
          .map(([key, value]) => [key.toLowerCase(), truncateText(String(value), 500)]),
      ),
      attachments: (message.attachments || [])
        .slice(0, 10)
        .map((attachment: any) => String(attachment.filename || attachment.name || 'attachment')),
    }));
  return {
    accountId: row.accountId,
    threadId: row.providerThreadId,
    messageId: row.latestMessageId || recent[0].providerMessageId,
    sourceRevision: mailSourceRevision(messages),
    selfAddresses: accounts.map((account: any) => account.email.toLowerCase()),
    messages,
    // Context is complete when the message window holds the whole thread. A
    // long body is cut to 2400 characters, but that does not hide a message:
    // most marketing mail is longer, and a body-length test sent it to Review.
    contextComplete: recent.length <= 16 && (!row.messageCount || row.messageCount <= messages.length),
  };
}

export const claimPending = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!(await loadJevSettings(ctx, args.userId)).preferences.enabled)
      return { items: [], moreRemaining: false };
    const limit = Math.max(1, Math.min(20, args.limit ?? 12));
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_llm_pending', (q) => q.eq('userId', args.userId).eq('llmPending', true))
      .order('desc')
      .take(120);
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const items = [];
    const now = Date.now();
    for (const row of rows) {
      if ((row.jevLeaseUntil || 0) > now || (row.jevRetryAt || 0) > now || (row.jevAttempts || 0) >= 3)
        continue;
      const input = await threadInput(ctx, row, accounts);
      if (!input) {
        await ctx.db.patch(row._id, {
          llmPending: undefined,
          jevStatus: 'unavailable',
          jevError: 'Message content is not synced yet.',
        });
        continue;
      }
      const leaseId = `${row._id}:${now}`;
      await ctx.db.patch(row._id, {
        jevLeaseId: leaseId,
        jevLeaseUntil: now + 90_000,
        jevStatus: 'pending',
      });
      items.push({ ...input, leaseId });
      if (items.length === limit) break;
    }
    return { items, moreRemaining: items.length === limit };
  },
});

export const storeAssessments = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    items: v.array(
      v.object({
        accountId: v.string(),
        threadId: v.string(),
        messageId: v.string(),
        sourceRevision: v.string(),
        leaseId: v.string(),
        assessment: v.optional(v.any()),
        error: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const context = await loadSmartContext(ctx, args.userId);
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    let stored = 0;
    for (const item of args.items.slice(0, 20)) {
      const row = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_account_thread', (q) =>
          q.eq('userId', args.userId).eq('accountId', item.accountId).eq('providerThreadId', item.threadId),
        )
        .unique();
      if (!row || row.latestMessageId !== item.messageId || row.jevLeaseId !== item.leaseId) continue;
      const input = await threadInput(ctx, row, accounts);
      if (!input || input.sourceRevision !== item.sourceRevision) {
        await ctx.db.patch(row._id, { jevLeaseId: undefined, jevLeaseUntil: undefined, llmPending: true });
        continue;
      }
      const parsed = jevAssessmentSchema.safeParse(item.assessment);
      if (
        !parsed.success ||
        parsed.data.sourceMessageId !== item.messageId ||
        parsed.data.sourceRevision !== item.sourceRevision ||
        [
          ...parsed.data.obligations.map((entry) => entry.evidence),
          ...(parsed.data.changeEvidence ? [parsed.data.changeEvidence] : []),
        ].some(
          (evidence) =>
            !input.messages.some(
              (message) =>
                message.id === evidence.messageId &&
                truncateText(message.body || message.subject, 2400) === evidence.text,
            ),
        )
      ) {
        const attempts = (row.jevAttempts || 0) + 1;
        await ctx.db.patch(row._id, {
          jevAttempts: attempts,
          jevStatus: 'unavailable',
          jevError: 'Classification is temporarily unavailable.',
          jevRetryAt: Date.now() + 30_000 * 4 ** (attempts - 1),
          jevLeaseId: undefined,
          jevLeaseUntil: undefined,
          llmPending: attempts < 3 ? true : undefined,
        });
        continue;
      }
      const assessment = parsed.data;
      const merged = classifyCorpusThread(
        { ...row, jev: assessment },
        context,
        await latestThreadContent(ctx, row),
      );
      await ctx.db.patch(row._id, {
        ...merged,
        jev: assessment,
        jevEvidenceMessageIds: [...new Set(assessment.obligations.map((item) => item.evidence.messageId))],
        jevVersion: JEV_VERSION,
        jevStatus: assessment.status,
        jevAttempts: 0,
        jevRetryAt: undefined,
        jevError: undefined,
        jevLeaseId: undefined,
        jevLeaseUntil: undefined,
        llmPending: undefined,
        jevNeedsReply: hasObligation(assessment, 'reply'),
        jevNeedsAction: hasObligation(assessment, 'action'),
        jevWaiting: hasObligation(assessment, 'waiting'),
        jevChange: assessment.meaningfulChange,
        updatedAt: Date.now(),
      });
      await syncLabelMembership(ctx, row, { ...row, ...merged });
      stored++;
    }
    return { stored };
  },
});

export const threadAssessments = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    threads: v.array(v.object({ accountId: v.string(), threadId: v.string() })),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return (
      await Promise.all(
        args.threads.slice(0, 600).map(async (target) => {
          const row = await ctx.db
            .query('mailCorpusThreads')
            .withIndex('by_user_account_thread', (q) =>
              q
                .eq('userId', args.userId)
                .eq('accountId', target.accountId)
                .eq('providerThreadId', target.threadId),
            )
            .unique();
          return row ? normalizeCorpusThread(row) : null;
        }),
      )
    ).filter(Boolean);
  },
});

export const liveBriefCandidates = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    since: v.number(),
    accountIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const allowed = new Set(
      accounts
        .filter((a) => a.status === 'connected' && args.accountIds.includes(a.accountId))
        .map((a) => a.accountId),
    );
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_lastDate', (q) => q.eq('userId', args.userId).gt('lastDate', args.since))
      .order('desc')
      .take(300);
    return rows
      .filter((r) => allowed.has(r.accountId) && assessmentIsCurrent(r.jev, r.latestMessageId))
      .map(normalizeCorpusThread);
  },
});

export const attentionCandidates = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await Promise.all([
      ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_jev_reply', (q) => q.eq('userId', args.userId).eq('jevNeedsReply', true))
        .order('desc')
        .take(150),
      ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_jev_action', (q) => q.eq('userId', args.userId).eq('jevNeedsAction', true))
        .order('desc')
        .take(150),
      ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_jev_waiting', (q) => q.eq('userId', args.userId).eq('jevWaiting', true))
        .order('desc')
        .take(150),
      ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_jev_change', (q) => q.eq('userId', args.userId).eq('jevChange', true))
        .order('desc')
        .take(150),
    ]);
    return [
      ...new Map(
        rows
          .flat()
          .filter((row) => !args.accountIds || args.accountIds.includes(row.accountId))
          .map((row) => [row._id, normalizeCorpusThread(row)]),
      ).values(),
    ];
  },
});

export const reprocess = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    await ctx.scheduler.runAfter(0, internal.jev.queueUser, { userId: args.userId });
    return { queued: true };
  },
});
export const markBriefItems = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    items: v.array(v.object({ accountId: v.string(), threadId: v.string(), sourceRevision: v.string() })),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    for (const item of args.items.slice(0, 20)) {
      const row = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_account_thread', (q) =>
          q.eq('userId', args.userId).eq('accountId', item.accountId).eq('providerThreadId', item.threadId),
        )
        .unique();
      if (row?.jev?.sourceRevision === item.sourceRevision)
        await ctx.db.patch(row._id, {
          jevLastBriefRevision: item.sourceRevision,
          jevLastBriefChangeId: row.jev.changeEvidence?.messageId || row.jevLastBriefChangeId,
          jevLastBriefAt: Date.now(),
        });
    }
  },
});
export const queueUser = internalMutation({
  args: { userId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });
    for (const row of page.page)
      await ctx.db.patch(row._id, {
        llmPending: true,
        jevVersion: 0,
        jevStatus: 'pending',
        jevAttempts: 0,
        jevRetryAt: undefined,
        jevLeaseId: undefined,
        jevLeaseUntil: undefined,
      });
    if (!page.isDone)
      await ctx.scheduler.runAfter(1_000, internal.jev.queueUser, {
        userId: args.userId,
        cursor: page.continueCursor,
      });
  },
});
export const queueUnassessed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_jev_version', (q) => q.eq('jevVersion', undefined))
      .take(100);
    for (const row of rows)
      await ctx.db.patch(row._id, { jevVersion: 0, llmPending: true, jevStatus: 'pending', jevAttempts: 0 });
    if (rows.length === 100) await ctx.scheduler.runAfter(1_000, internal.jev.queueUnassessed, {});
  },
});
export const usersWithMail = internalMutation({
  args: {},
  // 24 users / 3 workers * 55 seconds remains inside the action execution budget.
  handler: (ctx) => nextConnectedUsers(ctx, 'connectedAccounts', 'jev:connectedAccounts', 24),
});
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const base = process.env.LAB86_MAIL_PUBLIC_URL;
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    if (!base || !secret) return;
    const users: string[] = await ctx.runMutation(internal.jev.usersWithMail, {});
    await fanOutInternalPost(
      `${base.replace(/\/$/, '')}/api/cron/jev`,
      secret,
      users.map((userId) => ({ userId })),
      { concurrency: 3, timeoutMs: 55_000, label: 'jev' },
    );
  },
});
