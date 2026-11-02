import { afterEach, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  getDailyReportFacts,
  getLatestDailyReport,
  listDailyReportSummaries,
  listDailyReports,
  migrateDailyReport,
  readBriefEditionView,
  readBriefHead,
  readBriefView,
  saveDailyReport,
  setDailyReportReaderForTest,
} from '../lib/store/daily-reports';
import { KV_GET_MANY_LIMIT, kvGetMany, kvUpsert } from '../lib/store/kv';
import { realShapeEdition } from './fixtures/brief-real-shape';

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
  let newest: any = { ...report(100), editorial: { mode: 'fallback' } };
  const completed = { ...report(90), editorial: { mode: 'generated' } };
  setDailyReportReaderForTest({
    configured: () => true,
    query: (async (_fn: unknown, args: any) => {
      if (args.limit) reads.push(args);
      return {
        page: [newest, completed].slice(0, args.limit),
        isDone: true,
        continueCursor: '',
      };
    }) as any,
  });
  await context(async () => {
    expect((await getLatestDailyReport())?._id).toBe('edition-100');
    // One read of the row, not a summary read and then a second full read.
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ limit: 1, summaryOnly: false });
    newest = { ...report(100), editorial: { mode: 'generated' } };
    expect((await getLatestDailyReport())?._id).toBe('edition-100');
    newest = { ...report(86_400_100), status: 'partial' };
    expect((await getLatestDailyReport())?._id).toBe('edition-86400100');
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
    ).toBe<unknown>(value);
    expect(saved).toEqual([value]);
  }
});

test('hosted latest asks for exactly one edition in the current user context', async () => {
  const calls: any[] = [];
  setDailyReportReaderForTest({
    configured: () => true,
    query: (async (_fn: unknown, args: any) => {
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
    query: (async (_fn: unknown, args: any) => {
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
    query: (async (_fn: unknown, args: any) => {
      calls.push(args);
      return { page: [report(2)], isDone: true, continueCursor: '' };
    }) as any,
  });
  await context(async () => expect(await listDailyReportSummaries(30)).toEqual<unknown>([report(2)]));
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
    query: (async (_fn: unknown, args: any) => {
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

test('the latest read applies saved dismissals so a reload keeps items hidden', async () => {
  const { editorialFixture } = await import('./fixtures/editorial');
  const { edition } = editorialFixture();
  const saved = { ...edition, generatedAt: Date.now() - 3 * 86_400_000 };
  setDailyReportReaderForTest({
    configured: () => true,
    loadDismissals: async () => ({ threads: new Set(['account-a:thread-a']), tasks: new Set(['check']) }),
    query: (async () => ({ page: [saved], isDone: true, continueCursor: '' })) as any,
  });
  await context(async () => {
    const latest = await getLatestDailyReport();
    expect(latest?.sections.answer).toEqual([]);
    expect(latest?.sections.tasks).toEqual([]);
    expect(JSON.stringify(latest?.document)).not.toContain('thread-a');
    // History stays a snapshot.
    expect((await listDailyReports(1))[0].sections.answer).toHaveLength(1);
  });
});

// ---- The web view of the Today page ------------------------------------------

const ready = (i: number, patch: Record<string, unknown> = {}) => ({
  ...realShapeEdition(),
  _id: `edition-${i}`,
  generatedAt: i,
  ...patch,
});

function viewReader(input: {
  rows: any[];
  head?: any;
  calls?: Array<{ name: string; args: any }>;
  overrides?: Parameters<typeof setDailyReportReaderForTest>[0];
}) {
  setDailyReportReaderForTest({
    configured: () => true,
    loadPolicy: (async () => ({ preferences: {}, corrections: [] })) as any,
    loadDismissals: async () => ({}),
    loadClosedTracked: async () => new Set<string>(),
    loadSelfAddresses: async () => new Set<string>(),
    query: (async (fn: unknown, args: any) => {
      const name = getFunctionName(fn as any);
      input.calls?.push({ name, args });
      if (name === 'briefJobs:activeEdition') return input.head ?? null;
      if (name === 'userData:dailyReportPage') {
        const index = args.cursor ? Number(args.cursor) : 0;
        return {
          page: input.rows.slice(index, index + args.limit),
          isDone: index + args.limit >= input.rows.length,
          continueCursor: String(index + args.limit),
        };
      }
      return [];
    }) as any,
    ...input.overrides,
  });
}

test('the small poll reads the job only and says nothing about an edition', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  viewReader({ rows: [ready(100)], calls });
  await context(async () => {
    expect(await readBriefHead()).toEqual({ stamp: 'idle', pending: null });
    expect(calls.map((call) => call.name)).toEqual(['briefJobs:activeEdition']);
  });
  viewReader({ rows: [], head: { reportId: 'new', status: 'partial', progress: null } });
  await context(async () => {
    const head = await readBriefHead();
    expect(head.pending).toEqual({ reportId: 'new', phase: 'writing' });
    expect(head.stamp).toContain('new|partial');
  });
});

test('a ready edition costs one read of its row and goes out in the slim form', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  viewReader({ rows: [ready(100)], calls });
  await context(async () => {
    const view = await readBriefView();
    expect(view.report?._id).toBe('edition-100');
    expect(view.report?.html).toBeUndefined();
    expect(view.pending).toBeNull();
    expect(view.stamp).toBe('idle');
  });
  expect(calls.filter((call) => call.name === 'userData:dailyReportPage')).toHaveLength(1);
});

test('during a partial row the page gets the last ready edition and the new row as pending', async () => {
  const partial = { _id: 'new', generatedAt: 200, status: 'partial', sections: {}, stats: {} };
  const calls: Array<{ name: string; args: any }> = [];
  viewReader({ rows: [partial, ready(100)], head: { reportId: 'new', status: 'partial' }, calls });
  await context(async () => {
    const view = await readBriefView();
    expect(view.report?._id).toBe('edition-100');
    expect(view.pending).toEqual({ reportId: 'new', phase: 'writing' });
  });
  expect(
    calls.filter((call) => call.name === 'userData:dailyReportPage').map((call) => call.args.cursor),
  ).toEqual([null, '1']);
});

test('a composing row with no job settles, and a failed job read leaves it as it is', async () => {
  const composing = { ...ready(100), artifactStatus: 'composing' };
  viewReader({ rows: [composing] });
  await context(async () => {
    const settled = await readBriefView();
    expect(settled.report?.artifactStatus).toBe('rendered');
  });
  setDailyReportReaderForTest({
    configured: () => true,
    loadDismissals: async () => ({}),
    loadClosedTracked: async () => new Set<string>(),
    query: (async (fn: unknown, args: any) => {
      if (getFunctionName(fn as any) === 'briefJobs:activeEdition') throw new Error('Unavailable');
      return { page: [composing].slice(0, args.limit), isDone: true, continueCursor: '' };
    }) as any,
  });
  await context(async () => {
    const unknown = await readBriefView();
    expect(unknown.report?.artifactStatus).toBe('composing');
  });
});

test('a dead run of partial rows stops the scan, and nothing readable is a null report', async () => {
  const partial = (id: string) => ({ _id: id, generatedAt: 200, status: 'partial', sections: {} });
  const calls: Array<{ name: string; args: any }> = [];
  viewReader({
    rows: [partial('a'), partial('b'), partial('c'), partial('d'), ready(100)],
    calls,
  });
  await context(async () => {
    const view = await readBriefView();
    expect(view.report).toBeNull();
    expect(view.pending).toBeNull();
  });
  expect(calls.filter((call) => call.name === 'userData:dailyReportPage')).toHaveLength(4);
  viewReader({ rows: [partial('a')], head: { reportId: 'a', status: 'partial' } });
  await context(async () => {
    expect(await readBriefView()).toMatchObject({ report: null, pending: { phase: 'writing' } });
  });
  viewReader({ rows: [] });
  await context(async () => expect((await readBriefView()).report).toBeNull());
});

test('a composing row shows its own plain letter, and with no active job its letter is final', async () => {
  const { document: _document, ...plain } = ready(100);
  const composing = { ...plain, artifactSource: 'deterministic', artifactStatus: 'composing' };
  viewReader({
    rows: [composing],
    head: { reportId: 'edition-100', status: 'ready', artifactStatus: 'composing' },
  });
  await context(async () => {
    const view = await readBriefView();
    expect(view.report?._id).toBe('edition-100');
    expect(view.report?.artifactStatus).toBe('composing');
    expect(view.report?.sections.answer?.length).toBeGreaterThan(0);
    expect(view.pending).toEqual({ reportId: 'edition-100', phase: 'composing' });
  });
  viewReader({ rows: [composing] });
  await context(async () => {
    const view = await readBriefView();
    expect(view.report?.artifactStatus).toBe('rendered');
    expect(view.pending).toBeNull();
  });
});

test('a failed read of the job does not hide a readable edition', async () => {
  viewReader({ rows: [ready(100)] });
  setDailyReportReaderForTest({
    configured: () => true,
    loadDismissals: async () => ({}),
    loadClosedTracked: async () => new Set<string>(),
    query: (async (fn: unknown, args: any) => {
      if (getFunctionName(fn as any) === 'briefJobs:activeEdition') throw new Error('Unavailable');
      return { page: [ready(100)].slice(0, args.limit), isDone: true, continueCursor: '' };
    }) as any,
  });
  await context(async () => {
    const view = await readBriefView();
    expect(view.report?._id).toBe('edition-100');
    expect(view.pending).toBeNull();
  });
});

test('a revision that the reader has already means no edition on the wire', async () => {
  viewReader({ rows: [ready(100)] });
  await context(async () => {
    const first = await readBriefView();
    expect(first.report).toBeTruthy();
    const second = await readBriefView(first.revision);
    expect(second).toEqual({ stamp: 'idle', pending: null, revision: first.revision, unchanged: true });
    const third = await readBriefView('another-revision');
    expect(third.report).toBeTruthy();
  });
});

test('the web read of live facts is capped, and the native read keeps its full form', async () => {
  const now = Date.now();
  const calls: Array<{ name: string; args: any }> = [];
  viewReader({ rows: [ready(now, { accounts: ['account-a'] })], calls });
  await context(async () => {
    await readBriefView();
  });
  const threads = calls.find((call) => call.name === 'jev:threadAssessments');
  const arrivals = calls.find((call) => call.name === 'jev:liveBriefCandidates');
  expect(threads?.args.threads.length).toBeLessThanOrEqual(120);
  expect(arrivals?.args.limit).toBe(60);

  const native: Array<{ name: string; args: any }> = [];
  viewReader({ rows: [ready(now, { accounts: ['account-a'] })], calls: native });
  await context(async () => {
    await getLatestDailyReport();
  });
  expect(native.find((call) => call.name === 'jev:liveBriefCandidates')?.args.limit).toBeUndefined();
  expect(native.find((call) => call.name === 'jev:threadAssessments')?.args.threads.length).toBeGreaterThan(
    120,
  );
});

test('a live change reaches the web view without a rebuild of the legacy artifact', async () => {
  const now = Date.now();
  const row = ready(now, { accounts: ['account-a'] });
  const threadKey = `${row.sections.answer![0].account}:${row.sections.answer![0].threadId}`;
  viewReader({
    rows: [row],
    overrides: { loadDismissals: async () => ({ threads: new Set([threadKey]) }) },
  });
  await context(async () => {
    const view = await readBriefView();
    expect(JSON.stringify(view.report?.document)).not.toContain(row.sections.answer![0].threadId);
    expect(view.report?.html).toBeUndefined();
    const native = await getLatestDailyReport();
    expect(native?.html).toContain('<');
  });
});

test('one edition from history stays a snapshot, and a placeholder is not an edition', async () => {
  const stored = new Map<string, any>([
    ['old', { ...report(5), sections: {}, document: undefined }],
    ['partial', { ...report(6), status: 'partial' }],
  ]);
  await context(async () => {
    for (const [key, value] of stored) await kvUpsert('dailyReport', key, value);
    const view = await readBriefEditionView('old');
    expect(view).toMatchObject({ stamp: 'idle', pending: null });
    expect(view.report?._id).toBe('edition-5');
    expect(view.report?.artifactSource).toBe('deterministic');
    expect(await readBriefEditionView('old', view.revision)).toMatchObject({ unchanged: true });
    expect((await readBriefEditionView('partial')).report).toBeNull();
    expect((await readBriefEditionView('missing')).report).toBeNull();
    expect(await getDailyReportFacts('missing')).toBeNull();
    expect((await getDailyReportFacts('old'))?.html).toBeUndefined();
  });
});

test('without Convex the page reads the same rules from the local store', async () => {
  await runWithAiRequestContext({ userId: 'local-reader', agent: 'ai' }, async () => {
    expect((await readBriefView()).report).toBeNull();
    await kvUpsert('dailyReport', 'done', { ...report(5), sections: {} });
    await kvUpsert('dailyReport', 'new', { ...report(9), status: 'partial', sections: {} });
    expect(await readBriefHead()).toMatchObject({ pending: { reportId: 'edition-9', phase: 'writing' } });
    const view = await readBriefView();
    expect(view.report?._id).toBe('edition-5');
    expect(view.pending?.phase).toBe('writing');
  });
});

test('the closed tracked read asks for its own rows, and the store caps a batch', async () => {
  await runWithAiRequestContext({ userId: 'tracked-reader', agent: 'ai' }, async () => {
    await kvUpsert('trackedThread', 'open', { _id: 'open', status: 'open' });
    await kvUpsert('trackedThread', 'done', { _id: 'done', status: 'resolved' });
    expect(await kvGetMany('trackedThread', [])).toEqual([]);
    const rows = await kvGetMany<{ _id: string }>('trackedThread', ['open', 'done', 'done', 'missing']);
    expect(rows.map((row) => row._id)).toEqual(['open', 'done']);
  });
});

test('the hosted batch read sends each key once and at most the batch limit', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://kv-tests.example';
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({
      status: 'success',
      value: [{ key: 'a', doc: { _id: 'a', status: 'resolved' }, updatedAt: 1 }],
      logLines: [],
    });
  }) as unknown as typeof fetch;
  try {
    await context(async () => {
      const keys = ['a', 'a', ...Array.from({ length: 150 }, (_, index) => `k${index}`)];
      const rows = await kvGetMany('trackedThread', keys);
      expect(rows).toEqual([{ _id: 'a', status: 'resolved' }]);
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].path).toBe('userData:getDocs');
    const [args] = bodies[0].args;
    expect(args.kind).toBe('trackedThread');
    expect(args.keys).toHaveLength(KV_GET_MANY_LIMIT);
    expect(new Set(args.keys).size).toBe(KV_GET_MANY_LIMIT);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = previousUrl;
  }
});

test('a read without legacy artifacts builds none of them', () => {
  const { editorialFixture: _unused, ...raw } = { editorialFixture: 0, ...realShapeEdition() };
  const light = migrateDailyReport(raw as any, Date.now(), { legacyArtifacts: false });
  expect(light.html).toBeUndefined();
  expect(light.composition).toBeUndefined();
  expect(light.handoffs ?? []).toEqual([]);
  const full = migrateDailyReport(raw as any);
  expect(full.html).toBeTruthy();
  expect(full.composition).toBeTruthy();
});
