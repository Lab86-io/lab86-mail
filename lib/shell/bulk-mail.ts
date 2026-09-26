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
