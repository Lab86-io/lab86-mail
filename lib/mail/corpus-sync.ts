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
  const page = await requireNylas().messages.list({
    identifier: row.grantId,
    queryParams: { limit: batchLimit, page_token: pageToken } as any,
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
}

export async function reconcileMailCorpusAccount({
  userId,
  accountId,
  limit = 50,
}: ReconcileArgs): Promise<CorpusSyncResult> {
  const row = await getConnectedAccount(userId, accountId);
  const batchLimit = clampLimit(limit, 50, 100);
  await markSync(row, {
    status: 'syncing',
    corpusReady: false,
    progress: { stage: 'reconciling', limit: batchLimit },
  });
  const page = await requireNylas().messages.list({
    identifier: row.grantId,
    queryParams: { limit: batchLimit } as any,
  });
  const messages = page.data.map((message) => corpusMessageFromNylas(row, message));
  const threads = corpusThreadsFromMessages(messages);
  await upsertCorpus(row, {
    threads,
    messages,
    cursor: page.nextCursor || undefined,
    corpusReady: true,
    progress: { stage: 'reconciled', lastBatchMessages: messages.length },
    incremental: true,
  });
  return {
    ok: true,
    accountId: row.accountId,
    grantId: row.grantId,
    provider: row.provider,
    messages: messages.length,
    threads: threads.length,
    nextPageToken: page.nextCursor || undefined,
    corpusReady: true,
  };
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
      status: 'ready',
      corpusReady: true,
      progress: { stage: 'webhook', type: metadata.type, eventId: metadata.eventId },
      lastIncrementalSyncAt: Date.now(),
    });
    return { ok: true, duplicate: false, eventId: metadata.eventId };
  } catch (err: any) {
    await markWebhookProcessed(metadata, 'error', err?.message || 'webhook processing failed');
    await markSync(row, {
      status: 'error',
      corpusReady: false,
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
    corpusReady: true,
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
    corpusReady: boolean;
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
    await markSync(row, {
      status: 'ready',
      cursor: input.cursor,
      corpusReady: true,
      progress: input.progress,
      lastIncrementalSyncAt: Date.now(),
    });
  }
}

async function markSync(
  row: NylasAccountRow,
  patch: {
    status: 'idle' | 'backfilling' | 'syncing' | 'ready' | 'error';
    cursor?: string;
    corpusReady: boolean;
    progress?: unknown;
    error?: string;
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
