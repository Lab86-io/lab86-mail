import { includeInSmartCategory, SMART_CATEGORY_IDS } from '../mail/smart-categories';
import type { SmartCategoryStat, Thread } from '../shared/types';
import { db, findMany, upsert } from './db';
import { listSmartLabels } from './smart-labels';
import { listTrackedThreads } from './tracked-threads';

export async function computeSmartCategoryStats(account?: string) {
  const accountKey = account || '__all__';
  const [threads, labels, tracked] = await Promise.all([
    findMany<Thread>(db().threads, account ? { account } : {}, { sort: { lastDate: -1 }, limit: 5000 }),
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
      approximate: threads.length >= 5000,
    };
    await upsert(db().smartCategoryStats, { _id: stat._id }, stat).catch(() => undefined);
    stats[category] = stat;
  }

  return stats;
}
