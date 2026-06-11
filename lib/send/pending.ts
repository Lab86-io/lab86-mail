/**
 * Pending-send status helpers for "Undo Send".
 *
 * New compose sends use provider-side Nylas scheduled sends so the message and
 * attachments survive app restarts. The small in-memory queue remains for
 * legacy/agent callers that may still hold an older pending id.
 */

type PendingTask = {
  id: string;
  fireAt: number;
  cancelled: boolean;
  run: () => Promise<void>;
  timerId: ReturnType<typeof setTimeout>;
};

export type PendingStatus = 'pending' | 'sent' | 'failed' | 'cancelled' | 'unknown' | 'missing';

const tasks = new Map<string, PendingTask>();
const statuses = new Map<
  string,
  { status: Exclude<PendingStatus, 'missing'>; updatedAt: number; error?: string }
>();
const PROVIDER_SCHEDULE_MARKER = ':nylas-schedule:';

export function rememberPendingStatus(
  id: string,
  status: Exclude<PendingStatus, 'missing'>,
  error?: unknown,
) {
  statuses.set(id, {
    status,
    updatedAt: Date.now(),
    error: error instanceof Error ? error.message : typeof error === 'string' ? error : undefined,
  });
  setTimeout(() => {
    const current = statuses.get(id);
    if (current?.status === status) statuses.delete(id);
  }, 5 * 60_000);
}

export function makeProviderPendingId({
  userId,
  account,
  scheduleId,
  fireAt,
}: {
  userId: string;
  account: string;
  scheduleId: string;
  fireAt: number;
}) {
  const payload = Buffer.from(JSON.stringify({ account, scheduleId, fireAt }), 'utf8').toString('base64url');
  return `${userId}${PROVIDER_SCHEDULE_MARKER}${payload}`;
}

export function parseProviderPendingId(id: string, expectedUserId?: string) {
  const markerIndex = id.indexOf(PROVIDER_SCHEDULE_MARKER);
  if (markerIndex <= 0) return null;
  const userId = id.slice(0, markerIndex);
  if (expectedUserId && userId !== expectedUserId) return null;
  const payload = id.slice(markerIndex + PROVIDER_SCHEDULE_MARKER.length);
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      account?: unknown;
      scheduleId?: unknown;
      fireAt?: unknown;
    };
    if (
      typeof parsed.account !== 'string' ||
      typeof parsed.scheduleId !== 'string' ||
      typeof parsed.fireAt !== 'number'
    ) {
      return null;
    }
    return { userId, account: parsed.account, scheduleId: parsed.scheduleId, fireAt: parsed.fireAt };
  } catch {
    return null;
  }
}

export function queueSend(id: string, delayMs: number, run: () => Promise<void>) {
  // Re-queueing the same id replaces the earlier send entirely; without this
  // the old timer would still fire and the message would go out twice.
  const existing = tasks.get(id);
  if (existing) {
    existing.cancelled = true;
    clearTimeout(existing.timerId);
  }
  const fireAt = Date.now() + Math.max(0, delayMs);
  rememberPendingStatus(id, 'pending');
  const timerId = setTimeout(
    async () => {
      const task = tasks.get(id);
      if (!task || task.cancelled || task.timerId !== timerId) return;
      try {
        await task.run();
        rememberPendingStatus(id, 'sent');
      } catch (err) {
        rememberPendingStatus(id, 'failed', err);
      } finally {
        if (tasks.get(id) === task) tasks.delete(id);
      }
    },
    Math.max(0, delayMs),
  );
  tasks.set(id, { id, fireAt, cancelled: false, run, timerId });
}

export function cancelPending(id: string): boolean {
  const t = tasks.get(id);
  if (!t) return false;
  t.cancelled = true;
  clearTimeout(t.timerId);
  tasks.delete(id);
  rememberPendingStatus(id, 'cancelled');
  return true;
}

export function listPending() {
  return [...tasks.values()].map((t) => ({ id: t.id, fireAt: t.fireAt }));
}

export function getPendingStatus(id: string) {
  const task = tasks.get(id);
  if (task && !task.cancelled) return { status: 'pending' as const, fireAt: task.fireAt };
  const providerPending = parseProviderPendingId(id);
  if (providerPending) {
    const remembered = statuses.get(id);
    if (remembered && remembered.status !== 'pending') return remembered;
    if (Date.now() < providerPending.fireAt) {
      return { status: 'pending' as const, fireAt: providerPending.fireAt };
    }
    return remembered?.status === 'failed'
      ? remembered
      : { status: 'unknown' as const, updatedAt: Date.now() };
  }
  return statuses.get(id) || { status: 'missing' as const };
}
