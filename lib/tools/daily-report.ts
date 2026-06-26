import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { generateAgentReport } from '../mail/agent-report';
import type { DailyReport } from '../shared/types';
import {
  dailyReportThreadKey,
  dismissDailyReportTask,
  dismissDailyReportThread,
  listDismissedDailyReportTasks,
  listDismissedDailyReportThreads,
} from '../store/daily-report-dismissals';
import {
  getDailyReport as getDailyReportStore,
  getLatestDailyReport,
  listDailyReports as listDailyReportsStore,
  saveDailyReport,
} from '../store/daily-reports';
import { defineTool } from './registry';

const ReportKindSchema = z.enum(['morning', 'evening', 'manual']);

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
    void generateAgentReport({ kind, userId: ctx.userId, reportId }).catch((err) => {
      console.error('[daily-report] background generation failed:', err);
    });
    return { report: null, started: true };
  },
});

export const getLatestDailyReportTool = defineTool({
  name: 'get_latest_daily_report',
  description: 'Get the latest stored Daily Report.',
  category: 'ai',
  mutating: false,
  input: z.object({ kind: ReportKindSchema.optional() }).optional(),
  output: z.object({ report: z.any().nullable() }),
  async handler(input) {
    return { report: await getLatestDailyReport(input?.kind) };
  },
});

export const listDailyReportsTool = defineTool({
  name: 'list_daily_reports',
  description: 'List stored Daily Reports.',
  category: 'ai',
  mutating: false,
  input: z.object({ limit: z.number().int().min(1).max(100).default(20) }).optional(),
  output: z.object({ reports: z.array(z.any()) }),
  async handler(input) {
    return { reports: await listDailyReportsStore(input?.limit || 20) };
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
    return { report: await getDailyReportStore(id) };
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
