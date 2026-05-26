import type { DailyReport } from '../shared/types';
import { db, findMany, findOne, upsert } from './db';

export async function saveDailyReport(report: DailyReport) {
  await upsert(db().dailyReports, { _id: report._id }, report);
  return report;
}

export async function getDailyReport(id: string) {
  return await findOne<DailyReport>(db().dailyReports, { _id: id });
}

export async function getLatestDailyReport(kind?: DailyReport['kind']) {
  const query = kind ? { kind } : {};
  const reports = await findMany<DailyReport>(db().dailyReports, query, {
    sort: { generatedAt: -1 },
    limit: 1,
  });
  return reports[0] || null;
}

export async function listDailyReports(limit = 20) {
  return await findMany<DailyReport>(db().dailyReports, {}, { sort: { generatedAt: -1 }, limit });
}
