import { db, findMany, insertOne, removeMany } from './db';
import type { Snooze } from '../shared/types';

export async function snoozeMessage(account: string, messageId: string, threadId: string, untilTs: number) {
  return await insertOne<Snooze>(db().snooze, {
    account,
    messageId,
    threadId,
    untilTs,
    createdAt: Date.now(),
  });
}

export async function listDueSnoozes(now = Date.now()): Promise<Snooze[]> {
  return await findMany<Snooze>(db().snooze, { untilTs: { $lte: now } });
}

export async function unsnoozeByMessage(account: string, messageId: string) {
  return await removeMany(db().snooze, { account, messageId });
}
