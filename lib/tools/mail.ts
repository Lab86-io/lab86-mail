import { z } from 'zod';
import { normalizeGogMessage, normalizeGogSearchItem } from '../gog/normalize';
import { runGogJson } from '../gog/pool';
import {
  classifyThreadWithContext,
  includeInSmartCategory,
  SMART_CATEGORY_IDS,
} from '../mail/smart-categories';
import type { Account, LabelRecord, Thread } from '../shared/types';
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

const ACCOUNT_LIST = (
  process.env.LAB86_MAIL_ACCOUNTS ||
  process.env.MAIL_OS_ACCOUNTS ||
  'jjalangtry@gmail.com,jakob@lab86.io'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const listAccounts = defineTool({
  name: 'list_accounts',
  description: 'List configured Gmail accounts and which are authenticated via GOG.',
  category: 'mail',
  mutating: false,
  input: z.object({}).optional(),
  output: z.object({
    accounts: z.array(
      z.object({
        email: z.string(),
        provider: z.literal('gmail'),
        authed: z.boolean(),
        primary: z.boolean().optional(),
        services: z.array(z.string()).optional(),
      }),
    ),
  }),
  async handler() {
    let raw: any = null;
    try {
      raw = await runGogJson(['auth', 'list', '--json', '--no-input'], { timeoutMs: 15_000 });
    } catch {}
    const discovered: string[] = (raw?.accounts || []).map((a: any) => a.email).filter(Boolean);
    const all = [...new Set([...ACCOUNT_LIST, ...discovered])];
    const accounts: Account[] = all.map((email) => {
      const stored = raw?.accounts?.find((a: any) => a.email === email);
      return {
        email,
        provider: 'gmail',
        authed: Boolean(stored),
        primary: email === 'jakob@lab86.io',
        services: stored?.services || [],
      };
    });
    return { accounts };
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
  async handler({ account, query, max, pageToken }) {
    const args = [
      '--account',
      account,
      '--json',
      'gmail',
      'search',
      '--max',
      String(max),
      ...(pageToken ? ['--page', pageToken] : []),
      '--no-input',
      // End-of-flags separator so queries starting with "-" (e.g. -in:trash,
      // -label:foo) aren't misparsed by the CLI as flags.
      '--',
      query,
    ];
    const raw = await runGogJson<any>(args);
    const list = coerceList(raw);
    const items: (Partial<Thread> & { _id: string })[] = [];
    for (const it of list) {
      const norm = normalizeGogSearchItem(it, account);
      if (!norm._id) continue;
      items.push(norm);
      await upsertThread(account, norm).catch(() => undefined);
    }
    return { account, query, items, nextPageToken: coerceNextPageToken(raw) };
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
  async handler({ account, category, query, max, pageToken }) {
    const customLabelId = category.startsWith('custom:') ? category.slice('custom:'.length) : '';
    const customLabel = customLabelId ? await getSmartLabel(customLabelId) : null;
    const candidateQuery = query || customLabel?.candidateQuery || smartCandidateQuery(category);
    const [rules, customLabels] = await Promise.all([listSmartRules(), listSmartLabels()]);
    // Gmail/gog search does NOT return strictly newest-first (the most recent
    // thread can sit dozens of rows down), so we must classify a healthy pool
    // and sort by date ourselves before truncating. Taking "the first `max`
    // matches in gog order" silently drops the newest, most important mail —
    // e.g. a job offer dated today landing at gog-index 20 while a small
    // per-account page budget stops at ~10.
    const args = [
      '--account',
      account,
      '--json',
      'gmail',
      'search',
      '--max',
      String(Math.min(80, Math.max(max * 2, 60))),
      ...(pageToken ? ['--page', pageToken] : []),
      '--no-input',
      '--',
      candidateQuery,
    ];
    const raw = await runGogJson<any>(args);
    const list = coerceList(raw);
    const matched: any[] = [];
    for (const it of list) {
      const norm = normalizeGogSearchItem(it, account);
      if (!norm._id) continue;
      const smartCategory = classifyThreadWithContext(norm, { rules, customLabels });
      const enriched = { ...norm, smartCategory };
      await upsertThread(account, enriched).catch(() => undefined);
      await setThreadSmartCategory(account, norm._id, smartCategory).catch(() => undefined);
      if (includeInSmartCategory(enriched, category)) matched.push(enriched);
    }
    matched.sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
    const items = matched.slice(0, max);
    return {
      account,
      category,
      query: candidateQuery,
      items,
      nextPageToken: coerceNextPageToken(raw),
    };
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
  async handler({ account, threadId, refresh }) {
    const cachedThread = await getThreadRecord(account, threadId).catch(() => null);
    let messages = refresh ? [] : await getThreadMessages(account, threadId);
    if (!messages.length) {
      const raw = await runGogJson<any>([
        '--account',
        account,
        '--json',
        'gmail',
        'thread',
        'get',
        threadId,
        '--full',
        '--no-input',
      ]);
      const threadObj = raw?.thread || raw?.result || raw?.data || raw;
      const arr: any[] = threadObj?.messages || [];
      messages = arr
        .map((m) => normalizeGogMessage(m, account))
        .filter((m) => m._id)
        .sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0));
      for (const m of messages) await upsertMessageRecord(m).catch(() => undefined);
      const newest = messages[messages.length - 1];
      if (newest) {
        await upsertThread(account, {
          _id: threadId,
          subject: newest.subject || messages[0]?.subject || '(no subject)',
          fromAddress: newest.from,
          lastDate: newest.date,
          snippet: newest.snippet || newest.textBody?.slice(0, 240) || '',
          labels: newest.labels || [],
          unread: messages.some((m) => m.labels?.includes('UNREAD')),
        }).catch(() => undefined);
      }
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
  async handler({ account, id }) {
    const cached = await getMessageRecord(account, id);
    if (cached && Date.now() - cached.cachedAt < 30 * 60_000) return cached;
    const raw = await runGogJson<any>([
      '--account',
      account,
      '--json',
      'gmail',
      'get',
      id,
      '--format',
      'full',
      '--no-input',
    ]);
    const m = normalizeGogMessage(raw, account);
    await upsertMessageRecord(m).catch(() => undefined);
    return m;
  },
});

export const listLabels = defineTool({
  name: 'list_labels',
  description: 'List all Gmail labels (system + user) for an account.',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string() }),
  output: z.object({ labels: z.array(z.any()) }),
  async handler({ account }) {
    const raw = await runGogJson<any>([
      '--account',
      account,
      '--json',
      'gmail',
      'labels',
      'list',
      '--no-input',
    ]);
    const list = coerceList(raw);
    const labels: LabelRecord[] = list.map((l: any) => ({
      id: l.id || l.labelId,
      name: l.name,
      type: l.type,
      messagesTotal: l.messagesTotal,
      threadsTotal: l.threadsTotal,
    }));
    return { labels };
  },
});

export const listAttachments = defineTool({
  name: 'list_attachments',
  description: 'List attachments on a message (filename, mime, size).',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), messageId: z.string() }),
  output: z.object({ attachments: z.array(z.any()) }),
  async handler({ account, messageId }) {
    const msg = await getMessageRecord(account, messageId);
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

function coerceList(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.messages)) return raw.messages;
  if (Array.isArray(raw?.threads)) return raw.threads;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.labels)) return raw.labels;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.result)) return raw.result;
  return [];
}

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

function coerceNextPageToken(raw: any): string | undefined {
  const token =
    raw?.nextPageToken ||
    raw?.next_page_token ||
    raw?.pageToken ||
    raw?.page_token ||
    raw?.result?.nextPageToken ||
    raw?.result?.next_page_token ||
    raw?.data?.nextPageToken ||
    raw?.data?.next_page_token;
  return typeof token === 'string' && token ? token : undefined;
}
