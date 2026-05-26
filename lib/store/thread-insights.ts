import type { ThreadInsight } from '../shared/types';
import { db, findOne, upsert } from './db';

export function insightId(account: string, threadId: string) {
  return `${account}:${threadId}`;
}

export async function getThreadInsight(account: string, threadId: string) {
  return await findOne<ThreadInsight>(db().threadInsights, { _id: insightId(account, threadId) });
}

export async function upsertThreadInsight(insight: ThreadInsight) {
  await upsert(db().threadInsights, { _id: insight._id }, insight);
  return insight;
}
