/** Lifecycle wins over transient planning status, including legacy rows. */
export function workLifecycle(work: { workState?: string | null; status?: string | null }): string {
  return work.workState || (['done', 'archived'].includes(work.status || '') ? work.status! : 'active');
}

export function isTerminalWork(work: { workState?: string | null; status?: string | null }): boolean {
  return ['done', 'released', 'archived'].includes(workLifecycle(work));
}

export function assertWorkOpen(work: { workState?: string | null; status?: string | null }) {
  if (isTerminalWork(work)) throw new Error('This Albatross is closed. Reopen it before changing its plan.');
}
