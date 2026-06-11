import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../shared/types';
import { kvDeleteMany, kvList, kvUpsert } from './kv';

export async function appendChat(entry: Omit<ChatMessage, 'ts'> & { ts?: number }) {
  const doc: ChatMessage = { ...entry, ts: entry.ts ?? Date.now() };
  await kvUpsert('chat', `${doc.ts}:${randomUUID()}`, doc, `${doc.account}:${doc.threadId}`);
  return doc;
}

export async function recentChat(account: string, threadId: string, limit = 30): Promise<ChatMessage[]> {
  const rows = await kvList<ChatMessage>('chat', { ref: `${account}:${threadId}`, limit: limit * 10 });
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, limit).reverse();
}

export async function clearChat(account: string, threadId: string) {
  await kvDeleteMany('chat', `${account}:${threadId}`);
}
