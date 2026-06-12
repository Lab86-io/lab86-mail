import { v } from 'convex/values';
import {
  classifyThreadWithContext,
  includeInSmartCategory,
  SMART_CATEGORY_IDS,
} from '../lib/mail/smart-categories';
import type { QueryCtx } from './_generated/server';
import { query } from './_generated/server';
import {
  CATEGORY_COUNT_CAP,
  computeCategoryUnreadCounts,
  loadSmartContext,
  normalizeCorpusThread,
  queryCategoryThreads,
} from './smart';

const SmartCategoryValidator = v.union(...SMART_CATEGORY_IDS.map((id) => v.literal(id)), v.string());

async function requireUserId(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

function normalizeAccount(row: any) {
  return {
    accountId: row.accountId,
    email: row.email,
    provider: row.provider,
    authed: row.status === 'connected',
    primary: false,
    displayName: row.displayName,
    services: ['nylas', row.provider],
  };
}

function normalizeMessage(row: any) {
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
    // null = body not yet hydrated into the corpus; '' = synced and empty.
    // The reader uses the distinction to decide whether to hydrate.
    htmlBody: row.htmlBody ?? null,
    labels: row.labels || [],
    unread: Boolean(row.unread),
    starred: Boolean(row.starred),
    attachments: row.attachments || [],
    headers: row.headers || {},
    cachedAt: row.updatedAt || row.receivedAt || 0,
  };
}

export const listAccounts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const [accounts, syncStates] = await Promise.all([
      ctx.db
        .query('connectedAccounts')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('mailSyncStates')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    ]);
    const syncByAccount = new Map(syncStates.map((state) => [state.accountId, state]));
    return {
      accounts: accounts
        .filter((account) => account.status === 'connected')
        .map((account) => {
          const state = syncByAccount.get(account.accountId);
          return {
            ...normalizeAccount(account),
            sync: state
              ? {
                  status: String(state.status || 'idle'),
                  corpusReady: Boolean(state.corpusReady),
                  messagesSynced: typeof state.messagesSynced === 'number' ? state.messagesSynced : undefined,
                  error: state.error || undefined,
                  lastSyncAt: state.lastIncrementalSyncAt || state.lastBackfillAt || undefined,
                }
              : undefined,
          };
        }),
    };
  },
});

export const listThreads = query({
  args: {
    accountIds: v.optional(v.array(v.string())),
    category: v.optional(SmartCategoryValidator),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 50), 1), 200);
    const requestedAccounts = args.accountIds?.filter(Boolean) || [];
    if (args.accountIds && requestedAccounts.length === 0) return { items: [], nextPageToken: undefined };
    const text = (args.query || '').trim();
    const category = (args.category || '').trim();

    if (text) {
      // Search index hits are message-level, so group the live result window by
      // thread here and let the existing HTTP path handle deep historical pages.
      const search = ctx.db.query('mailCorpusMessages').withSearchIndex('by_search_text', (q) => {
        return q.search('searchText', text).eq('userId', userId);
      });
      const messages = await search.take(limit * 6);
      const accountSet = requestedAccounts.length ? new Set(requestedAccounts) : null;
      const byThread = new Map<string, any>();
      for (const message of messages) {
        if (accountSet && !accountSet.has(message.accountId)) continue;
        const key = `${message.accountId}:${message.providerThreadId}`;
        const existing = byThread.get(key);
        if (!existing || message.receivedAt > existing.lastDate) {
          byThread.set(key, {
            userId,
            accountId: message.accountId,
            providerThreadId: message.providerThreadId,
            subject: message.subject,
            fromAddress: message.from,
            lastDate: message.receivedAt,
            snippet: message.snippet,
            labels: message.labels || [],
            unread: Boolean(message.unread),
            starred: Boolean(message.starred),
            messageCount: 1,
            updatedAt: message.updatedAt,
          });
        } else {
          existing.messageCount = (existing.messageCount || 1) + 1;
          existing.labels = [...new Set([...(existing.labels || []), ...(message.labels || [])])];
          existing.unread = Boolean(existing.unread) || Boolean(message.unread);
          existing.starred = Boolean(existing.starred) || Boolean(message.starred);
        }
      }
      let items = [...byThread.values()].map(normalizeCorpusThread);
      if (category) {
        const smartContext = await loadSmartContext(ctx, userId);
        items = items
          .map((thread) => ({
            ...thread,
            smartCategory: classifyThreadWithContext(thread as any, smartContext),
          }))
          .filter((thread) => includeInSmartCategory(thread as any, category));
      }
      items.sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
      return { items: items.slice(0, limit), nextPageToken: undefined };
    }

    if (category) {
      // Indexed read over the persisted write-time verdicts — no provider
      // calls and no window-wide reclassification on the hot path.
      const { items } = await queryCategoryThreads(ctx, {
        userId,
        accountIds: requestedAccounts.length ? requestedAccounts : null,
        category,
        limit,
      });
      return { items, nextPageToken: undefined };
    }

    let rows: any[] = [];
    if (requestedAccounts.length) {
      const perAccount = Math.max(limit, Math.ceil((limit * 2) / Math.max(requestedAccounts.length, 1)));
      const accountRows = await Promise.all(
        requestedAccounts.map((accountId) =>
          ctx.db
            .query('mailCorpusThreads')
            .withIndex('by_user_account_updated', (q) => q.eq('userId', userId).eq('accountId', accountId))
            .order('desc')
            .take(perAccount),
        ),
      );
      rows = accountRows.flat();
    } else {
      rows = await ctx.db
        .query('mailCorpusThreads')
        .withIndex('by_user_lastDate', (q) => q.eq('userId', userId))
        .order('desc')
        .take(limit * 2);
    }
    const items = rows.map(normalizeCorpusThread);
    items.sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
    return { items: items.slice(0, limit), nextPageToken: undefined };
  },
});

// Live rail badges. One unread number per category from the unread indexes —
// no scans, and Convex pushes updates whenever corpus rows change. The UI
// renders counts at the cap as "99+".
export const categoryCounts = query({
  args: { accountIds: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const counts = await computeCategoryUnreadCounts(ctx, userId, args.accountIds);
    return { counts, cap: CATEGORY_COUNT_CAP };
  },
});

export const getThread = query({
  args: {
    account: v.string(),
    threadId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const thread = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_account_thread', (q) =>
        q.eq('userId', userId).eq('accountId', args.account).eq('providerThreadId', args.threadId),
      )
      .unique();
    // Not-in-corpus is an expected state (brand-new account mid-backfill), not
    // an error: return null and let the client hydrate over HTTP.
    if (!thread) return null;
    const messages = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_account_thread_received', (q) =>
        q.eq('userId', userId).eq('accountId', args.account).eq('providerThreadId', args.threadId),
      )
      .order('asc')
      .collect();
    if (!messages.length) return null;
    return {
      threadId: args.threadId,
      subject: thread.subject || messages[0]?.subject || '(no subject)',
      messages: messages.map(normalizeMessage),
      summary: null,
      summaryAt: null,
    };
  },
});
