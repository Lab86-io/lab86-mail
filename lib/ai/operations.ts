import { randomUUID } from 'node:crypto';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { getAiRequestContext } from './context';

// Act-then-undo framework (docs/productivity-platform-spec.md): every mutating
// productivity tool records the operation it applied together with a
// declarative inverse. Undo claims the row in Convex first (so double-clicks
// can't run an inverse twice), then dispatches to the executor registered for
// the inverse kind. Surfaces register their executors at module load
// (calendar in lib/calendar, tasks in lib/tasks).

export type OperationSurface = 'mail' | 'calendar' | 'tasks';

export interface InverseOp {
  kind: string;
  payload: any;
}

export interface RecordOperationInput {
  userId: string;
  // Defaults from the ambient AI request context when omitted.
  agent?: 'user' | 'ai';
  tool: string;
  surface: OperationSurface;
  summary: string;
  target: Record<string, unknown>;
  inverse?: InverseOp;
  batchId?: string;
  chatId?: string;
}

type UndoExecutor = (payload: any, ctx: { userId: string }) => Promise<void>;

const undoExecutors = new Map<string, UndoExecutor>();

export function registerUndoExecutor(kind: string, executor: UndoExecutor) {
  if (undoExecutors.has(kind)) {
    throw new Error(`Undo executor already registered for "${kind}".`);
  }
  undoExecutors.set(kind, executor);
}

// Batch ids group every operation of one agent turn into a single reviewable
// change-set in the UI.
export function newOperationBatchId() {
  return `batch_${randomUUID()}`;
}

export async function recordOperation(input: RecordOperationInput): Promise<string> {
  if (input.inverse && !undoExecutors.has(input.inverse.kind)) {
    // Catch typos at write time, not when the user reaches for undo.
    throw new Error(`No undo executor registered for inverse kind "${input.inverse.kind}".`);
  }
  const ctx = getAiRequestContext();
  return convexMutation<string>(api.operations.record, {
    ...input,
    agent: input.agent ?? (ctx.agent === 'user' ? 'user' : 'ai'),
    batchId: input.batchId ?? ctx.operationBatchId,
    chatId: input.chatId ?? ctx.chatId,
  });
}

export async function listRecentOperations(userId: string, opts?: { batchId?: string; limit?: number }) {
  return convexQuery<any[]>(api.operations.listRecent, {
    userId,
    batchId: opts?.batchId,
    limit: opts?.limit,
  });
}

export async function undoOperation(userId: string, operationId: string) {
  const claimed = await convexMutation<{
    tool: string;
    surface: OperationSurface;
    summary: string;
    inverse: InverseOp;
  }>(api.operations.claimUndo, { userId, operationId });
  const executor = undoExecutors.get(claimed.inverse.kind);
  if (!executor) {
    await convexMutation(api.operations.markUndoFailed, {
      userId,
      operationId,
      error: `No undo executor for "${claimed.inverse.kind}".`,
    });
    throw new Error(`This operation can no longer be undone (${claimed.inverse.kind}).`);
  }
  try {
    await executor(claimed.inverse.payload, { userId });
  } catch (err: any) {
    await convexMutation(api.operations.markUndoFailed, {
      userId,
      operationId,
      error: err?.message || 'Undo failed.',
    }).catch(() => {});
    throw err;
  }
  return { undone: claimed.summary, surface: claimed.surface };
}
