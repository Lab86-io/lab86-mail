import { z } from 'zod';
import { generateDailyReport } from '../mail/daily-report';
import {
  getDailyReport as getDailyReportStore,
  getLatestDailyReport,
  listDailyReports as listDailyReportsStore,
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
  }),
  output: z.object({ report: z.any() }),
  async handler({ kind }, ctx) {
    return { report: await generateDailyReport({ kind, includeCalendar: true, userId: ctx.userId }) };
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
