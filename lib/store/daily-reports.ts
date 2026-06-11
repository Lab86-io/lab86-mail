import type { DailyReport } from '../shared/types';
import { kvGet, kvList, kvUpsert } from './kv';

export async function saveDailyReport(report: DailyReport) {
  await kvUpsert('dailyReport', report._id, report);
  return report;
}

export async function getDailyReport(id: string) {
  return await kvGet<DailyReport>('dailyReport', id);
}

export async function getLatestDailyReport(kind?: DailyReport['kind']) {
  const reports = await kvList<DailyReport>('dailyReport');
  const matching = kind ? reports.filter((report) => report.kind === kind) : reports;
  matching.sort((a, b) => b.generatedAt - a.generatedAt);
  return matching[0] || null;
}

export async function listDailyReports(limit = 20) {
  const reports = await kvList<DailyReport>('dailyReport', { limit: Math.max(limit, 1000) });
  reports.sort((a, b) => b.generatedAt - a.generatedAt);
  return reports.slice(0, limit);
}
