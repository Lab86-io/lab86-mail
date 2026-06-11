import { randomUUID } from 'node:crypto';
import type { Snooze } from '../shared/types';
import { kvDeleteMany, kvList, kvUpsert } from './kv';

export async function snoozeMessage(account: string, messageId: string, threadId: string, untilTs: number) {
  const doc: Snooze = { account, messageId, threadId, untilTs, createdAt: Date.now() } as Snooze;
  await kvUpsert('snooze', randomUUID(), doc, `${account}:${messageId}`);
  return doc;
}

export async function listDueSnoozes(now = Date.now()): Promise<Snooze[]> {
  const rows = await kvList<Snooze>('snooze', { limit: 1000 });
  return rows.filter((row) => row.untilTs <= now);
}

export async function unsnoozeByMessage(account: string, messageId: string) {
  await kvDeleteMany('snooze', `${account}:${messageId}`);
}
