import type { ThreadInsight } from '../shared/types';
import { kvGet, kvUpsert } from './kv';

export function insightId(account: string, threadId: string) {
  return `${account}:${threadId}`;
}

export async function getThreadInsight(account: string, threadId: string) {
  return await kvGet<ThreadInsight>('threadInsight', insightId(account, threadId));
}

export async function upsertThreadInsight(insight: ThreadInsight) {
  const key = insightId(insight.account, insight.threadId);
  const next = { ...insight, _id: key };
  await kvUpsert('threadInsight', key, next);
  return next;
}
