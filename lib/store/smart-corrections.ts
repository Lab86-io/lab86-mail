import { randomUUID } from 'node:crypto';
import type { SmartCorrection } from '../shared/types';
import { kvList, kvUpsert } from './kv';

export async function writeSmartCorrection(input: Omit<SmartCorrection, '_id' | 'createdAt'>) {
  const doc: SmartCorrection = { _id: randomUUID(), createdAt: Date.now(), ...input };
  await kvUpsert('smartCorrection', doc._id, doc);
  return doc;
}

export async function listSmartCorrections(limit = 100) {
  const rows = await kvList<SmartCorrection>('smartCorrection', { limit: Math.max(limit, 100) });
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows.slice(0, limit);
}
