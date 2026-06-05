import { z } from 'zod';
import { listAudit, writeAudit } from '../store/audit';
import { defineTool } from './registry';

export const logAction = defineTool({
  name: 'log_action',
  description: 'Write a free-form entry to the audit log (used for human notes).',
  category: 'audit',
  mutating: true,
  input: z.object({
    tool: z.string(),
    account: z.string().nullable().optional(),
    detail: z.string().optional(),
    args: z.record(z.string(), z.any()).optional(),
    result: z.enum(['ok', 'error']).default('ok'),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ tool, account, detail, args, result }) {
    await writeAudit({
      tool,
      account: account ?? null,
      args: args || {},
      result,
      detail,
      agent: 'user',
    });
    return { ok: true };
  },
});

export const listAuditEntries = defineTool({
  name: 'list_audit',
  description: 'Return the N most recent audit entries.',
  category: 'audit',
  mutating: false,
  input: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
  output: z.object({ entries: z.array(z.any()) }),
  async handler({ limit }) {
    return { entries: await listAudit(limit) };
  },
});
