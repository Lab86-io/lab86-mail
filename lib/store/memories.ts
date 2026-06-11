import type { Memory } from '../shared/types';
import { kvDelete, kvGet, kvList, kvUpsert } from './kv';

export async function rememberSender(email: string, notes: string) {
  const key = email.toLowerCase();
  const doc: Memory = { email: key, notes, updatedAt: Date.now() } as Memory;
  await kvUpsert('memory', key, doc);
  return doc;
}

export async function recallSender(email: string): Promise<Memory | null> {
  return await kvGet<Memory>('memory', email.toLowerCase());
}

export async function listMemories(): Promise<Memory[]> {
  return await kvList<Memory>('memory', { limit: 500 });
}

export async function forgetSender(email: string) {
  await kvDelete('memory', email.toLowerCase());
}
