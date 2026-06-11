import { v } from 'convex/values';
import {
  classifyThreadWithContext,
  includeInSmartCategory,
  SMART_CATEGORY_IDS,
} from '../lib/mail/smart-categories';
import type { QueryCtx } from './_generated/server';
import { query } from './_generated/server';

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

function normalizeThread(row: any) {
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
    cachedAt: row.updatedAt || row.lastDate || 0,
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
    htmlBody: row.htmlBody || '',
    labels: row.labels || [],
    unread: Boolean(row.unread),
    starred: Boolean(row.starred),
    attachments: row.attachments || [],
    headers: row.headers || {},
    cachedAt: row.updatedAt || row.receivedAt || 0,
  };
}

async function listSmartContext(ctx: any, userId: string) {
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
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 50), 1), 100);
    const requestedAccounts = args.accountIds?.filter(Boolean) || [];
    if (args.accountIds && requestedAccounts.length === 0) return { items: [], nextPageToken: undefined };
    const text = (args.query || '').trim();
    const category = (args.category || '').trim();
    const needsSmartFilter = Boolean(category);
    const smartContext = needsSmartFilter ? await listSmartContext(ctx, userId) : null;
    let rows: any[] = [];

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
      rows = [...byThread.values()];
    } else if (requestedAccounts.length) {
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

    let items = rows.map(normalizeThread);
    if (smartContext && category) {
      items = items
        .map((thread) => ({
          ...thread,
          smartCategory: classifyThreadWithContext(thread, smartContext),
        }))
        .filter((thread) => includeInSmartCategory(thread, category));
    }
    items.sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
    return { items: items.slice(0, limit), nextPageToken: undefined };
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
    if (!thread) throw new Error('Thread not found');
    const messages = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_account_thread_received', (q) =>
        q.eq('userId', userId).eq('accountId', args.account).eq('providerThreadId', args.threadId),
      )
      .order('asc')
      .collect();
    return {
      threadId: args.threadId,
      subject: thread.subject || messages[0]?.subject || '(no subject)',
      messages: messages.map(normalizeMessage),
      summary: null,
      summaryAt: null,
    };
  },
});
