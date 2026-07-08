import { buildNativeDailyReportArtifact } from '../mail/report-artifact';
import { compositionFromReport } from '../shared/brief-composition';
import {
  DAILY_REPORT_ARTIFACT_ERROR_STAGES,
  type DailyReport,
  type DailyReportArtifactError,
  type DailyReportArtifactErrorStage,
  type DailyReportCalendarItem,
  type DailyReportItem,
  type DailyReportMcpItem,
  type DailyReportTaskItem,
  MAX_ARTIFACT_ERROR_MESSAGE_CHARS,
  MAX_ARTIFACT_ERRORS,
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
  // NB: explicit arg — a bare `.map(migrateDailyReport)` passes the array
  // index as `now` and silently breaks settle-on-read.
  return reports.slice(0, limit).map((report) => migrateDailyReport(report));
}

// Generation runs in the web process; a deploy/restart mid-run (SIGTERM skips
// the catch paths) leaves an edition wedged at artifactStatus 'composing' or
// 'enriching' forever, so the report page keeps treating it as in-flight. Past
// this cutoff the run is certainly dead — content exists (both statuses are
// only persisted alongside an html artifact), so reads settle it to 'rendered'.
// Mirrors STUCK_GENERATION_MS in components/report/DailyReport.tsx and
// ACTIVE_GENERATION_MS in lib/tools/daily-report.ts.
const STUCK_ARTIFACT_MS = 20 * 60_000;

// Daily reports are stored as opaque payloads, so editions written before a
// field existed (the redesign added lanes/tracking; later work added tasks,
// calendar, progressive `status`, and the `needsReply`→`replyOwed` rename) come
// back missing keys the rich report page now reads. This upgrades any stored
// report to the current shape on read so old and new editions render — and list
// in history — identically. Pure (no write-back): a read must not mutate.
// Exported for unit tests only; production callers go through the getters.
export function migrateDailyReport(raw: DailyReport, now: number = Date.now()): DailyReport {
  const sections = (raw.sections ?? {}) as Partial<DailyReport['sections']>;
  const items = (value: unknown): DailyReportItem[] => (Array.isArray(value) ? value : []);
  const tasks = (Array.isArray(sections.tasks) ? sections.tasks : []) as DailyReportTaskItem[];
  const calendar = (Array.isArray(sections.calendar) ? sections.calendar : []) as DailyReportCalendarItem[];
  const mcp = (Array.isArray(sections.mcp) ? sections.mcp : []) as DailyReportMcpItem[];

  const replyOwed = items(sections.replyOwed);
  const followUpOwed = items(sections.followUpOwed);
  const newPeople = items(sections.newPeople);
  const timeSensitive = items(sections.timeSensitive);
  const tracked = items(sections.tracked);
  const fyi = items(sections.fyi);
  const bulkTail = items(sections.bulkTail);

  const stats = (raw.stats ?? {}) as Partial<DailyReport['stats']>;
  const artifactErrors = sanitizeArtifactErrors((raw as any).artifactErrors);
  // Prefer stored counts; fall back to deriving them from the sections so a
  // legacy doc that predates a given stat still shows a truthful number.
  const replyOwedCount = stats.replyOwed ?? stats.needsReply ?? replyOwed.length;
  const openTasks = stats.openTasks ?? tasks.filter((task) => !task.completedAt).length;
  const completedTasks = stats.completedTasks ?? tasks.filter((task) => task.completedAt).length;

  const migrated: DailyReport = {
    _id: raw._id,
    kind: raw.kind ?? 'manual',
    generatedAt: raw.generatedAt ?? 0,
    status: raw.status ?? 'ready',
    progress: raw.progress,
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    services: Array.isArray(raw.services) ? raw.services : undefined,
    title: raw.title ?? 'Daily Report',
    narrative: raw.narrative ?? '',
    composition: raw.composition,
    html: typeof raw.html === 'string' ? raw.html : undefined,
    artifactStatus: raw.artifactStatus,
    artifactSource: raw.artifactSource,
    artifactErrors: artifactErrors.length ? artifactErrors : undefined,
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
      mcp,
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

  if (!migrated.composition && migrated.status !== 'partial') {
    migrated.composition = compositionFromReport(migrated);
  }

  if (!migrated.html && migrated.status !== 'partial') {
    migrated.html = buildNativeDailyReportArtifact(migrated, migrated.composition);
    migrated.artifactStatus = migrated.artifactStatus ?? 'rendered';
    migrated.artifactSource = migrated.artifactSource ?? 'deterministic';
  }

  // Settle-on-read: a non-terminal artifact status from a generation that died
  // mid-flight (deploy/SIGTERM) settles to 'rendered' once it is clearly stale,
  // so consumers stop polling a run that will never finish. The html shown is
  // whatever the last completed phase persisted.
  if (
    (migrated.artifactStatus === 'composing' || migrated.artifactStatus === 'enriching') &&
    migrated.html &&
    now - (migrated.generatedAt || 0) > STUCK_ARTIFACT_MS
  ) {
    migrated.artifactStatus = 'rendered';
  }

  return migrated;
}

function sanitizeArtifactErrors(value: unknown): DailyReportArtifactError[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry: any) => ({
      stage: entry?.stage,
      message:
        typeof entry?.message === 'string' ? entry.message.slice(0, MAX_ARTIFACT_ERROR_MESSAGE_CHARS) : '',
      at: Number.isFinite(Number(entry?.at)) ? Number(entry.at) : 0,
    }))
    .filter(
      (entry): entry is DailyReportArtifactError =>
        DAILY_REPORT_ARTIFACT_ERROR_STAGES.includes(entry.stage as DailyReportArtifactErrorStage) &&
        Boolean(entry.message),
    )
    .slice(-MAX_ARTIFACT_ERRORS);
}
