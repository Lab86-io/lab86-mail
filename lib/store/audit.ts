import { db, findMany, insertOne } from './db';
import type { AuditEntry } from '../shared/types';

export async function writeAudit(entry: Omit<AuditEntry, 'ts'> & { ts?: number }) {
  const doc: AuditEntry = { ...entry, ts: entry.ts ?? Date.now() };
  return await insertOne<AuditEntry>(db().audit, doc);
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  return await findMany<AuditEntry>(db().audit, {}, { sort: { ts: -1 }, limit });
}
