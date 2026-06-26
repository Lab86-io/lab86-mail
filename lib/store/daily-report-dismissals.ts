import { kvList, kvUpsert } from './kv';

const KIND = 'dailyReportTaskDismissal';
const REF = 'task';
const THREAD_KIND = 'dailyReportThreadDismissal';
const THREAD_REF = 'thread';

export interface DailyReportTaskDismissal {
  cardId: string;
  title?: string;
  dismissedAt: number;
}

export interface DailyReportThreadDismissal {
  account: string;
  threadId: string;
  subject?: string;
  receivedAt?: number | null;
  dismissedAt: number;
  action: 'dismissed' | 'resolved';
}

export function dailyReportThreadKey(account: string, threadId: string) {
  return JSON.stringify([account, threadId]);
}

export async function dismissDailyReportTask(input: { cardId: string; title?: string }) {
  const cardId = input.cardId.trim();
  if (!cardId) throw new Error('cardId is required.');
  const dismissal: DailyReportTaskDismissal = {
    cardId,
    title: input.title?.trim() || undefined,
    dismissedAt: Date.now(),
  };
  await kvUpsert(KIND, cardId, dismissal, REF);
  return dismissal;
}

export async function listDismissedDailyReportTaskIds() {
  return new Set((await listDismissedDailyReportTasks()).map((row) => row.cardId).filter(Boolean));
}

export async function listDismissedDailyReportTasks() {
  return kvList<DailyReportTaskDismissal>(KIND, { ref: REF, limit: 1000 });
}

export async function dismissDailyReportThread(input: {
  account: string;
  threadId: string;
  subject?: string;
  receivedAt?: number | null;
  action?: 'dismissed' | 'resolved';
}) {
  const account = input.account.trim();
  const threadId = input.threadId.trim();
  if (!account) throw new Error('account is required.');
  if (!threadId) throw new Error('threadId is required.');
  const dismissal: DailyReportThreadDismissal = {
    account,
    threadId,
    subject: input.subject?.trim() || undefined,
    receivedAt: typeof input.receivedAt === 'number' ? input.receivedAt : null,
    dismissedAt: Date.now(),
    action: input.action ?? 'dismissed',
  };
  await kvUpsert(THREAD_KIND, dailyReportThreadKey(account, threadId), dismissal, THREAD_REF);
  return dismissal;
}

export async function listDismissedDailyReportThreads() {
  return kvList<DailyReportThreadDismissal>(THREAD_KIND, { ref: THREAD_REF, limit: 1000 });
}
