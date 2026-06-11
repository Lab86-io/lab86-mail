import { includeInSmartCategory, SMART_CATEGORY_IDS } from '../mail/smart-categories';
import type { SmartCategoryStat, Thread } from '../shared/types';
import { kvList, kvUpsert } from './kv';
import { listSmartLabels } from './smart-labels';
import { listTrackedThreads } from './tracked-threads';

export async function computeSmartCategoryStats(account?: string) {
  const accountKey = account || '__all__';
  const [threads, labels, tracked] = await Promise.all([
    kvList<Thread>('thread', { ref: account, limit: 1000 }),
    listSmartLabels(),
    listTrackedThreads({ limit: 1000 }),
  ]);
  const trackedKeys = new Set(
    tracked
      .filter((item) => !account || item.account === account)
      .filter((item) => item.status !== 'resolved' && item.status !== 'dismissed')
      .map((item) => `${item.account}:${item.threadId}`),
  );
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
      // Either bounded fetch hitting its cap means the numbers may be off.
      approximate: threads.length >= 1000 || tracked.length >= 1000,
    };
    await kvUpsert('categoryStat', stat._id, stat).catch((err) => {
      console.error(`Failed to upsert category stat ${stat._id}:`, err);
    });
    stats[category] = stat;
  }

  return stats;
}
