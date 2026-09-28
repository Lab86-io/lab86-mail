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
import {
  JEV_BODY_CHARS,
  JEV_BODY_MESSAGES,
  type JevFactsView,
  type JevMailInput,
  type JevMailMessage,
  mailSourceRevision,
} from '../lib/jev/mail';
import { storedBodyText } from '../lib/mail/corpus-body';
import { labelsHaveRole } from '../lib/mail/search/folders';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import { internalAction, internalMutation, mutation, query } from './_generated/server';
import { nextConnectedUsers } from './content';
import { fanOutInternalPost, requireInternalSecret } from './lib';
import {
  classifierContent,
  classifyCorpusThread,
  loadSmartContext,
  normalizeCorpusThread,
  noteSavedContactSender,
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

// The ids of the messages that hold the evidence of the stored obligations.
function evidenceMessageIds(row: any): string[] {
  return (
    row.jevEvidenceMessageIds ||
    row.jev?.obligations?.map((obligation: any) => obligation.evidence.messageId) ||
    []
  );
}

// One message as the body stage sees it: the start of the plain text (IO-1:
// the small document keeps it, so no body document is read).
function bodyMessage(message: any): JevMailMessage {
  return {
    id: message.providerMessageId,
    from: message.from,
    to: message.to,
    cc: message.cc || '',
    subject: message.subject,
    body: truncateText(String(storedBodyText(message) || message.snippet || ''), JEV_BODY_CHARS),
    date: message.receivedAt,
    headers: Object.fromEntries(
      Object.entries(message.headers || {})
        .filter(
          ([key, value]) =>
            typeof value === 'string' && /^(list-id|list-unsubscribe|precedence|auto-submitted)$/i.test(key),
        )
        .map(([key, value]) => [key.toLowerCase(), truncateText(String(value), 500)]),
    ),
    attachments: (message.attachments || [])
      .slice(0, 10)
      .map((attachment: any) => String(attachment.filename || attachment.name || 'attachment')),
  };
}

interface JevThreadWindow {
  input: JevMailInput;
  /** The first-stage view, or undefined when the claim must read the bodies first. */
  facts?: JevFactsView;
  /** The newest small document of the thread. */
  newest: any;
}

/**
 * The Jev input of one thread (IO-1). It reads the small documents of the
 * newest JEV_BODY_MESSAGES messages and of the messages that hold open
 * evidence, never a body document. The source revision covers exactly these
 * messages, so the claim and the store compute the same value.
 */
async function threadWindow(ctx: any, row: any, knownAccounts?: any[]): Promise<JevThreadWindow | null> {
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
      .take(JEV_BODY_MESSAGES + 1),
    knownAccounts
      ? Promise.resolve(knownAccounts)
      : ctx.db
          .query('connectedAccounts')
          .withIndex('by_user', (q: any) => q.eq('userId', row.userId))
          .collect(),
  ]);
  if (!recent.length) return null;
  const byId = new Map<string, any>(
    recent.slice(0, JEV_BODY_MESSAGES).map((message: any) => [message.providerMessageId, message]),
  );
  // Retain evidence of older open obligations when the recent window moves.
  const evidenceIds = evidenceMessageIds(row);
  for (const id of [row.latestMessageId, ...evidenceIds]) {
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
  const docs = [...byId.values()].sort(
    (a, b) => a.receivedAt - b.receivedAt || a.providerMessageId.localeCompare(b.providerMessageId),
  );
  const messages = docs.map(bodyMessage);
  const messageCount = Math.max(Number(row.messageCount) || 0, recent.length);
  // Jev judges a thread one new message at a time. When the message of the
  // last verdict is among the newest messages, every later message is in the
  // window, and the evidence messages of its open obligations are too. The
  // window then holds the open state of the thread.
  const continuesVerdict =
    Boolean(row.jevAssessedMessageId) &&
    recent
      .slice(0, JEV_BODY_MESSAGES)
      .some((message: any) => message.providerMessageId === row.jevAssessedMessageId);
  const input: JevMailInput = {
    accountId: row.accountId,
    threadId: row.providerThreadId,
    messageId: row.latestMessageId || recent[0].providerMessageId,
    sourceRevision: mailSourceRevision(messages),
    selfAddresses: accounts.map((account: any) => account.email.toLowerCase()),
    messages,
    // Context is complete when the message window holds the whole thread. A
    // long body is cut to 2400 characters, but that does not hide a message.
    contextComplete:
      (recent.length <= JEV_BODY_MESSAGES && messageCount <= messages.length) || continuesVerdict,
  };
  const newest = recent[0];
  // A thread with open obligations goes to the body stage at once: the
  // first stage cannot keep or close evidence that it does not read.
  const facts: JevFactsView | undefined = evidenceIds.length
    ? undefined
    : {
        messages: [
          {
            ...bodyMessage(newest),
            body: truncateText(String(newest.snippet || ''), JEV_BODY_CHARS),
          },
        ],
        contextComplete: messageCount <= 1,
        threadFacts: {
          labels: (row.labels || []).slice(0, 20),
          messageCount,
          ruleCategory: row.smartCategory?.primary,
          ruleSignals: (row.smartCategory?.signals || []).slice(0, 12),
        },
      };
  return { input, facts, newest };
}

/** Jev classifies mail of the last 60 days only. Older mail keeps its rule-based category. */
export const JEV_WINDOW_MS = 60 * 86_400_000;
export type JevGate = 'account' | 'age' | 'spam';
const JEV_GATE_ERRORS: Record<JevGate, string> = {
  account: 'The account is not connected.',
  age: 'Mail older than 60 days is not classified.',
  spam: 'Spam and trash are not classified.',
};

/**
 * The reason Jev must not send a thread to the model, or null when it may.
 * Only recent mail of a connected account, outside spam and trash, is sent.
 * claimPending and clearIneligiblePending use this one test.
 */
export function jevGate(
  row: { accountId: string; lastDate?: number; labels?: string[] },
  liveAccountIds: ReadonlySet<string>,
  now: number,
): JevGate | null {
  if (!liveAccountIds.has(row.accountId)) return 'account';
  if (!((row.lastDate || 0) >= now - JEV_WINDOW_MS)) return 'age';
  if (labelsHaveRole(row.labels, 'SPAM') || labelsHaveRole(row.labels, 'TRASH')) return 'spam';
  return null;
}

async function userAccounts(ctx: any, userId: string) {
  const accounts = await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user', (q: any) => q.eq('userId', userId))
    .collect();
  const live = new Set<string>(
    accounts.filter((account: any) => account.status === 'connected').map((a: any) => a.accountId),
  );
  return { accounts, live };
}

// Removes a gated row from the queue. A current verdict stays as it is; other
// rows show the reason in the Unavailable count of the Jev settings.
function gatedPatch(row: any, gate: JevGate) {
  const current = assessmentIsCurrent(row.jev, row.latestMessageId);
  return {
    llmPending: undefined,
    jevStatus: current ? row.jev.status : 'unavailable',
    jevError: current ? undefined : JEV_GATE_ERRORS[gate],
  };
}

/** Pending thread rows that one claim reads. */
export const JEV_CLAIM_SCAN = 40;

// The evidence text that a stored assessment may carry for one message: the
// body-stage text, or the snippet that the first stage read.
function evidenceTexts(message: JevMailMessage, facts?: JevFactsView) {
  const texts = [truncateText(message.body || message.subject, JEV_BODY_CHARS)];
  const seen = facts?.messages.find((entry) => entry.id === message.id);
  if (seen) texts.push(truncateText(seen.body || seen.subject, JEV_BODY_CHARS));
  return texts;
}

export const claimPending = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!(await loadJevSettings(ctx, args.userId)).preferences.enabled)
      return { items: [], moreRemaining: false };
    const limit = Math.max(1, Math.min(20, args.limit ?? 12));
    // IO-1: thread rows are large (verdict, evidence). 40 rows cover three
    // claims of 12; gated and settled rows leave the index, so the next claim
    // reads further down.
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_llm_pending', (q) => q.eq('userId', args.userId).eq('llmPending', true))
      .order('desc')
      .take(JEV_CLAIM_SCAN);
    const { accounts, live } = await userAccounts(ctx, args.userId);
    const items = [];
    const now = Date.now();
    // Rows this claim took off the queue with no model call. Each one lets the
    // next claim read a row further down, so the sweep continues.
    let settled = 0;
    for (const row of rows) {
      if ((row.jevLeaseUntil || 0) > now) continue;
      const gate = jevGate(row, live, now);
      if (gate) {
        await ctx.db.patch(row._id, gatedPatch(row, gate));
        settled++;
        continue;
      }
      if ((row.jevRetryAt || 0) > now || (row.jevAttempts || 0) >= 3) continue;
      // A verdict for the current latest message and Jev version is current
      // without a message read: a content change clears the verdict at write
      // time (classificationFreshnessPatch).
      if (row.jevVersion === JEV_VERSION && assessmentIsCurrent(row.jev, row.latestMessageId)) {
        await ctx.db.patch(row._id, {
          llmPending: undefined,
          jevStatus: row.jev.status,
          jevError: undefined,
        });
        settled++;
        continue;
      }
      const window = await threadWindow(ctx, row, accounts);
      if (!window) {
        await ctx.db.patch(row._id, {
          llmPending: undefined,
          jevStatus: 'unavailable',
          jevError: 'Message content is not synced yet.',
        });
        settled++;
        continue;
      }
      const { input, facts } = window;
      // One classification for each source revision. A queue flag on a row
      // whose verdict already covers this exact content costs no model call.
      // queueUser and a classifier switch set jevVersion to 0 to force a pass.
      if (
        row.jevVersion === JEV_VERSION &&
        assessmentIsCurrent(row.jev, input.messageId, input.sourceRevision)
      ) {
        await ctx.db.patch(row._id, {
          llmPending: undefined,
          jevStatus: row.jev.status,
          jevError: undefined,
          ...(row.latestMessageId ? {} : { latestMessageId: input.messageId }),
        });
        settled++;
        continue;
      }
      const leaseId = `${row._id}:${now}`;
      await ctx.db.patch(row._id, {
        jevLeaseId: leaseId,
        jevLeaseUntil: now + 90_000,
        jevStatus: 'pending',
        // Rows synced before latestMessageId existed take it from the newest
        // message. storeAssessments requires the row to name the message the
        // claim assessed, so without this the result is dropped every time and
        // the row is claimed again forever.
        ...(row.latestMessageId ? {} : { latestMessageId: input.messageId }),
      });
      items.push({ ...input, leaseId, ...(facts ? { facts } : {}) });
      if (items.length === limit) break;
    }
    return { items, moreRemaining: items.length === limit || settled > 0 };
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
      const window = await threadWindow(ctx, row, accounts);
      const input = window?.input;
      if (!window || !input || input.sourceRevision !== item.sourceRevision) {
        // The content changed while the model ran. The attempt counts, so a
        // thread whose revision does not settle stops after three passes.
        const attempts = (row.jevAttempts || 0) + 1;
        await ctx.db.patch(row._id, {
          jevAttempts: attempts,
          jevLeaseId: undefined,
          jevLeaseUntil: undefined,
          llmPending: attempts < 3 ? true : undefined,
          ...(attempts < 3
            ? {}
            : { jevStatus: 'unavailable', jevError: 'Message content changed during classification.' }),
        });
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
                evidenceTexts(message, window.facts).includes(evidence.text),
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
      await noteSavedContactSender(ctx, args.userId, context, row.fromAddress);
      const merged = classifyCorpusThread(
        { ...row, jev: assessment },
        context,
        classifierContent(window.newest),
      );
      await ctx.db.patch(row._id, {
        ...merged,
        jev: assessment,
        jevEvidenceMessageIds: [...new Set(assessment.obligations.map((item) => item.evidence.messageId))],
        jevAssessedMessageId: item.messageId,
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

const clearedCounts = v.object({ account: v.number(), age: v.number(), spam: v.number() });

/**
 * One-time queue cleanup (cost stop, 2026-09-27). It takes queued rows that
 * fail jevGate off the Jev queue: mail of accounts that are not connected, mail
 * older than 60 days, and spam or trash. No model call occurs for them.
 *
 * It reads the pending index of one user at a time, at most 200 rows in each
 * transaction, and schedules the next page, then the next user. It is
 * idempotent: a cleared row leaves the pending index, so a second run finds
 * nothing to clear. The totals are in the deployment logs.
 * Run a dry run first (counts only, no writes), then the real pass:
 *   npx convex run jev:clearIneligiblePending '{"dryRun": true}'
 *   npx convex run jev:clearIneligiblePending '{}'
 * Add `"userId": "<clerk user id>"` to clean one user only.
 */
export const clearIneligiblePending = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    userId: v.optional(v.string()),
    limit: v.optional(v.number()),
    // Continuation state. The scheduler sets these; a caller leaves them out.
    current: v.optional(v.string()),
    cursor: v.optional(v.string()),
    scanned: v.optional(v.number()),
    cleared: v.optional(clearedCounts),
  },
  handler: async (ctx, args) => {
    const scope = args.userId ? `user ${args.userId}` : 'all users';
    const cleared = args.cleared ?? { account: 0, age: 0, spam: 0 };
    let scanned = args.scanned ?? 0;
    // Users go in clerkUserId order. `current` is the user this page reads.
    let current = args.current;
    if (!current)
      current = args.userId
        ? args.userId
        : (await ctx.db.query('users').withIndex('by_clerk_user_id').first())?.clerkUserId;
    const report = (done: boolean) => {
      const total = cleared.account + cleared.age + cleared.spam;
      if (done)
        console.log(
          `[jev queue cleanup] ${scope}: scanned ${scanned}, cleared ${total} (account ${cleared.account}, age ${cleared.age}, spam ${cleared.spam})${args.dryRun ? ' (dry run)' : ''}`,
        );
      return { scanned, cleared, done };
    };
    if (!current) return report(true);
    const userId: string = current;
    const page = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_llm_pending', (q) => q.eq('userId', userId).eq('llmPending', true))
      .paginate({
        cursor: args.cursor ?? null,
        numItems: Math.min(Math.max(args.limit ?? 200, 1), 200),
      });
    const { live } = await userAccounts(ctx, userId);
    const now = Date.now();
    for (const row of page.page) {
      scanned++;
      const gate = jevGate(row, live, now);
      if (!gate) continue;
      cleared[gate]++;
      if (!args.dryRun) await ctx.db.patch(row._id, gatedPatch(row, gate));
    }
    let next: { current: string; cursor?: string } | null = null;
    if (!page.isDone) next = { current: userId, cursor: page.continueCursor };
    else if (!args.userId) {
      const following = await ctx.db
        .query('users')
        .withIndex('by_clerk_user_id', (q) => q.gt('clerkUserId', userId))
        .first();
      if (following) next = { current: following.clerkUserId };
    }
    if (!next) return report(true);
    await ctx.scheduler.runAfter(0, internal.jev.clearIneligiblePending, {
      dryRun: args.dryRun,
      userId: args.userId,
      limit: args.limit,
      ...next,
      scanned,
      cleared,
    });
    return report(false);
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
