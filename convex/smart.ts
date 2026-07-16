import { v } from 'convex/values';
import {
  classifyThreadWithContext,
  includeInSmartCategory,
  type SmartClassificationContext,
} from '../lib/mail/smart-categories';
import { emailFromHeader } from '../lib/shared/format';
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

// The classifier reads thread-summary fields only; corpus rows carry all of
// them under slightly different names (fromAddress / providerThreadId).
// bodyText is the latest message body when the caller has it — classification
// is grounded in actual content, not just headers and snippets.
function classifierInput(row: any, bodyText?: string) {
  return {
    _id: row.providerThreadId,
    subject: row.subject,
    fromAddress: row.fromAddress,
    snippet: row.snippet,
    labels: row.labels || [],
    unread: Boolean(row.unread),
    starred: Boolean(row.starred),
    bodyText: bodyText || undefined,
  };
}

export function classifyCorpusThread(row: any, context: SmartClassificationContext, bodyText?: string) {
  const det = classifyThreadWithContext(classifierInput(row, bodyText) as any, context);
  const ruleDriven = det.model === 'user_rule';
  // Precedence: user rules > persisted LLM verdict > deterministic. Custom
  // labels and rule hits are always the deterministic computation (they're
  // exact matching, not judgment), and attention follows live unread state
  // rather than whatever was true when the model looked.
  const llmVerdictIsCurrent =
    Boolean(row.llmCategory) &&
    Boolean(row.latestMessageId) &&
    row.llmClassifiedMessageId === row.latestMessageId;
  const llm =
    !ruleDriven && llmVerdictIsCurrent
      ? {
          ...row.llmCategory,
          customLabels: det.customLabels || [],
          ruleHits: det.ruleHits || [],
          needsAttention: Boolean(row.llmCategory.needsAttention) && Boolean(row.unread),
        }
      : null;
  const verdict = llm || det;
  return {
    smartCategory: verdict,
    smartPrimary: verdict.primary,
    smartCustomKeys: verdict.customLabels || [],
    classifiedAt: now(),
    // Every latest message gets the lightweight model pass. Exact user rules
    // still override its result, but do not prevent the pass from happening.
    llmPending: !llmVerdictIsCurrent ? true : undefined,
  };
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
    areaClassifierVersion: undefined,
    areaClassifiedAt: undefined,
    areaRoutingPending: true,
  };
}

// Latest message body for a corpus thread — the content signal for the
// background sweeps, which don't have the message batch in hand the way the
// write path does.
export async function latestThreadBody(ctx: any, row: any): Promise<string | undefined> {
  const latest = await ctx.db
    .query('mailCorpusMessages')
    .withIndex('by_user_account_thread_received', (q: any) =>
      q.eq('userId', row.userId).eq('accountId', row.accountId).eq('providerThreadId', row.providerThreadId),
    )
    .order('desc')
    .take(1);
  const message = latest[0];
  if (!message) return undefined;
  return String(message.textBody || message.searchText || '').slice(0, 4000) || undefined;
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
    cachedAt: row.updatedAt || row.lastDate || 0,
  };
}

interface CategoryQueryArgs {
  userId: string;
  accountIds?: string[] | null;
  category: string;
  limit: number;
  before?: number;
}

// Indexed category listing. Membership is primary === X, plus secondary === X
// for threads promoted into Main (the classifier only ever attaches secondary
// categories to Main verdicts), plus custom-label hits. Rows written before
// classification existed have no smartPrimary; a bounded recency window
// classifies those in memory until the backlog cron has swept them.
export async function queryCategoryThreads(ctx: any, args: CategoryQueryArgs) {
  const { userId, category } = args;
  const limit = Math.min(Math.max(Math.floor(args.limit) || 50, 1), 200);
  const before = Number.isFinite(args.before) ? Number(args.before) : undefined;
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

  if (isCustom) {
    // Custom labels are arrays, which Convex indexes cannot key on; filter a
    // bounded recency window over the stored membership keys instead.
    add(await fetchRecent(limit * 6));
  } else {
    add(await fetchPrimary(category, limit * 2));
    if (category !== 'main') add(await fetchPrimary('main', limit * 4));
  }
  // Unclassified backlog window (pre-migration rows).
  add((await fetchRecent(limit * 2)).filter((row) => row.smartPrimary === undefined));

  const items: any[] = [];
  for (const row of candidates.values()) {
    const smart = row.smartCategory ?? classifyThreadWithContext(classifierInput(row) as any, context);
    const thread = { ...normalizeCorpusThread(row), smartCategory: smart };
    if (includeInSmartCategory(thread as any, category)) items.push(thread);
  }
  items.sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
  const page = items.slice(0, limit);
  // More matches than the page implies older pages exist; cursor on lastDate.
  const nextBefore =
    items.length > page.length && page.length ? Number(page[page.length - 1].lastDate) : undefined;
  return { items: page, nextBefore };
}

// Sweeps rows that predate write-time classification. Runs from a cron and
// chains itself while a full batch keeps coming back, so a deploy over an
// existing corpus converges in minutes without blocking any read path.
export const classifyBacklog = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 100/batch (was 200): each row now also reads its latest message body,
    // and message docs carry full bodies — keep the per-mutation read volume
    // well under Convex limits.
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_smart_primary', (q: any) => q.eq('smartPrimary', undefined))
      .take(100);
    if (!rows.length) return { classified: 0, done: true };
    const contexts = new Map<string, SmartClassificationContext>();
    for (const row of rows) {
      let context = contexts.get(row.userId);
      if (!context) {
        context = await loadSmartContext(ctx, row.userId);
        contexts.set(row.userId, context);
      }
      await ctx.db.patch(row._id, classifyCorpusThread(row, context, await latestThreadBody(ctx, row)));
    }
    if (rows.length === 100) {
      await ctx.scheduler.runAfter(1_000, internal.smart.classifyBacklog, {});
    }
    return { classified: rows.length, done: rows.length < 100 };
  },
});

function rowMatchesRuleScope(row: any, scope: string, match: string) {
  // Mirror matchRule() in lib/mail/smart-categories.ts so the immediate
  // reclassify covers the same rule surface as the eventual full sweep:
  // subject_pattern honors regex, and header rules match the same haystack.
  const email = (emailFromHeader(String(row.fromAddress || '')) || '').toLowerCase();
  const subject = String(row.subject || '').toLowerCase();
  const headerHaystack = [row.fromAddress, row.subject, row.snippet, ...(row.labels || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (scope === 'sender') return email === match;
  if (scope === 'domain') return (email.split('@')[1] || '') === match;
  if (scope === 'subject_pattern') return subject.includes(match) || safeRegexTest(match, subject);
  if (scope === 'header') return headerHaystack.includes(match);
  if (scope === 'thread') return String(row.providerThreadId || '').toLowerCase() === match;
  return false;
}

function safeRegexTest(pattern: string, value: string) {
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return false;
  }
}

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
    // Bounded recency window — covers everything a paged inbox view can show;
    // the scheduled sweep converges the older tail.
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_lastDate', (q: any) => q.eq('userId', args.userId))
      .order('desc')
      .take(1500);
    let patched = 0;
    for (const row of rows) {
      if (!rowMatchesRuleScope(row, args.scope, match)) continue;
      await ctx.db.patch(row._id, classifyCorpusThread(row, context, await latestThreadBody(ctx, row)));
      patched += 1;
    }
    return { patched };
  },
});

// Indexed unread-per-category counts, shared by the authenticated live query
// (liveMail.categoryCounts) and the internal-secret tool path. Counts cap at
// CATEGORY_COUNT_CAP; needs_reply and secondary hits derive from the unread
// Main window (the classifier only attaches secondary to Main verdicts).
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

  const counts: Record<string, { unread: number; attention: boolean }> = {};
  const mainRows = await unreadRows('main');
  const SMART_IDS = ['main', 'needs_reply', 'codes', 'orders', 'finance_admin', 'noise', 'review'];
  for (const id of SMART_IDS) {
    if (id === 'needs_reply') {
      const rows = mainRows.filter((row: any) => row.smartCategory?.secondary?.includes('needs_reply'));
      counts[id] = {
        unread: Math.min(rows.length, CAP),
        attention: rows.some((row: any) => row.smartCategory?.needsAttention),
      };
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

  // Custom labels: arrays can't be index keys, so count over a bounded recent
  // window — the badge is a freshness signal, not an inventory.
  const recent = await ctx.db
    .query('mailCorpusThreads')
    .withIndex('by_user_lastDate', (q: any) => q.eq('userId', userId))
    .order('desc')
    .take(300);
  const accountSet = accounts.length ? new Set(accounts) : null;
  for (const row of recent) {
    if (!row.unread || !row.smartCustomKeys?.length) continue;
    if (accountSet && !accountSet.has(row.accountId)) continue;
    for (const key of row.smartCustomKeys) {
      const id = `custom:${key}`;
      const entry = counts[id] || { unread: 0, attention: false };
      entry.unread = Math.min(entry.unread + 1, CAP);
      entry.attention = entry.attention || Boolean(row.smartCategory?.needsAttention);
      counts[id] = entry;
    }
  }
  return counts;
}

// Rule/label edits change what every existing verdict means; re-run the
// classifier over the user's corpus in scheduled pages.
export const reclassifyUserThreads = internalMutation({
  args: { userId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const context = await loadSmartContext(ctx, args.userId);
    // 50/page (was 100): the body lookup per row reads full message docs.
    const page = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user', (q: any) => q.eq('userId', args.userId))
      .paginate({ cursor: args.cursor ?? null, numItems: 50 });
    for (const row of page.page) {
      await ctx.db.patch(row._id, classifyCorpusThread(row, context, await latestThreadBody(ctx, row)));
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.smart.reclassifyUserThreads, {
        userId: args.userId,
        cursor: page.continueCursor,
      });
    }
    return { reclassified: page.page.length, done: page.isDone };
  },
});
