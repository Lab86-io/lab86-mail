import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireNylas } from '@/lib/nylas/client';
import { normalizeNylasMessage } from '@/lib/nylas/normalize';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { buildCorpusSearchText, extractNylasWebhookMetadata, type NylasWebhookMetadata } from './corpus';

const mailCorpusApi = (api as any).mailCorpus;
const accountsApi = (api as any).accounts;

export interface CorpusSyncResult {
  ok: true;
  accountId: string;
  grantId: string;
  provider: NylasAccountRow['provider'];
  messages: number;
  threads: number;
  nextPageToken?: string;
  corpusReady: boolean;
}

interface BackfillArgs {
  userId: string;
  accountId: string;
  pageToken?: string;
  limit?: number;
}

interface ReconcileArgs {
  userId: string;
  accountId: string;
  limit?: number;
}

interface CorpusMessageInput {
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  receivedAt: number;
  snippet: string;
  textBody?: string;
  searchText: string;
  labels: string[];
  unread?: boolean;
  starred?: boolean;
  attachments?: unknown[];
  headers?: unknown;
}

interface CorpusThreadInput {
  providerThreadId: string;
  subject: string;
  fromAddress: string;
  lastDate: number;
  snippet: string;
  labels: string[];
  unread: boolean;
  starred?: boolean;
  messageCount?: number;
}

export async function backfillMailCorpusAccount({
  userId,
  accountId,
  pageToken,
  limit = 50,
}: BackfillArgs): Promise<CorpusSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
  const batchLimit = clampLimit(limit, 50, 100);
  await markSync(row, {
    status: 'backfilling',
    cursor: pageToken,
    corpusReady: false,
    progress: { stage: 'fetching', pageToken: pageToken || null, limit: batchLimit },
  });
  try {
    // page_token must be OMITTED when absent: the SDK serializes an explicit
    // undefined as the literal string "undefined", which every provider
    // rejects ("could not decode: undefined" / "Invalid page_token").
    const page = await requireNylas().messages.list({
      identifier: row.grantId,
      queryParams: { limit: batchLimit, ...(pageToken ? { page_token: pageToken } : {}) } as any,
    });
    const messages = page.data.map((message) => corpusMessageFromNylas(row, message));
    const threads = corpusThreadsFromMessages(messages);
    const nextPageToken = page.nextCursor || undefined;
    const corpusReady = !nextPageToken;
    await upsertCorpus(row, {
      threads,
      messages,
      cursor: nextPageToken,
      corpusReady,
      progress: {
        stage: corpusReady ? 'ready' : 'backfilling',
        pageToken: nextPageToken || null,
        lastBatchMessages: messages.length,
      },
    });
    return {
      ok: true,
      accountId: row.accountId,
      grantId: row.grantId,
      provider: row.provider,
      messages: messages.length,
      threads: threads.length,
      nextPageToken,
      corpusReady,
    };
  } catch (err: any) {
    // Provider page cursors expire (deploys interrupt multi-page runs, and a
    // saved cursor can be hours old by the next kick). A dead cursor must be
    // discarded and the run restarted from the top, not replayed forever.
    if (pageToken && isInvalidCursorError(err)) {
      await markSync(row, {
        status: 'backfilling',
        corpusReady: false,
        clearCursor: true,
        progress: { stage: 'cursor_reset', discardedPageToken: pageToken },
      }).catch(() => undefined);
      return await backfillMailCorpusAccount({ userId, accountId, limit });
    }
    await markSync(row, {
      status: 'error',
      cursor: pageToken,
      corpusReady: false,
      error: err?.message || 'corpus backfill failed',
      progress: { stage: 'backfill_error', pageToken: pageToken || null },
    }).catch(() => undefined);
    throw err;
  }
}

function isInvalidCursorError(err: any) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('page_token') ||
    message.includes('page token') ||
    message.includes('bad request') ||
    message.includes('could not decode')
  );
}

// Runs the page loop for one account until the corpus is ready or the page
// budget for this run is spent. Resumes from the stored cursor, so repeated
// kicks make monotonic progress through the mailbox history.
export async function runCorpusBackfill({
  userId,
  accountId,
  maxPages = 40,
  pageLimit = 100,
}: {
  userId: string;
  accountId: string;
  maxPages?: number;
  pageLimit?: number;
}): Promise<CorpusSyncResult> {
  const syncState = await convexQuery<any | null>(mailCorpusApi.getSyncState, { userId, accountId }).catch(
    () => null,
  );
  // Only resume a cursor from an actively-progressing backfill; provider
  // cursors go stale across restarts, and replaying one 400s forever.
  const cursorFresh =
    syncState?.status === 'backfilling' && Date.now() - (Number(syncState?.updatedAt) || 0) < 30 * 60_000;
  let pageToken: string | undefined =
    cursorFresh && !syncState.corpusReady && typeof syncState.cursor === 'string' && syncState.cursor
      ? syncState.cursor
      : undefined;
  let result: CorpusSyncResult | null = null;
  for (let page = 0; page < Math.max(1, maxPages); page += 1) {
    result = await backfillMailCorpusAccount({ userId, accountId, pageToken, limit: pageLimit });
    if (result.corpusReady || !result.nextPageToken) return result;
    pageToken = result.nextPageToken;
  }
  return result as CorpusSyncResult;
}

const backfillKickAt = new Map<string, number>();
const BACKFILL_KICK_DEBOUNCE_MS = 10 * 60_000;
const BACKFILL_ACTIVE_WINDOW_MS = 5 * 60_000;

// Fire-and-forget backfill kick used by the search path and OAuth callback.
// Debounced in-process and skipped while another run is making fresh progress.
export function maybeKickCorpusBackfill(row: Pick<NylasAccountRow, 'userId' | 'accountId'>) {
  const key = `${row.userId}:${row.accountId}`;
  const last = backfillKickAt.get(key) || 0;
  if (Date.now() - last < BACKFILL_KICK_DEBOUNCE_MS) return;
  // Reserve the slot immediately (so concurrent searches don't double-kick),
  // but release it on failure — a crashed kick must not suppress retries for
  // the whole debounce window.
  backfillKickAt.set(key, Date.now());
  void (async () => {
    try {
      const syncState = await convexQuery<any | null>(mailCorpusApi.getSyncState, {
        userId: row.userId,
        accountId: row.accountId,
      });
      if (syncState?.corpusReady) return;
      const updatedAt = Number(syncState?.updatedAt) || 0;
      if (syncState?.status === 'backfilling' && Date.now() - updatedAt < BACKFILL_ACTIVE_WINDOW_MS) return;
      await runCorpusBackfill({ userId: row.userId, accountId: row.accountId });
    } catch (err: any) {
      backfillKickAt.delete(key);
      console.error(`[corpus] background backfill failed for ${row.accountId}:`, err?.message || err);
    }
  })();
}

export async function reconcileMailCorpusAccount({
  userId,
  accountId,
  limit = 50,
}: ReconcileArgs): Promise<CorpusSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
  const prevState = await convexQuery<any | null>(mailCorpusApi.getSyncState, { userId, accountId }).catch(
    () => null,
  );
  const wasReady = Boolean(prevState?.corpusReady);
  const batchLimit = clampLimit(limit, 50, 100);
  await markSync(row, {
    status: 'syncing',
    progress: { stage: 'reconciling', limit: batchLimit },
  });
  try {
    const page = await requireNylas().messages.list({
      identifier: row.grantId,
      queryParams: { limit: batchLimit } as any,
    });
    const messages = page.data.map((message) => corpusMessageFromNylas(row, message));
    const threads = corpusThreadsFromMessages(messages);
    await upsertCorpus(row, {
      threads,
      messages,
      progress: { stage: 'reconciled', lastBatchMessages: messages.length },
      incremental: true,
    });
    // Readiness is earned by a completed backfill only — a 1-page reconcile
    // sample never flips it. Restore whatever status the account was in.
    await markSync(row, {
      status: wasReady ? 'ready' : prevState?.status === 'backfilling' ? 'backfilling' : 'idle',
      progress: { stage: 'reconciled', lastBatchMessages: messages.length },
    });
    return {
      ok: true,
      accountId: row.accountId,
      grantId: row.grantId,
      provider: row.provider,
      messages: messages.length,
      threads: threads.length,
      nextPageToken: undefined,
      corpusReady: wasReady,
    };
  } catch (err: any) {
    // A failed reconcile must not strand the account in "syncing" or revoke
    // readiness the corpus already earned.
    await markSync(row, {
      status: 'error',
      error: err?.message || 'corpus reconcile failed',
      progress: { stage: 'reconcile_error' },
    }).catch(() => undefined);
    throw err;
  }
}

export async function ingestNylasWebhookPayload(payload: unknown) {
  const metadata = extractNylasWebhookMetadata(payload);
  const row = metadata.grantId ? await getConnectedAccountByGrant(metadata.grantId) : null;
  const event = await convexMutation<{ duplicate?: boolean }>(mailCorpusApi.recordWebhookEvent, {
    eventId: metadata.eventId,
    type: metadata.type,
    userId: row?.userId,
    accountId: row?.accountId,
    grantId: metadata.grantId,
    provider: row?.provider,
    payload,
  });
  if (event.duplicate) {
    return { ok: true, duplicate: true, eventId: metadata.eventId };
  }
  if (!metadata.grantId || !row) {
    await markWebhookProcessed(metadata, 'error', 'Webhook did not map to a connected grant.');
    return { ok: false, eventId: metadata.eventId, error: 'unknown grant' };
  }

  try {
    await applyWebhookDelta(row, metadata, payload);
    await markWebhookProcessed(metadata, 'processed');
    await markSync(row, {
      progress: { stage: 'webhook', type: metadata.type, eventId: metadata.eventId },
      lastIncrementalSyncAt: Date.now(),
    });
    return { ok: true, duplicate: false, eventId: metadata.eventId };
  } catch (err: any) {
    await markWebhookProcessed(metadata, 'error', err?.message || 'webhook processing failed');
    // A transient webhook failure must not revoke readiness the corpus earned
    // from a completed backfill; the reconciler repairs any missed delta.
    await markSync(row, {
      error: err?.message || 'webhook processing failed',
      progress: { stage: 'webhook_error', type: metadata.type, eventId: metadata.eventId },
    });
    throw err;
  }
}

async function applyWebhookDelta(row: NylasAccountRow, metadata: NylasWebhookMetadata, payload: unknown) {
  if (metadata.providerMessageId && /message.*deleted|deleted.*message/i.test(metadata.type)) {
    await convexMutation(mailCorpusApi.deleteCorpusMessage, {
      userId: row.userId,
      accountId: row.accountId,
      providerMessageId: metadata.providerMessageId,
    });
    return;
  }
  if (metadata.providerThreadId && /thread.*deleted|deleted.*thread/i.test(metadata.type)) {
    await convexMutation(mailCorpusApi.deleteCorpusThread, {
      userId: row.userId,
      accountId: row.accountId,
      providerThreadId: metadata.providerThreadId,
    });
    return;
  }
  if (!metadata.providerMessageId || !/message/i.test(metadata.type)) return;

  const raw = await requireNylas().messages.find({
    identifier: row.grantId,
    messageId: metadata.providerMessageId,
  });
  const messages = [corpusMessageFromNylas(row, raw.data || payload)];
  await upsertCorpus(row, {
    messages,
    threads: corpusThreadsFromMessages(messages),
    progress: {
      stage: metadata.truncated ? 'webhook_refetch_truncated' : 'webhook_refetch',
      eventId: metadata.eventId,
      type: metadata.type,
    },
    incremental: true,
  });
}

async function getConnectedAccount(userId: string, accountId: string) {
  const row = await convexQuery<NylasAccountRow | null>(accountsApi.getConnectedAccount, {
    userId,
    accountId,
  });
  if (!row || row.status !== 'connected') throw new Error('Connected account not found.');
  return row;
}

async function getConnectedAccountByGrant(grantId: string) {
  const row = await convexQuery<NylasAccountRow | null>(accountsApi.getConnectedAccountByGrant, { grantId });
  return row?.status === 'connected' ? row : null;
}

async function upsertCorpus(
  row: NylasAccountRow,
  input: {
    threads: CorpusThreadInput[];
    messages: CorpusMessageInput[];
    cursor?: string;
    corpusReady?: boolean;
    progress?: unknown;
    incremental?: boolean;
  },
) {
  await convexMutation(mailCorpusApi.upsertCorpusBatch, {
    userId: row.userId,
    accountId: row.accountId,
    grantId: row.grantId,
    provider: row.provider,
    threads: input.threads,
    messages: input.messages,
    cursor: input.cursor,
    corpusReady: input.corpusReady,
    progress: input.progress,
  });
  if (input.incremental) {
    // Incremental writers record freshness only — they never own
    // status/cursor/corpusReady, which belong to the backfill loop.
    await markSync(row, {
      progress: input.progress,
      lastIncrementalSyncAt: Date.now(),
    });
  }
}

async function markSync(
  row: NylasAccountRow,
  patch: {
    status?: 'idle' | 'backfilling' | 'syncing' | 'ready' | 'error';
    cursor?: string;
    corpusReady?: boolean;
    progress?: unknown;
    error?: string;
    clearCursor?: boolean;
    lastIncrementalSyncAt?: number;
  },
) {
  await convexMutation(mailCorpusApi.markSyncState, {
    userId: row.userId,
    accountId: row.accountId,
    grantId: row.grantId,
    provider: row.provider,
    status: patch.status,
    cursor: patch.cursor,
    corpusReady: patch.corpusReady,
    progress: patch.progress,
    error: patch.error,
    clearCursor: patch.clearCursor,
    lastIncrementalSyncAt: patch.lastIncrementalSyncAt,
  });
}

async function markWebhookProcessed(
  metadata: NylasWebhookMetadata,
  status: 'processed' | 'error',
  error?: string,
) {
  await convexMutation(mailCorpusApi.markWebhookEventProcessed, {
    eventId: metadata.eventId,
    status,
    error,
  });
}

function corpusMessageFromNylas(row: NylasAccountRow, raw: any): CorpusMessageInput {
  const normalized = normalizeNylasMessage(raw, row.accountId);
  const labels = normalized.labels || [];
  return {
    providerMessageId: normalized._id,
    providerThreadId: normalized.threadId,
    subject: normalized.subject,
    from: normalized.from,
    to: normalized.to,
    cc: normalized.cc || undefined,
    bcc: normalized.bcc || undefined,
    receivedAt: normalized.date,
    snippet: normalized.snippet,
    textBody: normalized.textBody,
    searchText: buildCorpusSearchText({
      subject: normalized.subject,
      from: normalized.from,
      to: normalized.to,
      cc: normalized.cc,
      bcc: normalized.bcc,
      snippet: normalized.snippet,
      textBody: normalized.textBody,
      labels,
    }),
    labels,
    unread: Boolean(raw?.unread) || labels.includes('UNREAD'),
    starred: Boolean(raw?.starred) || labels.includes('STARRED'),
    attachments: normalized.attachments,
    headers: normalized.headers,
  };
}

function corpusThreadsFromMessages(messages: CorpusMessageInput[]): CorpusThreadInput[] {
  const byThread = new Map<string, CorpusMessageInput[]>();
  for (const message of messages) {
    const group = byThread.get(message.providerThreadId) || [];
    group.push(message);
    byThread.set(message.providerThreadId, group);
  }
  return [...byThread.entries()].map(([providerThreadId, threadMessages]) => {
    const sorted = [...threadMessages].sort((a, b) => b.receivedAt - a.receivedAt);
    const latest = sorted[0];
    const labels = [...new Set(threadMessages.flatMap((message) => message.labels || []))];
    return {
      providerThreadId,
      subject: latest.subject || '(no subject)',
      fromAddress: latest.from || '',
      lastDate: latest.receivedAt,
      snippet: latest.snippet || '',
      labels,
      unread: threadMessages.some((message) => Boolean(message.unread)),
      starred: threadMessages.some((message) => Boolean(message.starred)) || undefined,
      messageCount: threadMessages.length,
    };
  });
}

function clampLimit(value: unknown, fallback: number, max: number) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
