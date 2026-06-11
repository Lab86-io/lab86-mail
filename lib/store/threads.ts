import type { Thread } from '../shared/types';
import { kvGet, kvList, kvUpsert } from './kv';

// Read-merge-write below is racy if two upserts for the same thread interleave
// (the later read clobbers the earlier write), so same-key upserts are
// serialized through a per-key promise chain.
const pendingUpserts = new Map<string, Promise<unknown>>();

const threadKey = (account: string, id: string) => `${account}:${id}`;

export function upsertThread(account: string, partial: Partial<Thread> & { _id: string }) {
  const key = threadKey(account, partial._id);
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
  await kvUpsert('thread', threadKey(account, merged._id), merged, account);
  return merged;
}

export async function getThread(account: string, id: string): Promise<Thread | null> {
  return await kvGet<Thread>('thread', threadKey(account, id));
}

export async function listRecentThreads(limit = 80): Promise<Thread[]> {
  const rows = await kvList<Thread>('thread');
  rows.sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));
  return rows.slice(0, limit);
}

export async function listThreadsForAccount(account: string, limit = 80): Promise<Thread[]> {
  const rows = await kvList<Thread>('thread', { ref: account });
  rows.sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));
  return rows.slice(0, limit);
}

async function patchThread(account: string, id: string, patch: Partial<Thread>) {
  const existing = await getThread(account, id);
  if (!existing) throw new Error(`Thread not found: ${id}`);
  await upsertThread(account, { _id: id, ...patch });
}

export async function setThreadSummary(account: string, id: string, summary: string) {
  await patchThread(account, id, { summary, summaryAt: Date.now() });
}

export async function setThreadTriage(account: string, id: string, triage: Thread['triage']) {
  await patchThread(account, id, { triage });
}

export async function setThreadSmartCategory(
  account: string,
  id: string,
  smartCategory: Thread['smartCategory'],
) {
  await patchThread(account, id, { smartCategory });
}

export async function setThreadReadState(account: string, id: string, readState: Thread['readState']) {
  await patchThread(account, id, { readState, unread: false });
}

export async function setThreadGmailLabelSync(
  account: string,
  id: string,
  gmailLabelSync: Thread['gmailLabelSync'],
) {
  await patchThread(account, id, { gmailLabelSync });
}

export async function listThreadsBySmartCategory(
  account: string | null,
  category: string,
  limit = 80,
): Promise<Thread[]> {
  const rows = await kvList<Thread>('thread', { ref: account ?? undefined });
  const matching = rows.filter((thread) => thread.smartCategory?.primary === category);
  matching.sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));
  return matching.slice(0, limit);
}
