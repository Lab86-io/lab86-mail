import type { Memory } from '../shared/types';
import { db, findMany, findOne, removeMany, upsert } from './db';

export async function rememberSender(email: string, notes: string) {
  const doc: Memory = { email: email.toLowerCase(), notes, updatedAt: Date.now() };
  await upsert(db().memories, { email: doc.email }, doc);
  return doc;
}

export async function recallSender(email: string): Promise<Memory | null> {
  return await findOne<Memory>(db().memories, { email: email.toLowerCase() });
}

export async function listMemories(): Promise<Memory[]> {
  return await findMany<Memory>(db().memories, {}, { sort: { updatedAt: -1 } });
}

export async function forgetSender(email: string) {
  return await removeMany(db().memories, { email: email.toLowerCase() });
}
