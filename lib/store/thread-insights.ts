import type { ThreadInsight } from '../shared/types';
import { kvUpsert } from './kv';

export function insightId(account: string, threadId: string) {
  return `${account}:${threadId}`;
}

export async function upsertThreadInsight(insight: ThreadInsight) {
  const key = insightId(insight.account, insight.threadId);
  const next = { ...insight, _id: key };
  // A derived cache row that its caller awaits in order.
  await kvUpsert('threadInsight', key, next, undefined, { skipQueue: true });
  return next;
}
