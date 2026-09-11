import { afterEach, expect, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  getLatestDailyReport,
  listDailyReportSummaries,
  listDailyReports,
  setDailyReportReaderForTest,
} from '../lib/store/daily-reports';

afterEach(() => setDailyReportReaderForTest());
const context = (run: () => Promise<unknown>) =>
  runWithAiRequestContext({ userId: 'reader', agent: 'ai' }, run);
const report = (i: number) => ({
  _id: `edition-${i}`,
  kind: 'morning',
  generatedAt: i,
  title: `Edition ${i}`,
  status: 'ready',
  artifactStatus: 'ready',
});

test('hosted latest asks for exactly one edition in the current user context', async () => {
  const calls: any[] = [];
  setDailyReportReaderForTest({
    configured: () => true,
    query: (async (_fn, args) => {
      calls.push(args);
      return {
        page: args.edition === 'manual' ? [] : [report(10)],
        isDone: args.edition === 'manual',
        continueCursor: 'older',
      };
    }) as any,
  });
  await context(async () => {
    expect((await getLatestDailyReport())?._id).toBe('edition-10');
    expect(await getLatestDailyReport('manual')).toBeNull();
  });
  expect(calls).toEqual([
    { userId: 'reader', edition: undefined, cursor: null, limit: 1, summaryOnly: false },
    { userId: 'reader', edition: 'manual', cursor: null, limit: 1, summaryOnly: false },
  ]);
});

test('hosted full history consumes bounded pages and stops at the requested count', async () => {
  const calls: any[] = [];
  setDailyReportReaderForTest({
    configured: () => true,
    query: (async (_fn, args) => {
      calls.push(args);
      const start = args.cursor ? Number(args.cursor) : 0;
      return {
        page: Array.from({ length: args.limit }, (_, i) => report(20 - start - i)),
        isDone: false,
        continueCursor: String(start + args.limit),
      };
    }) as any,
  });
  await context(async () => {
    const reports = await listDailyReports(10);
    expect(reports.map((r) => r._id)).toEqual(Array.from({ length: 10 }, (_, i) => `edition-${20 - i}`));
    expect(reports[0].sections.calendar).toEqual([]);
  });
  expect(calls.map((c) => [c.cursor, c.limit, c.summaryOnly])).toEqual([
    [null, 8, false],
    ['8', 2, false],
  ]);
});

test('summary history stops on exhaustion and requests no artifact bodies', async () => {
  const calls: any[] = [];
  setDailyReportReaderForTest({
    configured: () => true,
    query: (async (_fn, args) => {
      calls.push(args);
      return { page: [report(2)], isDone: true, continueCursor: '' };
    }) as any,
  });
  await context(async () => expect(await listDailyReportSummaries(30)).toEqual([report(2)]));
  expect(calls).toEqual([
    { userId: 'reader', edition: undefined, cursor: null, limit: 8, summaryOnly: true },
  ]);
});
