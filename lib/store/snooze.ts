import { randomUUID } from 'node:crypto';
import type { Snooze } from '../shared/types';
import { kvDeleteMany, kvList, kvUpsert } from './kv';

export async function snoozeMessage(account: string, messageId: string, threadId: string, untilTs: number) {
  const id = randomUUID();
  const doc: Snooze = { _id: id, account, messageId, threadId, untilTs, createdAt: Date.now() } as Snooze;
  await kvUpsert('snooze', id, doc, `${account}:${messageId}`);
  return doc;
}

export async function listDueSnoozes(now = Date.now()): Promise<Snooze[]> {
  const rows = await kvList<Snooze>('snooze');
  return rows.filter((row) => row.untilTs <= now);
}

export async function unsnoozeByMessage(account: string, messageId: string) {
  await kvDeleteMany('snooze', `${account}:${messageId}`);
}
