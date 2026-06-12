import { z } from 'zod';
import { listRecentOperations, undoOperation } from '../ai/operations';
import { defineTool } from './registry';

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

export const listRecentOperationsTool = defineTool({
  name: 'list_recent_operations',
  description:
    'List recent mutating operations applied to mail, calendar, or tasks (most recent first). Each entry says what was changed and whether it can still be undone. Pass batchId to fetch one change-set.',
  category: 'audit',
  mutating: false,
  input: z.object({
    batchId: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ operations: z.array(z.any()) }),
  async handler(args, ctx) {
    const rows = await listRecentOperations(requireUserId(ctx.userId), {
      batchId: args.batchId,
      limit: args.limit,
    });
    return {
      operations: rows.map((row) => ({
        operationId: row._id,
        tool: row.tool,
        surface: row.surface,
        summary: row.summary,
        agent: row.agent,
        batchId: row.batchId,
        target: row.target,
        status: row.status,
        undoable: row.status === 'applied' && !!row.inverse,
        createdAt: row.createdAt,
      })),
    };
  },
});

export const undoOperationTool = defineTool({
  name: 'undo_operation',
  description:
    'Undo a previously applied operation by operationId (from list_recent_operations). Only operations whose undoable flag is true can be undone.',
  category: 'audit',
  mutating: true,
  input: z.object({ operationId: z.string() }),
  output: z.object({ ok: z.boolean(), undone: z.string() }),
  async handler(args, ctx) {
    const result = await undoOperation(requireUserId(ctx.userId), args.operationId);
    return { ok: true, undone: result.undone };
  },
});
