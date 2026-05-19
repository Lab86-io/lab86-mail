/**
 * In-memory pending-send queue for "Undo Send" support.
 * A user (or the AI agent) can queue a send with a small delay (e.g. 15 s);
 * during that window, cancelPending(id) aborts the actual Gmail submission.
 */

type PendingTask = {
  id: string;
  fireAt: number;
  cancelled: boolean;
  run: () => Promise<void>;
};

const tasks = new Map<string, PendingTask>();

export function queueSend(id: string, delayMs: number, run: () => Promise<void>) {
  const fireAt = Date.now() + Math.max(0, delayMs);
  const task: PendingTask = { id, fireAt, cancelled: false, run };
  tasks.set(id, task);
  setTimeout(async () => {
    if (task.cancelled) return;
    try {
      await task.run();
    } finally {
      tasks.delete(id);
    }
  }, delayMs);
}

export function cancelPending(id: string): boolean {
  const t = tasks.get(id);
  if (!t) return false;
  t.cancelled = true;
  tasks.delete(id);
  return true;
}

export function listPending() {
  return [...tasks.values()].map((t) => ({ id: t.id, fireAt: t.fireAt }));
}
