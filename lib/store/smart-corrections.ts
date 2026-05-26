import { randomUUID } from 'node:crypto';
import type { SmartCorrection } from '../shared/types';
import { db, findMany, insertOne } from './db';

export async function writeSmartCorrection(input: Omit<SmartCorrection, '_id' | 'createdAt'>) {
  return await insertOne<SmartCorrection>(db().smartCorrections, {
    _id: randomUUID(),
    createdAt: Date.now(),
    ...input,
  });
}

export async function listSmartCorrections(limit = 100) {
  return await findMany<SmartCorrection>(db().smartCorrections, {}, { sort: { createdAt: -1 }, limit });
}
