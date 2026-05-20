import { z } from 'zod';
import { defineTool } from './registry';
import { runGogJson } from '../gog/pool';
import { normalizeGogMessage, normalizeGogSearchItem } from '../gog/normalize';
import { upsertThread, getThread as getThreadRecord, listRecentThreads, listThreadsForAccount } from '../store/threads';
import { upsertMessage as upsertMessageRecord, getMessage as getMessageRecord, getThreadMessages } from '../store/messages';
import type { Account, Thread, Message, LabelRecord } from '../shared/types';

const ACCOUNT_LIST = (process.env.MAIL_OS_ACCOUNTS || 'jjalangtry@gmail.com,jakob@lab86.io')
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
  }),
  output: z.object({
    account: z.string(),
    query: z.string(),
    items: z.array(z.any()),
  }),
  async handler({ account, query, max }) {
    const raw = await runGogJson<any>([
      '--account',
      account,
      '--json',
      '--results-only',
      'gmail',
      'search',
      '--max',
      String(max),
      '--no-input',
      // End-of-flags separator so queries starting with "-" (e.g. -in:trash,
      // -label:foo) aren't misparsed by the CLI as flags.
      '--',
      query,
    ]);
    const list = coerceList(raw);
    const items: (Partial<Thread> & { _id: string })[] = [];
    for (const it of list) {
      const norm = normalizeGogSearchItem(it, account);
      if (!norm._id) continue;
      items.push(norm);
      await upsertThread(account, norm).catch(() => undefined);
    }
    return { account, query, items };
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
  }),
  async handler({ account, threadId, refresh }) {
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
      messages = arr.map((m) => normalizeGogMessage(m, account));
      for (const m of messages) await upsertMessageRecord(m).catch(() => undefined);
    }
    return {
      account,
      threadId,
      subject: messages[0]?.subject || '(no subject)',
      messages,
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

function coerceList(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.messages)) return raw.messages;
  if (Array.isArray(raw?.threads)) return raw.threads;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.labels)) return raw.labels;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}
