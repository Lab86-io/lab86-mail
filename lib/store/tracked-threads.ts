import { randomUUID } from 'node:crypto';
import type { TrackedThread } from '../shared/types';
import { db, findMany, findOne, upsert } from './db';

const now = () => Date.now();

export async function getTrackedThread(account: string, threadId: string) {
  return await findOne<TrackedThread>(db().trackedThreads, { account, threadId });
}

export async function getTrackedThreadById(id: string) {
  return await findOne<TrackedThread>(db().trackedThreads, { _id: id });
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
    resolvedAt: input.resolvedAt ?? existing?.resolvedAt ?? null,
  };
  await upsert(db().trackedThreads, { _id: next._id }, next);
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
  await upsert(db().trackedThreads, { _id: id }, next);
  return next;
}

export async function listTrackedThreads(
  options: { status?: TrackedThread['status']; includeResolved?: boolean; limit?: number } = {},
) {
  const query: Record<string, unknown> = {};
  if (options.status) query.status = options.status;
  if (!options.includeResolved && !options.status) {
    query.status = { $nin: ['resolved', 'dismissed'] };
  }
  return await findMany<TrackedThread>(db().trackedThreads, query, {
    sort: { importance: 1, dueAt: 1, updatedAt: -1 },
    limit: options.limit || 120,
  });
}
