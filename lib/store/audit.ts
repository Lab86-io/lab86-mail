import { getAiRequestContext } from '../ai/context';
import type { AuditEntry } from '../shared/types';

// Audit entries are operational breadcrumbs, not user data: a per-process
// ring buffer plus a structured console line (Railway captures stdout) is
// enough, and nothing persists across users or deploys. Reads are filtered
// to the requesting user.
const RING_MAX = 500;
const ring: AuditEntry[] = [];

export async function writeAudit(entry: Omit<AuditEntry, 'ts'> & { ts?: number }) {
  const doc: AuditEntry = { ...entry, ts: entry.ts ?? Date.now() };
  ring.push(doc);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  console.log(`[audit] ${JSON.stringify(doc)}`);
  return doc;
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  const { userId } = getAiRequestContext();
  return ring
    .filter((entry) => !userId || entry.userId === userId)
    .slice(-limit)
    .reverse();
}
