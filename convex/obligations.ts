import { v } from 'convex/values';
import { correctionForMail, type JevAssessment, type JevCorrection } from '../lib/jev/contract';
import {
  CHANGE_AUTO_CLOSE_MS,
  mailSourceKey,
  type NeedsYouSnapshot,
  type ObligationCloseReason,
  type ObligationKind,
  type ObligationSource,
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
  type CalendarEventFacts,
  CLOSED_RETENTION_MS,
  type CodeFacts,
  type ContentLabelFacts,
  calendarEventId,
  calendarSourceKey,
  codeObligation,
  contentItemFacts,
  contentObligation,
  contentObligationSource,
  mailObligations,
  type ObligationSourceMessage,
  ownParticipant,
  PREPARE_WINDOW_MS,
  prepareCandidate,
  prepareObligation,
  prepareRevision,
  RSVP_WINDOW_MS,
  rsvpObligation,
  startOfLocalDay,
  sweepAtFor,
  sweepStep,
  type WantedObligation,
} from '../lib/obligations/rules';
import { emailFromHeader } from '../lib/shared/format';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
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
    ...(row.workId && row.workTitle ? { workTitle: row.workTitle } : {}),
    ...(row.sourceLabel ? { sourceLabel: row.sourceLabel } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.eventId ? { eventId: row.eventId } : {}),
    ...(row.eventStart !== undefined ? { eventStart: row.eventStart } : {}),
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

/** The page view of one row, with its code read from the code store. */
export async function viewOf(ctx: QueryCtx | MutationCtx, row: Obligation, at = now()) {
  return obligationView(row, await codeRowFor(ctx, row), at);
}

async function preferenceRow(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query('albatrossNotificationPreferences')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique();
}

/**
 * The NeedsYouSnapshot of one user: the open and snoozed obligations, and the
 * ones closed since the start of the user's day. Each read is one index range
 * with a bound. The web page (`needsYou`) and the mobile routes
 * (`obligationViews:snapshotFor`) both read through this loader, so a rule
 * change shows the same on every client.
 */
export async function loadNeedsYouSnapshot(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  at = now(),
): Promise<NeedsYouSnapshot> {
  const [enabled, preference] = await Promise.all([needsYouEnabled(ctx, userId), preferenceRow(ctx, userId)]);
  const timezone = preference?.timezone || 'UTC';
  if (!enabled) return { enabled: false, timezone, items: [] };
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
}

/** `api.obligations.needsYou`: the snapshot of the signed-in user. */
export const needsYou = query({
  args: {},
  handler: async (ctx): Promise<NeedsYouSnapshot> => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.subject;
    if (!userId) return { enabled: false, timezone: 'UTC', items: [] };
    return loadNeedsYouSnapshot(ctx, userId);
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
  /** The 30-day fill: no time-sensitive row (phase 1.1). */
  fill?: boolean;
  /**
   * The phase 1.1 repair: a row that the new rules drop closes at the time
   * the rules would have closed it, so it does not fill "Closed today".
   */
  repair?: boolean;
  at?: number;
}

/** The Albatross of a row: its id, its title, and if the user used it in the last 7 days. */
interface WorkLink {
  workId: string;
  workTitle?: string;
  recent: boolean;
}

const WORK_RECENT_MS = 7 * 86_400_000;

/**
 * The Albatross that an id names, when it is the user's and still active.
 * A `proposal:` id (a prepared draft) is not an Albatross yet.
 */
async function workLink(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  workId: string | null | undefined,
  at: number,
) {
  if (!workId || workId.startsWith('proposal:')) return undefined;
  const id = ctx.db.normalizeId('albatrossIntents', workId);
  const work = id ? await ctx.db.get(id) : null;
  if (!work || work.userId !== userId) return undefined;
  const state = String(work.workState || work.status || '');
  if (['done', 'archived', 'released'].includes(state)) return undefined;
  const touched = work.lastUserTouchAt ?? work.createdAt;
  return {
    workId: String(work._id),
    ...(work.title ? { workTitle: truncateText(work.title, 180) } : {}),
    recent: touched >= at - WORK_RECENT_MS,
  } satisfies WorkLink;
}

/** The Albatross that the content label of a source item names (jev_content labels mail threads too). */
async function labelWork(ctx: QueryCtx | MutationCtx, userId: string, key: string, at: number) {
  const item = await ctx.db
    .query('contentItems')
    .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', key))
    .unique();
  return item && !item.deleted ? workLink(ctx, userId, item.labels?.workId, at) : undefined;
}

function contentPatch(wanted: WantedObligation, sourceMessageId: string | undefined, at = now()) {
  const sweepAt = sweepAtFor({ ...wanted, state: 'open', openedAt: at });
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
    sourceMessageId,
    sourceAt: wanted.sourceAt,
    sweepAt,
    // A label never clears an Albatross link: the user can set one with
    // "Start in Albatross". The caller adds the link when it has one.
    ...(wanted.sourceLabel ? { sourceLabel: truncateText(wanted.sourceLabel, 180) } : {}),
    ...(wanted.url ? { url: wanted.url } : {}),
    ...(wanted.eventId ? { eventId: wanted.eventId } : {}),
    ...(wanted.calendarId ? { calendarId: wanted.calendarId } : {}),
    ...(wanted.eventStart !== undefined ? { eventStart: wanted.eventStart } : {}),
  };
}

/** The link fields for a row: the label's Albatross fills an empty link only. */
function workPatch(row: Obligation | undefined, work: WorkLink | undefined) {
  if (!work || (row?.workId && row.workId !== work.workId)) return {};
  return { workId: work.workId, ...(work.workTitle ? { workTitle: work.workTitle } : {}) };
}

/**
 * The follow-up of a `waiting` item (phase 1 gap): one push when its due time
 * passes. The hold uses the held-push path, so quiet hours and the hourly
 * limit apply. A row that had its follow-up gets no second one.
 */
function followUpPatch(wanted: WantedObligation, row: Obligation | undefined, at: number, push: boolean) {
  if (wanted.kind !== 'waiting' || row?.followUpAt) return {};
  const held = row?.pushHoldReason === 'follow_up';
  if (push && wanted.dueAt !== undefined && wanted.dueAt > at)
    return { pushHeldUntil: wanted.dueAt, pushHoldReason: 'follow_up' as const };
  // A follow-up that is due waits for the release; a lost or moved due time ends it.
  if (held && wanted.dueAt !== undefined && wanted.dueAt === row?.pushHeldUntil) return {};
  return held ? { pushHeldUntil: undefined, pushHoldReason: undefined } : {};
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
  followUpAt: undefined,
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
    sweepAt: undefined,
  };
}

type Close = {
  state: 'done' | 'resolved' | 'dismissed' | 'expired';
  reason: ObligationCloseReason;
  closedAt?: number;
};

interface SourceSync {
  userId: string;
  source: ObligationSource;
  sourceKey: string;
  accountId?: string;
  threadId?: string;
  /** The kinds that this sync manages. A row of another kind is left alone. */
  kinds: readonly ObligationKind[];
  wanted: WantedObligation[];
  /** The source revision: the latest message of a thread, or the version of an item. */
  sourceMessageId?: string;
  work?: WorkLink;
  push: boolean;
  at: number;
  /** True when a close by the user holds: the source has nothing new from another person. */
  userCloseHolds: (row: Obligation) => boolean;
  /** How an open row whose kind is gone closes. */
  closeGone: (row: Obligation) => Close;
}

/**
 * Opens, changes, and closes the rows of one source item, in the caller's
 * transaction. It returns the ids that need a push.
 */
async function applyWanted(ctx: MutationCtx, input: SourceSync): Promise<string[]> {
  const { at, push } = input;
  const rows = (
    await ctx.db
      .query('obligations')
      .withIndex('by_user_source', (q) => q.eq('userId', input.userId).eq('sourceKey', input.sourceKey))
      .take(10)
  ).filter((row) => input.kinds.includes(row.kind));
  const toPush: string[] = [];
  for (const item of input.wanted) {
    const row = rows.find((entry) => entry.kind === item.kind);
    const content = {
      ...contentPatch(item, input.sourceMessageId, at),
      ...workPatch(row, input.work),
      ...followUpPatch(item, row, at, push),
    };
    if (!row) {
      const id = await ctx.db.insert('obligations', {
        userId: input.userId,
        kind: item.kind,
        state: 'open',
        source: input.source,
        sourceKey: input.sourceKey,
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
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
    // Closed. A user close holds until the source has something new from
    // another person (decision 8: the sender writes again).
    if (row.closedBy === 'user' && input.userCloseHolds(row)) continue;
    await ctx.db.patch(row._id, {
      ...content,
      ...reopenFields,
      ...followUpPatch(item, undefined, at, push),
      openedAt: at,
      updatedAt: at,
    });
    if (push && item.pushLevel !== 'none') toPush.push(String(row._id));
  }
  const kinds = new Set(input.wanted.map((item) => item.kind));
  for (const row of rows) {
    if (kinds.has(row.kind) || !isOpen(row.state)) continue;
    const close = input.closeGone(row);
    await ctx.db.patch(row._id, {
      ...sourceClose(close.state, close.reason, close.closedAt ?? at),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      updatedAt: at,
    });
  }
  return toPush;
}

/** True when a change row is older than CHANGE_AUTO_CLOSE_MS. */
function changeAged(row: Pick<Obligation, 'kind' | 'sourceAt' | 'openedAt'>, sourceAt: number, at: number) {
  return row.kind === 'change' && at - sourceAt >= CHANGE_AUTO_CLOSE_MS;
}

/**
 * Opens, changes, and closes the obligations of one thread after a Jev
 * assessment, in the caller's transaction. A kind that is gone from the
 * assessment closes as `resolved` (`evidence`), as `resolved` (`aged_out`)
 * for a change older than CHANGE_AUTO_CLOSE_MS, or as `done` (`sent_reply`)
 * when the newest message is the user's own. A close by the user stays
 * closed until the thread has a newer message that is not the user's. The
 * Albatross comes from the content label of the thread. It returns the ids
 * that need a push.
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
  const work = await labelWork(ctx, input.userId, sourceKey, at);
  const wanted = mailObligations(
    input.assessment,
    {
      accountId: input.accountId,
      threadId: input.threadId,
      subject: input.subject,
      messages: input.messages,
      selfAddresses: input.selfAddresses,
      ...(work ? { workId: work.workId } : {}),
    },
    {
      vipSenders: settings.vipSenders,
      timezone: settings.timezone,
      excluded,
      recentWorkIds: work?.recent ? [work.workId] : [],
      fill: input.fill,
    },
    at,
  );
  const self = new Set(input.selfAddresses.map((address) => address.toLowerCase()));
  const newestFrom = emailFromHeader(input.messages.at(-1)?.from);
  const newestIsOwn = Boolean(newestFrom && self.has(newestFrom));
  const dateOf = (messageId: string | undefined) =>
    input.messages.find((message) => message.id === messageId)?.date;
  return applyWanted(ctx, {
    userId: input.userId,
    source: 'mail',
    sourceKey,
    accountId: input.accountId,
    threadId: input.threadId,
    kinds: ['reply', 'action', 'waiting', 'change'],
    wanted,
    sourceMessageId: input.latestMessageId,
    work,
    push: input.push !== false,
    at,
    userCloseHolds: (row) => row.closedMessageId === input.latestMessageId || newestIsOwn,
    closeGone: (row) => {
      const sourceAt = row.sourceAt ?? dateOf(row.messageId) ?? row.openedAt;
      const aged = changeAged(row, sourceAt, at);
      // The repair closes a row that the new rules drop at the time the
      // rules would have closed it: when it aged out, or at its message.
      const closedAt = input.repair
        ? Math.min(at, aged ? sourceAt + CHANGE_AUTO_CLOSE_MS : sourceAt)
        : undefined;
      if (excluded) return { state: 'dismissed', reason: 'not_mine', closedAt };
      if (newestIsOwn) return { state: 'done', reason: 'sent_reply', closedAt };
      return { state: 'resolved', reason: aged ? 'aged_out' : 'evidence', closedAt };
    },
  });
}

/**
 * Closes the open rows of one source item as `resolved` (`evidence`): the
 * mail thread moved to Trash or Spam, or the connector item was deleted.
 */
export async function closeSourceObligations(
  ctx: MutationCtx,
  userId: string,
  sourceKey: string,
  at = now(),
) {
  const rows = await ctx.db
    .query('obligations')
    .withIndex('by_user_source', (q) => q.eq('userId', userId).eq('sourceKey', sourceKey))
    .take(10);
  let closed = 0;
  for (const row of rows) {
    if (row.kind === 'code' || !isOpen(row.state)) continue;
    await ctx.db.patch(row._id, { ...sourceClose('resolved', 'evidence', at), updatedAt: at });
    closed += 1;
  }
  return closed;
}

/** True when the source item has an open row (a tombstone must reach it). */
export async function hasOpenObligation(ctx: QueryCtx | MutationCtx, userId: string, sourceKey: string) {
  const rows = await ctx.db
    .query('obligations')
    .withIndex('by_user_source', (q) => q.eq('userId', userId).eq('sourceKey', sourceKey))
    .take(10);
  return rows.some((row) => row.kind !== 'code' && isOpen(row.state));
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
      calendarId: row.calendarId ?? null,
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
    action: v.union(
      v.literal('done'),
      v.literal('later'),
      v.literal('not_mine'),
      v.literal('undo'),
      // Calendar `rsvp`: the route sent the answer; the row closes for good.
      v.literal('rsvp'),
    ),
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
        // The sweep looks at the row again (a change ages out, an event starts).
        sweepAt: sweepAtFor({ ...entry, state: entry.undo!.state }),
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
    if (args.action === 'rsvp') {
      if (row.kind !== 'rsvp') return { ok: false, error: 'invalid' };
      // The organizer has the answer already, so there is no Undo.
      await ctx.db.patch(row._id, {
        state: 'done',
        closeReason: 'event_passed',
        closedAt: at,
        closedBy: 'user',
        closedMessageId,
        pushHeldUntil: undefined,
        pushHoldReason: undefined,
        sweepAt: undefined,
        undo: undefined,
        updatedAt: at,
      });
      return result();
    }
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
    // A connected source or a calendar item has no mail correction: the row
    // closes, and stays closed until the source item changes.
    let correctionId: string | undefined;
    let previousCorrection: JevCorrection | null = null;
    if (row.kind !== 'code' && row.source === 'mail') {
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
    // The account id leads the key, so a mailbox disconnect removes the row
    // with the mail it quotes (ACCOUNT_KEYED_ROWS in convex/accounts.ts).
    dedupeKey: `obligation:${row.accountId ?? 'none'}:${String(row._id)}:${count}`,
    entityId: String(row._id),
    at,
  });
  await ctx.db.patch(row._id, {
    pushedAt: at,
    pushCount: count,
    notificationId,
    pushHeldUntil: undefined,
    pushHoldReason: undefined,
    ...(row.pushHoldReason === 'follow_up' ? { followUpAt: at } : {}),
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
    const [preference, pushes, summaryAt] = await Promise.all([
      preferenceRow(ctx, args.userId),
      recentPushes(ctx, args.userId, at),
      lastSummaryAt(ctx, args.userId),
    ]);
    const settings = obligationPushSettingsFromRow(preference);
    // The switches are read at release too: a follow-up was never checked
    // against them, and the user can turn pushes off while a push waits.
    const allowed = settings.nativePushEnabled && settings.obligationPushEnabled;
    const due: Obligation[] = [];
    for (const row of held) {
      if (row.state === 'open' && allowed) due.push(row);
      else
        await ctx.db.patch(row._id, {
          pushHeldUntil: undefined,
          pushHoldReason: undefined,
          // A follow-up that the switch stopped is spent: it does not come back.
          ...(row.pushHoldReason === 'follow_up' && row.state === 'open' ? { followUpAt: at } : {}),
        });
    }
    const plan = releasePlan({
      due: due.map((row) => ({ id: String(row._id), reason: row.pushHoldReason ?? 'quiet_hours' })),
      settings,
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
        await ctx.db.patch(row._id, {
          pushHeldUntil: plan.until,
          pushHoldReason: row.pushHoldReason === 'follow_up' ? 'follow_up' : 'limit',
        });
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
      await ctx.db.patch(row._id, {
        pushHeldUntil: undefined,
        pushHoldReason: undefined,
        summarizedAt: at,
        ...(row.pushHoldReason === 'follow_up' ? { followUpAt: at } : {}),
      });
    return { kind: 'summary' as const, notificationId: String(notificationId), count: plan.ids.length };
  },
});

// ---------------------------------------------------------------------------
// Connected sources (phase 2). jev_content labels each content item
// (convex/content.ts completeItem); the label opens, changes, and closes the
// `action` of the item.
// ---------------------------------------------------------------------------

type ContentRow = Doc<'contentItems'>;

async function userPreference(ctx: QueryCtx | MutationCtx, userId: string) {
  return obligationPushSettingsFromRow(await preferenceRow(ctx, userId));
}

/**
 * Syncs the obligation of one labelled content item. A mail item only lends
 * its Albatross to the rows of its thread. It returns the ids that need a
 * push.
 */
export async function syncContentObligation(
  ctx: MutationCtx,
  input: { userId: string; item: ContentRow; push: boolean; fill?: boolean; at?: number },
): Promise<string[]> {
  const at = input.at ?? now();
  const { item, userId } = input;
  const labels = item.labels as (ContentLabelFacts & { workId: string | null }) | undefined;
  if (item.source === 'mail') {
    await linkThreadWork(ctx, userId, item.key, labels?.workId, at);
    return [];
  }
  const source = contentObligationSource(item.source);
  if (!source) return [];
  const connector = ['google_drive', 'onedrive'].includes(item.source)
    ? null
    : await ctx.db
        .query('mcpItems')
        .withIndex('by_connection_external', (q) =>
          q.eq('connectionId', item.connectionId).eq('externalId', item.externalId),
        )
        .unique();
  const work = await workLink(ctx, userId, labels?.workId, at);
  const settings = await userPreference(ctx, userId);
  const owned = !connector || connector.userId === userId;
  const wanted =
    labels && owned
      ? contentObligation(
          contentItemFacts(item, connector ?? undefined),
          labels,
          {
            vipSenders: settings.vipSenders,
            timezone: settings.timezone,
            recentWorkIds: work?.recent ? [work.workId] : [],
            fill: input.fill,
          },
          at,
        )
      : null;
  return applyWanted(ctx, {
    userId,
    source,
    sourceKey: item.key,
    kinds: ['action'],
    wanted: wanted ? [wanted] : [],
    sourceMessageId: item.version,
    work,
    push: input.push,
    at,
    userCloseHolds: (row) => row.closedMessageId === item.version,
    closeGone: () => ({ state: 'resolved', reason: 'evidence' }),
  });
}

/** Puts the Albatross of a mail thread's content label on the open rows of the thread. */
async function linkThreadWork(
  ctx: MutationCtx,
  userId: string,
  sourceKey: string,
  workId: string | null | undefined,
  at: number,
) {
  const work = await workLink(ctx, userId, workId, at);
  if (!work) return;
  const rows = await ctx.db
    .query('obligations')
    .withIndex('by_user_source', (q) => q.eq('userId', userId).eq('sourceKey', sourceKey))
    .take(10);
  for (const row of rows) {
    if (row.kind === 'code' || !isOpen(row.state) || row.workId) continue;
    await ctx.db.patch(row._id, { ...workPatch(row, work), updatedAt: at });
  }
}

/** Content items that one fill pass reads, newest first. */
export const CONTENT_FILL_ITEMS = 200;

/** Opens the rows of the labelled content items of the last 30 days, in-app only. */
export async function fillContentObligations(ctx: MutationCtx, userId: string, at = now()) {
  const items = await ctx.db
    .query('contentItems')
    .withIndex('by_user_updated', (q) => q.eq('userId', userId))
    .order('desc')
    .take(CONTENT_FILL_ITEMS);
  let synced = 0;
  for (const item of items) {
    if (item.deleted || !item.labels?.actionable || !contentObligationSource(item.source)) continue;
    await syncContentObligation(ctx, { userId, item, push: false, fill: true, at });
    synced += 1;
  }
  return synced;
}

// ---------------------------------------------------------------------------
// Calendar (phase 4). The calendar sync writes each changed event through
// convex/calendarData.ts; these functions keep the `rsvp` and `prepare` rows
// of the event in step.
// ---------------------------------------------------------------------------

type EventRow = Doc<'calendarEvents'>;

function eventFacts(row: EventRow): CalendarEventFacts {
  return {
    accountId: row.accountId,
    providerCalendarId: row.providerCalendarId,
    providerEventId: row.providerEventId,
    ...(row.masterEventId ? { masterEventId: row.masterEventId } : {}),
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    ...(row.location ? { location: row.location } : {}),
    ...(row.status ? { status: row.status } : {}),
    startAt: row.startAt,
    endAt: row.endAt,
    ...(row.allDay ? { allDay: true } : {}),
    organizer: row.organizer ?? null,
    participants: Array.isArray(row.participants) ? row.participants : null,
    ...(row.htmlLink ? { htmlLink: row.htmlLink } : {}),
  };
}

/** The mailbox addresses of a user, lower case. */
export async function selfAddressesFor(ctx: QueryCtx | MutationCtx, userId: string) {
  const accounts = await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect();
  return accounts.map((account) => String(account.email || '').toLowerCase()).filter(Boolean);
}

/** How a calendar row closes when its event no longer wants it. */
function calendarClose(event: CalendarEventFacts | null, self: string[], at: number): Close {
  if (event && event.startAt <= at) return { state: 'expired', reason: 'event_passed' };
  const own = event ? ownParticipant(event, self) : undefined;
  if (event && !/^cancel/i.test(event.status || '') && own?.status && own.status !== 'noreply')
    return { state: 'done', reason: 'event_passed' };
  return { state: 'resolved', reason: 'evidence' };
}

/**
 * Syncs the `rsvp` and `prepare` rows of changed events, in the caller's
 * transaction. An `rsvp` row names the series of a repeated event and shows
 * its next start. A `prepare` row keeps its Jev answer; a change of the event
 * that leaves the 24-hour window, a cancel, or a decline closes it.
 */
export async function syncCalendarObligations(
  ctx: MutationCtx,
  userId: string,
  events: EventRow[],
  context?: { self?: string[]; at?: number },
) {
  const at = context?.at ?? now();
  const self = context?.self ?? (await selfAddressesFor(ctx, userId));
  let synced = 0;
  for (const row of events) {
    if (row.userId !== userId) continue;
    const event = eventFacts(row);
    const wanted = rsvpObligation(event, self, at);
    const sourceKey = calendarSourceKey(row.accountId, calendarEventId(event));
    const [existing] = await ctx.db
      .query('obligations')
      .withIndex('by_user_source', (q) =>
        q.eq('userId', userId).eq('sourceKey', sourceKey).eq('kind', 'rsvp'),
      )
      .take(1);
    // A later instance of a series does not move the item past the next one.
    const series = Boolean(event.masterEventId);
    const laterInstance =
      series &&
      existing &&
      isOpen(existing.state) &&
      existing.eventStart !== undefined &&
      existing.eventStart > at &&
      existing.eventStart < event.startAt;
    if (wanted && !laterInstance) {
      await applyWanted(ctx, {
        userId,
        source: 'calendar',
        sourceKey,
        accountId: row.accountId,
        kinds: ['rsvp'],
        wanted: [wanted],
        sourceMessageId: String(row.updatedAt),
        push: false,
        at,
        // An answer sent from Needs you holds; another close holds until the event changes.
        userCloseHolds: (closed) =>
          closed.closeReason === 'event_passed' || closed.closedMessageId === String(row.updatedAt),
        closeGone: () => ({ state: 'resolved', reason: 'evidence' }),
      });
      synced += 1;
    } else if (!wanted && existing && isOpen(existing.state)) {
      // An instance of a series closes the item only for its own start.
      if (!series || existing.eventStart === event.startAt) {
        const close = calendarClose(event, self, at);
        await ctx.db.patch(existing._id, {
          ...sourceClose(close.state, close.reason, at),
          updatedAt: at,
        });
        synced += 1;
      }
    }
    synced += await syncPrepareRow(ctx, userId, event, self, at);
  }
  return synced;
}

/** Keeps an open `prepare` row in step with its event, or closes it. */
async function syncPrepareRow(
  ctx: MutationCtx,
  userId: string,
  event: CalendarEventFacts,
  self: string[],
  at: number,
) {
  const [row] = await ctx.db
    .query('obligations')
    .withIndex('by_user_source', (q) =>
      q
        .eq('userId', userId)
        .eq('sourceKey', calendarSourceKey(event.accountId, event.providerEventId))
        .eq('kind', 'prepare'),
    )
    .take(1);
  if (!row || !isOpen(row.state)) return 0;
  const wanted = prepareObligation(event, row.probability, self, { fill: true }, at);
  if (wanted) {
    // The push level stays as Jev's answer set it: an edit does not push.
    const { pushLevel: _pushLevel, ...content } = contentPatch(wanted, row.sourceMessageId, at);
    await ctx.db.patch(row._id, { ...content, updatedAt: at });
  } else if (event.startAt <= at) {
    await ctx.db.patch(row._id, { ...sourceClose('expired', 'event_passed', at), updatedAt: at });
  } else {
    // Cancelled, declined, moved out of the next 24 hours, or no other people.
    await ctx.db.patch(row._id, { ...sourceClose('resolved', 'evidence', at), updatedAt: at });
  }
  return 1;
}

/** Closes the calendar rows of a deleted event (the event, and the series of an instance). */
export async function closeCalendarEventObligations(
  ctx: MutationCtx,
  row: Pick<EventRow, 'userId' | 'accountId' | 'providerEventId' | 'masterEventId' | 'startAt'>,
  at = now(),
) {
  let closed = 0;
  const rows = await ctx.db
    .query('obligations')
    .withIndex('by_user_source', (q) =>
      q.eq('userId', row.userId).eq('sourceKey', calendarSourceKey(row.accountId, row.providerEventId)),
    )
    .take(5);
  for (const entry of rows) {
    if ((entry.kind !== 'rsvp' && entry.kind !== 'prepare') || !isOpen(entry.state)) continue;
    await ctx.db.patch(entry._id, { ...sourceClose('resolved', 'evidence', at), updatedAt: at });
    closed += 1;
  }
  if (row.masterEventId) {
    // A deleted instance closes the series item only when it was the shown one.
    const [series] = await ctx.db
      .query('obligations')
      .withIndex('by_user_source', (q) =>
        q
          .eq('userId', row.userId)
          .eq('sourceKey', calendarSourceKey(row.accountId, row.masterEventId!))
          .eq('kind', 'rsvp'),
      )
      .take(1);
    if (series && isOpen(series.state) && series.eventStart === row.startAt) {
      await ctx.db.patch(series._id, { ...sourceClose('resolved', 'evidence', at), updatedAt: at });
      closed += 1;
    }
  }
  return closed;
}

/** Calendar events that one fill pass reads: the next 14 days. */
export const CALENDAR_FILL_EVENTS = 200;

/** Opens the `rsvp` rows of the invitations in the next 14 days, in-app only. */
export async function fillCalendarObligations(ctx: MutationCtx, userId: string, at = now()) {
  const events = await ctx.db
    .query('calendarEvents')
    .withIndex('by_user_start', (q) =>
      q
        .eq('userId', userId)
        .gt('startAt', at)
        .lte('startAt', at + RSVP_WINDOW_MS),
    )
    .take(CALENDAR_FILL_EVENTS);
  return syncCalendarObligations(ctx, userId, events, { at });
}

// ---------------------------------------------------------------------------
// The `prepare` question (phase 4). The Node Jev sweep claims the events of
// the next 24 hours with other people, asks Jev, and stores the answers here.
// One userDocs row (kind `needsYouPrepare`) for each event keeps the answer
// for its revision, so an unchanged event is asked once.
// ---------------------------------------------------------------------------

const PREPARE_KIND = 'needsYouPrepare';
const PREPARE_CLAIM_EVENTS = 40;
const PREPARE_CLAIM_LIMIT = 6;
const PREPARE_CHECKS_READ = 200;
const PREPARE_MAX_ATTEMPTS = 3;

/** The event facts that the `prepare` question reads (lib/jev/calendar.ts). */
export interface PrepareClaim {
  accountId: string;
  providerCalendarId: string;
  providerEventId: string;
  revision: string;
  title: string;
  description?: string;
  location?: string;
  startAt: number;
  endAt: number;
  organizer?: string;
  attendees: string[];
  selfAddresses: string[];
}

function prepareKey(accountId: string, providerEventId: string) {
  return `${accountId}:${providerEventId}`;
}

function personLabel(person: any) {
  const name = String(person?.name || '').trim();
  const email = String(person?.email || '').trim();
  return name && email ? `${name} <${email}>` : name || email;
}

export const claimPrepareEvents = mutation({
  args: { internalSecret: v.optional(v.string()), userId: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ events: PrepareClaim[] }> => {
    requireInternalSecret(args.internalSecret);
    if (!(await needsYouEnabled(ctx, args.userId))) return { events: [] };
    const at = args.now ?? now();
    const [rows, checks, self] = await Promise.all([
      ctx.db
        .query('calendarEvents')
        .withIndex('by_user_start', (q) =>
          q
            .eq('userId', args.userId)
            .gt('startAt', at)
            .lte('startAt', at + PREPARE_WINDOW_MS),
        )
        .take(PREPARE_CLAIM_EVENTS),
      ctx.db
        .query('userDocs')
        .withIndex('by_user_kind_key', (q) => q.eq('userId', args.userId).eq('kind', PREPARE_KIND))
        .take(PREPARE_CHECKS_READ),
      selfAddressesFor(ctx, args.userId),
    ]);
    const byKey = new Map(checks.map((row) => [row.key, row]));
    // The answers of events that started are no longer needed.
    for (const check of checks)
      if ((check.doc?.eventStart ?? 0) <= at) {
        await ctx.db.delete(check._id);
        byKey.delete(check.key);
      }
    const events: PrepareClaim[] = [];
    for (const row of rows) {
      if (events.length >= PREPARE_CLAIM_LIMIT) break;
      const event = eventFacts(row);
      if (!prepareCandidate(event, self, at)) continue;
      const key = prepareKey(row.accountId, row.providerEventId);
      const revision = prepareRevision(event);
      const check = byKey.get(key);
      const doc = check?.doc ?? {};
      if (doc.revision === revision) {
        // Answered, waiting for a retry, or out of attempts.
        if (typeof doc.probability === 'number') continue;
        if ((doc.attempts ?? 0) >= PREPARE_MAX_ATTEMPTS || (doc.retryAt ?? 0) > at) continue;
      }
      const attempts = doc.revision === revision ? (doc.attempts ?? 0) + 1 : 1;
      const next = { revision, eventStart: row.startAt, attempts, retryAt: at + 15 * 60_000 * attempts };
      if (check) await ctx.db.patch(check._id, { doc: next, updatedAt: at });
      else
        await ctx.db.insert('userDocs', {
          userId: args.userId,
          kind: PREPARE_KIND,
          key,
          doc: next,
          createdAt: at,
          updatedAt: at,
        });
      const organizer = personLabel(row.organizer);
      events.push({
        accountId: row.accountId,
        providerCalendarId: row.providerCalendarId,
        providerEventId: row.providerEventId,
        revision,
        title: truncateText(row.title, 300),
        ...(row.description ? { description: truncateText(row.description, 1_500) } : {}),
        ...(row.location ? { location: truncateText(row.location, 200) } : {}),
        startAt: row.startAt,
        endAt: row.endAt,
        ...(organizer ? { organizer } : {}),
        attendees: (Array.isArray(row.participants) ? row.participants : [])
          .slice(0, 20)
          .map(personLabel)
          .filter(Boolean),
        selfAddresses: self,
      });
    }
    return { events };
  },
});

export const storePrepare = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    results: v.array(
      v.object({
        accountId: v.string(),
        providerCalendarId: v.string(),
        providerEventId: v.string(),
        revision: v.string(),
        probability: v.optional(v.number()),
      }),
    ),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const at = args.now ?? now();
    const self = await selfAddressesFor(ctx, args.userId);
    const obligationIds: string[] = [];
    for (const result of args.results.slice(0, 20)) {
      if (result.probability === undefined || !Number.isFinite(result.probability)) continue;
      const row = await ctx.db
        .query('calendarEvents')
        .withIndex('by_account_calendar_event', (q) =>
          q
            .eq('accountId', result.accountId)
            .eq('providerCalendarId', result.providerCalendarId)
            .eq('providerEventId', result.providerEventId),
        )
        .unique();
      if (!row || row.userId !== args.userId) continue;
      const event = eventFacts(row);
      // The event changed while Jev ran: the next claim asks again.
      if (prepareRevision(event) !== result.revision) continue;
      const probability = Math.max(0, Math.min(1, result.probability));
      const key = prepareKey(row.accountId, row.providerEventId);
      const check = await ctx.db
        .query('userDocs')
        .withIndex('by_user_kind_key', (q) =>
          q.eq('userId', args.userId).eq('kind', PREPARE_KIND).eq('key', key),
        )
        .unique();
      const doc = { revision: result.revision, eventStart: row.startAt, probability };
      if (check) await ctx.db.patch(check._id, { doc, updatedAt: at });
      else
        await ctx.db.insert('userDocs', {
          userId: args.userId,
          kind: PREPARE_KIND,
          key,
          doc,
          createdAt: at,
          updatedAt: at,
        });
      const wanted = prepareObligation(event, probability, self, {}, at);
      obligationIds.push(
        ...(await applyWanted(ctx, {
          userId: args.userId,
          source: 'calendar',
          sourceKey: calendarSourceKey(row.accountId, row.providerEventId),
          accountId: row.accountId,
          kinds: ['prepare'],
          wanted: wanted ? [wanted] : [],
          sourceMessageId: result.revision,
          push: true,
          at,
          userCloseHolds: (closed) => closed.closedMessageId === result.revision,
          closeGone: () => ({ state: 'resolved', reason: 'evidence' }),
        })),
      );
    }
    return { obligationIds };
  },
});

// ---------------------------------------------------------------------------
// The sweep (phase 1.1, 1 gaps, 4): a change leaves Now and ages out, a
// calendar item's event starts, and a closed row goes after 30 days. The Jev
// cron (convex/jev.ts tick) runs it every 5 minutes. Each read is one index
// range with a bound.
// ---------------------------------------------------------------------------

export const SWEEP_BATCH = 100;

export const sweep = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const at = args.now ?? now();
    const counts = { closed: 0, demoted: 0, deferred: 0, removed: 0 };
    const due = await ctx.db
      .query('obligations')
      .withIndex('by_sweep', (q) => q.gt('sweepAt', 0).lte('sweepAt', at))
      .take(SWEEP_BATCH);
    for (const row of due) {
      const step = sweepStep(row, at);
      if (step.action === 'close') {
        await ctx.db.patch(row._id, { ...sourceClose(step.state, step.closeReason, at), updatedAt: at });
        counts.closed += 1;
      } else if (step.action === 'demote') {
        await ctx.db.patch(row._id, { pushLevel: 'normal', sweepAt: step.sweepAt, updatedAt: at });
        counts.demoted += 1;
      } else if (step.action === 'defer' && step.sweepAt > at) {
        await ctx.db.patch(row._id, { sweepAt: step.sweepAt });
        counts.deferred += 1;
      } else await ctx.db.patch(row._id, { sweepAt: undefined });
    }
    const old = await ctx.db
      .query('obligations')
      .withIndex('by_closed', (q) => q.gt('closedAt', 0).lt('closedAt', at - CLOSED_RETENTION_MS))
      .take(SWEEP_BATCH);
    for (const row of old) {
      if (isOpen(row.state)) continue;
      await ctx.db.delete(row._id);
      counts.removed += 1;
    }
    const more = due.length === SWEEP_BATCH || old.length === SWEEP_BATCH;
    if (more) await ctx.scheduler.runAfter(0, internal.obligations.sweep, {});
    return { ...counts, more };
  },
});

// ---------------------------------------------------------------------------
// The phase 1.1 repair. It applies the new rules to the open mail rows of one
// user, then fills the connected sources and the calendar, in-app only. It
// never pushes. It is idempotent: a second run finds the rows as the first
// run left them. The Jev claim starts it once for each user in the flag
// whose rules version is older (OBLIGATION_RULES_VERSION).
// ---------------------------------------------------------------------------

/** The version of the rules that the rows of a user follow. A higher value starts the repair once. */
export const OBLIGATION_RULES_VERSION = 2;
/** Open mail rows that one repair pass reads. */
export const REPAIR_ROWS = 100;

/** True when the flag row of the user says an older rules version. It records the new one. */
export async function takeRulesUpgrade(ctx: MutationCtx, userId: string) {
  const row = await flagRow(ctx, userId);
  if (row?.doc?.enabled !== true || (row.doc.rulesVersion ?? 1) >= OBLIGATION_RULES_VERSION) return false;
  await ctx.db.patch(row._id, { doc: { ...row.doc, rulesVersion: OBLIGATION_RULES_VERSION } });
  return true;
}

/** Records the rules version for a user whose ledger the backfill fills with the new rules. */
export async function markRulesVersion(ctx: MutationCtx, userId: string) {
  const row = await flagRow(ctx, userId);
  if (row && (row.doc?.rulesVersion ?? 1) < OBLIGATION_RULES_VERSION)
    await ctx.db.patch(row._id, { doc: { ...row.doc, rulesVersion: OBLIGATION_RULES_VERSION } });
}

/** The open mail rows of a user, one thread each, newest first. */
export async function openMailThreads(ctx: MutationCtx, userId: string) {
  const [open, snoozed] = await Promise.all([
    ctx.db
      .query('obligations')
      .withIndex('by_user_state', (q) => q.eq('userId', userId).eq('state', 'open'))
      .order('desc')
      .take(REPAIR_ROWS),
    ctx.db
      .query('obligations')
      .withIndex('by_user_state', (q) => q.eq('userId', userId).eq('state', 'snoozed'))
      .order('desc')
      .take(REPAIR_ROWS),
  ]);
  const threads = new Map<string, { accountId: string; threadId: string }>();
  for (const row of [...open, ...snoozed])
    if (row.source === 'mail' && row.kind !== 'code' && row.accountId && row.threadId)
      threads.set(row.sourceKey, { accountId: row.accountId, threadId: row.threadId });
  return [...threads.values()];
}
