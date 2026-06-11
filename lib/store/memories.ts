import type { Memory } from '../shared/types';
import { kvDelete, kvGet, kvList, kvUpsert } from './kv';

export async function rememberSender(email: string, notes: string) {
  const key = email.toLowerCase();
  const doc: Memory = { _id: key, email: key, notes, updatedAt: Date.now() };
  await kvUpsert('memory', key, doc);
  return doc;
}

export async function recallSender(email: string): Promise<Memory | null> {
  return await kvGet<Memory>('memory', email.toLowerCase());
}

export async function listMemories(): Promise<Memory[]> {
  const rows = await kvList<Memory>('memory', { limit: 500 });
  return rows.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

export async function forgetSender(email: string) {
  await kvDelete('memory', email.toLowerCase());
}
