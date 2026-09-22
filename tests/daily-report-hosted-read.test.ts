import { afterEach, expect, test } from 'bun:test';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  getLatestDailyReport,
  listDailyReportSummaries,
  listDailyReports,
  saveDailyReport,
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

test('reader shows the newest edition even while it is generating or has a fallback layout', async () => {
  const reads: any[] = [];
  const loaded: string[] = [];
  let newest: any = { ...report(100), editorial: { mode: 'fallback' } };
  const completed = { ...report(90), editorial: { mode: 'generated' } };
  setDailyReportReaderForTest({
    configured: () => true,
    load: (async (id: string) => {
      loaded.push(id);
      return id === newest._id ? newest : completed;
    }) as any,
    query: (async (_fn, args) => {
      reads.push(args);
      return {
        page: [newest, completed].slice(0, args.limit),
        isDone: true,
        continueCursor: '',
      };
    }) as any,
  });
  await context(async () => {
    expect((await getLatestDailyReport(undefined, true))?._id).toBe('edition-100');
    expect(reads[0].summaryOnly).toBe(true);
    expect(loaded).toEqual(['edition-100']);
    expect((await getLatestDailyReport())?._id).toBe('edition-100');
    newest = { ...report(100), editorial: { mode: 'generated' } };
    expect((await getLatestDailyReport(undefined, true))?._id).toBe('edition-100');
    newest = { ...report(86_400_100), status: 'partial' };
    expect((await getLatestDailyReport(undefined, true))?._id).toBe('edition-86400100');
  });
});

test('a saved Brief succeeds despite synchronous owner or asynchronous attention-marking failures', async () => {
  for (const syncFailure of [true, false]) {
    const saved: unknown[] = [];
    const value = report(1);
    expect(
      await saveDailyReport(
        value as any,
        {
          persist: async (_kind: string, _key: string, doc: unknown) => {
            saved.push(doc);
            return doc;
          },
          configured: () => true,
          owner: () => {
            if (syncFailure) throw new Error('No owner');
            return 'reader';
          },
          mark: async () => {
            throw new Error('Unavailable');
          },
        } as any,
      ),
    ).toBe(value);
    expect(saved).toEqual([value]);
  }
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

test('latest edition reflects current scoped Jev facts while full history remains a snapshot', async () => {
  const { report: fixture, thread, assessment, policy } = await import('./fixtures/jev');
  const saved = { ...fixture(), generatedAt: Date.now() };
  const calls: any[] = [];
  setDailyReportReaderForTest({
    configured: () => true,
    loadPolicy: async () => policy,
    query: (async (_fn, args) => {
      calls.push(args);
      return args.threads
        ? [thread({ jev: assessment({ sourceRevision: 'resolved', obligations: [] }) })]
        : { page: [saved], isDone: true, continueCursor: '' };
    }) as any,
  });
  await context(async () => {
    expect((await getLatestDailyReport())?.sections.answer).toEqual([]);
    expect((await listDailyReports(1))[0].sections.answer).toHaveLength(1);
  });
  expect(calls.find((c) => c.threads)).toMatchObject({
    userId: 'reader',
    threads: [{ accountId: 'account-a', threadId: 'thread-a' }],
  });
  expect(saved.sections.answer).toHaveLength(1);
});
