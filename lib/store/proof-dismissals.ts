import { kvGet, kvUpsert } from './kv';

/**
 * "Not related" on a mail proof offer, kept for each user and for each Work
 * and thread pair. The proof-match route leaves these pairs out, so the same
 * offer does not come back on any device. A new Work that matches the thread
 * still shows.
 */
const KIND = 'proofDismissal';
/** Work ids kept for one thread; the newest stay. */
const WORK_LIMIT = 100;

export interface ProofDismissal {
  accountId: string;
  threadId: string;
  workId: string;
}

interface ThreadDismissals {
  accountId: string;
  threadId: string;
  workIds: string[];
  updatedAt: number;
}

function threadKey(accountId: string, threadId: string) {
  return JSON.stringify([accountId, threadId]);
}

export async function dismissedProofWorkIds(accountId: string, threadId: string): Promise<Set<string>> {
  if (!accountId || !threadId) return new Set();
  const doc = await kvGet<ThreadDismissals>(KIND, threadKey(accountId, threadId));
  return new Set(Array.isArray(doc?.workIds) ? doc.workIds : []);
}

/** Record the pairs. Saving a pair again is harmless. */
export async function dismissProofWork(pairs: ProofDismissal[]): Promise<number> {
  const byThread = new Map<string, { accountId: string; threadId: string; workIds: string[] }>();
  for (const pair of pairs) {
    const key = threadKey(pair.accountId, pair.threadId);
    const entry = byThread.get(key) ?? { accountId: pair.accountId, threadId: pair.threadId, workIds: [] };
    entry.workIds.push(pair.workId);
    byThread.set(key, entry);
  }
  for (const [key, entry] of byThread) {
    const existing = await kvGet<ThreadDismissals>(KIND, key);
    const previous = Array.isArray(existing?.workIds) ? existing.workIds : [];
    const workIds = [...new Set([...previous, ...entry.workIds])].slice(-WORK_LIMIT);
    await kvUpsert<ThreadDismissals>(
      KIND,
      key,
      { accountId: entry.accountId, threadId: entry.threadId, workIds, updatedAt: Date.now() },
      entry.accountId,
    );
  }
  return byThread.size;
}
