import { v } from 'convex/values';
import {
  type AttentionView,
  assessmentIsCurrent,
  attentionMatches,
  isAttentionView,
} from '../lib/jev/contract';
import { smartCategoryFromJev } from '../lib/jev/mail';
import { labelsHaveRole } from '../lib/mail/search/folders';
import { pageEndsInTie, pageThroughTies } from '../lib/mail/search/page-ties';
import {
  applyUserRuleOverrides,
  classifyThreadWithContext,
  clipClassifierBody,
  includeInSmartCategory,
  SMART_CLASSIFIER_VERSION,
  type SmartClassificationContext,
  smartIndexKey,
  smartRuleMatches,
} from '../lib/mail/smart-categories';
import type { SmartRule } from '../lib/shared/types';
import { internal } from './_generated/api';
import { internalMutation, mutation } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Write-time smart classification. Categories are computed once when a thread
// row is written (backfill page, webhook delta, read-path hydration) and
// stored on the row, so listing a category is an indexed range read instead of
// reclassifying the whole window on every query.

export async function loadSmartContext(ctx: any, userId: string): Promise<SmartClassificationContext> {
  const [labels, rules] = await Promise.all([
    ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_updatedAt', (q: any) => q.eq('userId', userId).eq('kind', 'smartLabel'))
      .collect(),
    ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_updatedAt', (q: any) => q.eq('userId', userId).eq('kind', 'smartRule'))
      .collect(),
  ]);
  return {
    customLabels: labels.map((row: any) => row.doc).filter((label: any) => label?.enabled !== false),
    rules: rules.map((row: any) => row.doc).filter((rule: any) => rule?.enabled !== false),
  };
}

// Latest-message content for the classifier: the clipped body and the list
// headers. Callers that have only a body text can pass it as a string.
export interface ClassifierContent {
  bodyText?: string;
  listId?: string;
  listUnsubscribe?: string;
}

function headerValue(headers: unknown, name: string) {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.trim())
      return value.trim().slice(0, 500);
  }
  return undefined;
}

export function classifierContent(message: any): ClassifierContent {
  return {
    bodyText: clipClassifierBody(String(message?.textBody || message?.searchText || '')) || undefined,
    listId: headerValue(message?.headers, 'list-id'),
    listUnsubscribe: headerValue(message?.headers, 'list-unsubscribe'),
  };
}

// The classifier reads thread-summary fields only; corpus rows carry all of
// them under slightly different names (fromAddress / providerThreadId).
// The content is the latest message when the caller has it — classification
// is grounded in actual content, not just headers and snippets.
function classifierInput(row: any, content?: string | ClassifierContent) {
  const latest = typeof content === 'string' ? { bodyText: content } : content || {};
  return {
    _id: row.providerThreadId,
    subject: row.subject,
    fromAddress: row.fromAddress,
    snippet: row.snippet,
    labels: row.labels || [],
    unread: Boolean(row.unread),
    starred: Boolean(row.starred),
    bodyText: latest.bodyText || undefined,
    listId: latest.listId,
    listUnsubscribe: latest.listUnsubscribe,
  };
}

export function classifyCorpusThread(
  row: any,
  context: SmartClassificationContext,
  content?: string | ClassifierContent,
) {
  const input = classifierInput(row, content) as any;
  const det = classifyThreadWithContext(input, context);
  const ruleDriven = det.model === 'user_rule';
  // Precedence: user rules > persisted LLM verdict > deterministic. Custom
  // labels and rule hits are always the deterministic computation (they're
  // exact matching, not judgment), and attention follows live unread state
  // rather than whatever was true when the model looked.
  const llmAttemptIsCurrent =
    Boolean(row.latestMessageId) && row.llmClassifiedMessageId === row.latestMessageId;
  const llmVerdictIsCurrent = Boolean(row.llmCategory) && llmAttemptIsCurrent;
  const llm =
    !ruleDriven && llmVerdictIsCurrent
      ? {
          ...row.llmCategory,
          customLabels: det.customLabels || [],
          ruleHits: det.ruleHits || [],
          needsAttention: Boolean(row.llmCategory.needsAttention) && Boolean(row.unread),
        }
      : null;
  const jevCurrent = assessmentIsCurrent(row.jev, row.latestMessageId);
  // User placement rules apply last, on top of whichever verdict won, so a
  // label move or a Never Main rule holds after every later model pass.
  const verdict = applyUserRuleOverrides(
    jevCurrent ? smartCategoryFromJev(row.jev, det, Boolean(row.unread)) : llm || det,
    input,
    context,
    det.primary,
  );
  return {
    smartCategory: verdict,
    smartPrimary: smartIndexKey(verdict),
    smartCustomKeys: verdict.customLabels || [],
    smartClassifierVersion: SMART_CLASSIFIER_VERSION,
    classifiedAt: now(),
    // Every latest message gets the lightweight model pass. Exact user rules
    // still override its result, but do not prevent the pass from happening.
    llmPending: !jevCurrent && (row.jevAttempts || 0) < 3 ? true : undefined,
  };
}

// ---- Custom label membership (CLS-13) -------------------------------------
// mailLabelMembership mirrors smartCustomKeys: one row for each label hit,
// with the thread's lastDate, unread, and attention state. Call this after
// every write that sets smartCustomKeys, with the row before and after the
// write. Only this function writes membership, so a thread whose old and new
// rows both have no label hits has no membership rows to change.
interface MembershipThread {
  userId: string;
  accountId: string;
  providerThreadId: string;
  lastDate?: number;
  unread?: boolean;
  smartCustomKeys?: string[];
  smartCategory?: { needsAttention?: boolean } | null;
}

export async function syncLabelMembership(
  ctx: any,
  previous: { smartCustomKeys?: string[] } | null | undefined,
  next: MembershipThread,
) {
  const keys = [...new Set(next.smartCustomKeys || [])];
  if (!keys.length && !previous?.smartCustomKeys?.length) return;
  const state = {
    lastDate: Number(next.lastDate || 0),
    unread: Boolean(next.unread),
    needsAttention: Boolean(next.smartCategory?.needsAttention) || undefined,
  };
  const rows = await ctx.db
    .query('mailLabelMembership')
    .withIndex('by_user_account_thread', (q: any) =>
      q
        .eq('userId', next.userId)
        .eq('accountId', next.accountId)
        .eq('providerThreadId', next.providerThreadId),
    )
    .collect();
  const kept = new Set<string>();
  for (const row of rows) {
    if (!keys.includes(row.labelKey) || kept.has(row.labelKey)) {
      await ctx.db.delete(row._id);
      continue;
    }
    kept.add(row.labelKey);
    if (
      row.lastDate !== state.lastDate ||
      row.unread !== state.unread ||
      Boolean(row.needsAttention) !== Boolean(state.needsAttention)
    )
      await ctx.db.patch(row._id, state);
  }
  for (const labelKey of keys) {
    if (kept.has(labelKey)) continue;
    await ctx.db.insert('mailLabelMembership', {
      userId: next.userId,
      accountId: next.accountId,
      providerThreadId: next.providerThreadId,
      labelKey,
      ...state,
    });
  }
}

/** Removes every membership row of a deleted thread. */
export async function deleteLabelMembership(
  ctx: any,
  userId: string,
  accountId: string,
  providerThreadId: string,
) {
  const rows = await ctx.db
    .query('mailLabelMembership')
    .withIndex('by_user_account_thread', (q: any) =>
      q.eq('userId', userId).eq('accountId', accountId).eq('providerThreadId', providerThreadId),
    )
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

// Rows the backlog sweep has not rewritten with this classifier version yet.
// They can have label hits and no membership rows, so the label reads also
// look at them in a bounded recent window until the sweep is done.
function classifiedBeforeMembership(row: any) {
  return Number(row.smartClassifierVersion ?? -1) < SMART_CLASSIFIER_VERSION;
}

const membershipDate = (row: any) => Number(row.lastDate || 0);

// One page of label members, newest first. Each account is its own indexed
// range; a page never ends inside a group of same-time rows (PAGE-1).
async function pageLabelMembers(
  ctx: any,
  args: {
    userId: string;
    accounts: Array<string | undefined>;
    labelKey: string;
    limit: number;
    before?: number;
  },
) {
  const read = async (range: (q: any) => any, take: number) => {
    const chunks = await Promise.all(
      args.accounts.map((accountId) =>
        (accountId
          ? ctx.db
              .query('mailLabelMembership')
              .withIndex('by_user_account_label_lastDate', (q: any) =>
                range(q.eq('userId', args.userId).eq('accountId', accountId).eq('labelKey', args.labelKey)),
              )
          : ctx.db
              .query('mailLabelMembership')
              .withIndex('by_user_label_lastDate', (q: any) =>
                range(q.eq('userId', args.userId).eq('labelKey', args.labelKey)),
              )
        )
          .order('desc')
          .take(take),
      ),
    );
    return chunks.flat().sort((a: any, b: any) => membershipDate(b) - membershipDate(a));
  };
  let rows = await read(
    (q) => (args.before === undefined ? q : q.lt('lastDate', args.before)),
    args.limit + 1,
  );
  if (pageEndsInTie(rows, args.limit, membershipDate)) {
    const boundary = membershipDate(rows[args.limit - 1]);
    const group = await read((q) => q.eq('lastDate', boundary), 200);
    // One older row tells pageThroughTies whether another page exists.
    const older = await read((q) => q.lt('lastDate', boundary), 1);
    rows = [...rows.filter((row: any) => membershipDate(row) > boundary), ...group, ...older];
  }
  return pageThroughTies(rows, args.limit, membershipDate);
}

export function classificationFreshnessPatch(
  existingLatestMessageId: string | undefined,
  latestMessageId: string,
) {
  if (existingLatestMessageId === latestMessageId) return {};
  return {
    llmCategory: undefined,
    llmClassifiedAt: undefined,
    llmClassifiedMessageId: undefined,
    jev: undefined,
    jevVersion: 0,
    jevStatus: 'pending',
    jevAttempts: 0,
    jevRetryAt: undefined,
    jevError: undefined,
    jevLeaseId: undefined,
    jevLeaseUntil: undefined,
    jevNeedsReply: false,
    jevNeedsAction: false,
    jevWaiting: false,
    jevChange: false,
    areaClassifierVersion: undefined,
    areaClassifiedAt: undefined,
    areaClassifiedMessageId: undefined,
    areaRoutingPending: true,
  };
}

// Latest message content for a corpus thread — the content signal for the
// background sweeps, which don't have the message batch in hand the way the
// write path does.
export async function latestThreadContent(ctx: any, row: any): Promise<ClassifierContent | undefined> {
  const latest = await ctx.db
    .query('mailCorpusMessages')
    .withIndex('by_user_account_thread_received', (q: any) =>
      q.eq('userId', row.userId).eq('accountId', row.accountId).eq('providerThreadId', row.providerThreadId),
    )
    .order('desc')
    .take(1);
  const message = latest[0];
  if (!message) return undefined;
  return classifierContent(message);
}

export function normalizeCorpusThread(row: any) {
  return {
    _id: row.providerThreadId,
    account: row.accountId,
    subject: row.subject || '(no subject)',
    fromAddress: row.fromAddress || '',
    lastDate: row.lastDate || 0,
    date: row.lastDate || 0,
    snippet: row.snippet || '',
    labels: row.labels || [],
    unread: Boolean(row.unread),
    starred: Boolean(row.starred),
    messageCount: row.messageCount || 0,
    smartCategory: row.smartCategory || undefined,
    jev: assessmentIsCurrent(row.jev, row.latestMessageId) ? row.jev : undefined,
    jevStatus: row.jevStatus,
    jevLastBriefRevision: row.jevLastBriefRevision,
    jevLastBriefChangeId: row.jevLastBriefChangeId,
    cachedAt: row.updatedAt || row.lastDate || 0,
  };
}

// One test for the attention views and their badge: a current Jev verdict with
// the obligation, not in spam or trash, and not muted by a user rule.
function attentionRowVisible(row: any, view: AttentionView) {
  return (
    assessmentIsCurrent(row.jev, row.latestMessageId) &&
    attentionMatches(row.jev, view) &&
    // Provider-neutral roles: iCloud ids end in `:Junk` (SEARCH-1).
    !labelsHaveRole(row.labels || [], 'SPAM') &&
    !labelsHaveRole(row.labels || [], 'TRASH') &&
    !(row.smartCategory?.model === 'user_rule' && row.smartCategory?.primary === 'noise')
  );
}

interface CategoryQueryArgs {
  userId: string;
  accountIds?: string[] | null;
  category: string;
  limit: number;
  before?: number;
  cursor?: string;
}

// Indexed category listing. Membership is primary === X, plus secondary === X
// for threads promoted into Main (the classifier only ever attaches secondary
// categories to Main verdicts). A custom-label view reads the membership
// table instead (CLS-13). Rows written before classification existed have no
// smartPrimary; a bounded recency window classifies those in memory until the
// backlog cron has swept them.
export async function queryCategoryThreads(ctx: any, args: CategoryQueryArgs) {
  const { userId, category } = args;
  const limit = Math.min(Math.max(Math.floor(args.limit) || 50, 1), 200);
  const before = Number.isFinite(args.before) ? Number(args.before) : undefined;
  if (isAttentionView(category)) {
    const indexes = {
      needs_reply: ['by_user_jev_reply', 'jevNeedsReply'],
      needs_action: ['by_user_jev_action', 'jevNeedsAction'],
      waiting_for: ['by_user_jev_waiting', 'jevWaiting'],
      important_changes: ['by_user_jev_change', 'jevChange'],
    } as const;
    const [index, field] = indexes[category];
    let source = ctx.db
      .query('mailCorpusThreads')
      .withIndex(index, (q: any) => q.eq('userId', userId).eq(field, true))
      .order('desc');
    if (args.accountIds?.length)
      source = source.filter((q: any) =>
        q.or(...args.accountIds!.map((id) => q.eq(q.field('accountId'), id))),
      );
    const page = await source.paginate({ cursor: args.cursor ?? null, numItems: limit });
    return {
      items: page.page.filter((row: any) => attentionRowVisible(row, category)).map(normalizeCorpusThread),
      nextBefore: undefined,
      nextCursor: page.isDone ? undefined : page.continueCursor,
    };
  }
  const accounts = args.accountIds?.length ? args.accountIds : [undefined];
  const isCustom = category.startsWith('custom:');
  const context = await loadSmartContext(ctx, userId);

  const fetchPrimary = async (primary: string, take: number) => {
    const chunks = await Promise.all(
      accounts.map((accountId) => {
        const base = accountId
          ? ctx.db.query('mailCorpusThreads').withIndex('by_user_account_primary_lastDate', (q: any) => {
              const eq = q.eq('userId', userId).eq('accountId', accountId).eq('smartPrimary', primary);
              return before === undefined ? eq : eq.lt('lastDate', before);
            })
          : ctx.db.query('mailCorpusThreads').withIndex('by_user_primary_lastDate', (q: any) => {
              const eq = q.eq('userId', userId).eq('smartPrimary', primary);
              return before === undefined ? eq : eq.lt('lastDate', before);
            });
        return base.order('desc').take(take);
      }),
    );
    return chunks.flat();
  };

  const fetchRecent = async (take: number) => {
    const chunks = await Promise.all(
      accounts.map((accountId) => {
        const base = accountId
          ? ctx.db.query('mailCorpusThreads').withIndex('by_user_account_updated', (q: any) => {
              const eq = q.eq('userId', userId).eq('accountId', accountId);
              return before === undefined ? eq : eq.lt('lastDate', before);
            })
          : ctx.db.query('mailCorpusThreads').withIndex('by_user_lastDate', (q: any) => {
              const eq = q.eq('userId', userId);
              return before === undefined ? eq : eq.lt('lastDate', before);
            });
        return base.order('desc').take(take);
      }),
    );
    return chunks.flat();
  };

  const candidates = new Map<string, any>();
  const add = (rows: any[]) => {
    for (const row of rows) candidates.set(`${row.accountId}:${row.providerThreadId}`, row);
  };

  let labelPage: { nextBefore: number | undefined } | undefined;
  if (isCustom) {
    // Label hits, filed or not, are rows of the membership table (CLS-13), so
    // the view pages through the whole mailbox by lastDate.
    const members = await pageLabelMembers(ctx, {
      userId,
      accounts,
      labelKey: category.slice('custom:'.length),
      limit,
      before,
    });
    labelPage = members;
    const rows = await Promise.all(
      members.page.map((member: any) =>
        ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_account_thread', (q: any) =>
            q
              .eq('userId', userId)
              .eq('accountId', member.accountId)
              .eq('providerThreadId', member.providerThreadId),
          )
          .first(),
      ),
    );
    add(rows.filter(Boolean));
    // Rows the sweep has not rewritten yet: only the part of the recent
    // window that falls inside this page's time range.
    const floor = members.nextBefore;
    add(
      (await fetchRecent(limit * 2)).filter(
        (row) =>
          classifiedBeforeMembership(row) && (floor === undefined || Number(row.lastDate || 0) >= floor),
      ),
    );
  } else {
    add(await fetchPrimary(category, limit * 2));
    if (category !== 'main') add(await fetchPrimary('main', limit * 4));
    // Unclassified backlog window (pre-migration rows).
    add((await fetchRecent(limit * 2)).filter((row) => row.smartPrimary === undefined));
  }

  const items: any[] = [];
  for (const row of candidates.values()) {
    const smart = row.smartCategory ?? classifyThreadWithContext(classifierInput(row) as any, context);
    const thread = { ...normalizeCorpusThread(row), smartCategory: smart };
    if (includeInSmartCategory(thread as any, category)) items.push(thread);
  }
  items.sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
  if (labelPage) return { items, nextBefore: labelPage.nextBefore, nextCursor: undefined };
  // More matches than the page implies older pages exist; cursor on lastDate.
  // PAGE-1: the page holds every same-second match at its boundary, so the
  // next page's `lt` watermark skips none of them.
  const tied = pageThroughTies(items, limit, (row) => Number(row.lastDate || 0));
  const boundary = tied.page.length ? Number(tied.page[tied.page.length - 1].lastDate || 0) : 0;
  // The candidate windows are bounded, so a group that fills the rest of them
  // does not prove there is nothing older: keep a watermark while matches ran over.
  const nextBefore = tied.nextBefore ?? (items.length > limit && boundary > 0 ? boundary : undefined);
  return { items: tied.page, nextBefore, nextCursor: undefined };
}

// Sweeps rows with no verdict or a verdict from older classifier code
// (smartClassifierVersion below SMART_CLASSIFIER_VERSION). Runs from a cron and
// chains itself while a full batch keeps coming back, so a deploy over an
// existing corpus converges in minutes without blocking any read path, and a
// classifier change needs no manual resort.
export const classifyBacklog = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 100/batch (was 200): each row now also reads its latest message body,
    // and message docs carry full bodies — keep the per-mutation read volume
    // well under Convex limits.
    const BATCH = 100;
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_smart_classifier_version', (q: any) => q.eq('smartClassifierVersion', undefined))
      .take(BATCH);
    if (rows.length < BATCH)
      rows.push(
        ...(await ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_smart_classifier_version', (q: any) =>
            q.gte('smartClassifierVersion', 0).lt('smartClassifierVersion', SMART_CLASSIFIER_VERSION),
          )
          .take(BATCH - rows.length)),
      );
    if (!rows.length) return { classified: 0, done: true };
    const contexts = new Map<string, SmartClassificationContext>();
    for (const row of rows) {
      let context = contexts.get(row.userId);
      if (!context) {
        context = await loadSmartContext(ctx, row.userId);
        contexts.set(row.userId, context);
      }
      const patch = classifyCorpusThread(row, context, await latestThreadContent(ctx, row));
      await ctx.db.patch(row._id, patch);
      // A version bump makes this sweep write membership for every row.
      await syncLabelMembership(ctx, row, { ...row, ...patch });
    }
    if (rows.length === BATCH) {
      await ctx.scheduler.runAfter(1_000, internal.smart.classifyBacklog, {});
    }
    return { classified: rows.length, done: rows.length < BATCH };
  },
});

// Targeted, synchronous reclassification of the threads a just-created rule
// matches. The full-corpus sweep that rule edits schedule runs ~5s later in
// background pages; this exists so the rows the user is looking at flip
// before their search refetch lands (quick fixes feel instant instead of
// resurrecting the sender until the sweep catches up).
export const reclassifyMatchingThreads = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    scope: v.string(),
    match: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const context = await loadSmartContext(ctx, args.userId);
    const match = args.match.trim().toLowerCase();
    if (!match) return { patched: 0 };
    const rule = { enabled: true, scope: args.scope as SmartRule['scope'], match };
    // Bounded recency window — covers everything a paged inbox view can show;
    // the scheduled sweep converges the older tail.
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_lastDate', (q: any) => q.eq('userId', args.userId))
      .order('desc')
      .take(1500);
    let patched = 0;
    for (const row of rows) {
      if (!smartRuleMatches(rule, classifierInput(row))) continue;
      const patch = classifyCorpusThread(row, context, await latestThreadContent(ctx, row));
      await ctx.db.patch(row._id, patch);
      await syncLabelMembership(ctx, row, { ...row, ...patch });
      patched += 1;
    }
    return { patched };
  },
});

// Indexed unread-per-category counts, shared by the authenticated live query
// (liveMail.categoryCounts) and the internal-secret tool path. Counts cap at
// CATEGORY_COUNT_CAP; secondary hits derive from the unread Main window (the
// classifier only attaches secondary to Main verdicts). needs_reply reads the
// Jev reply index, as its view does.
export const CATEGORY_COUNT_CAP = 100;

export async function computeCategoryUnreadCounts(ctx: any, userId: string, accountIds?: string[] | null) {
  const accounts = accountIds?.filter(Boolean) || [];
  const CAP = CATEGORY_COUNT_CAP;

  const unreadRows = async (primary: string) => {
    if (accounts.length) {
      const chunks = await Promise.all(
        accounts.map((accountId) =>
          ctx.db
            .query('mailCorpusThreads')
            .withIndex('by_user_account_primary_unread', (q: any) =>
              q
                .eq('userId', userId)
                .eq('accountId', accountId)
                .eq('smartPrimary', primary)
                .eq('unread', true),
            )
            .order('desc')
            .take(CAP),
        ),
      );
      return chunks.flat();
    }
    return await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_primary_unread', (q: any) =>
        q.eq('userId', userId).eq('smartPrimary', primary).eq('unread', true),
      )
      .order('desc')
      .take(CAP);
  };

  const accountSet = accounts.length ? new Set(accounts) : null;
  const counts: Record<string, { unread: number; attention: boolean }> = {};
  const mainRows = await unreadRows('main');
  const SMART_IDS = ['main', 'needs_reply', 'codes', 'orders', 'finance_admin', 'noise', 'review'];
  for (const id of SMART_IDS) {
    if (id === 'needs_reply') {
      // The badge counts what the Needs reply view lists: current Jev reply
      // obligations, through the same index and the same filters, unread only.
      const rows = (
        await ctx.db
          .query('mailCorpusThreads')
          .withIndex('by_user_jev_reply', (q: any) => q.eq('userId', userId).eq('jevNeedsReply', true))
          .order('desc')
          .take(CAP * 3)
      ).filter(
        (row: any) =>
          row.unread &&
          (!accountSet || accountSet.has(row.accountId)) &&
          attentionRowVisible(row, 'needs_reply'),
      );
      counts[id] = { unread: Math.min(rows.length, CAP), attention: rows.length > 0 };
      continue;
    }
    const rows = id === 'main' ? mainRows : await unreadRows(id);
    const secondaryHits =
      id === 'main' ? [] : mainRows.filter((row: any) => row.smartCategory?.secondary?.includes(id));
    counts[id] = {
      unread: Math.min(rows.length + secondaryHits.length, CAP),
      attention: [...rows, ...secondaryHits].some((row: any) => row.smartCategory?.needsAttention),
    };
  }

  // Custom labels (CLS-13): one indexed unread read per enabled label over
  // the membership table, so the badge counts the whole mailbox.
  const counted = new Set<string>();
  const countLabelHit = (key: string, accountId: string, threadId: string, attention: unknown) => {
    const hit = `${key}\n${accountId}\n${threadId}`;
    if (counted.has(hit)) return;
    counted.add(hit);
    const id = `custom:${key}`;
    const entry = counts[id] || { unread: 0, attention: false };
    entry.unread = Math.min(entry.unread + 1, CAP);
    entry.attention = entry.attention || Boolean(attention);
    counts[id] = entry;
  };
  const labels = await ctx.db
    .query('userDocs')
    .withIndex('by_user_kind_updatedAt', (q: any) => q.eq('userId', userId).eq('kind', 'smartLabel'))
    .collect();
  for (const label of labels) {
    const key = label.doc?._id;
    if (!key || label.doc?.enabled === false) continue;
    const members = accounts.length
      ? (
          await Promise.all(
            accounts.map((accountId) =>
              ctx.db
                .query('mailLabelMembership')
                .withIndex('by_user_account_label_unread', (q: any) =>
                  q.eq('userId', userId).eq('accountId', accountId).eq('labelKey', key).eq('unread', true),
                )
                .order('desc')
                .take(CAP),
            ),
          )
        ).flat()
      : await ctx.db
          .query('mailLabelMembership')
          .withIndex('by_user_label_unread', (q: any) =>
            q.eq('userId', userId).eq('labelKey', key).eq('unread', true),
          )
          .order('desc')
          .take(CAP);
    for (const member of members)
      countLabelHit(key, member.accountId, member.providerThreadId, member.needsAttention);
  }
  // Rows the sweep has not rewritten yet have no membership rows; count their
  // hits in a bounded recent window until the sweep is done.
  const recent = await ctx.db
    .query('mailCorpusThreads')
    .withIndex('by_user_lastDate', (q: any) => q.eq('userId', userId))
    .order('desc')
    .take(300);
  for (const row of recent) {
    if (!classifiedBeforeMembership(row) || !row.unread || !row.smartCustomKeys?.length) continue;
    if (accountSet && !accountSet.has(row.accountId)) continue;
    for (const key of row.smartCustomKeys)
      countLabelHit(key, row.accountId, row.providerThreadId, row.smartCategory?.needsAttention);
  }
  return counts;
}

// One resort job record for each user (userDocs kind smartReclassifyJob).
// `generation` goes up on each rule or label edit. `chain` is the generation
// that started the page chain that runs now, so each user has one chain.
const RECLASSIFY_JOB_KIND = 'smartReclassifyJob';
// A chain writes heartbeatAt on each page. A chain with no page in this time
// has stopped, and the next edit starts a new one.
export const RECLASSIFY_STALE_MS = 10 * 60_000;

async function reclassifyJob(ctx: any, userId: string) {
  return ctx.db
    .query('userDocs')
    .withIndex('by_user_kind_key', (q: any) =>
      q.eq('userId', userId).eq('kind', RECLASSIFY_JOB_KIND).eq('key', 'default'),
    )
    .unique();
}

// Rule/label edits change what every existing verdict means. Each edit asks
// for a resort. When a chain runs already, the edit only raises the
// generation, and the chain starts again from the first page with the new
// rules. Otherwise the edit starts one chain after a short delay, which also
// collects quick edits into one run.
export async function requestSmartReclassify(ctx: any, userId: string, delayMs = 5_000) {
  const job = await reclassifyJob(ctx, userId);
  const ts = now();
  const generation = Number(job?.doc?.generation || 0) + 1;
  const running = Boolean(job?.doc?.running) && ts - Number(job?.doc?.heartbeatAt || 0) < RECLASSIFY_STALE_MS;
  const doc = running
    ? { ...job.doc, generation }
    : { generation, chain: generation, running: true, heartbeatAt: ts };
  if (job) await ctx.db.patch(job._id, { doc, updatedAt: ts });
  else
    await ctx.db.insert('userDocs', {
      userId,
      kind: RECLASSIFY_JOB_KIND,
      key: 'default',
      doc,
      createdAt: ts,
      updatedAt: ts,
    });
  if (!running)
    await ctx.scheduler.runAfter(delayMs, internal.smart.reclassifyUserThreads, {
      userId,
      chain: generation,
      generation,
    });
  return { scheduled: !running, generation };
}

// Re-run the classifier over the user's corpus in scheduled pages. A call
// with no chain (a manual run) does not read or write the job record.
export const reclassifyUserThreads = internalMutation({
  args: {
    userId: v.string(),
    cursor: v.optional(v.string()),
    chain: v.optional(v.number()),
    generation: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let cursor = args.cursor;
    let generation = args.generation;
    const job = args.chain === undefined ? null : await reclassifyJob(ctx, args.userId);
    if (job) {
      // A newer chain owns the job: stop this one.
      if (job.doc?.chain !== args.chain) return { reclassified: 0, done: true, superseded: true };
      // The rules changed during the run: start again with the new rules.
      if (job.doc?.generation !== generation) {
        generation = job.doc?.generation;
        cursor = undefined;
      }
    }
    const context = await loadSmartContext(ctx, args.userId);
    // 50/page (was 100): the body lookup per row reads full message docs.
    const page = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user', (q: any) => q.eq('userId', args.userId))
      .paginate({ cursor: cursor ?? null, numItems: 50 });
    for (const row of page.page) {
      const patch = classifyCorpusThread(row, context, await latestThreadContent(ctx, row));
      await ctx.db.patch(row._id, patch);
      await syncLabelMembership(ctx, row, { ...row, ...patch });
    }
    if (job)
      await ctx.db.patch(job._id, {
        doc: { ...job.doc, generation, running: !page.isDone, heartbeatAt: now() },
        updatedAt: now(),
      });
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.smart.reclassifyUserThreads, {
        userId: args.userId,
        cursor: page.continueCursor,
        ...(args.chain === undefined ? {} : { chain: args.chain, generation }),
      });
    }
    return { reclassified: page.page.length, done: page.isDone };
  },
});
