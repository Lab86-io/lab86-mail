import { z } from 'zod';
import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { listNylasAccounts, searchNylasThreads } from '../nylas/provider';
import { emailFromHeader } from '../shared/format';
import { recallSender } from '../store/memories';
import { defineTool } from './registry';

const mailCorpusApi = (api as any).mailCorpus;

// Agent tools over the synced mail corpus. Unlike search_threads (one
// account per call), these answer the questions the agent actually gets:
// "across all my mail", "who is this person", "how many", "what happened in
// this thread" — each in a single call against the local index.

async function authedAccountIds(userId?: string | null): Promise<string[]> {
  const accounts = await listNylasAccounts(userId);
  return accounts.filter((account: any) => account.authed).map((account: any) => account.accountId);
}

export const corpusSearch = defineTool({
  name: 'corpus_search',
  description:
    'Search mail across ALL connected accounts at once (local index first, provider fallback). Prefer this over per-account search_threads when the user has not named a specific mailbox.',
  category: 'mail',
  mutating: false,
  input: z.object({
    query: z.string().describe('Mail search query (from:, to:, subject:, newer_than:, free text, …)'),
    accounts: z.array(z.string()).optional().describe('Restrict to these accountIds (default: all)'),
    max: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ items: z.array(z.any()), accountsSearched: z.array(z.string()) }),
  async handler({ query, accounts, max }, ctx) {
    const all = await authedAccountIds(ctx.userId);
    const targets = accounts?.length ? all.filter((id) => accounts.includes(id)) : all;
    if (!targets.length) throw new Error('No connected accounts to search.');
    const perAccount = Math.max(5, Math.ceil(max / targets.length));
    const results = await Promise.all(
      targets.map((account) =>
        searchNylasThreads({ userId: ctx.userId, account, query, max: perAccount })
          .then((result) =>
            (result?.items || []).map((item: any) => ({ ...item, account, searchTier: result?.searchTier })),
          )
          .catch(() => []),
      ),
    );
    const merged = results
      .flat()
      .sort((a: any, b: any) => (Number(b.lastDate ?? b.date) || 0) - (Number(a.lastDate ?? a.date) || 0))
      .slice(0, max);
    return { items: merged, accountsSearched: targets };
  },
});

export const senderProfile = defineTool({
  name: 'sender_profile',
  description:
    'Profile a sender across all accounts from the local mail index: volume, first/last contact, recent subjects, plus any stored memory about them.',
  category: 'mail',
  mutating: false,
  input: z.object({ email: z.string().describe('Sender email address') }),
  output: z.object({
    email: z.string(),
    name: z.string().optional(),
    totalMessages: z.number(),
    accounts: z.array(z.any()),
    recentSubjects: z.array(z.string()),
    firstSeen: z.number().nullable(),
    lastSeen: z.number().nullable(),
    memory: z.any().nullable(),
  }),
  async handler({ email }, ctx) {
    if (!isConvexConfigured()) throw new Error('Mail index is not available.');
    const target = email.trim().toLowerCase();
    const accountIds = await authedAccountIds(ctx.userId);
    const perAccount = await Promise.all(
      accountIds.map(async (accountId) => {
        const rows = await convexQuery<any[]>(mailCorpusApi.searchCorpusMessages, {
          userId: ctx.userId,
          accountId,
          query: target,
          limit: 100,
        }).catch(() => []);
        const fromSender = rows.filter(
          (row) => (emailFromHeader(row.from) || row.from || '').toLowerCase() === target,
        );
        return { accountId, rows: fromSender };
      }),
    );
    const allRows = perAccount.flatMap((entry) => entry.rows);
    allRows.sort((a, b) => b.receivedAt - a.receivedAt);
    const name = allRows[0]?.from?.replace(/<.*?>/g, '').trim() || undefined;
    const memory = await recallSender(target).catch(() => null);
    return {
      email: target,
      name,
      totalMessages: allRows.length,
      accounts: perAccount
        .filter((entry) => entry.rows.length)
        .map((entry) => ({
          accountId: entry.accountId,
          messages: entry.rows.length,
          lastSeen: entry.rows[0]?.receivedAt ?? null,
        })),
      recentSubjects: [...new Set(allRows.slice(0, 10).map((row) => String(row.subject || '')))].slice(0, 6),
      firstSeen: allRows.length ? allRows[allRows.length - 1].receivedAt : null,
      lastSeen: allRows.length ? allRows[0].receivedAt : null,
      memory: memory || null,
    };
  },
});

export const corpusCount = defineTool({
  name: 'corpus_count',
  description:
    'Count indexed messages matching a query (per account, capped at 1000 → approximate). Use for "how many emails…" questions instead of paging search results.',
  category: 'mail',
  mutating: false,
  input: z.object({
    query: z.string().optional().describe('Free-text filter (omit to count everything)'),
    account: z.string().optional().describe('Single accountId (default: all accounts)'),
    after: z.number().optional().describe('Only messages received after this epoch ms'),
    before: z.number().optional().describe('Only messages received before this epoch ms'),
  }),
  output: z.object({ total: z.number(), approximate: z.boolean(), accounts: z.array(z.any()) }),
  async handler({ query, account, after, before }, ctx) {
    if (!isConvexConfigured()) throw new Error('Mail index is not available.');
    const accountIds = account ? [account] : await authedAccountIds(ctx.userId);
    const counts = await Promise.all(
      accountIds.map(async (accountId) => {
        const result = await convexQuery<{ count: number; approximate: boolean }>(
          mailCorpusApi.countCorpusMessages,
          { userId: ctx.userId, accountId, query, after, before },
        ).catch(() => ({ count: 0, approximate: false }));
        return { accountId, ...result };
      }),
    );
    return {
      total: counts.reduce((sum, entry) => sum + entry.count, 0),
      approximate: counts.some((entry) => entry.approximate),
      accounts: counts,
    };
  },
});

export const threadTimeline = defineTool({
  name: 'thread_timeline',
  description:
    'Chronological timeline of a thread from the local index — who said what, when — without refetching from the provider. Cheaper than get_thread for summarizing history.',
  category: 'mail',
  mutating: false,
  input: z.object({ account: z.string(), threadId: z.string() }),
  output: z.object({ messages: z.array(z.any()) }),
  async handler({ account, threadId }, ctx) {
    if (!isConvexConfigured()) throw new Error('Mail index is not available.');
    const rows = await convexQuery<any[]>(mailCorpusApi.listCorpusThreadMessages, {
      userId: ctx.userId,
      accountId: account,
      providerThreadId: threadId,
    });
    return {
      messages: (rows || []).map((row) => ({
        from: row.from,
        to: row.to,
        date: row.receivedAt,
        subject: row.subject,
        snippet: row.snippet,
        unread: Boolean(row.unread),
      })),
    };
  },
});
