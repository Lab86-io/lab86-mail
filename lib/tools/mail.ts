import { z } from 'zod';
import { normalizeGogSearchItem } from '../gog/normalize';
import { runGogJson } from '../gog/pool';
import { isGogEnabled } from '../hosted/env';
import {
  classifyThreadWithContext,
  includeInSmartCategory,
  SMART_CATEGORY_IDS,
} from '../mail/smart-categories';
import {
  getNylasMessage,
  getNylasThread,
  listNylasAccounts,
  listNylasLabels,
  searchNylasThreads,
} from '../nylas/provider';
import type { Thread } from '../shared/types';
import {
  getMessage as getMessageRecord,
  getThreadMessages,
  upsertMessage as upsertMessageRecord,
} from '../store/messages';
import { computeSmartCategoryStats } from '../store/smart-category-stats';
import { getSmartLabel, listSmartLabels } from '../store/smart-labels';
import { listSmartRules } from '../store/smart-rules';
import {
  getThread as getThreadRecord,
  listRecentThreads,
  listThreadsForAccount,
  setThreadSmartCategory,
  upsertThread,
} from '../store/threads';
import { defineTool } from './registry';

export const listAccounts = defineTool({
  name: 'list_accounts',
  description: 'List connected hosted mail accounts.',
  category: 'mail',
  mutating: false,
  input: z.object({}).optional(),
  output: z.object({
    accounts: z.array(
      z.object({
        email: z.string(),
        provider: z.literal('gmail'),
        authed: z.boolean(),
        accountId: z.string().optional(),
        primary: z.boolean().optional(),
        displayName: z.string().optional(),
        services: z.array(z.string()).optional(),
      }),
    ),
  }),
  async handler(_args, ctx) {
    return { accounts: await listNylasAccounts(ctx.userId).catch(() => []) };
  },
});

export const searchThreads = defineTool({
  name: 'search_threads',
  description:
    'Search Gmail threads with Gmail query syntax (in:inbox, is:unread, from:, subject:, newer_than:7d, has:attachment, etc.). Cache write-through.',
  category: 'mail',
  mutating: false,
  input: z.object({
    account: z.string().describe('Email of the account to search'),
    query: z.string().default('in:inbox newer_than:30d').describe('Gmail search query'),
    max: z.number().int().min(1).max(80).default(30),
    pageToken: z.string().optional(),
  }),
  output: z.object({
    account: z.string(),
    query: z.string(),
    items: z.array(z.any()),
    nextPageToken: z.string().optional(),
  }),
  async handler({ account, query, max, pageToken }, ctx) {
    const nylas = await searchNylasThreads({
      userId: ctx.userId,
      account,
      query,
      max,
      pageToken,
    }).catch((err) => {
      if (String(err?.message || '').includes('Nylas is not configured')) throw err;
      return null;
    });
    if (nylas) {
      for (const item of nylas.items) {
        if (item._id) await upsertThread(account, item).catch(() => undefined);
      }
      return nylas;
    }
    if (isGogEnabled()) {
      const legacy = await runGogJson<any>(
        ['--account', account, 'search', '--max', String(max), '--', query],
        { timeoutMs: 60_000 },
      ).catch(() => null);
      const rawItems = Array.isArray(legacy?.threads) ? legacy.threads : Array.isArray(legacy) ? legacy : [];
      const items = rawItems.map((item: any) => normalizeGogSearchItem(item, account));
      for (const item of items) {
        if (item._id) await upsertThread(account, item).catch(() => undefined);
      }
      return { account, query, items, nextPageToken: undefined };
    }
    return { account, query, items: [], nextPageToken: undefined };
  },
});

const SmartCategorySchema = z.union([z.enum(SMART_CATEGORY_IDS), z.string().regex(/^custom:.+/)]);

export const listSmartCategory = defineTool({
  name: 'list_smart_category',
  description:
    'List a smart MailOS category. Fetches recent Gmail candidates, classifies missing/stale rows locally, and filters into built-in or custom smart labels.',
  category: 'mail',
  mutating: false,
  input: z.object({
    account: z.string(),
    category: SmartCategorySchema,
    query: z.string().optional(),
    max: z.number().int().min(1).max(80).default(50),
    pageToken: z.string().optional(),
  }),
  output: z.object({
    account: z.string(),
    category: SmartCategorySchema,
    query: z.string(),
    items: z.array(z.any()),
    nextPageToken: z.string().optional(),
  }),
  async handler({ account, category, query, max, pageToken }, ctx) {
    const customLabelId = category.startsWith('custom:') ? category.slice('custom:'.length) : '';
    const customLabel = customLabelId ? await getSmartLabel(customLabelId) : null;
    const candidateQuery = query || customLabel?.candidateQuery || smartCandidateQuery(category);
    const [rules, customLabels] = await Promise.all([listSmartRules(), listSmartLabels()]);
    const nylas = await searchNylasThreads({
      userId: ctx.userId,
      account,
      query: candidateQuery,
      max: Math.min(80, Math.max(max * 2, 60)),
      pageToken,
    }).catch((err) => {
      if (String(err?.message || '').includes('Nylas is not configured')) throw err;
      return null;
    });
    if (nylas) {
      const matched: any[] = [];
      for (const item of nylas.items) {
        if (!item._id) continue;
        const smartCategory = classifyThreadWithContext(item as Thread, { rules, customLabels });
        const enriched = { ...item, smartCategory };
        await upsertThread(account, enriched).catch(() => undefined);
        await setThreadSmartCategory(account, item._id, smartCategory).catch(() => undefined);
        if (includeInSmartCategory(enriched, category)) matched.push(enriched);
      }
      matched.sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
      return {
        account,
        category,
        query: candidateQuery,
        items: matched.slice(0, max),
        nextPageToken: nylas.nextPageToken,
      };
    }
    return { account, category, query: candidateQuery, items: [], nextPageToken: undefined };
  },
});

export const getThread = defineTool({
  name: 'get_thread',
  description: 'Fetch a full Gmail thread (all messages) by thread id. Caches messages.',
  category: 'mail',
  mutating: false,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    refresh: z.boolean().default(false).optional(),
  }),
  output: z.object({
    account: z.string(),
    threadId: z.string(),
    subject: z.string(),
    messages: z.array(z.any()),
    summary: z.string().nullable().optional(),
    summaryAt: z.number().nullable().optional(),
  }),
  async handler({ account, threadId, refresh }, ctx) {
    const nylas = await getNylasThread({ userId: ctx.userId, account, threadId }).catch((err) => {
      if (String(err?.message || '').includes('Nylas is not configured')) throw err;
      return null;
    });
    if (nylas) {
      for (const message of nylas.messages) await upsertMessageRecord(message).catch(() => undefined);
      const newest = nylas.messages[nylas.messages.length - 1];
      if (newest) {
        await upsertThread(account, {
          _id: threadId,
          subject: newest.subject || nylas.messages[0]?.subject || '(no subject)',
          fromAddress: newest.from,
          lastDate: newest.date,
          snippet: newest.snippet || newest.textBody?.slice(0, 240) || '',
          labels: newest.labels || [],
          unread: nylas.messages.some((message) => message.labels?.includes('UNREAD')),
        }).catch(() => undefined);
      }
      const cachedThread = await getThreadRecord(account, threadId).catch(() => null);
      return {
        ...nylas,
        summary: cachedThread?.summary ?? null,
        summaryAt: cachedThread?.summaryAt ?? null,
      };
    }

    const cachedThread = await getThreadRecord(account, threadId).catch(() => null);
    const messages = refresh ? [] : await getThreadMessages(account, threadId);
    if (!messages.length) {
      throw new Error('Thread is not available from Nylas yet. Refresh the mailbox and try again.');
    }
    return {
      account,
      threadId,
      subject: messages[0]?.subject || '(no subject)',
      messages,
      summary: cachedThread?.summary ?? null,
      summaryAt: cachedThread?.summaryAt ?? null,
    };
  },
});

export const getMessage = defineTool({
  name: 'get_message',
  description: 'Fetch a single Gmail message by id. Caches.',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), id: z.string() }),
  output: z.any(),
  async handler({ account, id }, ctx) {
    const nylas = await getNylasMessage({ userId: ctx.userId, account, id }).catch((err) => {
      if (String(err?.message || '').includes('Nylas is not configured')) throw err;
      return null;
    });
    if (nylas) return nylas;

    const cached = await getMessageRecord(account, id);
    if (cached && Date.now() - cached.cachedAt < 30 * 60_000) return cached;
    throw new Error('Message is not available from Nylas yet. Reopen the thread and try again.');
  },
});

export const listLabels = defineTool({
  name: 'list_labels',
  description: 'List all Gmail labels (system + user) for an account.',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string() }),
  output: z.object({ labels: z.array(z.any()) }),
  async handler({ account }, ctx) {
    const nylas = await listNylasLabels(ctx.userId, account).catch((err) => {
      if (String(err?.message || '').includes('Nylas is not configured')) throw err;
      return null;
    });
    if (nylas) return nylas;
    return { labels: [] };
  },
});

export const listAttachments = defineTool({
  name: 'list_attachments',
  description: 'List attachments on a message (filename, mime, size).',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), messageId: z.string() }),
  output: z.object({ attachments: z.array(z.any()) }),
  async handler({ account, messageId }, ctx) {
    const msg =
      (await getNylasMessage({ userId: ctx.userId, account, id: messageId }).catch(() => null)) ||
      (await getMessageRecord(account, messageId));
    return { attachments: msg?.attachments || [] };
  },
});

export const recentThreadsCached = defineTool({
  name: 'recent_threads',
  description: 'Return up to N recent threads from the local cache (used to seed the command palette).',
  category: 'mail',
  mutating: false,
  input: z.object({ limit: z.number().int().min(1).max(200).default(80) }),
  output: z.object({ threads: z.array(z.any()) }),
  async handler({ limit }) {
    return { threads: await listRecentThreads(limit) };
  },
});

export const listAccountThreads = defineTool({
  name: 'list_account_threads',
  description: 'List cached threads for a specific account (no Gmail fetch).',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), limit: z.number().int().min(1).max(200).default(80) }),
  output: z.object({ threads: z.array(z.any()) }),
  async handler({ account, limit }) {
    return { threads: await listThreadsForAccount(account, limit) };
  },
});

export const getSmartCategoryStats = defineTool({
  name: 'get_smart_category_stats',
  description:
    'Return locally computed smart category stats: total, unread, needs-attention, tracked, and freshness.',
  category: 'mail',
  mutating: false,
  input: z.object({
    account: z.string().optional(),
    refresh: z.boolean().default(false).optional(),
  }),
  output: z.object({
    categories: z.record(
      z.string(),
      z.object({
        total: z.number(),
        unread: z.number(),
        needsAttention: z.number(),
        tracked: z.number(),
        computedAt: z.number(),
        approximate: z.boolean(),
      }),
    ),
  }),
  async handler({ account }) {
    const categories = await computeSmartCategoryStats(account);
    return {
      categories: Object.fromEntries(
        Object.entries(categories).map(([id, stat]) => [
          id,
          {
            total: stat.total,
            unread: stat.unread,
            needsAttention: stat.needsAttention,
            tracked: stat.tracked,
            computedAt: stat.computedAt,
            approximate: stat.approximate,
          },
        ]),
      ),
    };
  },
});

function smartCandidateQuery(category: string) {
  switch (category) {
    case 'main':
    case 'needs_reply':
    case 'waiting':
      // Human conversations live in Gmail's Primary tab (plus anything Gmail
      // flagged Important). Querying the whole inbox lets the high-volume
      // Promotions / Updates / Social tabs saturate the result cap and crowd
      // out real people — a job offer sitting 2nd in Primary would never make
      // the first 80 inbox rows. Scope to primary-or-important, and do NOT
      // time-box it: a year-old human thread still owed a reply matters more
      // than today's promotions. Newest-first + pagination keeps it bounded.
      return 'in:inbox (category:primary OR is:important) -in:trash -in:spam';
    case 'codes':
      return 'newer_than:30d (code OR verification OR login OR security OR "magic link") -in:trash -in:spam';
    case 'orders':
      return 'newer_than:90d (order OR shipped OR delivery OR tracking OR refund OR receipt OR invoice OR booking) -in:trash -in:spam';
    case 'finance_admin':
      return 'newer_than:180d (invoice OR billing OR payment OR tax OR legal OR contract OR subscription) -in:trash -in:spam';
    case 'noise':
      return 'newer_than:30d -in:trash -in:spam';
    default:
      return 'in:inbox newer_than:45d -in:trash -in:spam';
  }
}
