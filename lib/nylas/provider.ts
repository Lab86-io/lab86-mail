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
import { requireNylas } from './client';
import {
  emailList,
  normalizeNylasAccount,
  normalizeNylasFolder,
  normalizeNylasMessage,
  normalizeNylasThread,
} from './normalize';

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
  return row?.status === 'connected' ? row : null;
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
  const route = await resolveAccountSearchRoute(row, pageToken).catch(() =>
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

async function resolveAccountSearchRoute(row: NylasAccountRow, pageToken?: string) {
  const syncState = await convexQuery<any | null>(mailCorpusApi.getSyncState, {
    userId: row.userId,
    accountId: row.accountId,
  });
  return resolveSearchRoute({
    provider: row.provider,
    corpusReady: Boolean(syncState?.corpusReady && syncState?.grantId === row.grantId),
    pageToken,
  });
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
  // relevance-windowed by the Convex search index and do not page. The cursor
  // resumes from the oldest RETURNED message so matches are never skipped,
  // even when the next window held zero hits.
  const returned = collected.slice(0, Math.max(max * 2, max));
  const nextPageToken =
    !plan.query && lastWindowFull
      ? `${LOCAL_PAGE_TOKEN_PREFIX}${
          returned.length ? Math.min(...returned.map((message) => message.receivedAt)) - 1 : scanBefore
        }`
      : undefined;
  return {
    ast,
    dropped: plan.dropped,
    items: corpusMessagesToThreads(returned, row.accountId).slice(0, max),
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
  const folders = await applyFolderDelta(row.grantId, current.data.folders || [], {
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
  return { ok: true };
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
  const folders = await applyFolderDelta(row.grantId, current.data.folders || [], {
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
  return { ok: true };
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
  attachments?: CreateAttachmentRequest[];
}) {
  assertOutboundSendEnabled();
  const row = await getNylasAccount(userId, account);
  if (!row) return null;
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
      sendAt: sendAt ? Math.floor(sendAt / 1000) : undefined,
      attachments,
    },
  });
  return normalizeNylasMessage(result.data, row.accountId);
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
  if (grantId) {
    await requireNylas()
      .grants.destroy({ grantId })
      .catch(() => undefined);
  }
  await convexMutation(api.accounts.deleteConnectedAccount, { userId, accountId });
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
      await sleep(baseDelayMs * 2 ** attempt);
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
