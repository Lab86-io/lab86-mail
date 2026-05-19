import { db, findMany, findOne, upsert } from './db';
import type { Message } from '../shared/types';

export async function upsertMessage(message: Message) {
  message.cachedAt = Date.now();
  await upsert(db().messages, { _id: message._id, account: message.account }, message);
}

export async function getMessage(account: string, id: string): Promise<Message | null> {
  return await findOne<Message>(db().messages, { _id: id, account });
}

export async function getThreadMessages(account: string, threadId: string): Promise<Message[]> {
  return await findMany<Message>(db().messages, { account, threadId }, { sort: { date: 1 } });
}
