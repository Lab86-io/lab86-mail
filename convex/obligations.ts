import { v } from 'convex/values';
import { correctionForMail, type JevAssessment, type JevCorrection } from '../lib/jev/contract';
import {
  mailSourceKey,
  type NeedsYouSnapshot,
  type ObligationCloseReason,
  type ObligationState,
  type ObligationView,
  UNDO_WINDOW_MS,
} from '../lib/obligations/contract';
import {
  decideObligationPush,
  obligationPushSettingsFromRow,
  PUSH_WINDOW_MS,
  releasePlan,
} from '../lib/obligations/push-policy';
import {
  type CodeFacts,
  codeObligation,
  mailObligations,
  type ObligationSourceMessage,
  startOfLocalDay,
  type WantedObligation,
} from '../lib/obligations/rules';
import { emailFromHeader } from '../lib/shared/format';
import { truncateText } from '../lib/shared/text';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalQuery, mutation, query } from './_generated/server';
import { putBriefCorrection } from './dailyReports';
import { now, requireInternalSecret } from './lib';

// Needs you (docs/needs-you.md, docs/needs-you-phase-1.md). The ledger of
// the things the user must do. Jev (convex/jev.ts storeAssessments) and the
// code detector (convex/mailOneTimeCodes.ts recordCode) open, change, and
// close rows; the API routes run the user's actions; the web page reads
// `needsYou`.
//
// The rollout flag LAB86_NEEDS_YOU lives in the Node app (Railway). Convex
// does not read it. Each Node call that writes obligations passes the value
// that the Node app computed (`needsYou`), and the Jev claim records it for
// the user in userDocs (kind `needsYouFlag`), so `needsYou` can answer
// `enabled` for a signed-in browser.

type Obligation = Doc<'obligations'>;
type OpenState = 'open' | 'snoozed';

const FLAG_KIND = 'needsYouFlag';
const OPEN_READ = 200;
const SNOOZED_READ = 100;
const CLOSED_READ = 100;
/** Later: at most this far ahead. */
const MAX_SNOOZE_MS = 90 * 86_400_000;
const LEVEL_RANK = { none: 0, normal: 1, time_sensitive: 2 } as const;

function isOpen(state: ObligationState): state is OpenState {
  return state === 'open' || state === 'snoozed';
}

// ---------------------------------------------------------------------------
// The rollout flag, as the Node app last reported it.
// ---------------------------------------------------------------------------

async function flagRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query('userDocs')
    .withIndex('by_user_kind_key', (q) => q.eq('userId', userId).eq('kind', FLAG_KIND).eq('key', 'default'))
    .unique();
}

export async function needsYouEnabled(ctx: QueryCtx | MutationCtx, userId: string) {
  return (await flagRow(ctx, userId))?.doc?.enabled === true;
}

/**
 * Records the flag value of the Node app for one user. It writes only when
 * the value changes. It returns true when the flag turns on.
 */
export async function recordNeedsYouFlag(ctx: MutationCtx, userId: string, enabled: boolean) {
  const row = await flagRow(ctx, userId);
  if ((row?.doc?.enabled === true) === enabled) return false;
  const ts = now();
  if (row) await ctx.db.patch(row._id, { doc: { enabled }, updatedAt: ts });
  else if (enabled)
    await ctx.db.insert('userDocs', {
      userId,
      kind: FLAG_KIND,
      key: 'default',
      doc: { enabled },
      createdAt: ts,
      updatedAt: ts,
    });
  return enabled;
}

// ---------------------------------------------------------------------------
// The page view of one row.
// ---------------------------------------------------------------------------

type CodeRow = Doc<'mailOneTimeCodes'> | null | undefined;

/** One row as the page reads it. A code past its expiry reads as expired. */
export function obligationView(row: Obligation, code: CodeRow, at: number): ObligationView {
  let state: ObligationState = row.state;
  let closeReason = row.closeReason as ObligationCloseReason | undefined;
  let closedAt = row.closedAt;
  let value: ObligationView['code'];
  if (row.kind === 'code' && isOpen(state)) {
    // Expiry is checked on read, as the code store does: a lagging sweep must
    // never show a live secret past its window.
    const expiresAt = code?.expiresAt ?? row.codeExpiresAt ?? at;
    if (code?.status === 'used') {
      state = 'done';
      closeReason = 'code_used';
      closedAt = code.usedAt ?? at;
    } else if (!code || code.status !== 'active' || expiresAt <= at) {
      state = 'expired';
      closeReason = 'expired';
      closedAt = Math.min(expiresAt, at);
    } else value = { value: code.code, issuer: code.issuer || undefined, expiresAt: code.expiresAt };
  }
  return {
    id: String(row._id),
    kind: row.kind,
    state,
    source: row.source,
    sourceKey: row.sourceKey,
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.threadId ? { threadId: row.threadId } : {}),
    ...(row.messageId ? { messageId: row.messageId } : {}),
    title: row.title,
    asker: row.asker,
    ...(row.askerAddress ? { askerAddress: row.askerAddress } : {}),
    ...(row.why ? { why: row.why } : {}),
    ...(row.excerpt ? { excerpt: row.excerpt } : {}),
    due: row.due,
    ...(row.dueAt !== undefined ? { dueAt: row.dueAt } : {}),
    ...(row.workId ? { workId: row.workId } : {}),
    pushLevel: row.pushLevel,
    probability: row.probability,
    ...(value ? { code: value } : {}),
    ...(state === 'snoozed' && row.snoozedUntil !== undefined ? { snoozedUntil: row.snoozedUntil } : {}),
    ...(draftIsCurrent(row) ? { draftReady: true } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(closedAt !== undefined && !isOpen(state) ? { closedAt } : {}),
    ...(closeReason && !isOpen(state) ? { closeReason } : {}),
  };
}

function draftIsCurrent(row: Obligation) {
  return Boolean(row.draft && row.draft.sourceMessageId === row.sourceMessageId);
}

async function codeRowFor(ctx: QueryCtx | MutationCtx, row: Obligation) {
  return row.kind === 'code' && row.codeId ? ctx.db.get(row.codeId) : undefined;
}

async function viewOf(ctx: QueryCtx | MutationCtx, row: Obligation, at = now()) {
  return obligationView(row, await codeRowFor(ctx, row), at);
}

async function preferenceRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query('albatrossNotificationPreferences')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique();
}

/**
 * `api.obligations.needsYou`: the open and snoozed obligations of the
 * signed-in user, and the ones closed since the start of the user's day.
 * Each read is one index range with a bound.
 */
export const needsYou = query({
  args: {},
  handler: async (ctx): Promise<NeedsYouSnapshot> => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.subject;
    if (!userId) return { enabled: false, timezone: 'UTC', items: [] };
    const [enabled, preference] = await Promise.all([
      needsYouEnabled(ctx, userId),
      preferenceRow(ctx, userId),
    ]);
    const timezone = preference?.timezone || 'UTC';
    if (!enabled) return { enabled: false, timezone, items: [] };
    const at = now();
    const dayStart = startOfLocalDay(at, timezone);
    const [open, snoozed, closed] = await Promise.all([
      ctx.db
        .query('obligations')
        .withIndex('by_user_state', (q) => q.eq('userId', userId).eq('state', 'open'))
        .order('desc')
        .take(OPEN_READ),
      ctx.db
        .query('obligations')
        .withIndex('by_user_state', (q) => q.eq('userId', userId).eq('state', 'snoozed'))
        .order('desc')
        .take(SNOOZED_READ),
      ctx.db
        .query('obligations')
        .withIndex('by_user_closed', (q) => q.eq('userId', userId).gte('closedAt', dayStart))
        .order('desc')
        .take(CLOSED_READ),
    ]);
    const seen = new Set<string>();
    const items: ObligationView[] = [];
    for (const row of [...open, ...snoozed, ...closed]) {
      const id = String(row._id);
      if (seen.has(id)) continue;
      seen.add(id);
      const view = await viewOf(ctx, row, at);
      // A code that expired before today is not part of today's list.
      if (!isOpen(view.state) && (view.closedAt ?? at) < dayStart) continue;
      items.push(view);
    }
    return { enabled: true, timezone, items };
  },
});

// ---------------------------------------------------------------------------
// Jev: open, change, and close the obligations of one thread.
// ---------------------------------------------------------------------------

export interface ThreadSync {
  userId: string;
  accountId: string;
  threadId: string;
  subject: string;
  assessment: JevAssessment;
  /** The messages that Jev read, oldest to newest. */
  messages: ObligationSourceMessage[];
  selfAddresses: string[];
  /** The latest message of the thread. */
  latestMessageId: string;
  corrections: JevCorrection[];
  preference: Record<string, any> | null;
  /** False for a backfill: rows open in-app only. */
  push?: boolean;
  at?: number;
}

function contentPatch(wanted: WantedObligation, latestMessageId: string) {
  return {
    title: truncateText(wanted.title, 300),
    asker: truncateText(wanted.asker, 180),
    askerAddress: wanted.askerAddress,
    why: wanted.why,
    excerpt: wanted.excerpt,
    due: wanted.due,
    dueAt: wanted.dueAt,
    probability: wanted.probability,
    pushLevel: wanted.pushLevel,
    messageId: wanted.messageId,
    sourceMessageId: latestMessageId,
    workId: wanted.workId,
  };
}

const reopenFields = {
  state: 'open' as const,
  closedAt: undefined,
  closeReason: undefined,
  closedBy: undefined,
  closedMessageId: undefined,
  undo: undefined,
  snoozedUntil: undefined,
  pushHeldUntil: undefined,
  pushHoldReason: undefined,
  summarizedAt: undefined,
};

function sourceClose(
  state: 'done' | 'resolved' | 'dismissed' | 'expired',
  reason: ObligationCloseReason,
  at: number,
) {
  return {
    state,
    closeReason: reason,
    closedAt: at,
    closedBy: 'source' as const,
    undo: undefined,
    pushHeldUntil: undefined,
    pushHoldReason: undefined,
  };
}

/**
 * Opens, changes, and closes the obligations of one thread after a Jev
 * assessment, in the caller's transaction. A kind that is gone from the
 * assessment closes as `resolved` (`evidence`), or as `done` (`sent_reply`)
 * when the newest message is the user's own. A close by the user stays
 * closed until the thread has a newer message that is not the user's. It
 * returns the ids that need a push.
 */
export async function syncThreadObligations(ctx: MutationCtx, input: ThreadSync): Promise<string[]> {
  const at = input.at ?? now();
  const sourceKey = mailSourceKey(input.accountId, input.threadId);
  const settings = obligationPushSettingsFromRow(input.preference);
  const correction = correctionForMail(input.corrections, {
    accountId: input.accountId,
    threadId: input.threadId,
    sender: input.assessment.sender || '',
    listId: input.assessment.listId,
  });
  const excluded = correction?.brief === 'exclude';
  const wanted = mailObligations(
    input.assessment,
    {
      accountId: input.accountId,
      threadId: input.threadId,
      subject: input.subject,
      messages: input.messages,
      selfAddresses: input.selfAddresses,
    },
    { vipSenders: settings.vipSenders, timezone: settings.timezone, excluded },
    at,
  );
  const rows = (
    await ctx.db
      .query('obligations')
      .withIndex('by_user_source', (q) => q.eq('userId', input.userId).eq('sourceKey', sourceKey))
      .take(10)
  ).filter((row) => row.kind !== 'code');
  const self = new Set(input.selfAddresses.map((address) => address.toLowerCase()));
  const newestFrom = emailFromHeader(input.messages.at(-1)?.from);
  const newestIsOwn = Boolean(newestFrom && self.has(newestFrom));
  const push = input.push !== false;
  const toPush: string[] = [];
  for (const item of wanted) {
    const row = rows.find((entry) => entry.kind === item.kind);
    const content = contentPatch(item, input.latestMessageId);
    if (!row) {
      const id = await ctx.db.insert('obligations', {
        userId: input.userId,
        kind: item.kind,
        state: 'open',
        source: 'mail',
        sourceKey,
        accountId: input.accountId,
        threadId: input.threadId,
        ...content,
        openedAt: at,
        createdAt: at,
        updatedAt: at,
      });
      if (push && item.pushLevel !== 'none') toPush.push(String(id));
      continue;
    }
    if (isOpen(row.state)) {
      const wake = row.state === 'snoozed' && (row.snoozedUntil ?? 0) <= at;
      await ctx.db.patch(row._id, {
        ...content,
        ...(wake ? { state: 'open' as const, snoozedUntil: undefined } : {}),
        updatedAt: at,
      });
      // A change does not push again. A higher level (an in-app item that
      // now passes the push bar) does, with the same collapse id.
      if (
        push &&
        (wake ? 'open' : row.state) === 'open' &&
        LEVEL_RANK[item.pushLevel] > LEVEL_RANK[row.pushLevel] &&
        !row.pushHeldUntil
      )
        toPush.push(String(row._id));
      continue;
    }
    // Closed. A user close holds until the thread has a newer message that is
    // not the user's own (decision 8: the sender writes again).
    if (row.closedBy === 'user' && (row.closedMessageId === input.latestMessageId || newestIsOwn)) continue;
    await ctx.db.patch(row._id, { ...content, ...reopenFields, openedAt: at, updatedAt: at });
    if (push && item.pushLevel !== 'none') toPush.push(String(row._id));
  }
  const kinds = new Set(wanted.map((item) => item.kind));
  for (const row of rows) {
    if (kinds.has(row.kind) || !isOpen(row.state)) continue;
    const close = excluded
      ? sourceClose('dismissed', 'not_mine', at)
      : newestIsOwn
        ? sourceClose('done', 'sent_reply', at)
        : sourceClose('resolved', 'evidence', at);
    await ctx.db.patch(row._id, { ...close, sourceMessageId: input.latestMessageId, updatedAt: at });
  }
  return toPush;
}

// ---------------------------------------------------------------------------
// One-time codes (S6). The code value stays in mailOneTimeCodes.
// ---------------------------------------------------------------------------

/**
 * Opens the `code` obligation of a recorded code, or puts the new code on
 * the thread's existing code row (the push then replaces the old one). It
 * returns the id to push.
 */
export async function recordCodeObligation(
  ctx: MutationCtx,
  input: CodeFacts & { userId: string; accountId: string; threadId: string; codeId: Id<'mailOneTimeCodes'> },
): Promise<string> {
  const at = now();
  const sourceKey = mailSourceKey(input.accountId, input.threadId);
  const wanted = codeObligation(input);
  const row = await ctx.db
    .query('obligations')
    .withIndex('by_user_source', (q) =>
      q.eq('userId', input.userId).eq('sourceKey', sourceKey).eq('kind', 'code'),
    )
    .first();
  const content = {
    ...contentPatch(wanted, input.messageId),
    codeId: input.codeId,
    codeExpiresAt: input.expiresAt,
  };
  if (row) {
    await ctx.db.patch(row._id, { ...content, ...reopenFields, openedAt: at, updatedAt: at });
    return String(row._id);
  }
  return String(
    await ctx.db.insert('obligations', {
      userId: input.userId,
      kind: 'code',
      state: 'open',
      source: 'mail',
      sourceKey,
      accountId: input.accountId,
      threadId: input.threadId,
      ...content,
      openedAt: at,
      createdAt: at,
      updatedAt: at,
    }),
  );
}

/** Closes the code obligation of one code: used (`code_used`) or expired. */
export async function closeCodeObligation(
  ctx: MutationCtx,
  code: Pick<Doc<'mailOneTimeCodes'>, '_id' | 'userId' | 'accountId' | 'providerThreadId'>,
  reason: 'code_used' | 'expired',
  at = now(),
) {
  const row = await ctx.db
    .query('obligations')
    .withIndex('by_user_source', (q) =>
      q
        .eq('userId', code.userId)
        .eq('sourceKey', mailSourceKey(code.accountId, code.providerThreadId))
        .eq('kind', 'code'),
    )
    .first();
  if (!row || row.codeId !== code._id || !isOpen(row.state)) return false;
  await ctx.db.patch(row._id, {
    ...(reason === 'code_used'
      ? sourceClose('done', 'code_used', at)
      : sourceClose('expired', 'expired', at)),
    updatedAt: at,
  });
  return true;
}

// ---------------------------------------------------------------------------
// The user's actions (POST /api/obligations/[id]).
// ---------------------------------------------------------------------------

async function ownRow(ctx: QueryCtx | MutationCtx, userId: string, id: string) {
  const obligationId = ctx.db.normalizeId('obligations', id);
  if (!obligationId) return null;
  const row = await ctx.db.get(obligationId);
  return row?.userId === userId ? row : null;
}

async function threadRow(ctx: QueryCtx | MutationCtx, row: Obligation) {
  if (!row.accountId || !row.threadId) return null;
  return ctx.db
    .query('mailCorpusThreads')
    .withIndex('by_user_account_thread', (q) =>
      q.eq('userId', row.userId).eq('accountId', row.accountId!).eq('providerThreadId', row.threadId!),
    )
    .unique();
}

/**
 * True when the newest message of the thread is the user's own and is newer
 * than the evidence: the user replied outside Needs you.
 */
async function userReplied(ctx: MutationCtx, row: Obligation) {
  if (!row.accountId || !row.threadId) return false;
  const [newest] = await ctx.db
    .query('mailCorpusMessages')
    .withIndex('by_user_account_thread_received', (q) =>
      q.eq('userId', row.userId).eq('accountId', row.accountId!).eq('providerThreadId', row.threadId!),
    )
    .order('desc')
    .take(1);
  if (!newest || newest.providerMessageId === row.messageId) return false;
  const accounts = await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user', (q) => q.eq('userId', row.userId))
    .collect();
  const from = emailFromHeader(newest.from);
  return Boolean(from && accounts.some((account) => account.email?.toLowerCase() === from));
}

/** The rows that one user action closes together: the row, and for Not mine the other open rows of its thread. */
async function threadSiblings(ctx: MutationCtx, row: Obligation) {
  return (
    await ctx.db
      .query('obligations')
      .withIndex('by_user_source', (q) => q.eq('userId', row.userId).eq('sourceKey', row.sourceKey))
      .take(10)
  ).filter((entry) => entry._id !== row._id && entry.kind !== 'code' && isOpen(entry.state));
}

type ActResult =
  | { ok: true; obligation: ObligationView; undoUntil?: number }
  | {
      ok: false;
      error: 'not_found' | 'closed' | 'invalid' | 'undo_expired' | 'send_pending';
      pendingId?: string;
    };

export const get = query({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ownRow(ctx, args.userId, args.id);
    if (!row) return null;
    return {
      obligation: await viewOf(ctx, row),
      sourceMessageId: row.sourceMessageId ?? null,
      undo: row.undo ? { until: row.undo.until, pendingId: row.undo.pendingId ?? null } : null,
      draft:
        draftIsCurrent(row) && row.draft
          ? { to: row.draft.to, cc: row.draft.cc, subject: row.draft.subject, body: row.draft.body }
          : null,
    };
  },
});

export const act = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    id: v.string(),
    action: v.union(v.literal('done'), v.literal('later'), v.literal('not_mine'), v.literal('undo')),
    until: v.optional(v.number()),
    // Not mine: the scoped Jev correction that the Node route built.
    correction: v.optional(v.any()),
    // Undo of a reply: the route cancelled the outbox send first.
    sendCancelled: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ActResult> => {
    requireInternalSecret(args.internalSecret);
    const row = await ownRow(ctx, args.userId, args.id);
    if (!row) return { ok: false, error: 'not_found' };
    const at = now();
    const result = async (undoUntil?: number): Promise<ActResult> => {
      const fresh = (await ctx.db.get(row._id))!;
      return { ok: true, obligation: await viewOf(ctx, fresh, at), ...(undoUntil ? { undoUntil } : {}) };
    };
    if (args.action === 'undo') {
      if (!row.undo || row.undo.until < at) return { ok: false, error: 'undo_expired' };
      if (row.undo.pendingId && !args.sendCancelled)
        return { ok: false, error: 'send_pending', pendingId: row.undo.pendingId };
      const undo = row.undo;
      const restore = (entry: Obligation) => ({
        state: entry.undo!.state,
        snoozedUntil: entry.undo!.snoozedUntil,
        closedAt: undefined,
        closeReason: undefined,
        closedBy: undefined,
        closedMessageId: undefined,
        undo: undefined,
        updatedAt: at,
      });
      await ctx.db.patch(row._id, restore(row));
      if (undo.correctionId) {
        await putBriefCorrection(ctx, row.userId, undo.correctionId, undo.previousCorrection ?? null);
        // The other rows of the thread that the same Not mine closed.
        const siblings = await ctx.db
          .query('obligations')
          .withIndex('by_user_source', (q) => q.eq('userId', row.userId).eq('sourceKey', row.sourceKey))
          .take(10);
        for (const entry of siblings)
          if (entry._id !== row._id && entry.state === 'dismissed' && entry.undo?.until === undo.until)
            await ctx.db.patch(entry._id, restore(entry));
      }
      return result();
    }
    if (!isOpen(row.state)) return { ok: false, error: 'closed' };
    const previous = { state: row.state as OpenState, snoozedUntil: row.snoozedUntil };
    const until = at + UNDO_WINDOW_MS;
    const thread = await threadRow(ctx, row);
    const closedMessageId = thread?.latestMessageId ?? row.sourceMessageId;
    if (args.action === 'later') {
      const wake = Number(args.until);
      if (!Number.isFinite(wake) || wake <= at || wake > at + MAX_SNOOZE_MS)
        return { ok: false, error: 'invalid' };
      // Later is in-app only: a held push of the row does not go out.
      await ctx.db.patch(row._id, {
        state: 'snoozed',
        snoozedUntil: Math.round(wake),
        pushHeldUntil: undefined,
        pushHoldReason: undefined,
        undo: { until, ...previous },
        updatedAt: at,
      });
      return result(until);
    }
    if (args.action === 'done') {
      // Done on a reply without a sent reply: no second check (decision 8).
      const reason: ObligationCloseReason =
        row.kind === 'reply' && !(await userReplied(ctx, row)) ? 'user_done_no_reply' : 'user_done';
      await ctx.db.patch(row._id, {
        state: 'done',
        closeReason: reason,
        closedAt: at,
        closedBy: 'user',
        closedMessageId,
        pushHeldUntil: undefined,
        pushHoldReason: undefined,
        undo: { until, ...previous },
        updatedAt: at,
      });
      return result(until);
    }
    // Not mine: a scoped Jev correction, and the rows of the thread close.
    let correctionId: string | undefined;
    let previousCorrection: JevCorrection | null = null;
    if (row.kind !== 'code') {
      const correction = args.correction as JevCorrection | undefined;
      if (!correction?.id) return { ok: false, error: 'invalid' };
      correctionId = correction.id;
      previousCorrection = (await putBriefCorrection(ctx, row.userId, correction.id, correction)).previous;
    }
    const dismiss = (entry: Obligation, withCorrection: boolean) => ({
      state: 'dismissed' as const,
      closeReason: 'not_mine' as const,
      closedAt: at,
      closedBy: 'user' as const,
      closedMessageId,
      pushHeldUntil: undefined,
      pushHoldReason: undefined,
      undo: {
        until,
        state: entry.state as OpenState,
        snoozedUntil: entry.snoozedUntil,
        ...(withCorrection && correctionId ? { correctionId, previousCorrection } : {}),
      },
      updatedAt: at,
    });
    await ctx.db.patch(row._id, dismiss(row, true));
    if (correctionId)
      for (const entry of await threadSiblings(ctx, row))
        await ctx.db.patch(entry._id, dismiss(entry, false));
    return result(until);
  },
});

/**
 * The reply route sent (or queued) the reply: the row closes as `done`
 * (`sent_reply`). A queued send keeps Undo until it leaves the outbox.
 */
export const recordReply = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    id: v.string(),
    pendingId: v.optional(v.string()),
    fireAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ActResult> => {
    requireInternalSecret(args.internalSecret);
    const row = await ownRow(ctx, args.userId, args.id);
    if (!row) return { ok: false, error: 'not_found' };
    if (!isOpen(row.state)) return { ok: false, error: 'closed' };
    const at = now();
    const thread = await threadRow(ctx, row);
    const undoUntil = args.pendingId && args.fireAt && args.fireAt > at ? args.fireAt : undefined;
    await ctx.db.patch(row._id, {
      state: 'done',
      closeReason: 'sent_reply',
      closedAt: at,
      closedBy: 'user',
      closedMessageId: thread?.latestMessageId ?? row.sourceMessageId,
      pushHeldUntil: undefined,
      pushHoldReason: undefined,
      undo: undoUntil
        ? {
            until: undoUntil,
            state: row.state as OpenState,
            snoozedUntil: row.snoozedUntil,
            pendingId: args.pendingId,
          }
        : undefined,
      updatedAt: at,
    });
    const fresh = (await ctx.db.get(row._id))!;
    return { ok: true, obligation: await viewOf(ctx, fresh, at), ...(undoUntil ? { undoUntil } : {}) };
  },
});

/** Keeps the prepared reply of a row, for its current source message. */
export const saveDraft = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    id: v.string(),
    draft: v.object({
      to: v.array(v.string()),
      cc: v.array(v.string()),
      subject: v.string(),
      body: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ownRow(ctx, args.userId, args.id);
    if (!row) return { saved: false };
    const at = now();
    await ctx.db.patch(row._id, {
      draft: {
        to: args.draft.to.slice(0, 20).map((entry) => truncateText(entry, 320)),
        cc: args.draft.cc.slice(0, 20).map((entry) => truncateText(entry, 320)),
        subject: truncateText(args.draft.subject, 500),
        body: truncateText(args.draft.body, 8_000),
        sourceMessageId: row.sourceMessageId,
        createdAt: at,
      },
      updatedAt: at,
    });
    return { saved: true };
  },
});

// ---------------------------------------------------------------------------
// Push delivery (S4). The decision is in lib/obligations/push-policy.ts; the
// app (lib/obligations/delivery.ts) sends the APNs push.
// ---------------------------------------------------------------------------

const SUMMARY_KEY = 'obligation-summary:';

function summaryKey(at: number) {
  // Zero-padded, so the key order is the time order.
  return `${SUMMARY_KEY}${String(Math.max(0, Math.round(at))).padStart(15, '0')}`;
}

async function lastSummaryAt(ctx: QueryCtx | MutationCtx, userId: string) {
  const row = await ctx.db
    .query('albatrossNotifications')
    .withIndex('by_user_dedupe', (q) =>
      q.eq('userId', userId).gte('dedupeKey', SUMMARY_KEY).lt('dedupeKey', `${SUMMARY_KEY}~`),
    )
    .order('desc')
    .first();
  return row?.createdAt;
}

async function recentPushes(ctx: QueryCtx | MutationCtx, userId: string, at: number) {
  const rows = await ctx.db
    .query('obligations')
    .withIndex('by_user_pushed', (q) => q.eq('userId', userId).gt('pushedAt', at - PUSH_WINDOW_MS))
    .take(50);
  return rows.filter((row) => row.kind !== 'code').map((row) => row.pushedAt!);
}

/** The deep link of a mail obligation: the format of the `mail_message` link, which the iOS app opens. */
export function obligationDeepLink(row: Pick<Obligation, 'accountId' | 'threadId' | 'messageId'>) {
  if (!row.accountId || !row.threadId) return '/?view=notifications';
  const query = new URLSearchParams({ account: row.accountId, thread: row.threadId });
  if (row.messageId) query.set('message', row.messageId);
  return `/mail/thread?${query.toString()}`;
}

async function insertNotification(
  ctx: MutationCtx,
  input: {
    userId: string;
    title: string;
    body: string;
    deepLink: string;
    dedupeKey: string;
    entityId?: string;
    at: number;
  },
) {
  return ctx.db.insert('albatrossNotifications', {
    userId: input.userId,
    type: 'obligation',
    title: truncateText(input.title.trim() || 'Needs you', 180),
    body: truncateText(input.body.trim() || 'Something needs you.', 1_000),
    ...(input.entityId ? { entityKind: 'obligation' as const, entityId: input.entityId } : {}),
    deepLink: input.deepLink,
    dedupeKey: input.dedupeKey,
    // The in-app list reads the obligations table; this row carries the push.
    status: 'delivered',
    scheduledFor: input.at,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

/** Writes the notification row of one push and marks the row pushed. */
async function pushRow(ctx: MutationCtx, row: Obligation, at: number) {
  const count = (row.pushCount ?? 0) + 1;
  const notificationId = await insertNotification(ctx, {
    userId: row.userId,
    title: row.asker,
    body: row.title,
    deepLink: obligationDeepLink(row),
    dedupeKey: `obligation:${String(row._id)}:${count}`,
    entityId: String(row._id),
    at,
  });
  await ctx.db.patch(row._id, {
    pushedAt: at,
    pushCount: count,
    notificationId,
    pushHeldUntil: undefined,
    pushHoldReason: undefined,
    updatedAt: at,
  });
  return {
    notificationId: String(notificationId),
    collapseId: String(row._id),
    codeAvailable: row.kind === 'code',
    timeSensitive: row.kind === 'code' || row.pushLevel === 'time_sensitive',
  };
}

export type ClaimedPush = Awaited<ReturnType<typeof pushRow>>;

/**
 * Decides the push of one obligation in one transaction: push now (it writes
 * the notification row), hold it (quiet hours or the hourly limit), or keep
 * it in-app only.
 */
export const claimPush = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    id: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ownRow(ctx, args.userId, args.id);
    if (!row) return { action: 'none' as const, reason: 'not_found' };
    const at = args.now ?? now();
    const [preference, pushes, summaryAt] = await Promise.all([
      preferenceRow(ctx, args.userId),
      recentPushes(ctx, args.userId, at),
      lastSummaryAt(ctx, args.userId),
    ]);
    // A code past its expiry does not push.
    const state = row.kind === 'code' && (row.codeExpiresAt ?? 0) <= at ? 'expired' : row.state;
    const decision = decideObligationPush({
      obligation: { kind: row.kind, state, pushLevel: row.pushLevel, askerAddress: row.askerAddress },
      settings: obligationPushSettingsFromRow(preference),
      now: at,
      recentPushes: pushes,
      lastSummaryAt: summaryAt,
    });
    if (decision.action === 'push') return { action: 'push' as const, ...(await pushRow(ctx, row, at)) };
    if (decision.action === 'hold') {
      await ctx.db.patch(row._id, {
        pushHeldUntil: decision.until,
        pushHoldReason: decision.reason,
        updatedAt: at,
      });
      return { action: 'hold' as const, reason: decision.reason, until: decision.until };
    }
    return { action: 'none' as const, reason: decision.reason };
  },
});

/** Users with a held obligation push that is due. */
export const dueHeldUsers = query({
  args: {
    internalSecret: v.optional(v.string()),
    now: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const at = args.now ?? now();
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 500), 1), 2_000);
    const rows = await ctx.db
      .query('obligations')
      .withIndex('by_push_held', (q) => q.gt('pushHeldUntil', 0).lte('pushHeldUntil', at))
      .take(limit);
    return { userIds: [...new Set(rows.map((row) => row.userId))] };
  },
});

export const hasDueHeldPushes = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db
      .query('obligations')
      .withIndex('by_push_held', (q) => q.gt('pushHeldUntil', 0).lte('pushHeldUntil', now()))
      .first()) !== null,
});

/**
 * Releases the due held pushes of one user: one item pushes as itself, more
 * become one summary push (at most one each hour).
 */
export const claimHeldPushes = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const at = args.now ?? now();
    const held = await ctx.db
      .query('obligations')
      .withIndex('by_user_push_held', (q) =>
        q.eq('userId', args.userId).gt('pushHeldUntil', 0).lte('pushHeldUntil', at),
      )
      .take(50);
    const due: Obligation[] = [];
    for (const row of held) {
      if (row.state === 'open') due.push(row);
      else await ctx.db.patch(row._id, { pushHeldUntil: undefined, pushHoldReason: undefined });
    }
    const [preference, pushes, summaryAt] = await Promise.all([
      preferenceRow(ctx, args.userId),
      recentPushes(ctx, args.userId, at),
      lastSummaryAt(ctx, args.userId),
    ]);
    const plan = releasePlan({
      due: due.map((row) => ({ id: String(row._id), reason: row.pushHoldReason ?? 'quiet_hours' })),
      settings: obligationPushSettingsFromRow(preference),
      now: at,
      recentPushes: pushes,
      lastSummaryAt: summaryAt,
    });
    if (plan.action === 'wait') return { kind: 'wait' as const };
    if (plan.action === 'single') {
      const row = due.find((entry) => String(entry._id) === plan.id)!;
      return { kind: 'push' as const, push: await pushRow(ctx, row, at) };
    }
    if (plan.action === 'later') {
      for (const row of due)
        await ctx.db.patch(row._id, { pushHeldUntil: plan.until, pushHoldReason: 'limit' });
      return { kind: 'later' as const, until: plan.until };
    }
    const notificationId = await insertNotification(ctx, {
      userId: args.userId,
      title: plan.title,
      body: plan.body,
      deepLink: '/?view=notifications',
      dedupeKey: summaryKey(at),
      at,
    });
    for (const row of due)
      await ctx.db.patch(row._id, { pushHeldUntil: undefined, pushHoldReason: undefined, summarizedAt: at });
    return { kind: 'summary' as const, notificationId: String(notificationId), count: plan.ids.length };
  },
});
