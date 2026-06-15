import type {
  DailyReport,
  DailyReportCalendarItem,
  DailyReportItem,
  DailyReportTaskItem,
} from '../shared/types';
import { kvGet, kvList, kvUpsert } from './kv';

export async function saveDailyReport(report: DailyReport) {
  await kvUpsert('dailyReport', report._id, report);
  return report;
}

export async function getDailyReport(id: string) {
  const report = await kvGet<DailyReport>('dailyReport', id);
  return report ? migrateDailyReport(report) : null;
}

export async function getLatestDailyReport(kind?: DailyReport['kind']) {
  const reports = await kvList<DailyReport>('dailyReport');
  const matching = kind ? reports.filter((report) => report.kind === kind) : reports;
  matching.sort((a, b) => b.generatedAt - a.generatedAt);
  return matching[0] ? migrateDailyReport(matching[0]) : null;
}

export async function listDailyReports(limit = 20) {
  const reports = await kvList<DailyReport>('dailyReport', { limit: Math.max(limit, 1000) });
  reports.sort((a, b) => b.generatedAt - a.generatedAt);
  return reports.slice(0, limit).map(migrateDailyReport);
}

// Daily reports are stored as opaque payloads, so editions written before a
// field existed (the redesign added lanes/tracking; later work added tasks,
// calendar, progressive `status`, and the `needsReply`→`replyOwed` rename) come
// back missing keys the rich report page now reads. This upgrades any stored
// report to the current shape on read so old and new editions render — and list
// in history — identically. Pure (no write-back): a read must not mutate.
function migrateDailyReport(raw: DailyReport): DailyReport {
  const sections = (raw.sections ?? {}) as Partial<DailyReport['sections']>;
  const items = (value: unknown): DailyReportItem[] => (Array.isArray(value) ? value : []);
  const tasks = (Array.isArray(sections.tasks) ? sections.tasks : []) as DailyReportTaskItem[];
  const calendar = (Array.isArray(sections.calendar) ? sections.calendar : []) as DailyReportCalendarItem[];

  const replyOwed = items(sections.replyOwed);
  const followUpOwed = items(sections.followUpOwed);
  const newPeople = items(sections.newPeople);
  const timeSensitive = items(sections.timeSensitive);
  const tracked = items(sections.tracked);
  const fyi = items(sections.fyi);
  const bulkTail = items(sections.bulkTail);

  const stats = (raw.stats ?? {}) as Partial<DailyReport['stats']>;
  // Prefer stored counts; fall back to deriving them from the sections so a
  // legacy doc that predates a given stat still shows a truthful number.
  const replyOwedCount = stats.replyOwed ?? stats.needsReply ?? replyOwed.length;
  const openTasks = stats.openTasks ?? tasks.filter((task) => !task.completedAt).length;
  const completedTasks = stats.completedTasks ?? tasks.filter((task) => task.completedAt).length;

  return {
    _id: raw._id,
    kind: raw.kind ?? 'manual',
    generatedAt: raw.generatedAt ?? 0,
    status: raw.status ?? 'ready',
    progress: raw.progress,
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    title: raw.title ?? 'Daily Report',
    narrative: raw.narrative ?? '',
    html: typeof raw.html === 'string' ? raw.html : undefined,
    artifactStatus: raw.artifactStatus,
    sections: {
      replyOwed,
      followUpOwed,
      newPeople,
      timeSensitive,
      tracked,
      fyi,
      bulkTail,
      tasks,
      calendar,
      noiseSummary: typeof sections.noiseSummary === 'string' ? sections.noiseSummary : undefined,
    },
    stats: {
      scannedThreads: stats.scannedThreads ?? 0,
      trackedThreads: stats.trackedThreads ?? tracked.length,
      needsReply: stats.needsReply ?? replyOwedCount,
      replyOwed: replyOwedCount,
      dueSoon: stats.dueSoon ?? timeSensitive.length,
      bulkTailCount: stats.bulkTailCount ?? bulkTail.length,
      unread: stats.unread ?? 0,
      openTasks,
      completedTasks,
      calendarEvents: stats.calendarEvents ?? calendar.length,
    },
    model: raw.model,
    errors: Array.isArray(raw.errors) ? raw.errors : undefined,
  };
}
