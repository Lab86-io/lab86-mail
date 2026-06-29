import { categoricalColor } from './format';

export type TaskSourceColorInput = {
  cardId?: string | null;
  boardId?: string | null;
  source?: {
    accountId?: string | null;
    calendarId?: string | null;
    eventId?: string | null;
    providerEventId?: string | null;
    threadId?: string | null;
  } | null;
  sourceAccountId?: string | null;
  sourceCalendarEventId?: string | null;
  sourceThreadId?: string | null;
};

export function taskSourceColorKey(task: TaskSourceColorInput | null | undefined): string | null {
  if (!task) return null;
  return (
    clean(task.source?.accountId) ||
    clean(task.sourceAccountId) ||
    clean(task.source?.calendarId) ||
    clean(task.sourceCalendarEventId) ||
    clean(task.source?.eventId) ||
    clean(task.source?.providerEventId) ||
    clean(task.sourceThreadId) ||
    clean(task.source?.threadId) ||
    clean(task.boardId) ||
    clean(task.cardId)
  );
}

export function taskSourceColor(task: TaskSourceColorInput | null | undefined): string | null {
  const key = taskSourceColorKey(task);
  return key ? categoricalColor(key) : null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}
