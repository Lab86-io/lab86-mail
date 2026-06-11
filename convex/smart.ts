import { v } from 'convex/values';
import {
  classifyThreadWithContext,
  includeInSmartCategory,
  type SmartClassificationContext,
} from '../lib/mail/smart-categories';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { now } from './lib';

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
function classifierInput(row: any) {
  return {
    _id: row.providerThreadId,
    subject: row.subject,
    fromAddress: row.fromAddress,
    snippet: row.snippet,
    labels: row.labels || [],
    unread: Boolean(row.unread),
    starred: Boolean(row.starred),
  };
}

export function classifyCorpusThread(row: any, context: SmartClassificationContext) {
  const verdict = classifyThreadWithContext(classifierInput(row) as any, context);
  return {
    smartCategory: verdict,
    smartPrimary: verdict.primary,
    smartCustomKeys: verdict.customLabels || [],
    classifiedAt: now(),
  };
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
    const rows = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_smart_primary', (q: any) => q.eq('smartPrimary', undefined))
      .take(200);
    if (!rows.length) return { classified: 0, done: true };
    const contexts = new Map<string, SmartClassificationContext>();
    for (const row of rows) {
      let context = contexts.get(row.userId);
      if (!context) {
        context = await loadSmartContext(ctx, row.userId);
        contexts.set(row.userId, context);
      }
      await ctx.db.patch(row._id, classifyCorpusThread(row, context));
    }
    if (rows.length === 200) {
      await ctx.scheduler.runAfter(1_000, internal.smart.classifyBacklog, {});
    }
    return { classified: rows.length, done: rows.length < 200 };
  },
});

// Rule/label edits change what every existing verdict means; re-run the
// classifier over the user's corpus in scheduled pages.
export const reclassifyUserThreads = internalMutation({
  args: { userId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const context = await loadSmartContext(ctx, args.userId);
    const page = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user', (q: any) => q.eq('userId', args.userId))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });
    for (const row of page.page) {
      await ctx.db.patch(row._id, classifyCorpusThread(row, context));
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
