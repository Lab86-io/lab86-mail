import type { AuditEntry } from '../shared/types';

// Audit entries are operational breadcrumbs, not user data: a structured
// console line (Railway captures stdout) is enough, and nothing persists
// across users or deploys. Arguments and detail stay out of the log.
export async function writeAudit(entry: Omit<AuditEntry, 'ts'> & { ts?: number }) {
  const doc: AuditEntry = { ...entry, ts: entry.ts ?? Date.now() };
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
