import { db, findMany, insertOne, removeMany } from './db';
import type { ChatMessage } from '../shared/types';

export async function appendChat(entry: Omit<ChatMessage, 'ts'> & { ts?: number }) {
  const doc: ChatMessage = { ...entry, ts: entry.ts ?? Date.now() };
  return await insertOne<ChatMessage>(db().chat, doc);
}

export async function recentChat(account: string, threadId: string, limit = 30): Promise<ChatMessage[]> {
  const docs = await findMany<ChatMessage>(
    db().chat,
    { account, threadId },
    { sort: { ts: -1 }, limit },
  );
  return docs.reverse();
}

export async function clearChat(account: string, threadId: string) {
  return await removeMany(db().chat, { account, threadId });
}
