import { parseBriefEditionBudget } from '../brief/budget';
import { editorialPlanSchema } from '../brief/editorial';
import { applySinceOperationStates, loadOperationStates, sinceOperationIds } from '../brief/since';
import { buildTriageHandoffIndex } from '../brief/triage-index';
import { api, convexQuery } from '../hosted/convex';
import { isConvexConfigured } from '../hosted/env';
import { DEFAULT_JEV_PREFERENCES } from '../jev/contract';
import { type BriefHiddenItems, briefJevDigest, projectBriefMail } from '../jev/report';
import { loadJevPolicy, markJevBriefItems } from '../jev/service';
import { buildNativeDailyReportArtifact } from '../mail/report-artifact';
import { compositionFromReport } from '../shared/brief-composition';
import { parseBriefDocument } from '../shared/brief-document';
import { parseTriageHandoffs } from '../shared/triage-handoff';
import type { BriefEditionKind, Thread } from '../shared/types';
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
import { listDismissedDailyReportTasks, listDismissedDailyReportThreads } from './daily-report-dismissals';
import { kvGet, kvList, kvUpsert, requireStoreUserId } from './kv';
import { listTrackedThreads } from './tracked-threads';

const saveDefaults = {
  persist: kvUpsert,
  configured: isConvexConfigured,
  owner: requireStoreUserId,
  mark: markJevBriefItems,
};
// Convex rejects a document over 1 MiB. The stored edition must stay below
// this, with room for the row's other fields; above it the edition degrades.
export const DAILY_REPORT_STORED_BYTE_LIMIT = 900_000;
const OVERSIZE_NOTE = 'This edition was too large to store in full, so some detail was left out.';

function storedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// Overflow items only need their identity and line to render. Of `jev`, only
// the digest that the live projection reads stays (see briefJevDigest).
function slimOverflowItem(item: DailyReportItem): DailyReportItem {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject,
    people: [],
    whyItMatters: item.whyItMatters,
    unread: item.unread,
    ...(item.line ? { line: item.line } : {}),
    ...(item.sender ? { sender: item.sender } : {}),
    ...(item.receivedAt != null ? { receivedAt: item.receivedAt } : {}),
    ...(item.dueAt != null ? { dueAt: item.dueAt } : {}),
    ...(item.score != null ? { score: item.score } : {}),
    ...(item.budgetLane ? { budgetLane: item.budgetLane } : {}),
    ...(item.lane ? { lane: item.lane } : {}),
    ...(item.trackedThreadId ? { trackedThreadId: item.trackedThreadId } : {}),
    ...(item.firstSurfacedAt != null ? { firstSurfacedAt: item.firstSurfacedAt } : {}),
    ...(item.inInbox ? { inInbox: true } : {}),
    ...(item.senderEmail ? { senderEmail: item.senderEmail } : {}),
    ...(item.jev ? { jev: briefJevDigest(item.jev) } : {}),
  };
}

/**
 * The form of an edition that goes to storage. A document-v2 edition does not
 * store the legacy `html`, `composition`, and `handoffs`: every reader goes
 * through migrateDailyReport, which rebuilds them from the sections. Above
 * DAILY_REPORT_STORED_BYTE_LIMIT the edition degrades step by step instead of
 * failing the save.
 */
export function dailyReportForStorage(report: DailyReport): DailyReport {
  if (report.artifactSource !== 'document-v2' || !report.document) return report;
  const { html: _html, composition: _composition, handoffs: _handoffs, ...rest } = report;
  let stored: DailyReport = {
    ...rest,
    sections: { ...rest.sections, overflow: rest.sections.overflow?.map(slimOverflowItem) },
  };
  if (!rest.sections.overflow) delete stored.sections.overflow;
  if (storedBytes(stored) <= DAILY_REPORT_STORED_BYTE_LIMIT) return stored;
  const note = { stage: 'document_v2' as const, message: OVERSIZE_NOTE, at: Date.now() };
  const degrade = [
    // The overflow list is the least important content; its count stays in stats.
    (value: DailyReport): DailyReport => ({ ...value, sections: { ...value.sections, overflow: [] } }),
    // The legacy lanes repeat the budget lanes for older readers.
    (value: DailyReport): DailyReport => ({
      ...value,
      sections: { ...value.sections, replyOwed: [], followUpOwed: [], timeSensitive: [], tracked: [] },
    }),
    // Last: drop the composed page; readers rebuild the source letter from sections.
    (value: DailyReport): DailyReport => {
      const { document: _document, editorial: _editorial, ...withoutPage } = value;
      return { ...withoutPage, artifactSource: 'deterministic', artifactStatus: 'rendered' };
    },
  ];
  for (const step of degrade) {
    stored = step(stored);
    if (storedBytes(stored) <= DAILY_REPORT_STORED_BYTE_LIMIT) break;
  }
  return {
    ...stored,
    artifactErrors: [...(stored.artifactErrors || []), note].slice(-MAX_ARTIFACT_ERRORS),
  };
}

export async function saveDailyReport(report: DailyReport, dependencies = saveDefaults) {
  await dependencies.persist('dailyReport', report._id, dailyReportForStorage(report));
  if (
    dependencies.configured() &&
    (report.artifactStatus === 'rendered' || report.artifactStatus === 'ready')
  ) {
    try {
      await dependencies.mark(report, dependencies.owner());
    } catch {
      // Attention bookkeeping must not turn an already-persisted edition into a failed save.
    }
  }
  return report;
}

export async function getDailyReport(id: string) {
  const report = await kvGet<DailyReport>('dailyReport', id);
  return report ? migrateDailyReportForRead(report) : null;
}

export type DailyReportSummary = Pick<DailyReport, '_id' | 'kind' | 'generatedAt' | 'title'>;

// Saved brief dismissals (dismiss, resolve, archive) as hidden item sets.
async function loadBriefDismissals(): Promise<BriefHiddenItems> {
  const [threads, tasks] = await Promise.all([
    listDismissedDailyReportThreads(),
    listDismissedDailyReportTasks(),
  ]);
  return {
    threads: new Set(threads.map((row) => `${row.account}:${row.threadId}`)),
    tasks: new Set(tasks.map((row) => row.cardId).filter(Boolean)),
  };
}

// Tracked threads among `ids` that the user resolved or dismissed.
async function loadClosedTracked(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const wanted = new Set(ids);
  const rows = await listTrackedThreads({ includeResolved: true, limit: 1000 });
  return new Set(
    rows
      .filter((row) => wanted.has(row._id) && (row.status === 'resolved' || row.status === 'dismissed'))
      .map((row) => row._id),
  );
}

// The user's own addresses. A thread whose newest message is from one of them
// was answered after the edition.
async function loadSelfAddresses(userId: string): Promise<Set<string>> {
  const accounts = await convexQuery<Array<{ email?: string }>>(api.accounts.listConnectedAccounts, {
    userId,
  });
  return new Set((accounts || []).map((row) => String(row.email || '').toLowerCase()).filter(Boolean));
}

const readDefaults = {
  query: convexQuery,
  configured: isConvexConfigured,
  loadPolicy: loadJevPolicy,
  load: getDailyReport,
  loadDismissals: loadBriefDismissals,
  loadClosedTracked,
  loadSelfAddresses,
  loadOperationStates: (userId: string, ids: string[]) => loadOperationStates(userId, ids),
};
let readDependencies = readDefaults;
export function setDailyReportReaderForTest(overrides: Partial<typeof readDefaults> = {}) {
  readDependencies = { ...readDefaults, ...overrides };
}

async function readReportRows<T>(
  limit: number,
  summaryOnly: boolean,
  edition?: BriefEditionKind,
): Promise<T[]> {
  const count = Math.min(100, Math.max(1, Math.floor(limit)));
  if (!readDependencies.configured()) {
    const reports = await kvList<DailyReport>('dailyReport');
    return reports
      .filter((report) => !edition || report.kind === edition)
      .sort((a, b) => b.generatedAt - a.generatedAt)
      .slice(0, count)
      .map((report) =>
        summaryOnly
          ? {
              _id: report._id,
              kind: report.kind,
              generatedAt: report.generatedAt,
              title: report.title,
              artifactStatus: report.artifactStatus,
              editorial: report.editorial ? { mode: report.editorial.mode } : undefined,
            }
          : report,
      ) as T[];
  }
  const userId = requireStoreUserId();
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const result: { page: T[]; continueCursor: string; isDone: boolean } = await readDependencies.query(
      api.userData.dailyReportPage,
      { userId, edition, cursor, limit: Math.min(8, count - rows.length), summaryOnly },
    );
    rows.push(...result.page);
    if (result.isDone || rows.length >= count) break;
    cursor = result.continueCursor;
  } while (cursor);
  return rows;
}

export async function getLatestDailyReport(kind?: BriefEditionKind, summaryFirst = false) {
  const rows = await readReportRows<DailyReport>(1, summaryFirst, kind);
  const latest = rows[0];
  if (!latest) return null;
  const report = summaryFirst
    ? await readDependencies.load(latest._id)
    : await migrateDailyReportForRead(latest);
  if (!report) return null;
  if (!readDependencies.configured()) return report;
  const lanes: Partial<DailyReport['sections']> = report.sections ?? {};
  const trackedIds = [
    ...new Set(
      [
        ...(lanes.answer || []),
        ...(lanes.today || []),
        ...(lanes.know || []),
        ...(lanes.waiting || []),
        ...(lanes.overflow || []),
      ]
        .map((item) => item.trackedThreadId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const [dismissals, closedTracked] = await Promise.all([
    readDependencies.loadDismissals().catch((): BriefHiddenItems => ({})),
    readDependencies.loadClosedTracked(trackedIds).catch(() => new Set<string>()),
  ]);
  const hidden: BriefHiddenItems = { ...dismissals, closedTracked };
  // Dismissals apply to any latest edition; live mail facts only to a fresh one.
  if (Date.now() - report.generatedAt > 24 * 3600_000)
    return withLiveSince(
      projectBriefMail(
        report,
        [],
        { preferences: DEFAULT_JEV_PREFERENCES, corrections: [] },
        Date.now(),
        hidden,
      ),
    );
  const items = [
    ...(report.sections.answer || []),
    ...(report.sections.today || []),
    ...(report.sections.know || []),
    ...(report.sections.overflow || []),
    ...(report.sections.waiting || []),
  ];
  try {
    const userId = requireStoreUserId();
    const [policy, threads, arrivals, selfAddresses] = await Promise.all([
      readDependencies.loadPolicy(userId),
      readDependencies.query<Thread[]>(api.jev.threadAssessments, {
        userId,
        threads: items.slice(0, 300).map((item) => ({ accountId: item.account, threadId: item.threadId })),
      }),
      readDependencies
        .query<Thread[]>(api.jev.liveBriefCandidates, {
          userId,
          since: report.generatedAt,
          accountIds: report.accounts,
        })
        .catch(() => []),
      readDependencies.loadSelfAddresses(userId).catch(() => new Set<string>()),
    ]);
    return withLiveSince(
      projectBriefMail(
        report,
        [
          ...new Map(
            [...(Array.isArray(threads) ? threads : []), ...(Array.isArray(arrivals) ? arrivals : [])].map(
              (thread) => [`${thread.account}:${thread._id}`, thread],
            ),
          ).values(),
        ],
        policy,
        Date.now(),
        { ...hidden, selfAddresses },
      ),
    );
  } catch {
    return withLiveSince(
      projectBriefMail(
        report,
        [],
        { preferences: DEFAULT_JEV_PREFERENCES, corrections: [] },
        Date.now(),
        hidden,
      ),
    );
  }
}

// An operation the user undid since the edition leaves its look back.
async function withLiveSince(report: DailyReport): Promise<DailyReport> {
  const ids = sinceOperationIds(report);
  if (!ids.length) return report;
  try {
    return applySinceOperationStates(
      report,
      await readDependencies.loadOperationStates(requireStoreUserId(), ids),
    );
  } catch {
    return report;
  }
}

export async function listDailyReports(limit = 20) {
  const reports = await readReportRows<DailyReport>(limit, false);
  return Promise.all(reports.map((report) => migrateDailyReportForRead(report)));
}

export async function listDailyReportSummaries(limit = 20) {
  return readReportRows<DailyReportSummary>(limit, true);
}

async function migrateDailyReportForRead(raw: DailyReport): Promise<DailyReport> {
  return migrateDailyReport(raw);
}

// Daily reports are stored as opaque payloads, so editions written before a
// field existed (the redesign added lanes/tracking; later work added tasks,
// calendar, progressive `status`, and the `needsReply`→`replyOwed` rename) come
// back missing keys the rich report page now reads. This upgrades any stored
// report to the current shape so old and new editions render — and list in
// history — identically. Reading never changes the generation lifecycle.
// Exported for unit tests only; production callers go through the getters.
export function migrateDailyReport(raw: DailyReport, _now: number = Date.now()): DailyReport {
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
  const editorialPlan = editorialPlanSchema.safeParse(raw.editorial?.plan);
  // Prefer stored counts; fall back to deriving them from the sections so a
  // legacy doc that predates a given stat still shows a truthful number.
  const replyOwedCount = stats.replyOwed ?? stats.needsReply ?? replyOwed.length;
  const openTasks = stats.openTasks ?? tasks.filter((task) => !task.completedAt).length;
  const completedTasks = stats.completedTasks ?? tasks.filter((task) => task.completedAt).length;

  const migrated: DailyReport = {
    _id: raw._id,
    kind: raw.kind ?? 'manual',
    ...(raw.light === true ? { light: true } : {}),
    ...(raw.first === true ? { first: true } : {}),
    generatedAt: raw.generatedAt ?? 0,
    status: raw.status ?? 'ready',
    progress: raw.progress,
    ...(raw.retrying === true ? { retrying: true } : {}),
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    services: Array.isArray(raw.services) ? raw.services : undefined,
    ...(Array.isArray(raw.sourceChecks)
      ? {
          sourceChecks: raw.sourceChecks
            .filter((check) => typeof check?.source === 'string')
            .slice(0, 24)
            .map((check) => ({
              source: check.source,
              status: check.status === 'unavailable' ? ('unavailable' as const) : ('checked' as const),
            })),
        }
      : {}),
    title: raw.title ?? 'Daily Report',
    narrative: raw.narrative ?? '',
    tier: raw.tier === 'free' || raw.tier === 'pro' || raw.tier === 'team' ? raw.tier : undefined,
    ...(raw.budget ? { budget: parseBriefEditionBudget(raw.budget) } : {}),
    ...(typeof raw.emailedAt === 'number' ? { emailedAt: raw.emailedAt } : {}),
    prose:
      raw.prose && typeof raw.prose === 'object'
        ? {
            lede: String(raw.prose.lede ?? ''),
            weekAhead: String(raw.prose.weekAhead ?? ''),
            ...(typeof raw.prose.yesterday === 'string' ? { yesterday: raw.prose.yesterday } : {}),
            model: String(raw.prose.model ?? 'local'),
          }
        : undefined,
    handoffs: parseTriageHandoffs(raw.handoffs),
    composition: raw.composition,
    document: migrateBriefDocument(raw.document),
    ...(editorialPlan.success
      ? {
          editorial: {
            plan: editorialPlan.data,
            mode: raw.editorial?.mode === 'generated' ? ('generated' as const) : ('fallback' as const),
          },
        }
      : {}),
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
      // Budget lanes (2026-09-03). Absent on older editions; readers treat a
      // missing lane as empty.
      ...(Array.isArray(sections.answer) ? { answer: items(sections.answer) } : {}),
      ...(Array.isArray(sections.today) ? { today: items(sections.today) } : {}),
      ...(Array.isArray(sections.know) ? { know: items(sections.know) } : {}),
      ...(Array.isArray(sections.overflow) ? { overflow: items(sections.overflow) } : {}),
      ...(Array.isArray(sections.waiting) ? { waiting: items(sections.waiting) } : {}),
      ...(sections.since ? { since: sections.since } : {}),
      ...(sections.weekly ? { weekly: sections.weekly } : {}),
      tasks,
      calendar,
      mcp,
      // Area context is durable report content, not a render-only decoration.
      // Preserve it across read migration so both desktop and native can add
      // the same Area brief to the stored artifact without rebuilding current
      // context or mutating report history.
      albatross: sections.albatross,
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
      ...(typeof stats.noise === 'number' ? { noise: stats.noise } : {}),
      ...(typeof stats.selected === 'number' ? { selected: stats.selected } : {}),
      ...(typeof stats.overflow === 'number' ? { overflow: stats.overflow } : {}),
      openTasks,
      completedTasks,
      calendarEvents: stats.calendarEvents ?? calendar.length,
      albatrossActiveIntents: stats.albatrossActiveIntents,
      albatrossActiveProjects: stats.albatrossActiveProjects,
      albatrossQuestions: stats.albatrossQuestions,
    },
    model: raw.model,
    errors: Array.isArray(raw.errors) ? raw.errors : undefined,
  };

  if (!migrated.handoffs?.length) {
    migrated.handoffs = buildTriageHandoffIndex(migrated);
  }

  if (!migrated.composition && migrated.status !== 'partial') {
    migrated.composition = compositionFromReport(migrated);
  }

  if (!migrated.html && migrated.status !== 'partial') {
    migrated.html = buildNativeDailyReportArtifact(migrated, migrated.composition);
    migrated.artifactStatus = migrated.artifactStatus ?? 'rendered';
    migrated.artifactSource = migrated.artifactSource ?? 'deterministic';
  }

  return migrated;
}

function migrateBriefDocument(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  return parseBriefDocument(value);
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
