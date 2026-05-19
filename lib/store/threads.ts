import { db, findMany, findOne, upsert } from './db';
import type { Thread } from '../shared/types';

export async function upsertThread(account: string, partial: Partial<Thread> & { _id: string }) {
  const merged: Thread = {
    _id: partial._id,
    account,
    subject: partial.subject || '',
    fromAddress: partial.fromAddress || '',
    lastDate: partial.lastDate || 0,
    snippet: partial.snippet || '',
    labels: partial.labels || [],
    unread: partial.unread ?? false,
    starred: partial.starred ?? false,
    summary: partial.summary ?? null,
    summaryAt: partial.summaryAt ?? null,
    triage: partial.triage ?? null,
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
