import { z } from 'zod';
import { DEFAULT_MAIL_QUERY, SMART_CATEGORY_CANDIDATE_QUERIES } from '../mail/search/constants';
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
import { upsertMessage as upsertMessageRecord } from '../store/messages';
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
        provider: z.enum(['google', 'microsoft', 'icloud', 'imap']),
        authed: z.boolean(),
        accountId: z.string(),
        primary: z.boolean().optional(),
        displayName: z.string().optional(),
        services: z.array(z.string()).optional(),
      }),
    ),
  }),
  async handler(_args, ctx) {
    return { accounts: await listNylasAccounts(ctx.userId) };
  },
});

export const searchThreads = defineTool({
  name: 'search_threads',
  description:
    'Search hosted mail threads using the provider transport and cache the returned thread summaries.',
  category: 'mail',
  mutating: false,
  input: z.object({
    account: z.string().describe('Connected hosted account identifier'),
    query: z.string().default(DEFAULT_MAIL_QUERY).describe('Mail search query'),
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
    const nylas = await requireNylasResult(
      searchNylasThreads({
        userId: ctx.userId,
        account,
        query,
        max,
        pageToken,
      }),
      'Connected Nylas account not found.',
    );
    for (const item of nylas.items) {
      if (item._id) await upsertThread(account, item).catch(() => undefined);
    }
    return nylas;
  },
});

const SmartCategorySchema = z.union([z.enum(SMART_CATEGORY_IDS), z.string().regex(/^custom:.+/)]);

export const listSmartCategory = defineTool({
  name: 'list_smart_category',
  description:
    'List a smart MailOS category. Fetches recent hosted mail candidates, classifies missing/stale rows locally, and filters into built-in or custom smart labels.',
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
    const nylas = await requireNylasResult(
      searchNylasThreads({
        userId: ctx.userId,
        account,
        query: candidateQuery,
        max: Math.min(80, Math.max(max * 2, 60)),
        pageToken,
      }),
      'Connected Nylas account not found.',
    );
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
  },
});

export const getThread = defineTool({
  name: 'get_thread',
  description: 'Fetch a full hosted mail thread by thread id and cache its messages.',
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
  async handler({ account, threadId }, ctx) {
    const nylas = await requireNylasResult(
      getNylasThread({ userId: ctx.userId, account, threadId }),
      'Connected Nylas account not found.',
    );
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
        unread: nylas.messages.some(
          (message) => Boolean(message.unread) || message.labels?.includes('UNREAD'),
        ),
      }).catch(() => undefined);
    }
    const cachedThread = await getThreadRecord(account, threadId).catch(() => null);
    return {
      ...nylas,
      summary: cachedThread?.summary ?? null,
      summaryAt: cachedThread?.summaryAt ?? null,
    };
  },
});

export const getMessage = defineTool({
  name: 'get_message',
  description: 'Fetch a single hosted mail message by id.',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), id: z.string() }),
  output: z.any(),
  async handler({ account, id }, ctx) {
    return await requireNylasResult(
      getNylasMessage({ userId: ctx.userId, account, id }),
      'Connected Nylas account not found.',
    );
  },
});

export const listLabels = defineTool({
  name: 'list_labels',
  description: 'List all provider folders/labels for an account.',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string() }),
  output: z.object({ labels: z.array(z.any()) }),
  async handler({ account }, ctx) {
    return await requireNylasResult(
      listNylasLabels(ctx.userId, account),
      'Connected Nylas account not found.',
    );
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
    const msg = await requireNylasResult(
      getNylasMessage({ userId: ctx.userId, account, id: messageId }),
      'Connected Nylas account not found.',
    );
    return { attachments: msg.attachments || [] };
  },
});

export const recentThreadsCached = defineTool({
  name: 'recent_threads',
  description: 'Return up to N recent cached threads used to seed the command palette.',
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
  description: 'List cached threads for a specific account.',
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

async function requireNylasResult<T>(value: Promise<T | null>, message: string): Promise<T> {
  const result = await value;
  if (!result) throw new Error(message);
  return result;
}

function smartCandidateQuery(category: string) {
  return SMART_CATEGORY_CANDIDATE_QUERIES[category] || SMART_CATEGORY_CANDIDATE_QUERIES.default;
}
