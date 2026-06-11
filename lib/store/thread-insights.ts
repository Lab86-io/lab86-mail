import type { ThreadInsight } from '../shared/types';
import { kvGet, kvUpsert } from './kv';

export function insightId(account: string, threadId: string) {
  return `${account}:${threadId}`;
}

export async function getThreadInsight(account: string, threadId: string) {
  return await kvGet<ThreadInsight>('threadInsight', insightId(account, threadId));
}

export async function upsertThreadInsight(insight: ThreadInsight) {
  await kvUpsert('threadInsight', insight._id, insight);
  return insight;
}
