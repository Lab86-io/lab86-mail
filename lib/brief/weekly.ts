import { getAiRequestContext } from '../ai/context';
import { api, convexQuery } from '../hosted/convex';
import { hasObligation, jevReason } from '../jev/contract';
import { resolveBriefTimezone } from '../mail/brief-timezone';
import { loadCalendarContext, loadTaskContext } from '../mail/daily-report';
import { normalizeBriefTimezone } from '../shared/brief-edition';
import { shortFrom } from '../shared/format';
import type { DailyReport, DailyReportItem, Thread } from '../shared/types';
import { saveDailyReport } from '../store/daily-reports';
import {
  composeWeeklyReviewDocument,
  nextMondayMorning,
  WEEKLY_LIST_LIMIT,
  WEEKLY_REVIEW_TITLE,
  type WeeklyDoneItem,
} from './weekly-document';

// The weekly review generator (FEATURES item 9). It reads the week from
// Convex (completions, Jev attention, tasks, calendar), stores the edition,
// and composes it with lib/brief/weekly-document.ts. It makes no model call.

const WEEK_MS = 7 * 86_400_000;

function threadItem(thread: Thread): DailyReportItem {
  const reason = thread.jev ? jevReason(thread.jev) : '';
  const sender = shortFrom(thread.fromAddress || '') || undefined;
  return {
    account: thread.account,
    threadId: thread._id,
    subject: thread.subject || '(no subject)',
    people: sender ? [sender] : [],
    whyItMatters: reason,
    unread: Boolean(thread.unread),
    receivedAt: thread.lastDate || null,
    ...(sender ? { sender } : {}),
    ...(thread.jev ? { jev: thread.jev } : {}),
  };
}

const defaults = {
  loadCompletions: (userId: string, since: number) =>
    convexQuery<any[]>(api.albatrossWork.completionsSince, { userId, since, limit: 40 }),
  loadAttention: (userId: string) => convexQuery<Thread[]>(api.jev.attentionCandidates, { userId }),
  loadTasks: loadTaskContext,
  loadCalendar: loadCalendarContext,
  save: saveDailyReport,
  timezone: (userId: string) => resolveBriefTimezone(userId, getAiRequestContext().userTimezone),
};

export async function generateWeeklyReview(
  input: { userId: string; reportId: string; now?: number },
  deps = defaults,
): Promise<DailyReport> {
  const now = input.now ?? Date.now();
  const timezone = normalizeBriefTimezone(await deps.timezone(input.userId).catch(() => undefined));
  const weekStart = now - WEEK_MS;
  const [completions, attention, tasks, calendar] = await Promise.all([
    deps.loadCompletions(input.userId, weekStart).catch(() => [] as any[]),
    deps.loadAttention(input.userId).catch(() => [] as Thread[]),
    deps.loadTasks(input.userId, now),
    deps.loadCalendar(input.userId, now),
  ]);
  const done: WeeklyDoneItem[] = [];
  const seen = new Set<string>();
  for (const row of completions || []) {
    const kind = row.artifactKind === 'task' ? 'task' : 'work';
    const id = String(row.artifactId || '');
    if (!id || seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    done.push({
      kind,
      id,
      title: String(row.title || '').slice(0, 240),
      completedAt: Number(row.completedAt || now),
      ...(row.areaId ? { areaId: String(row.areaId) } : {}),
    });
  }
  for (const task of tasks) {
    if (!task.completedAt || task.completedAt < weekStart || seen.has(`task:${task.cardId}`)) continue;
    seen.add(`task:${task.cardId}`);
    done.push({ kind: 'task', id: task.cardId, title: task.title, completedAt: task.completedAt });
  }
  done.sort((a, b) => b.completedAt - a.completedAt);
  const threads = (attention || []).sort((a, b) => Number(b.lastDate || 0) - Number(a.lastDate || 0));
  const owed = threads.filter(
    (thread) => hasObligation(thread.jev, 'reply') || hasObligation(thread.jev, 'action'),
  );
  const waiting = threads.filter(
    (thread) =>
      hasObligation(thread.jev, 'waiting') &&
      !hasObligation(thread.jev, 'reply') &&
      !hasObligation(thread.jev, 'action'),
  );
  const sections: DailyReport['sections'] = {
    replyOwed: [],
    followUpOwed: [],
    newPeople: [],
    timeSensitive: [],
    tracked: [],
    fyi: [],
    bulkTail: [],
    answer: owed.slice(0, WEEKLY_LIST_LIMIT).map(threadItem),
    today: [],
    know: [],
    overflow: [],
    waiting: waiting.slice(0, WEEKLY_LIST_LIMIT).map(threadItem),
    tasks: tasks.filter((task) => !task.completedAt),
    calendar,
    weekly: { weekStart, deferUntil: nextMondayMorning(now, timezone), done: done.slice(0, 20) },
  };
  const report: DailyReport = {
    _id: input.reportId,
    kind: 'weekly',
    generatedAt: now,
    status: 'ready',
    accounts: [...new Set(threads.map((thread) => thread.account))],
    title: WEEKLY_REVIEW_TITLE,
    narrative: '',
    sections,
    stats: {
      scannedThreads: threads.length,
      trackedThreads: 0,
      needsReply: owed.length,
      replyOwed: owed.length,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: 0,
      selected: sections.answer?.length ?? 0,
      openTasks: sections.tasks?.length ?? 0,
      completedTasks: done.filter((item) => item.kind === 'task').length,
      calendarEvents: calendar.length,
    },
    artifactStatus: 'ready',
    artifactSource: 'document-v2',
    model: 'local',
  };
  report.document = composeWeeklyReviewDocument(report, timezone);
  report.narrative = report.document.summary;
  report.prose = { lede: report.document.summary, weekAhead: '', model: 'local' };
  await deps.save(report);
  return report;
}
