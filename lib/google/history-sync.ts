// Direct Google transport: mail sync through the Gmail History API.
//
// A direct account (grant id `google:<accountId>`) gets no Nylas webhooks.
// Every 2 minutes the Convex cron (googleDirect:historyTick) asks the app to
// read `users.history.list` from the stored History id of each such account
// (mailSyncStates.historyId). Added and relabeled messages are read through
// the adapter and go into the corpus by the webhook ingest path; deleted
// messages go through the webhook delete path. A History id that Google no
// longer has (404) runs the normal reconcile and starts again from now.

import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { applyProviderMessageChanges, reconcileMailCorpusAccount } from '@/lib/mail/corpus-sync';
import { requireNylas } from '@/lib/nylas/client';
import { noteGrantFailure } from '@/lib/nylas/grant-health';
import type { NylasAccountRow } from '@/lib/nylas/provider';
import { GMAIL_API, googleJson, googleUrl } from './http';
import { isGoogleDirectGrant } from './transport';

const HISTORY_TYPES = ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'];
const HISTORY_PAGE_SIZE = 500;
const MAX_HISTORY_PAGES = 10;
/** Messages read in one run; the rest wait for the next run. */
const MAX_CHANGES_PER_RUN = 400;
const READ_CONCURRENCY = 5;

interface HistoryMessageRef {
  message?: { id?: string; threadId?: string; labelIds?: string[] };
}

interface HistoryRecord {
  id?: string;
  messagesAdded?: HistoryMessageRef[];
  messagesDeleted?: HistoryMessageRef[];
  labelsAdded?: HistoryMessageRef[];
  labelsRemoved?: HistoryMessageRef[];
}

interface HistoryPage {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

export interface HistorySyncResult {
  ok: boolean;
  accountId: string;
  skipped?: 'not_connected' | 'not_direct' | 'busy';
  baseline?: boolean;
  reset?: boolean;
  added: number;
  relabeled: number;
  deleted: number;
  historyId?: string;
  more?: boolean;
}

const defaults = {
  query: convexQuery,
  mutate: convexMutation,
  googleJson,
  findMessage: async (grantId: string, messageId: string, withHeaders: boolean): Promise<unknown> =>
    (
      await requireNylas().messages.find({
        identifier: grantId,
        messageId,
        ...(withHeaders ? { queryParams: { fields: 'include_headers' as any } } : {}),
      })
    ).data,
  applyProviderMessageChanges,
  reconcileMailCorpusAccount,
  noteGrantFailure: (grantId: string, err: unknown) => noteGrantFailure(grantId, err),
};
let deps = defaults;
const running = new Set<string>();

export function __setGoogleHistoryDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
  running.clear();
}

/** Message ids that each History record touched, in the order the records came. */
export function collectHistoryChanges(records: HistoryRecord[]) {
  const added = new Set<string>();
  const relabeled = new Set<string>();
  const deleted = new Set<string>();
  for (const record of records) {
    for (const item of record.messagesAdded || []) {
      const id = item.message?.id;
      if (!id || (item.message?.labelIds || []).includes('DRAFT')) continue;
      added.add(id);
      deleted.delete(id);
    }
    for (const item of record.messagesDeleted || []) {
      const id = item.message?.id;
      if (!id) continue;
      deleted.add(id);
      added.delete(id);
      relabeled.delete(id);
    }
    for (const item of [...(record.labelsAdded || []), ...(record.labelsRemoved || [])]) {
      const id = item.message?.id;
      if (id && !deleted.has(id) && !added.has(id)) relabeled.add(id);
    }
  }
  return { added, relabeled, deleted };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

async function currentHistoryId(grantId: string) {
  const profile = await deps.googleJson<{ historyId?: string }>(grantId, `${GMAIL_API}/profile`);
  if (!profile?.historyId) throw new Error('The Gmail profile had no History id.');
  return String(profile.historyId);
}

async function saveHistoryId(row: NylasAccountRow, historyId: string, progress: Record<string, unknown>) {
  await deps.mutate(api.mailCorpus.markSyncState, {
    userId: row.userId,
    accountId: row.accountId,
    grantId: row.grantId,
    provider: row.provider,
    historyId,
    progress: { stage: 'google_history', ...progress },
    lastIncrementalSyncAt: Date.now(),
  });
}

function statusOf(err: unknown) {
  return Number((err as { statusCode?: unknown })?.statusCode);
}

/** One History pass for one direct account. */
export async function syncGoogleHistory({
  userId,
  accountId,
  maxChanges = MAX_CHANGES_PER_RUN,
}: {
  userId: string;
  accountId: string;
  maxChanges?: number;
}): Promise<HistorySyncResult> {
  const empty = { accountId, added: 0, relabeled: 0, deleted: 0 };
  const row = await deps.query<NylasAccountRow | null>(api.accounts.getConnectedAccount, {
    userId,
    accountId,
  });
  if (!row || row.status !== 'connected') return { ok: false, skipped: 'not_connected', ...empty };
  if (!isGoogleDirectGrant(row.grantId)) return { ok: false, skipped: 'not_direct', ...empty };
  const key = `${userId}:${accountId}`;
  if (running.has(key)) return { ok: false, skipped: 'busy', ...empty };
  running.add(key);
  try {
    return await runHistoryPass(row, maxChanges);
  } catch (err) {
    await deps.noteGrantFailure(row.grantId, err);
    throw err;
  } finally {
    running.delete(key);
  }
}

async function runHistoryPass(row: NylasAccountRow, maxChanges: number): Promise<HistorySyncResult> {
  const empty = { accountId: row.accountId, added: 0, relabeled: 0, deleted: 0 };
  const state = await deps.query<{ historyId?: string } | null>(api.mailCorpus.getSyncState, {
    userId: row.userId,
    accountId: row.accountId,
  });
  const start = state?.historyId;
  if (!start) {
    // No starting point (it is set at the switch): take the current one.
    const historyId = await currentHistoryId(row.grantId);
    await saveHistoryId(row, historyId, { baseline: true });
    return { ok: true, baseline: true, historyId, ...empty };
  }

  const records: HistoryRecord[] = [];
  let pageToken: string | undefined;
  let latest = start;
  let more = false;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    let result: HistoryPage;
    try {
      result = await deps.googleJson<HistoryPage>(
        row.grantId,
        googleUrl(`${GMAIL_API}/history`, {
          startHistoryId: start,
          historyTypes: HISTORY_TYPES,
          maxResults: HISTORY_PAGE_SIZE,
          pageToken,
        }),
      );
    } catch (err) {
      if (statusOf(err) === 404) return await resetExpiredHistory(row);
      throw err;
    }
    records.push(...(result.history || []));
    pageToken = result.nextPageToken || undefined;
    const changes = collectHistoryChanges(records);
    const count = changes.added.size + changes.relabeled.size + changes.deleted.size;
    if (!pageToken) {
      latest = String(result.historyId || latest);
      break;
    }
    if (count >= maxChanges || page === MAX_HISTORY_PAGES - 1) {
      // Stop after whole records; the next run starts after the last one.
      latest = String(records.at(-1)?.id || latest);
      more = true;
      break;
    }
  }

  const { added, relabeled, deleted } = collectHistoryChanges(records);
  const reads = [
    ...[...added].map((id) => ({ id, withHeaders: true })),
    ...[...relabeled].map((id) => ({ id, withHeaders: false })),
  ];
  const gone: string[] = [];
  const fetched = await mapLimit(reads, READ_CONCURRENCY, async (read) => {
    try {
      // New mail keeps the list headers (unsubscribe, the classifier). A
      // label change reads no headers, so the stored headers stay as they are.
      return await deps.findMessage(row.grantId, read.id, read.withHeaders);
    } catch (err) {
      if (statusOf(err) === 404) {
        gone.push(read.id);
        return null;
      }
      throw err;
    }
  });
  const upserts = fetched.filter(
    (message: any) => message && !(Array.isArray(message.folders) && message.folders.includes('DRAFT')),
  );
  await deps.applyProviderMessageChanges(row, {
    upserts,
    deletes: [...deleted, ...gone],
    progress: { source: 'google_history', historyId: latest },
  });
  await saveHistoryId(row, latest, { added: added.size, relabeled: relabeled.size, deleted: deleted.size });
  return {
    ok: true,
    accountId: row.accountId,
    added: added.size,
    relabeled: relabeled.size,
    deleted: deleted.size + gone.length,
    historyId: latest,
    ...(more ? { more: true } : {}),
  };
}

/** Google no longer has the History id: reconcile, and start again from now. */
async function resetExpiredHistory(row: NylasAccountRow): Promise<HistorySyncResult> {
  // Read the new starting point first, so changes during the reconcile come
  // in on the next run.
  const historyId = await currentHistoryId(row.grantId);
  await deps.reconcileMailCorpusAccount({ userId: row.userId, accountId: row.accountId });
  await saveHistoryId(row, historyId, { reset: true });
  return { ok: true, reset: true, historyId, accountId: row.accountId, added: 0, relabeled: 0, deleted: 0 };
}
