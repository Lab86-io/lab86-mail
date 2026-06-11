import { randomUUID } from 'node:crypto';
import type { TrackedThread } from '../shared/types';
import { kvGet, kvList, kvUpsert } from './kv';

const now = () => Date.now();

const pairRef = (account: string, threadId: string) => `${account}:${threadId}`;

export async function getTrackedThread(account: string, threadId: string) {
  const rows = await kvList<TrackedThread>('trackedThread', { ref: pairRef(account, threadId), limit: 5 });
  return rows[0] || null;
}

export async function getTrackedThreadById(id: string) {
  return await kvGet<TrackedThread>('trackedThread', id);
}

export async function upsertTrackedThread(
  input: Omit<Partial<TrackedThread>, '_id' | 'createdAt' | 'updatedAt'> & {
    account: string;
    threadId: string;
    subject: string;
  },
) {
  const existing = await getTrackedThread(input.account, input.threadId);
  const ts = now();
  const next: TrackedThread = {
    _id: existing?._id || randomUUID(),
    account: input.account,
    threadId: input.threadId,
    subject: input.subject || existing?.subject || '(no subject)',
    participants: input.participants || existing?.participants || [],
    status: input.status || existing?.status || 'open',
    reason: input.reason || existing?.reason || 'Tracked conversation',
    openLoops: input.openLoops || existing?.openLoops || [],
    nextAction: input.nextAction ?? existing?.nextAction,
    dueAt: input.dueAt ?? existing?.dueAt ?? null,
    snoozedUntil: input.snoozedUntil ?? existing?.snoozedUntil ?? null,
    importance: input.importance || existing?.importance || 2,
    source: input.source || existing?.source || 'manual',
    aiSuggestedResolved: input.aiSuggestedResolved ?? existing?.aiSuggestedResolved,
    createdAt: existing?.createdAt || ts,
    updatedAt: ts,
  };
  await kvUpsert('trackedThread', next._id, next, pairRef(next.account, next.threadId));
  return next;
}

export async function updateTrackedThread(id: string, patch: Partial<TrackedThread>) {
  const existing = await getTrackedThreadById(id);
  if (!existing) throw new Error('Tracked thread not found');
  const next: TrackedThread = {
    ...existing,
    ...patch,
    _id: existing._id,
    account: existing.account,
    threadId: existing.threadId,
    updatedAt: now(),
  };
  await kvUpsert('trackedThread', id, next, pairRef(next.account, next.threadId));
  return next;
}

export async function listTrackedThreads(
  options: { status?: TrackedThread['status']; includeResolved?: boolean; limit?: number } = {},
) {
  const rows = await kvList<TrackedThread>('trackedThread', { limit: 1000 });
  let filtered = rows;
  if (options.status) {
    filtered = filtered.filter((row) => row.status === options.status);
  } else if (!options.includeResolved) {
    filtered = filtered.filter((row) => row.status !== 'resolved' && row.status !== 'dismissed');
  }
  // Mirror the old NeDB compound sort: importance asc, dueAt asc, updatedAt desc.
  filtered.sort(
    (a, b) =>
      (a.importance || 2) - (b.importance || 2) ||
      (a.dueAt ?? Number.POSITIVE_INFINITY) - (b.dueAt ?? Number.POSITIVE_INFINITY) ||
      (b.updatedAt || 0) - (a.updatedAt || 0),
  );
  return filtered.slice(0, options.limit || 120);
}
