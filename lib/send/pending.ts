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
  timerId: ReturnType<typeof setTimeout>;
};

const tasks = new Map<string, PendingTask>();

export function queueSend(id: string, delayMs: number, run: () => Promise<void>) {
  // Re-queueing the same id replaces the earlier send entirely; without this
  // the old timer would still fire and the message would go out twice.
  const existing = tasks.get(id);
  if (existing) {
    existing.cancelled = true;
    clearTimeout(existing.timerId);
  }
  const fireAt = Date.now() + Math.max(0, delayMs);
  const timerId = setTimeout(async () => {
    const task = tasks.get(id);
    if (!task || task.cancelled || task.timerId !== timerId) return;
    try {
      await task.run();
    } finally {
      tasks.delete(id);
    }
  }, Math.max(0, delayMs));
  tasks.set(id, { id, fireAt, cancelled: false, run, timerId });
}

export function cancelPending(id: string): boolean {
  const t = tasks.get(id);
  if (!t) return false;
  t.cancelled = true;
  clearTimeout(t.timerId);
  tasks.delete(id);
  return true;
}

export function listPending() {
  return [...tasks.values()].map((t) => ({ id: t.id, fireAt: t.fireAt }));
}
