import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { includeInSmartCategory, SMART_CATEGORY_IDS } from '../mail/smart-categories';
import type { SmartCategoryStat, Thread } from '../shared/types';
import { kvList, kvUpsert, requireStoreUserId } from './kv';
import { listSmartLabels } from './smart-labels';
import { listTrackedThreads } from './tracked-threads';

const STATS_SCAN_LIMIT = 5_000;
const CORPUS_SCAN_LIMIT = 1_000;

// Counts come from the synced corpus (stored write-time verdicts), so they
// reflect the same data the category views serve. The kv cache remains only
// as a fallback for Convex-less unit tests.
async function listStatThreads(account?: string): Promise<{ threads: Thread[]; capped: boolean }> {
  if (isConvexConfigured()) {
    try {
      const userId = requireStoreUserId();
      const rows = await convexQuery<Thread[]>((api as any).mailCorpus.listRecentCorpusThreads, {
        userId,
        accountId: account || undefined,
        limit: CORPUS_SCAN_LIMIT,
      });
      return { threads: rows, capped: rows.length >= CORPUS_SCAN_LIMIT };
    } catch {
      // fall through to the kv cache
    }
  }
  const rows = await kvList<Thread>('thread', { ref: account, limit: STATS_SCAN_LIMIT });
  return { threads: rows, capped: rows.length >= STATS_SCAN_LIMIT };
}

export async function computeSmartCategoryStats(account?: string) {
  const accountKey = account || '__all__';
  const [{ threads, capped }, labels, tracked] = await Promise.all([
    listStatThreads(account),
    listSmartLabels(),
    listTrackedThreads({ limit: 1000 }),
  ]);
  const filteredTracked = tracked
    .filter((item) => !account || item.account === account)
    .filter((item) => item.status !== 'resolved' && item.status !== 'dismissed');
  const trackedKeys = new Set(filteredTracked.map((item) => `${item.account}:${item.threadId}`));
  const categories = [
    ...SMART_CATEGORY_IDS,
    ...labels.filter((label) => label.sidebarVisible).map((label) => `custom:${label._id}`),
  ];
  const computedAt = Date.now();
  const stats: Record<string, SmartCategoryStat> = {};

  for (const category of categories) {
    const matching = threads.filter((thread) => {
      const trackedKey = `${thread.account}:${thread._id}`;
      if (category === 'main' && trackedKeys.has(trackedKey)) return true;
      return includeInSmartCategory(thread, category);
    });
    const stat: SmartCategoryStat = {
      _id: `${accountKey}:${category}`,
      account: accountKey,
      category,
      total: matching.length,
      unread: matching.filter((thread) => thread.unread).length,
      needsAttention: matching.filter((thread) => thread.smartCategory?.needsAttention).length,
      tracked: matching.filter((thread) => trackedKeys.has(`${thread.account}:${thread._id}`)).length,
      computedAt,
      // A bounded tracked fetch hitting its filtered cap means the numbers may be off.
      approximate: capped || filteredTracked.length >= 1000,
    };
    await kvUpsert('categoryStat', stat._id, stat).catch((err) => {
      console.error(`Failed to upsert category stat ${stat._id}:`, err);
    });
    stats[category] = stat;
  }

  return stats;
}
