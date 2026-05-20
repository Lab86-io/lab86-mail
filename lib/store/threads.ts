import { db, findMany, findOne, upsert } from './db';
import type { Thread } from '../shared/types';

export async function upsertThread(account: string, partial: Partial<Thread> & { _id: string }) {
  const existing = await getThread(account, partial._id);
  const merged: Thread = {
    _id: partial._id,
    account,
    subject: partial.subject ?? existing?.subject ?? '',
    fromAddress: partial.fromAddress ?? existing?.fromAddress ?? '',
    lastDate: partial.lastDate ?? existing?.lastDate ?? 0,
    snippet: partial.snippet ?? existing?.snippet ?? '',
    labels: partial.labels ?? existing?.labels ?? [],
    unread: partial.unread ?? existing?.unread ?? false,
    starred: partial.starred ?? existing?.starred ?? false,
    summary: partial.summary ?? existing?.summary ?? null,
    summaryAt: partial.summaryAt ?? existing?.summaryAt ?? null,
    triage: partial.triage ?? existing?.triage ?? null,
    cachedAt: Date.now(),
  };
  await upsert(db().threads, { _id: merged._id, account }, merged);
  return merged;
}

export async function getThread(account: string, id: string): Promise<Thread | null> {
  return await findOne<Thread>(db().threads, { _id: id, account });
}

export async function listRecentThreads(limit = 80): Promise<Thread[]> {
  return await findMany<Thread>(db().threads, {}, { sort: { lastDate: -1 }, limit });
}

export async function listThreadsForAccount(account: string, limit = 80): Promise<Thread[]> {
  return await findMany<Thread>(db().threads, { account }, { sort: { lastDate: -1 }, limit });
}

export async function setThreadSummary(account: string, id: string, summary: string) {
  await db().threads.updateAsync(
    { _id: id, account },
    { $set: { summary, summaryAt: Date.now() } },
  );
}

export async function setThreadTriage(
  account: string,
  id: string,
  triage: Thread['triage'],
) {
  await db().threads.updateAsync({ _id: id, account }, { $set: { triage } });
}
