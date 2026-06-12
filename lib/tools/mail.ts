import { z } from 'zod';
import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { ingestThreadIntoCorpus, maybeKickCorpusBackfill } from '../mail/corpus-sync';
import { DEFAULT_MAIL_QUERY, SMART_CATEGORY_CANDIDATE_QUERIES } from '../mail/search/constants';
import {
  classifyThreadWithContext,
  includeInSmartCategory,
  SMART_CATEGORY_IDS,
} from '../mail/smart-categories';
import {
  getNylasAccount,
  getNylasMessage,
  getNylasThread,
  listNylasAccounts,
  listNylasLabels,
  searchNylasThreads,
} from '../nylas/provider';
import type { Thread } from '../shared/types';
import { upsertMessage as upsertMessageRecord } from '../store/messages';
import { getSmartLabel, listSmartLabels } from '../store/smart-labels';
import { listSmartRules } from '../store/smart-rules';
import {
  getThread as getThreadRecord,
  listRecentThreads,
  listThreadsForAccount,
  upsertThread,
} from '../store/threads';
import { defineTool } from './registry';

const LOCAL_CURSOR_PREFIX = 'local:';

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
        sync: z
          .object({
            status: z.string(),
            corpusReady: z.boolean(),
            messagesSynced: z.number().optional(),
            error: z.string().optional(),
            lastSyncAt: z.number().optional(),
          })
          .optional(),
      }),
    ),
  }),
  async handler(_args, ctx) {
    const accounts = await listNylasAccounts(ctx.userId);
    const syncStates = ctx.userId
      ? await convexQuery<any[]>((api as any).mailCorpus.listSyncTargets, {
          userId: ctx.userId,
          limit: 500,
        }).catch(() => [])
      : [];
    const syncByAccount = new Map(syncStates.map((state) => [state.accountId, state]));
    return {
      accounts: accounts.map((account) => {
        const state = syncByAccount.get(account.accountId);
        return {
          ...account,
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
    // Local-tier results already came out of the corpus; only provider-tier
    // results are worth caching, and those writes run in parallel, never as a
    // serial per-row chain on the response path.
    if (nylas.searchTier !== 'local') {
      await Promise.allSettled(
        nylas.items.filter((item) => item._id).map((item) => upsertThread(account, item)),
      );
    }
    return nylas;
  },
});

const SmartCategorySchema = z.union([z.enum(SMART_CATEGORY_IDS), z.string().regex(/^custom:.+/)]);

export const listSmartCategory = defineTool({
  name: 'list_smart_category',
  description:
    'List a smart MailOS category from the synced corpus (indexed, instant). Falls back to a provider search only while a brand-new account awaits its first sync batch.',
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
    // The user is looking at categories — opportunistically drain any threads
    // still waiting for their one LLM verdict (debounced, runs off-request).
    if (ctx.userId) {
      void import('../mail/llm-classify').then(({ kickLlmClassification }) =>
        kickLlmClassification(ctx.userId),
      );
    }
    // Primary path: indexed corpus read over persisted write-time verdicts.
    // No provider calls and no writes — this is a pure local query.
    if (ctx.userId && isConvexConfigured() && (!pageToken || pageToken.startsWith(LOCAL_CURSOR_PREFIX))) {
      const before = pageToken ? Number(pageToken.slice(LOCAL_CURSOR_PREFIX.length)) : undefined;
      const result = await convexQuery<{ items: any[]; nextBefore?: number }>(
        (api as any).mailCorpus.listSmartCategoryThreads,
        {
          userId: ctx.userId,
          accountId: account,
          category,
          limit: max,
          before: Number.isFinite(before) ? before : undefined,
        },
      ).catch(() => null);
      if (result) {
        const corpusEmpty = result.items.length === 0 && pageToken === undefined;
        if (!corpusEmpty || (await accountHasCorpusRows(ctx.userId, account))) {
          return {
            account,
            category,
            query: query || '',
            items: result.items,
            nextPageToken:
              result.nextBefore !== undefined ? `${LOCAL_CURSOR_PREFIX}${result.nextBefore}` : undefined,
          };
        }
      }
    }

    // Fallback: the corpus has no rows for this account yet (first sync batch
    // is still in flight). Serve a provider search so the view is never blank,
    // kick the backfill, and let the reactive corpus queries take over.
    const customLabelId = category.startsWith('custom:') ? category.slice('custom:'.length) : '';
    const customLabel = customLabelId ? await getSmartLabel(customLabelId) : null;
    const candidateQuery = query || customLabel?.candidateQuery || smartCandidateQuery(category);
    const [rules, customLabels] = await Promise.all([listSmartRules(), listSmartLabels()]);
    if (ctx.userId) {
      const row = await getNylasAccount(ctx.userId, account).catch(() => null);
      if (row) maybeKickCorpusBackfill(row);
    }
    const nylas = await requireNylasResult(
      searchNylasThreads({
        userId: ctx.userId,
        account,
        query: candidateQuery,
        max: Math.min(80, Math.max(max * 2, 60)),
        pageToken: pageToken?.startsWith(LOCAL_CURSOR_PREFIX) ? undefined : pageToken,
      }),
      'Connected Nylas account not found.',
    );
    const matched = nylas.items
      .filter((item) => item._id)
      .map((item) => ({
        ...item,
        smartCategory: classifyThreadWithContext(item as Thread, { rules, customLabels }),
      }))
      .filter((item) => includeInSmartCategory(item, category));
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

async function accountHasCorpusRows(userId: string, accountId: string) {
  const state = await convexQuery<any | null>((api as any).mailCorpus.getSyncState, {
    userId,
    accountId,
  }).catch(() => null);
  return Boolean(state && (state.messagesSynced || state.corpusReady));
}

export const getThread = defineTool({
  name: 'get_thread',
  description:
    'Fetch a full hosted mail thread by thread id. Served from the synced corpus when bodies are present; otherwise fetched from the provider once and persisted so the next open is local.',
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
    // Fast path: the corpus already holds every message body — pure local
    // read, no provider round-trip.
    if (!refresh && ctx.userId && isConvexConfigured()) {
      const bundle = await convexQuery<any | null>((api as any).mailCorpus.getCorpusThreadBundle, {
        userId: ctx.userId,
        accountId: account,
        providerThreadId: threadId,
      }).catch(() => null);
      if (bundle?.bodiesComplete) {
        const cachedThread = await getThreadRecord(account, threadId).catch(() => null);
        return {
          account,
          threadId,
          subject: bundle.subject,
          messages: bundle.messages,
          summary: cachedThread?.summary ?? null,
          summaryAt: cachedThread?.summaryAt ?? null,
        };
      }
    }

    // Hydration path: fetch once from the provider, then persist into the
    // corpus in a single batched mutation (live queries update reactively) and
    // refresh the legacy caches in parallel — no serial per-row awaits.
    const nylas = await requireNylasResult(
      getNylasThread({ userId: ctx.userId, account, threadId }),
      'Connected Nylas account not found.',
    );
    const newest = nylas.messages[nylas.messages.length - 1];
    const row = ctx.userId ? await getNylasAccount(ctx.userId, account).catch(() => null) : null;
    await Promise.all([
      row && isConvexConfigured()
        ? ingestThreadIntoCorpus(row, nylas.messages).catch(() => undefined)
        : Promise.resolve(),
      Promise.all(nylas.messages.map((message) => upsertMessageRecord(message).catch(() => undefined))),
      newest
        ? upsertThread(account, {
            _id: threadId,
            subject: newest.subject || nylas.messages[0]?.subject || '(no subject)',
            fromAddress: newest.from,
            lastDate: newest.date,
            snippet: newest.snippet || newest.textBody?.slice(0, 240) || '',
            labels: newest.labels || [],
            unread: nylas.messages.some(
              (message) => Boolean(message.unread) || message.labels?.includes('UNREAD'),
            ),
          }).catch(() => undefined)
        : Promise.resolve(),
    ]);
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
  description: 'Return up to N recent synced threads used to seed the command palette.',
  category: 'mail',
  mutating: false,
  input: z.object({ limit: z.number().int().min(1).max(200).default(80) }),
  output: z.object({ threads: z.array(z.any()) }),
  async handler({ limit }, ctx) {
    if (ctx.userId && isConvexConfigured()) {
      const rows = await convexQuery<any[]>((api as any).mailCorpus.listRecentCorpusThreads, {
        userId: ctx.userId,
        limit,
      }).catch(() => null);
      if (rows?.length) return { threads: rows };
    }
    return { threads: await listRecentThreads(limit) };
  },
});

export const listAccountThreads = defineTool({
  name: 'list_account_threads',
  description: 'List synced threads for a specific account.',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), limit: z.number().int().min(1).max(200).default(80) }),
  output: z.object({ threads: z.array(z.any()) }),
  async handler({ account, limit }, ctx) {
    if (ctx.userId && isConvexConfigured()) {
      const rows = await convexQuery<any[]>((api as any).mailCorpus.listRecentCorpusThreads, {
        userId: ctx.userId,
        accountId: account,
        limit,
      }).catch(() => null);
      if (rows?.length) return { threads: rows };
    }
    return { threads: await listThreadsForAccount(account, limit) };
  },
});

export const getSmartCategoryStats = defineTool({
  name: 'get_smart_category_stats',
  description:
    'Return unread counts per smart category (capped at 100) with a needs-attention flag. Indexed corpus read — instant.',
  category: 'mail',
  mutating: false,
  input: z.object({
    account: z.string().optional(),
  }),
  output: z.object({
    categories: z.record(z.string(), z.object({ unread: z.number(), attention: z.boolean() })),
  }),
  async handler({ account }, ctx) {
    if (!ctx.userId || !isConvexConfigured()) return { categories: {} };
    const result = await convexQuery<{ counts: Record<string, { unread: number; attention: boolean }> }>(
      (api as any).mailCorpus.categoryCountsInternal,
      { userId: ctx.userId, accountIds: account ? [account] : undefined },
    );
    return { categories: result.counts };
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
