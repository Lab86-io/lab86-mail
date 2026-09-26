/**
 * Bulk archive and trash run one request per thread. Some can fail while
 * the rest succeed, so the result is counted, not a single pass or fail.
 */
export type BulkMailOutcome = { succeeded: string[]; failed: string[] };

export async function settleBulk(
  ids: string[],
  run: (id: string) => Promise<unknown>,
): Promise<BulkMailOutcome> {
  const results = await Promise.allSettled(ids.map((id) => run(id)));
  const outcome: BulkMailOutcome = { succeeded: [], failed: [] };
  results.forEach((result, index) => {
    (result.status === 'fulfilled' ? outcome.succeeded : outcome.failed).push(ids[index]);
  });
  return outcome;
}

/** One bulk_move_threads request takes at most this many threads. */
export const BULK_MOVE_CHUNK = 100;

export type BulkMoveResponse = {
  moved: Array<{ account: string; threadId: string }>;
  failed: Array<{ account: string; threadId: string; error?: string }>;
  operationId?: string;
};

/**
 * Moves row keys (`account:threadId`) with bulk_move_threads, one request per
 * chunk, so the whole selection is one Activity entry per chunk with one Undo.
 * A chunk that fails as a request counts all its rows as failed.
 */
export async function runBulkMove(
  keys: string[],
  resolve: (key: string) => { account: string; threadId: string },
  call: (items: Array<{ account: string; threadId: string }>) => Promise<BulkMoveResponse>,
): Promise<BulkMailOutcome & { operationIds: string[] }> {
  const outcome: BulkMailOutcome & { operationIds: string[] } = {
    succeeded: [],
    failed: [],
    operationIds: [],
  };
  for (let index = 0; index < keys.length; index += BULK_MOVE_CHUNK) {
    const group = keys.slice(index, index + BULK_MOVE_CHUNK);
    const items = group.map(resolve);
    try {
      const response = await call(items);
      const moved = new Set((response.moved || []).map((item) => `${item.account}:${item.threadId}`));
      group.forEach((key, position) => {
        const item = items[position];
        (moved.has(`${item.account}:${item.threadId}`) ? outcome.succeeded : outcome.failed).push(key);
      });
      if (response.operationId) outcome.operationIds.push(response.operationId);
    } catch {
      outcome.failed.push(...group);
    }
  }
  return outcome;
}

export function bulkMailMessages(
  action: 'archive' | 'trash',
  outcome: BulkMailOutcome,
): { success: string | null; error: string | null } {
  const done = outcome.succeeded.length;
  const failed = outcome.failed.length;
  const noun = (count: number) => (count === 1 ? 'thread' : 'threads');
  const moved =
    action === 'archive' ? `Archived ${done} ${noun(done)}` : `Moved ${done} ${noun(done)} to Trash`;
  return {
    success: done ? moved : null,
    error: failed
      ? `Could not ${action === 'archive' ? 'archive' : 'trash'} ${failed} ${noun(failed)}. ${failed === 1 ? 'It is' : 'They are'} back in the list.`
      : null,
  };
}
