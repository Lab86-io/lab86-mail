import { z } from 'zod';
import { listAudit } from '../store/audit';
import { defineTool } from './registry';

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
