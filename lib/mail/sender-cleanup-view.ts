// Client helpers for the sender cleanup list (components/inbox/SenderCleanup).

/** One batch id for a batch block, so Activity reads it as one change-set. */
export function newCleanupBatchId() {
  return `batch_${globalThis.crypto.randomUUID()}`;
}

/** The toasts after a batch block: what was blocked, and what failed. */
export function senderCleanupSummary(outcome: { blocked: string[]; failed: string[]; archived: number }) {
  const blocked = outcome.blocked.length;
  const failed = outcome.failed.length;
  const senders = (count: number) => `${count} ${count === 1 ? 'sender' : 'senders'}`;
  const threads = outcome.archived
    ? ` ${outcome.archived} ${outcome.archived === 1 ? 'thread' : 'threads'} left the inbox.`
    : '';
  return {
    success: blocked ? `Blocked ${blocked === 1 ? outcome.blocked[0] : senders(blocked)}.${threads}` : null,
    error: failed
      ? `Could not block ${failed === 1 ? outcome.failed[0] : senders(failed)}. Try again.`
      : null,
  };
}
