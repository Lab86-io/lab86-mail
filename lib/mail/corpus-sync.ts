import { applyCalendarWebhookDelta, isCalendarWebhookType } from '@/lib/calendar/sync';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireNylas } from '@/lib/nylas/client';
import { normalizeNylasMessage } from '@/lib/nylas/normalize';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { nylasErrorStatus, withNylasRetry } from '@/lib/nylas/retry';
import { dispatchNativeNotification } from '@/lib/notifications/native-delivery';
import type { Message } from '@/lib/shared/types';
import { buildCorpusSearchText, extractNylasWebhookMetadata, type NylasWebhookMetadata } from './corpus';
import { detectMailSuggestions } from './suggestion-detectors';

const mailCorpusApi = (api as any).mailCorpus;
const accountsApi = (api as any).accounts;
const notificationsApi = (api as any).albatrossNotifications;

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
  htmlBody?: string;
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
  limit = 20,
}: BackfillArgs): Promise<CorpusSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
  // Nylas 429s message-object fetches above limit=20 (nyl.as/429-tmr).
  const batchLimit = clampLimit(limit, 20, 20);
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
    const page = await withRateLimitRetry(() =>
      requireNylas().messages.list({
        identifier: row.grantId,
        queryParams: { limit: batchLimit, ...(pageToken ? { page_token: pageToken } : {}) } as any,
      }),
    );
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
    // New rows may be flagged llmPending; drain them once the batch lands.
    // Dynamic import: llm-classify pulls in the AI tool layer, which loops
    // back into this module at static-import time.
    void import('./llm-classify')
      .then(({ kickLlmClassification }) => kickLlmClassification(userId))
      .catch(() => undefined);
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

// Retries transient upstream failures: 429 rate limits AND 5xx provider
// outages (502/503/504, "service unavailable"). A brief Nylas/Google hiccup
// during backfill must not permanently park the account in `error` state —
// nothing re-kicks an errored account except a fresh search or reconnect.
function isTransientUpstreamError(err: any): boolean {
  const message = String(err?.message || '').toLowerCase();
  const status = Number(err?.statusCode ?? err?.status);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return (
    message.includes('too many requests') ||
    message.includes('service unavailable') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout') ||
    message.includes('temporarily unavailable')
  );
}

async function withRateLimitRetry<T>(operation: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      if (!isTransientUpstreamError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
    }
  }
  throw lastError;
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
//
// The loop is pipelined: while page N's rows are being written to Convex,
// page N+1 is already in flight to Nylas. Fetch and persist latencies are
// comparable, so overlapping them roughly halves wall-clock backfill time
// (the per-page limit of 20 is a hard Nylas rate constraint — see
// backfillMailCorpusAccount — so fewer, bigger pages aren't an option).
export async function runCorpusBackfill({
  userId,
  accountId,
  maxPages = 150,
  pageLimit = 20,
}: {
  userId: string;
  accountId: string;
  maxPages?: number;
  pageLimit?: number;
}): Promise<CorpusSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
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

  const batchLimit = clampLimit(pageLimit, 20, 20);
  const fetchPage = (token: string | undefined) =>
    withRateLimitRetry(() =>
      requireNylas().messages.list({
        identifier: row.grantId,
        queryParams: { limit: batchLimit, ...(token ? { page_token: token } : {}) } as any,
      }),
    );

  await markSync(row, {
    status: 'backfilling',
    cursor: pageToken,
    corpusReady: false,
    progress: { stage: 'fetching', pageToken: pageToken || null, limit: batchLimit },
  });

  let result: CorpusSyncResult | null = null;
  let cursorResets = 0;
  let inFlight = fetchPage(pageToken);
  for (let page = 0; page < Math.max(1, maxPages); page += 1) {
    let pageData: Awaited<ReturnType<typeof fetchPage>>;
    try {
      pageData = await inFlight;
    } catch (err: any) {
      // Stored cursors expire across deploys; discard once and restart from
      // the top rather than replaying a dead token forever.
      if (pageToken && isInvalidCursorError(err) && cursorResets === 0) {
        cursorResets += 1;
        await markSync(row, {
          status: 'backfilling',
          corpusReady: false,
          clearCursor: true,
          progress: { stage: 'cursor_reset', discardedPageToken: pageToken },
        }).catch(() => undefined);
        pageToken = undefined;
        inFlight = fetchPage(undefined);
        page -= 1;
        continue;
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

    const messages = pageData.data.map((message) => corpusMessageFromNylas(row, message));
    const nextPageToken = pageData.nextCursor || undefined;
    // The pipelining win: the next fetch departs before this page persists.
    if (nextPageToken && page + 1 < maxPages) inFlight = fetchPage(nextPageToken);
    const corpusReady = !nextPageToken;
    await upsertCorpus(row, {
      threads: corpusThreadsFromMessages(messages),
      messages,
      cursor: nextPageToken,
      corpusReady,
      progress: {
        stage: corpusReady ? 'ready' : 'backfilling',
        pageToken: nextPageToken || null,
        lastBatchMessages: messages.length,
      },
    });
    void import('./llm-classify')
      .then(({ kickLlmClassification }) => kickLlmClassification(userId))
      .catch(() => undefined);
    await detectMailSuggestions(row, messages);
    result = {
      ok: true,
      accountId: row.accountId,
      grantId: row.grantId,
      provider: row.provider,
      messages: messages.length,
      threads: messages.length,
      nextPageToken,
      corpusReady,
    };
    if (corpusReady) return result;
    pageToken = nextPageToken;
  }
  return result as CorpusSyncResult;
}

const backfillKickAt = new Map<string, number>();
const BACKFILL_KICK_DEBOUNCE_MS = 10 * 60_000;
const BACKFILL_ACTIVE_WINDOW_MS = 5 * 60_000;

// Fire-and-forget backfill kick used by the search path and OAuth callback.
// Ownership is decided by an atomic Convex claim (safe across instances); the
// local Map is only a best-effort throttle so one instance doesn't spam the
// claim mutation on every search.
export function maybeKickCorpusBackfill(row: Pick<NylasAccountRow, 'userId' | 'accountId'>) {
  const key = `${row.userId}:${row.accountId}`;
  const last = backfillKickAt.get(key) || 0;
  if (Date.now() - last < BACKFILL_KICK_DEBOUNCE_MS) return;
  void (async () => {
    try {
      const account = await convexQuery<NylasAccountRow | null>(accountsApi.getConnectedAccount, {
        userId: row.userId,
        accountId: row.accountId,
      });
      if (!account || account.status !== 'connected') return;
      const claim = await convexMutation<{ claimed: boolean; reason?: string }>(
        mailCorpusApi.claimCorpusBackfill,
        {
          userId: row.userId,
          accountId: row.accountId,
          grantId: account.grantId,
          provider: account.provider,
          activeWindowMs: BACKFILL_ACTIVE_WINDOW_MS,
        },
      );
      if (!claim.claimed) {
        // Lost the claim (another instance owns it, or the corpus is ready):
        // only suppress THIS instance briefly so retries aren't starved.
        backfillKickAt.set(key, Date.now() - BACKFILL_KICK_DEBOUNCE_MS + 60_000);
        return;
      }
      backfillKickAt.set(key, Date.now());
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
  limit = 20,
}: ReconcileArgs): Promise<CorpusSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
  const prevState = await convexQuery<any | null>(mailCorpusApi.getSyncState, { userId, accountId }).catch(
    () => null,
  );
  const wasReady = Boolean(prevState?.corpusReady);
  const batchLimit = clampLimit(limit, 20, 20);
  await markSync(row, {
    status: 'syncing',
    progress: { stage: 'reconciling', limit: batchLimit },
  });
  try {
    const page = await withRateLimitRetry(() =>
      requireNylas().messages.list({
        identifier: row.grantId,
        queryParams: { limit: batchLimit } as any,
      }),
    );
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

  // Calendar triggers (event.*, calendar.*) belong to the calendar corpus;
  // they share the queue/dedup path but never touch mail sync state.
  if (isCalendarWebhookType(metadata.type)) {
    try {
      await applyCalendarWebhookDelta(row, metadata.type, payload);
      await markWebhookProcessed(metadata, 'processed');
      return { ok: true, duplicate: false, eventId: metadata.eventId };
    } catch (err: any) {
      await markWebhookProcessed(metadata, 'error', err?.message || 'calendar webhook failed');
      throw err;
    }
  }

  try {
    await applyWebhookDelta(row, metadata, payload);
    await markWebhookProcessed(metadata, 'processed');
    await markSync(row, {
      progress: { stage: 'webhook', type: metadata.type, eventId: metadata.eventId },
      lastIncrementalSyncAt: Date.now(),
    });
    void import('./llm-classify')
      .then(({ kickLlmClassification }) => kickLlmClassification(row.userId))
      .catch(() => undefined);
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

  let raw: { data?: unknown };
  try {
    raw = await withNylasRetry(() =>
      requireNylas().messages.find({
        identifier: row.grantId,
        messageId: metadata.providerMessageId as string,
      }),
    );
  } catch (err: any) {
    // A redelivered backlog references resources that may be gone; treat
    // not-found as nothing to ingest rather than a hard failure. Transient 5xx
    // were already retried; let those bubble so the reconciler picks them up.
    const status = nylasErrorStatus(err);
    if (status === 404 || status === 410) return;
    throw err;
  }
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
  const suggestions = await detectMailSuggestions(row, messages);
  if (
    suggestions.created === 0 &&
    /message.*created|created.*message/i.test(metadata.type) &&
    messages[0] &&
    messages[0].receivedAt >= Date.now() - 15 * 60_000
  ) {
    const message = messages[0];
    const queued = await convexMutation<{ notificationId: string; created: boolean }>(
      notificationsApi.queueMailNotification,
      {
        userId: row.userId,
        accountId: row.accountId,
        threadId: message.providerThreadId,
        messageId: message.providerMessageId,
        sender: message.from,
        subject: message.subject,
        snippet: message.snippet,
      },
    );
    if (queued.created) {
      await dispatchNativeNotification(row.userId, queued.notificationId).catch(() => undefined);
    }
  }
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
  return corpusMessageFromNormalized(normalized, {
    unread: Boolean(raw?.unread),
    starred: Boolean(raw?.starred),
  });
}

function corpusMessageFromNormalized(
  message: Message,
  flags: { unread?: boolean; starred?: boolean } = {},
): CorpusMessageInput {
  const labels = message.labels || [];
  return {
    providerMessageId: message._id,
    providerThreadId: message.threadId,
    subject: message.subject,
    from: message.from,
    to: message.to,
    cc: message.cc || undefined,
    bcc: message.bcc || undefined,
    receivedAt: message.date,
    snippet: message.snippet,
    textBody: message.textBody,
    // The provider hands us the full body on every list/find call; storing it
    // is what makes opening a thread a pure local read.
    htmlBody: message.htmlBody ?? '',
    searchText: buildCorpusSearchText({
      subject: message.subject,
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      snippet: message.snippet,
      textBody: message.textBody,
      labels,
    }),
    labels,
    unread: Boolean(flags.unread) || Boolean(message.unread) || labels.includes('UNREAD'),
    starred: Boolean(flags.starred) || labels.includes('STARRED'),
    attachments: message.attachments,
    headers: message.headers,
  };
}

// Write a freshly fetched (already normalized) thread into the corpus in one
// batched mutation. Used by the read path to hydrate threads whose rows
// predate body storage — after this, the live Convex queries serve them.
export async function ingestThreadIntoCorpus(row: NylasAccountRow, messages: Message[]) {
  if (!messages.length) return;
  const corpusMessages = messages.map((message) => corpusMessageFromNormalized(message));
  await upsertCorpus(row, {
    messages: corpusMessages,
    threads: corpusThreadsFromMessages(corpusMessages),
    progress: { stage: 'read_hydrate', messages: corpusMessages.length },
    incremental: true,
  });
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
