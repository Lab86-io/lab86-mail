import type { CreateAttachmentRequest } from 'nylas';
import { assertOutboundSendEnabled } from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { maybeKickCorpusBackfill } from '@/lib/mail/corpus-sync';
import {
  fallbackTierForProvider,
  isLocalPageToken,
  LOCAL_PAGE_TOKEN_PREFIX,
  resolveSearchRoute,
} from '@/lib/mail/search/capabilities';
import {
  buildNativeSearchPlan,
  compileQueryToNylasStructuredParams,
  UNRESOLVED_FOLDER_PARAM,
} from '@/lib/mail/search/compiler';
import { folderRowMatches } from '@/lib/mail/search/folders';
import {
  type CorpusMessageDocument,
  compileAstToLocalCorpusQuery,
  corpusMessagesToThreads,
  filterCorpusMessagesByAst,
} from '@/lib/mail/search/local';
import { parseMailSearchQuery } from '@/lib/mail/search/parser';
import { rerankMail } from '../jev/search';
import { matchingMailExcerpt } from '../mail/search/ranking';
import { requireNylas } from './client';
import {
  emailList,
  normalizeNylasAccount,
  normalizeNylasFolder,
  normalizeNylasMessage,
  normalizeNylasThread,
} from './normalize';
import { RATE_LIMIT_MAX_DELAY_MS, retryAfterMs } from './retry';

const mailCorpusApi = (api as any).mailCorpus;

export interface NylasAccountRow {
  userId: string;
  accountId: string;
  email: string;
  provider: 'google' | 'microsoft' | 'icloud' | 'imap';
  status: string;
  displayName?: string;
  grantId: string;
  scopes: string[];
  // The reconnect reason when status is `error` (see grant-health.ts).
  error?: string;
}

interface UpdateNylasMessageFoldersArgs {
  userId?: string | null;
  account: string;
  messageId: string;
  add?: string[];
  remove?: string[];
  createMissing?: boolean;
}

interface UpdateNylasThreadFoldersArgs {
  userId?: string | null;
  account: string;
  threadId: string;
  add?: string[];
  remove?: string[];
  createMissing?: boolean;
}

export async function listNylasAccounts(userId?: string | null) {
  if (!userId) return [];
  const rows = await convexQuery<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId });
  return rows.filter((row) => row.status === 'connected').map(normalizeNylasAccount);
}

export async function getNylasAccount(userId: string | null | undefined, accountId: string) {
  if (!userId) throw new Error('Sign in required for hosted mail access.');
  const row = await convexQuery<NylasAccountRow | null>(api.accounts.getConnectedAccount, {
    userId,
    accountId,
  });
  if (row) return row.status === 'connected' ? row : null;
  // The AI (and humans) routinely refer to an account by email or grant id
  // rather than the internal accountId — an exact-id-only lookup is the main
  // source of "Connected account not found" / "no grant" flakiness. Fall
  // back to a flexible match across the user's accounts.
  const resolved = await resolveConnectedAccount(userId, accountId);
  return resolved?.status === 'connected' ? resolved : null;
}

// Resolve a loose account reference (accountId | grantId | email,
// case-insensitive) to a connected-account row, or null. Returns the row
// even when disconnected so callers can give a precise "reconnect" message.
export async function resolveConnectedAccount(userId: string, ref: string): Promise<NylasAccountRow | null> {
  const needle = (ref || '').trim().toLowerCase();
  if (!needle) return null;
  const accounts = await convexQuery<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId });
  return (
    (accounts || []).find(
      (account) =>
        account.accountId === ref || account.grantId === ref || account.email?.toLowerCase() === needle,
    ) || null
  );
}

// Connected-or-throw with an actionable message that names the live accounts
// or tells the user exactly which one to reconnect.
export async function requireConnectedAccount(userId: string, ref: string): Promise<NylasAccountRow> {
  const accounts = await convexQuery<NylasAccountRow[]>(api.accounts.listConnectedAccounts, { userId });
  const list = accounts || [];
  const needle = (ref || '').trim().toLowerCase();
  const match = list.find(
    (account) =>
      account.accountId === ref || account.grantId === ref || account.email?.toLowerCase() === needle,
  );
  if (match && match.status === 'connected') return match;
  if (match) {
    throw new Error(
      `The account ${match.email || ref} is disconnected — reconnect it in Settings to use it again.`,
    );
  }
  const connected = list.filter((a) => a.status === 'connected').map((a) => a.email);
  throw new Error(
    connected.length
      ? `No account matches "${ref}". Connected accounts: ${connected.join(', ')}.`
      : 'No connected accounts. Connect one in Settings first.',
  );
}

export interface SearchNylasThreadsResult {
  account: string;
  query: string;
  items: any[];
  nextPageToken?: string;
  searchTier: 'local' | 'structured' | 'native';
  route: ReturnType<typeof resolveSearchRoute>;
  ast?: unknown;
  dropped?: unknown[];
  fallbackReason?: string;
}

export async function searchNylasThreads({
  userId,
  account,
  query,
  max,
  pageToken,
}: {
  userId?: string | null;
  account: string;
  query: string;
  max: number;
  pageToken?: string;
}): Promise<SearchNylasThreadsResult | null> {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const bounds = localQueryBounds(query);
  const route = await resolveAccountSearchRoute(row, pageToken, bounds).catch(() =>
    resolveSearchRoute({ provider: row.provider, corpusReady: false, pageToken }),
  );
  if (route.localEnabled && !route.corpusReady) {
    // Self-heal: accounts connected before corpus sync existed never get a
    // backfill kick from the OAuth callback, so the search path requests one.
    maybeKickCorpusBackfill(row);
  }
  if (route.tier === 'local') {
    try {
      const local = await searchLocalCorpusThreads({ row, query, max, pageToken });
      return {
        account: row.accountId,
        query,
        items: local.items,
        nextPageToken: local.nextPageToken,
        searchTier: 'local',
        route,
        ast: local.ast,
        dropped: local.dropped,
      };
    } catch (err: any) {
      const fallback = await searchNylasProviderThreads({
        row,
        query,
        max,
        pageToken: isLocalPageToken(pageToken) ? undefined : pageToken,
      });
      return {
        ...fallback,
        route: {
          ...route,
          tier: fallback.searchTier,
          reason: 'local search failed; provider fallback used',
        },
        fallbackReason: err?.message || 'local search failed',
      };
    }
  }
  // Local cursors are meaningless to provider transports: if routing landed on
  // a fallback tier (local disabled, corpus regressed), restart provider
  // pagination instead of sending Nylas a "local:" token.
  return {
    ...(await searchNylasProviderThreads({
      row,
      query,
      max,
      pageToken: isLocalPageToken(pageToken) ? undefined : pageToken,
    })),
    route,
  };
}

async function resolveAccountSearchRoute(
  row: NylasAccountRow,
  pageToken?: string,
  bounds: { queryAfter?: number; hasTextQuery?: boolean } = {},
) {
  const syncState = await convexQuery<any | null>(mailCorpusApi.getSyncState, {
    userId: row.userId,
    accountId: row.accountId,
  });
  const grantMatches = syncState?.grantId === row.grantId;
  return resolveSearchRoute({
    provider: row.provider,
    corpusReady: Boolean(syncState?.corpusReady && grantMatches),
    oldestIndexedAt:
      grantMatches && typeof syncState?.oldestIndexedAt === 'number' ? syncState.oldestIndexedAt : null,
    queryAfter: bounds.queryAfter,
    hasTextQuery: bounds.hasTextQuery,
    pageToken,
  });
}

// Lower date bound and text-ness of the query, used to decide whether a
// partially-backfilled corpus can serve it.
function localQueryBounds(query: string): { queryAfter?: number; hasTextQuery?: boolean } {
  try {
    const plan = compileAstToLocalCorpusQuery(parseMailSearchQuery(query));
    return { queryAfter: plan.after, hasTextQuery: Boolean(plan.query) };
  } catch {
    return {};
  }
}

async function searchLocalCorpusThreads({
  row,
  query,
  max,
  pageToken,
}: {
  row: NylasAccountRow;
  query: string;
  max: number;
  pageToken?: string;
}) {
  const ast = parseMailSearchQuery(query);
  const plan = compileAstToLocalCorpusQuery(ast);
  if (plan.query) {
    const prefix = `${LOCAL_PAGE_TOKEN_PREFIX}relevant:`;
    let cursor: string | undefined;
    let offset = 0;
    let rankOffset = 0;
    if (pageToken?.startsWith(prefix)) {
      const decoded = JSON.parse(Buffer.from(pageToken.slice(prefix.length), 'base64url').toString());
      if (
        decoded.query !== query ||
        decoded.account !== row.accountId ||
        !Number.isInteger(decoded.offset) ||
        decoded.offset < 0
      )
        throw new Error('Invalid search cursor.');
      cursor = typeof decoded.cursor === 'string' ? decoded.cursor : undefined;
      offset = decoded.offset;
      rankOffset =
        Number.isSafeInteger(decoded.rankOffset) && decoded.rankOffset >= 0 ? decoded.rankOffset : 0;
    }
    const startCursor = cursor;
    const collected: CorpusMessageDocument[] = [];
    const target = Math.max(80, Math.min(240, max * 4));
    for (let window = 0; window < 8; window++) {
      const page = await convexQuery<{ items: CorpusMessageDocument[]; nextCursor?: string }>(
        mailCorpusApi.searchCorpusMessagesPage,
        {
          userId: row.userId,
          accountId: row.accountId,
          query: plan.query,
          after: plan.after,
          before: plan.before,
          cursor,
          limit: target,
        },
      );
      collected.push(
        ...filterCorpusMessagesByAst(page.items, ast).map((message) => ({
          ...message,
          snippet: matchingMailExcerpt(message.textBody || message.snippet, plan.query),
        })),
      );
      cursor = page.nextCursor;
      if (!cursor || collected.length >= target) break;
    }
    const grouped = corpusMessagesToThreads(collected, row.accountId, 'relevant').map((thread) => ({
      ...thread,
      searchRank: (thread.searchRank || 0) + rankOffset,
    }));
    const stored = await convexQuery<any[]>((api as any).jev.threadAssessments, {
      userId: row.userId,
      threads: grouped.slice(0, 300).map((thread) => ({ accountId: row.accountId, threadId: thread._id })),
    }).catch(() => []);
    const byId = new Map(stored.map((thread) => [thread._id, thread]));
    const ranked = await rerankMail(
      row.userId,
      query,
      grouped.map((thread) => ({
        ...thread,
        jev: byId.get(thread._id)?.jev,
        smartCategory: byId.get(thread._id)?.smartCategory,
      })),
    );
    const items = ranked.slice(offset, offset + max);
    const moreInBlock = offset + max < ranked.length;
    const next = moreInBlock
      ? { cursor: startCursor, offset: offset + max, rankOffset }
      : cursor
        ? { cursor, offset: 0, rankOffset: rankOffset + collected.length }
        : null;
    return {
      ast,
      dropped: plan.dropped,
      items,
      nextPageToken: next
        ? prefix +
          Buffer.from(JSON.stringify({ ...next, query, account: row.accountId })).toString('base64url')
        : undefined,
    };
  }
  const cursorBefore = localPageTokenBefore(pageToken);
  let scanBefore =
    cursorBefore !== null && plan.before !== undefined
      ? Math.min(cursorBefore, plan.before)
      : (cursorBefore ?? plan.before);
  const fetchLimit = Math.min(100, Math.max(max * 4, max));
  // Selective in-memory filters (folder, unread, ...) can match nothing inside
  // a single recency window even though older matches exist, so browse-style
  // queries keep advancing the cursor through additional windows instead of
  // stopping after the first one.
  const maxWindows = plan.query ? 1 : 5;
  const collected: CorpusMessageDocument[] = [];
  let lastWindowFull = false;
  for (let window = 0; window < maxWindows; window += 1) {
    const rows = await convexQuery<CorpusMessageDocument[]>(mailCorpusApi.searchCorpusMessages, {
      userId: row.userId,
      accountId: row.accountId,
      provider: row.provider,
      query: plan.query,
      after: plan.after,
      before: scanBefore,
      limit: fetchLimit,
    });
    collected.push(...filterCorpusMessagesByAst(rows, ast));
    lastWindowFull = rows.length >= fetchLimit;
    if (!lastWindowFull) break;
    scanBefore = Math.min(...rows.map((message) => message.receivedAt)) - 1;
    if (collected.length >= max) break;
  }
  // Cursor paging only applies to browse-style queries; text searches are
  // relevance-windowed by the Convex search index and do not page. Group ALL
  // collected messages into threads first, then derive the cursor from the
  // oldest thread actually included — threads trimmed by the per-page cap
  // must reappear on the next page, never be skipped.
  const threads = corpusMessagesToThreads(collected, row.accountId);
  const items = threads.slice(0, max);
  const trimmedThreads = threads.length > items.length;
  const oldestIncluded = items.length ? Number(items[items.length - 1].lastDate) : null;
  const nextPageToken =
    !plan.query && (trimmedThreads || lastWindowFull)
      ? `${LOCAL_PAGE_TOKEN_PREFIX}${
          trimmedThreads && oldestIncluded !== null ? oldestIncluded - 1 : scanBefore
        }`
      : undefined;
  return {
    ast,
    dropped: plan.dropped,
    items,
    nextPageToken,
  };
}

function localPageTokenBefore(pageToken?: string) {
  if (!pageToken || !isLocalPageToken(pageToken)) return null;
  const value = Number(pageToken.slice(LOCAL_PAGE_TOKEN_PREFIX.length));
  return Number.isFinite(value) ? value : null;
}

async function searchNylasProviderThreads({
  row,
  query,
  max,
  pageToken,
}: {
  row: NylasAccountRow;
  query: string;
  max: number;
  pageToken?: string;
}) {
  if (fallbackTierForProvider(row.provider) === 'native') {
    const plan = buildNativeSearchPlan({ provider: row.provider, query, max, pageToken });
    const page = await requireNylas().threads.list({
      identifier: row.grantId,
      queryParams: plan.queryParams as any,
    });
    const items = page.data.map((thread) => normalizeNylasThread(thread, row.accountId));
    return {
      account: row.accountId,
      query,
      items,
      nextPageToken: page.nextCursor,
      searchTier: 'native' as const,
      dropped: [] as unknown[],
    };
  }

  const plan = compileQueryToNylasStructuredParams({ provider: row.provider, query, max, pageToken });
  const queryParams: Record<string, unknown> = { ...plan.queryParams };
  const unresolvedFolder = queryParams[UNRESOLVED_FOLDER_PARAM] as string | undefined;
  delete queryParams[UNRESOLVED_FOLDER_PARAM];
  if (unresolvedFolder) {
    const folderId = await resolveProviderFolderId(row, unresolvedFolder).catch(() => null);
    if (folderId) {
      queryParams.in = folderId;
    } else {
      plan.dropped.push({
        clause: { type: 'folder', value: unresolvedFolder },
        reason: 'folder not found on provider; results are unscoped',
      });
    }
  }
  const page = await requireNylas().threads.list({
    identifier: row.grantId,
    queryParams: queryParams as any,
  });
  const items = page.data.map((thread) => normalizeNylasThread(thread, row.accountId));
  return {
    account: row.accountId,
    query,
    items,
    nextPageToken: page.nextCursor,
    searchTier: 'structured' as const,
    dropped: plan.dropped,
  };
}

const providerFolderCache = new Map<string, { at: number; rows: ProviderFolderRow[] }>();
const PROVIDER_FOLDER_CACHE_TTL_MS = 10 * 60_000;
// Bound the cache so a long-lived process serving many grants cannot grow it
// without limit; Map iteration order gives us oldest-inserted eviction.
const PROVIDER_FOLDER_CACHE_MAX_ENTRIES = 500;

interface ProviderFolderRow {
  id: string;
  name: string;
  attributes?: string[];
}

async function resolveProviderFolderId(row: NylasAccountRow, canonicalFolder: string) {
  const cached = providerFolderCache.get(row.grantId);
  let rows = cached && Date.now() - cached.at < PROVIDER_FOLDER_CACHE_TTL_MS ? cached.rows : null;
  if (!rows) {
    const page = await requireNylas().folders.list({
      identifier: row.grantId,
      queryParams: { limit: 200 },
    });
    rows = page.data.map((folder: any) => ({
      id: String(folder.id),
      name: String(folder.name || ''),
      attributes: Array.isArray(folder.attributes) ? folder.attributes.map(String) : undefined,
    }));
    if (
      !providerFolderCache.has(row.grantId) &&
      providerFolderCache.size >= PROVIDER_FOLDER_CACHE_MAX_ENTRIES
    ) {
      const oldest = providerFolderCache.keys().next().value;
      if (oldest !== undefined) providerFolderCache.delete(oldest);
    }
    providerFolderCache.set(row.grantId, { at: Date.now(), rows });
  }
  return rows.find((folder) => folderRowMatches(canonicalFolder, folder))?.id ?? null;
}

export function buildNylasStructuredSearchQueryParams({
  query,
  max,
  pageToken,
  provider = 'google',
}: {
  query: string;
  max: number;
  pageToken?: string;
  provider?: NylasAccountRow['provider'];
}) {
  return compileQueryToNylasStructuredParams({ provider, query, max, pageToken }).queryParams;
}

export async function getNylasThread({
  userId,
  account,
  threadId,
}: {
  userId?: string | null;
  account: string;
  threadId: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const messagesPage = await requireNylas().messages.list({
    identifier: row.grantId,
    queryParams: { threadId, limit: 200 },
  });
  const messages = (await messagesPage).data
    .map((message) => normalizeNylasMessage(message, row.accountId))
    .sort((a, b) => Number(a.date || 0) - Number(b.date || 0));
  return {
    account: row.accountId,
    threadId,
    subject: messages[0]?.subject || '(no subject)',
    messages,
  };
}

export async function getNylasMessage({
  userId,
  account,
  id,
}: {
  userId?: string | null;
  account: string;
  id: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await requireNylas().messages.find({ identifier: row.grantId, messageId: id });
  return normalizeNylasMessage(result.data, row.accountId);
}

/**
 * The headers of one message, lowercased. Webhook payloads and list pages do
 * not carry headers, so unsubscribe reads them once for the message it needs.
 */
export async function getNylasMessageHeaders({
  userId,
  account,
  messageId,
}: {
  userId?: string | null;
  account: string;
  messageId: string;
}): Promise<Record<string, string> | null> {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await withNylasRetry(() =>
    requireNylas().messages.find({
      identifier: row.grantId,
      messageId,
      queryParams: { fields: 'include_headers' as any },
    }),
  );
  const headers: Record<string, string> = {};
  for (const header of (result.data as any)?.headers || []) {
    if (header?.name && typeof header.value === 'string')
      headers[String(header.name).toLowerCase()] = header.value;
  }
  return headers;
}

export async function listNylasLabels(userId: string | null | undefined, account: string) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await requireNylas().folders.list({ identifier: row.grantId, queryParams: { limit: 200 } });
  return { labels: (await result).data.map(normalizeNylasFolder) };
}

export async function createNylasFolder({
  userId,
  account,
  name,
}: {
  userId?: string | null;
  account: string;
  name: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const existing = await findNylasFolder(row.grantId, name);
  if (existing) return normalizeNylasFolder(existing);
  const result = await withNylasRetry(
    () =>
      requireNylas().folders.create({
        identifier: row.grantId,
        requestBody: { name },
      }),
    { shouldRetry: isNylasRateLimitError },
  ).catch(async (err) => {
    if (!isNylasConflictError(err)) throw err;
    const created = await findNylasFolder(row.grantId, name);
    if (created) return { data: created };
    throw err;
  });
  return normalizeNylasFolder(result.data);
}

export async function updateNylasThread({
  userId,
  account,
  threadId,
  unread,
  starred,
  folders,
}: {
  userId?: string | null;
  account: string;
  threadId: string;
  unread?: boolean;
  starred?: boolean;
  folders?: string[];
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  await requireNylas().threads.update({
    identifier: row.grantId,
    threadId,
    requestBody: { unread, starred, folders },
  });
  return { ok: true };
}

export type MailboxMove = 'archive' | 'trash' | 'inbox';

type FolderResolver = (canonicalFolder: string) => Promise<string | null>;

/**
 * Folder ids after a move (MUT-2). Gmail folders are labels, so a move edits
 * only INBOX and TRASH and keeps every other label and category. Microsoft,
 * iCloud, and IMAP keep a message in exactly one folder, with opaque ids, so a
 * move sets the one resolved folder: Archive, Trash (Deleted Items), or Inbox.
 */
export async function folderIdsAfterMove(
  provider: NylasAccountRow['provider'],
  current: string[],
  to: MailboxMove,
  resolve: FolderResolver,
): Promise<string[]> {
  if (provider === 'google') {
    const inbox = (await resolve('INBOX')) || 'INBOX';
    const trash = (await resolve('TRASH')) || 'TRASH';
    const kept = [...new Set(current.filter(Boolean))].filter((id) => id !== inbox && id !== trash);
    if (to === 'archive') return kept;
    if (to === 'trash') return [...kept, trash];
    return [...kept, inbox];
  }
  const canonical = to === 'archive' ? 'ARCHIVE' : to === 'trash' ? 'TRASH' : 'INBOX';
  const target = await resolve(canonical);
  if (!target) {
    const name = to === 'archive' ? 'Archive' : to === 'trash' ? 'Trash' : 'Inbox';
    throw new Error(`This mailbox has no ${name} folder, so the message was not moved.`);
  }
  return [target];
}

/**
 * The folder ids before and after one change. Undo (lib/mail/mail-operations)
 * keeps both, so it can take back exactly this change later.
 */
export interface FolderChange {
  ok: true;
  before: string[];
  after: string[];
}

function folderChange(before: string[], after: string[]): FolderChange {
  return { ok: true, before: [...before], after: [...after] };
}

/**
 * The folders after one recorded change is taken back. Gmail labels stack, so
 * undo removes only what the change added and adds back only what it removed;
 * labels the user changed later stay. Other providers keep a message in one
 * folder, so undo puts it back in the folder it left (the Inbox first).
 */
export function revertedFolderIds(
  provider: NylasAccountRow['provider'],
  current: string[],
  change: { before: string[]; after: string[] },
  inboxId?: string | null,
): string[] {
  const added = change.after.filter((id) => !change.before.includes(id));
  const removed = change.before.filter((id) => !change.after.includes(id));
  if (provider === 'google') {
    const next = [...new Set(current.filter(Boolean))].filter((id) => !added.includes(id));
    for (const id of removed) if (!next.includes(id)) next.push(id);
    return next;
  }
  if (!removed.length) return current.filter((id) => !added.includes(id));
  const target = (inboxId && removed.includes(inboxId) ? inboxId : removed[0]) as string;
  return [target];
}

/** Take back one recorded thread folder change (archive, trash, label, mute). */
export async function revertNylasThreadFolders({
  userId,
  account,
  threadId,
  before,
  after,
}: {
  userId?: string | null;
  account: string;
  threadId: string;
  before: string[];
  after: string[];
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const current = await withNylasRetry(() =>
    requireNylas().threads.find({ identifier: row.grantId, threadId }),
  );
  const now = current.data.folders || [];
  const inboxId = row.provider === 'google' ? 'INBOX' : await resolveProviderFolderId(row, 'INBOX');
  const folders = revertedFolderIds(row.provider, now, { before, after }, inboxId);
  await withNylasRetry(() =>
    requireNylas().threads.update({ identifier: row.grantId, threadId, requestBody: { folders } }),
  );
  return folderChange(now, folders);
}

/** Take back one recorded message folder change (a label added or removed). */
export async function revertNylasMessageFolders({
  userId,
  account,
  messageId,
  before,
  after,
}: {
  userId?: string | null;
  account: string;
  messageId: string;
  before: string[];
  after: string[];
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const current = await withNylasRetry(() =>
    requireNylas().messages.find({ identifier: row.grantId, messageId }),
  );
  const now = current.data.folders || [];
  const inboxId = row.provider === 'google' ? 'INBOX' : await resolveProviderFolderId(row, 'INBOX');
  const folders = revertedFolderIds(row.provider, now, { before, after }, inboxId);
  await withNylasRetry(() =>
    requireNylas().messages.update({ identifier: row.grantId, messageId, requestBody: { folders } }),
  );
  return folderChange(now, folders);
}

/** Move a whole thread to Archive, Trash, or the Inbox for any provider. */
export async function moveNylasThread({
  userId,
  account,
  threadId,
  to,
}: {
  userId?: string | null;
  account: string;
  threadId: string;
  to: MailboxMove;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const current = await withNylasRetry(() =>
    requireNylas().threads.find({ identifier: row.grantId, threadId }),
  );
  const before = current.data.folders || [];
  const folders = await folderIdsAfterMove(row.provider, before, to, (folder) =>
    resolveProviderFolderId(row, folder),
  );
  await withNylasRetry(() =>
    requireNylas().threads.update({ identifier: row.grantId, threadId, requestBody: { folders } }),
  );
  return folderChange(before, folders);
}

/** Move one message to Archive, Trash, or the Inbox for any provider. */
export async function moveNylasMessage({
  userId,
  account,
  messageId,
  to,
}: {
  userId?: string | null;
  account: string;
  messageId: string;
  to: MailboxMove;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const current = await withNylasRetry(() =>
    requireNylas().messages.find({ identifier: row.grantId, messageId }),
  );
  const before = current.data.folders || [];
  const folders = await folderIdsAfterMove(row.provider, before, to, (folder) =>
    resolveProviderFolderId(row, folder),
  );
  await withNylasRetry(() =>
    requireNylas().messages.update({ identifier: row.grantId, messageId, requestBody: { folders } }),
  );
  return folderChange(before, folders);
}

export async function updateNylasMessage({
  userId,
  account,
  messageId,
  unread,
  starred,
  folders,
}: {
  userId?: string | null;
  account: string;
  messageId: string;
  unread?: boolean;
  starred?: boolean;
  folders?: string[];
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  await requireNylas().messages.update({
    identifier: row.grantId,
    messageId,
    requestBody: { unread, starred, folders },
  });
  return { ok: true };
}

export async function updateNylasMessageFolders({
  userId,
  account,
  messageId,
  add = [],
  remove = [],
  createMissing = false,
}: UpdateNylasMessageFoldersArgs) {
  return await updateNylasMessageFoldersInternal({
    userId,
    account,
    messageId,
    add,
    remove,
    createMissing,
    retryRequests: true,
  });
}

async function updateNylasMessageFoldersInternal({
  userId,
  account,
  messageId,
  add = [],
  remove = [],
  createMissing = false,
  retryRequests,
}: UpdateNylasMessageFoldersArgs & { retryRequests: boolean }) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const current = await runMaybeRetried(
    () => requireNylas().messages.find({ identifier: row.grantId, messageId }),
    retryRequests,
  );
  const before = current.data.folders || [];
  const folders = await applyFolderDelta(row.grantId, before, {
    add,
    remove,
    createMissing,
  });
  await runMaybeRetried(
    () =>
      requireNylas().messages.update({
        identifier: row.grantId,
        messageId,
        requestBody: { folders },
      }),
    retryRequests,
  );
  return folderChange(before, folders);
}

export async function updateNylasMessageFoldersWithRetry({
  userId,
  account,
  messageId,
  add = [],
  remove = [],
  createMissing = false,
  retries = 4,
}: UpdateNylasMessageFoldersArgs & { retries?: number }) {
  return await withNylasRetry(
    () =>
      updateNylasMessageFoldersInternal({
        userId,
        account,
        messageId,
        add,
        remove,
        createMissing,
        retryRequests: false,
      }),
    { retries },
  );
}

export async function updateNylasThreadFoldersWithRetry({
  userId,
  account,
  threadId,
  add = [],
  remove = [],
  createMissing = false,
  retries = 4,
}: UpdateNylasThreadFoldersArgs & { retries?: number }) {
  return await withNylasRetry(
    () =>
      updateNylasThreadFoldersInternal({
        userId,
        account,
        threadId,
        add,
        remove,
        createMissing,
        retryRequests: false,
      }),
    { retries },
  );
}

export async function updateNylasThreadFolders({
  userId,
  account,
  threadId,
  add = [],
  remove = [],
  createMissing = false,
}: UpdateNylasThreadFoldersArgs) {
  return await updateNylasThreadFoldersInternal({
    userId,
    account,
    threadId,
    add,
    remove,
    createMissing,
    retryRequests: true,
  });
}

async function updateNylasThreadFoldersInternal({
  userId,
  account,
  threadId,
  add = [],
  remove = [],
  createMissing = false,
  retryRequests,
}: UpdateNylasThreadFoldersArgs & { retryRequests: boolean }) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const current = await runMaybeRetried(
    () => requireNylas().threads.find({ identifier: row.grantId, threadId }),
    retryRequests,
  );
  const before = current.data.folders || [];
  const folders = await applyFolderDelta(row.grantId, before, {
    add,
    remove,
    createMissing,
  });
  await runMaybeRetried(
    () =>
      requireNylas().threads.update({
        identifier: row.grantId,
        threadId,
        requestBody: { folders },
      }),
    retryRequests,
  );
  return folderChange(before, folders);
}

export async function sendNylasMessage({
  userId,
  account,
  to,
  cc,
  bcc,
  subject,
  body,
  html,
  replyToMessageId,
  sendAt,
  useDraft,
  attachments,
}: {
  userId?: string | null;
  account: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
  replyToMessageId?: string;
  sendAt?: number;
  useDraft?: boolean;
  attachments?: CreateAttachmentRequest[];
}) {
  assertOutboundSendEnabled();
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  // Nylas rejects send_at values that are not in the future AT VALIDATION
  // TIME ("provided send_at field is less than current epoch time"). Short
  // undo windows plus request/upload latency made stale timestamps common, so
  // clamp to a small floor at dispatch: the send goes out a few seconds late
  // in the worst case instead of failing outright.
  const SEND_AT_FLOOR_SECONDS = 10;
  const sendAtSeconds = sendAt
    ? Math.max(Math.floor(sendAt / 1000), Math.floor(Date.now() / 1000) + SEND_AT_FLOOR_SECONDS)
    : undefined;
  const result = await requireNylas().messages.send({
    identifier: row.grantId,
    requestBody: {
      to: emailList(to),
      cc: emailList(cc),
      bcc: emailList(bcc),
      subject,
      body: html || body,
      isPlaintext: !html,
      replyToMessageId,
      sendAt: sendAtSeconds,
      useDraft,
      attachments,
    },
  });
  const normalized = normalizeNylasMessage(result.data, row.accountId);
  // Scheduled sends come back with a schedule id used to cancel them later.
  const scheduleId = (result.data as any)?.scheduleId ?? (result.data as any)?.schedule_id;
  if (scheduleId !== undefined) (normalized as any).scheduleId = String(scheduleId);
  return normalized;
}

export async function listNylasScheduledMessages({
  userId,
  account,
}: {
  userId?: string | null;
  account: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await requireNylas().messages.listScheduledMessages({ identifier: row.grantId });
  return result.data;
}

// Real status of one provider-side scheduled send (the undo-window path).
// Nylas status codes: pending → close_to_send_time → sucess/success | failed | cancelled.
export async function getNylasScheduledSendStatus({
  userId,
  account,
  scheduleId,
}: {
  userId?: string | null;
  account: string;
  scheduleId: string;
}): Promise<'pending' | 'sent' | 'failed' | 'cancelled' | null> {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await requireNylas().messages.findScheduledMessage({
    identifier: row.grantId,
    scheduleId,
  });
  const code = String(result.data?.status?.code || '').toLowerCase();
  if (/succ?ess/.test(code)) return 'sent';
  if (/fail|error/.test(code)) return 'failed';
  if (/cancel/.test(code)) return 'cancelled';
  return 'pending';
}

export async function stopNylasScheduledMessage({
  userId,
  account,
  scheduleId,
}: {
  userId?: string | null;
  account: string;
  scheduleId: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  const result = await requireNylas().messages.stopScheduledMessage({
    identifier: row.grantId,
    scheduleId,
  });
  return result.data;
}

export async function downloadNylasAttachment({
  userId,
  account,
  messageId,
  attachmentId,
}: {
  userId?: string | null;
  account: string;
  messageId: string;
  attachmentId: string;
}) {
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
  return await requireNylas().attachments.download({
    identifier: row.grantId,
    attachmentId,
    queryParams: { messageId },
  });
}

export async function deleteNylasAccount(userId: string, accountId: string, grantId?: string) {
  // Convex first: if this throws, the account survives WITH a live grant.
  // (Destroying the grant first is how failed deletes used to strand
  // connected-looking accounts whose provider grant was already burned.)
  await convexMutation(api.accounts.deleteConnectedAccount, { userId, accountId });
  if (grantId) {
    await requireNylas()
      .grants.destroy({ grantId })
      .catch(() => undefined);
  }
  return { ok: true };
}

async function applyFolderDelta(
  grantId: string,
  currentFolders: string[],
  {
    add,
    remove,
    createMissing,
  }: {
    add: string[];
    remove: string[];
    createMissing: boolean;
  },
) {
  const folders = [...new Set(currentFolders.filter(Boolean))];
  const removeIds = new Set<string>();
  for (const label of remove.map((value) => value.trim()).filter(Boolean)) {
    removeIds.add(label);
    const existing = await findNylasFolder(grantId, label);
    if (existing?.id) removeIds.add(existing.id);
  }

  const next = folders.filter((folder) => !removeIds.has(folder));
  for (const label of add.map((value) => value.trim()).filter(Boolean)) {
    const folderId = await resolveNylasFolderId(grantId, label, createMissing);
    if (folderId && !next.includes(folderId)) next.push(folderId);
  }
  return next;
}

async function resolveNylasFolderId(grantId: string, label: string, createMissing: boolean) {
  const existing = await findNylasFolder(grantId, label);
  if (existing?.id) return existing.id;
  if (!createMissing || isSystemFolderId(label)) return label;
  const created = await withNylasRetry(
    () =>
      requireNylas().folders.create({
        identifier: grantId,
        requestBody: { name: label },
      }),
    { shouldRetry: isNylasRateLimitError },
  ).catch(async (err) => {
    if (!isNylasConflictError(err)) throw err;
    const existingAfterConflict = await findNylasFolder(grantId, label);
    if (existingAfterConflict) return { data: existingAfterConflict };
    throw err;
  });
  return created.data.id;
}

async function findNylasFolder(grantId: string, label: string) {
  const normalized = label.toLowerCase();
  const result = await requireNylas().folders.list({ identifier: grantId, queryParams: { limit: 200 } });
  return (await result).data.find(
    (folder) => folder.id === label || folder.name === label || folder.name?.toLowerCase() === normalized,
  );
}

async function runMaybeRetried<T>(operation: () => Promise<T>, retryRequests: boolean) {
  return retryRequests ? await withNylasRetry(operation) : await operation();
}

function isSystemFolderId(label: string) {
  return SYSTEM_FOLDER_IDS.has(label.toUpperCase());
}

async function withNylasRetry<T>(
  operation: () => Promise<T>,
  {
    retries = 3,
    baseDelayMs = 800,
    shouldRetry = isNylasRetryableError,
  }: { retries?: number; baseDelayMs?: number; shouldRetry?: (err: unknown) => boolean } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err) || attempt === retries) break;
      await sleep(Math.min(RATE_LIMIT_MAX_DELAY_MS, retryAfterMs(err) ?? baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}

function isNylasRetryableError(err: unknown) {
  return isNylasRateLimitError(err) || isNylasConflictError(err);
}

function isNylasRateLimitError(err: unknown) {
  return nylasStatus(err) === 429 || /too many requests|rate/i.test(nylasErrorText(err));
}

function isNylasConflictError(err: unknown) {
  return nylasStatus(err) === 409 || /\bconflict\b/i.test(nylasErrorText(err));
}

function nylasStatus(err: unknown) {
  const value = err as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = value?.statusCode ?? value?.status ?? value?.response?.status;
  return typeof status === 'number' ? status : Number(status || 0);
}

function nylasErrorText(err: unknown) {
  const value = err as { message?: unknown; body?: unknown; response?: { data?: unknown } };
  return [value?.message, value?.body, value?.response?.data]
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part || '')))
    .join(' ');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_FOLDER_IDS = new Set([
  'ARCHIVE',
  'DRAFT',
  'DRAFTS',
  'IMPORTANT',
  'INBOX',
  'JUNK',
  'MUTE',
  'SENT',
  'SPAM',
  'STARRED',
  'TRASH',
  'UNREAD',
]);
