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
  console.log(
    `[audit] ${JSON.stringify({
      ts: doc.ts,
      tool: doc.tool,
      userId: doc.userId,
      account: doc.account,
      result: doc.result,
      agent: doc.agent,
      args: doc.args === undefined ? undefined : '[REDACTED]',
      detail: doc.detail === undefined ? undefined : '[REDACTED]',
    })}`,
  );
  return doc;
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  const { userId } = getAiRequestContext();
  if (!userId) return [];
  return ring
    .filter((entry) => entry.userId === userId)
    .slice(-limit)
    .reverse();
}
