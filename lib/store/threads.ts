import type { Thread } from '../shared/types';
import { db, findMany, findOne, upsert } from './db';

// Read-merge-write below is racy if two upserts for the same thread interleave
// (the later read clobbers the earlier write), so same-key upserts are
// serialized through a per-key promise chain.
const pendingUpserts = new Map<string, Promise<unknown>>();

export function upsertThread(account: string, partial: Partial<Thread> & { _id: string }) {
  const key = `${account}:${partial._id}`;
  const prev = pendingUpserts.get(key) ?? Promise.resolve();
  const next = prev.then(
    () => doUpsertThread(account, partial),
    () => doUpsertThread(account, partial),
  );
  const tracked = next.catch(() => undefined);
  pendingUpserts.set(key, tracked);
  tracked.then(() => {
    if (pendingUpserts.get(key) === tracked) pendingUpserts.delete(key);
  });
  return next;
}

async function doUpsertThread(account: string, partial: Partial<Thread> & { _id: string }) {
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
    smartCategory: partial.smartCategory ?? existing?.smartCategory ?? null,
    readState: partial.readState ?? existing?.readState ?? null,
    gmailLabelSync: partial.gmailLabelSync ?? existing?.gmailLabelSync ?? null,
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
  await db().threads.updateAsync({ _id: id, account }, { $set: { summary, summaryAt: Date.now() } });
}

export async function setThreadTriage(account: string, id: string, triage: Thread['triage']) {
  await db().threads.updateAsync({ _id: id, account }, { $set: { triage } });
}

export async function setThreadSmartCategory(
  account: string,
  id: string,
  smartCategory: Thread['smartCategory'],
) {
  await db().threads.updateAsync({ _id: id, account }, { $set: { smartCategory } });
}

export async function setThreadReadState(account: string, id: string, readState: Thread['readState']) {
  await db().threads.updateAsync({ _id: id, account }, { $set: { readState, unread: false } });
}

export async function setThreadGmailLabelSync(
  account: string,
  id: string,
  gmailLabelSync: Thread['gmailLabelSync'],
) {
  await db().threads.updateAsync({ _id: id, account }, { $set: { gmailLabelSync } });
}

export async function listThreadsBySmartCategory(
  account: string | null,
  category: string,
  limit = 80,
): Promise<Thread[]> {
  const query = account
    ? { account, 'smartCategory.primary': category }
    : { 'smartCategory.primary': category };
  return await findMany<Thread>(db().threads, query, { sort: { lastDate: -1 }, limit });
}
