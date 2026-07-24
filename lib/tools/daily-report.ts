import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { generateAgentReport } from '../mail/agent-report';
import { getDailyArt } from '../mail/daily-art';
import { injectReportAreaBrief } from '../mail/report-area-brief';
import type { DailyReport } from '../shared/types';
import {
  dailyReportThreadKey,
  dismissDailyReportTask,
  dismissDailyReportThread,
  listDismissedDailyReportTasks,
  listDismissedDailyReportThreads,
  restoreDailyReportTask,
  restoreDailyReportThread,
} from '../store/daily-report-dismissals';
import {
  getDailyReport as getDailyReportStore,
  getLatestDailyReport,
  listDailyReports as listDailyReportsStore,
  saveDailyReport,
} from '../store/daily-reports';
import { defineTool } from './registry';

const ReportKindSchema = z.enum(['morning', 'evening', 'manual']);
const ACTIVE_GENERATION_MS = 20 * 60_000;

export const generateDailyReportTool = defineTool({
  name: 'generate_daily_report',
  description:
    'Generate and store an in-app Daily Report from recent mail, tracked threads, and calendar context.',
  category: 'ai',
  mutating: true,
  input: z.object({
    kind: ReportKindSchema.default('manual'),
    // wait=false (default) starts generation and returns immediately; the
    // edition streams into get_latest_daily_report as a status:'partial' doc.
    wait: z.boolean().default(false),
  }),
  output: z.object({ report: z.any().nullable(), started: z.boolean().optional() }),
  async handler({ kind, wait }, ctx) {
    if (wait) {
      return { report: await generateAgentReport({ kind, userId: ctx.userId }) };
    }
    const active = await getActiveGeneration(kind);
    if (active) return { report: active, started: false };

    const reportId = randomUUID();
    const now = Date.now();
    await saveDailyReport({
      _id: reportId,
      kind,
      generatedAt: now,
      status: 'partial',
      progress: { stage: 'queued', done: 0, total: 1 },
      accounts: [],
      title: 'Daily Report',
      narrative: 'Generating daily report.',
      sections: {
        replyOwed: [],
        followUpOwed: [],
        newPeople: [],
        timeSensitive: [],
        tracked: [],
        fyi: [],
        bulkTail: [],
        tasks: [],
        calendar: [],
      },
      stats: {
        scannedThreads: 0,
        trackedThreads: 0,
        needsReply: 0,
        replyOwed: 0,
        dueSoon: 0,
        bulkTailCount: 0,
        unread: 0,
        openTasks: 0,
        completedTasks: 0,
        calendarEvents: 0,
      },
    } satisfies DailyReport);
    void generateAgentReport({ kind, userId: ctx.userId, reportId }).catch(
      console.error.bind(console, '[daily-report] background generation failed:'),
    );
    return { report: null, started: true };
  },
});

async function getActiveGeneration(kind: z.infer<typeof ReportKindSchema>) {
  const latest = await getLatestDailyReport(kind);
  if (!latest) return null;
  const age = Date.now() - Number(latest.generatedAt || 0);
  if (age > ACTIVE_GENERATION_MS) return null;
  if (latest.status === 'partial') return latest;
  if (latest.artifactStatus === 'composing' || latest.artifactStatus === 'enriching') return latest;
  return null;
}

export const getLatestDailyReportTool = defineTool({
  name: 'get_latest_daily_report',
  description: 'Get the latest stored Daily Report.',
  category: 'ai',
  mutating: false,
  input: z.object({ kind: ReportKindSchema.optional() }).optional(),
  output: z.object({ report: z.any().nullable() }),
  async handler(input) {
    const report = withDisplayAreaBrief(await getLatestDailyReport(input?.kind));
    return { report: report ? attachDailyReportArt(report) : null };
  },
});

// The stored artifact HTML is the raw edition; desktop injects the area brief at
// render time (components/report/DailyReport.tsx → injectReportAreaBrief). Return
// the same display artifact so native and desktop render identically. This clones
// before injecting (never mutates stored history) and is idempotent — a report
// whose html already carries the brief marker is returned untouched.
function withDisplayAreaBrief(report: DailyReport | null): DailyReport | null {
  const rawHtml = report?.html;
  const albatross = report?.sections?.albatross;
  if (!report || !rawHtml || !albatross) return report;
  const html = injectReportAreaBrief(rawHtml, albatross);
  return html === rawHtml ? report : { ...report, html };
}

// `art` mirrors the deterministic edition art desktop derives from
// generatedAt (components/report/DailyReport.tsx) so native surfaces render
// the same museum piece without their own art-pool logic. Always clones —
// never mutates the report object returned by the store — and `services`
// (already on DailyReport) passes through untouched via the spread.
function attachDailyReportArt<T extends DailyReport>(report: T): T & { art: ReturnType<typeof getDailyArt> } {
  return { ...report, art: getDailyArt(report.generatedAt) };
}

export const listDailyReportsTool = defineTool({
  name: 'list_daily_reports',
  description: 'List stored Daily Reports.',
  category: 'ai',
  mutating: false,
  input: z.object({ limit: z.number().int().min(1).max(100).default(20) }).optional(),
  output: z.object({ reports: z.array(z.any()) }),
  async handler(input) {
    const reports = await listDailyReportsStore(input?.limit || 20);
    return { reports: reports.map(attachDailyReportArt) };
  },
});

export const getDailyReportTool = defineTool({
  name: 'get_daily_report',
  description: 'Get a stored Daily Report by id.',
  category: 'ai',
  mutating: false,
  input: z.object({ id: z.string() }),
  output: z.object({ report: z.any().nullable() }),
  async handler({ id }) {
    const report = await getDailyReportStore(id);
    return { report: report ? attachDailyReportArt(report) : null };
  },
});

export const dismissDailyReportTaskTool = defineTool({
  name: 'dismiss_daily_report_task',
  description:
    'Remove a task card from future Daily Brief task sections without completing or deleting the underlying task.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    cardId: z.string().min(1),
    title: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), dismissal: z.any() }),
  async handler(args) {
    const dismissal = await dismissDailyReportTask(args);
    return { ok: true, dismissal };
  },
});

export const listDailyReportTaskDismissalsTool = defineTool({
  name: 'list_daily_report_task_dismissals',
  description: 'List task cards the user has removed from Daily Brief task sections.',
  category: 'tasks',
  mutating: false,
  input: z.object({}),
  output: z.object({ cardIds: z.array(z.string()), dismissals: z.array(z.any()) }),
  async handler() {
    const dismissals = await listDismissedDailyReportTasks();
    return {
      cardIds: dismissals.map((dismissal) => dismissal.cardId).filter(Boolean),
      dismissals,
    };
  },
});

export const dismissDailyReportThreadTool = defineTool({
  name: 'dismiss_daily_report_thread',
  description:
    'Remove or resolve a conversation from Daily Brief email sections until that thread receives newer mail.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string().min(1),
    threadId: z.string().min(1),
    subject: z.string().optional(),
    receivedAt: z.number().nullable().optional(),
    action: z.enum(['dismissed', 'resolved']).default('dismissed'),
  }),
  output: z.object({ ok: z.boolean(), dismissal: z.any() }),
  async handler(args) {
    const dismissal = await dismissDailyReportThread(args);
    return { ok: true, dismissal };
  },
});

export const listDailyReportThreadDismissalsTool = defineTool({
  name: 'list_daily_report_thread_dismissals',
  description: 'List conversations the user has removed or resolved from Daily Brief email sections.',
  category: 'mail',
  mutating: false,
  input: z.object({}),
  output: z.object({ threadKeys: z.array(z.string()), dismissals: z.array(z.any()) }),
  async handler() {
    const dismissals = await listDismissedDailyReportThreads();
    return {
      threadKeys: dismissals.map((dismissal) => dailyReportThreadKey(dismissal.account, dismissal.threadId)),
      dismissals,
    };
  },
});

export const restoreDailyReportTaskTool = defineTool({
  name: 'restore_daily_report_task',
  description: 'Undo removal of a task from future Daily Brief task sections.',
  category: 'tasks',
  mutating: true,
  input: z.object({ cardId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
  async handler({ cardId }) {
    await restoreDailyReportTask(cardId);
    return { ok: true };
  },
});

export const restoreDailyReportThreadTool = defineTool({
  name: 'restore_daily_report_thread',
  description: 'Undo removal or resolution of a conversation from Daily Brief sections.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string().min(1),
    threadId: z.string().min(1),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler(args) {
    await restoreDailyReportThread(args);
    return { ok: true };
  },
});
