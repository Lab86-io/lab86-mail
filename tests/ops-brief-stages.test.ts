import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import { summarizeEditionTelemetry } from '../convex/dailyReports';
import schema from '../convex/schema';
import { BriefEditionMeter, currentBriefMeter, runWithBriefMeter, withBriefStage } from '../lib/brief/budget';
import { addBriefStages, BRIEF_STAGES } from '../lib/brief/stages';
import { runBriefJob } from '../lib/mail/brief-jobs';

const SECRET = 'brief-stage-secret';
const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

describe('stage maps', () => {
  test('the sum keeps whole milliseconds and only the stages that ran', () => {
    expect(addBriefStages({ queued: 10.4, prose: 5 }, { prose: 7, save: 1 })).toEqual({
      queued: 10,
      prose: 12,
      save: 1,
    });
    expect(addBriefStages(null, undefined)).toBeUndefined();
    expect(addBriefStages({}, {})).toBeUndefined();
    expect(BRIEF_STAGES).toEqual(['queued', 'sources', 'composition', 'prose', 'editorial', 'save']);
  });
});

describe('the meter', () => {
  test('a stage adds its time, also when it throws, and a repeated stage sums', async () => {
    const meter = new BriefEditionMeter();
    meter.addStageTime('queued', 40);
    meter.addStageTime('queued', -5);
    await runWithBriefMeter(meter, async () => {
      expect(currentBriefMeter()).toBe(meter);
      expect(await withBriefStage('save', () => 'saved')).toBe('saved');
      await expect(
        withBriefStage('prose', async () => {
          throw new Error('The writer stopped');
        }),
      ).rejects.toThrow('The writer stopped');
    });
    const stages = meter.stages();
    expect(stages.queued).toBe(40);
    expect(stages.save).toBeGreaterThanOrEqual(0);
    expect(stages.prose).toBeGreaterThanOrEqual(0);
    expect(stages.editorial).toBeUndefined();
  });

  test('outside an edition a stage only runs', async () => {
    expect(await withBriefStage('prose', () => 7)).toBe(7);
  });
});

describe('the edition job', () => {
  function worker(job: Record<string, unknown>, daily: (input: any) => Promise<any>) {
    const telemetry: any[] = [];
    const deps = {
      mutation: (async (fn: any) => {
        const name = getFunctionName(fn);
        if (name === 'briefJobs:claim')
          return { kind: 'daily', edition: 'morning', reportId: 'r1', createdAt: 10, attempts: 1, ...job };
        return true;
      }) as any,
      query: (async () => null) as any,
      telemetry: mock(async (_user: string, _job: unknown, _budget: unknown, stages: unknown) => {
        telemetry.push(stages);
      }),
      daily: mock(daily),
      weekly: mock(daily),
      readDaily: mock(async () => null),
      notify: mock(async () => {}),
      email: mock(async () => {}),
      stepRuns: mock(async () => {}),
      noAccess: mock(async () => false),
      now: () => 110,
    };
    return { deps, telemetry };
  }
  const done = { _id: 'r1', status: 'ready', editorial: { mode: 'generated' } } as any;

  test('sends the wait in the queue and the stages that ran', async () => {
    const { deps, telemetry } = worker({}, async () => {
      await withBriefStage('prose', () => undefined);
      return done;
    });
    await runBriefJob('owner', 'job', deps as any);
    expect(telemetry[0].queued).toBe(100);
    expect(telemetry[0].prose).toBeGreaterThanOrEqual(0);
  });

  test('a retry does not count its backoff as a queue', async () => {
    const { deps, telemetry } = worker({ attempts: 2 }, async () => done);
    await runBriefJob('owner', 'job', deps as any);
    expect(telemetry[0]).toEqual({});
  });

  test('a failed attempt and a weekly edition send their stages too', async () => {
    const failed = worker({}, async () => {
      throw new Error('The writer stopped');
    });
    await runBriefJob('owner', 'job', failed.deps as any);
    expect(failed.telemetry[0].queued).toBe(100);
    const weekly = worker({ edition: 'weekly' }, async () => done);
    await runBriefJob('owner', 'job', weekly.deps as any);
    expect(weekly.telemetry[0].queued).toBe(100);
    // A weekly attempt that fails counts too.
    const stopped = worker({ edition: 'weekly' }, async () => {
      throw new Error('The sources stopped');
    });
    await runBriefJob('owner', 'job', stopped.deps as any);
    expect(stopped.telemetry[0].queued).toBe(100);
  });
});

describe('the telemetry row', () => {
  const harness = () =>
    convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
    });
  const record = (t: ReturnType<typeof harness>, extra: Record<string, unknown>) =>
    t.mutation(api.dailyReports.recordEditionTelemetry, {
      internalSecret: SECRET,
      userId: 'u1',
      reportId: 'r1',
      kind: 'morning',
      timeMs: 1_000,
      costUsd: 0.01,
      inputTokens: 1,
      outputTokens: 1,
      calls: 1,
      fallback: false,
      attempts: 1,
      ...extra,
    });

  test('sums the stages of each attempt', async () => {
    const t = harness();
    await record(t, { stages: { queued: 500, prose: 1_000 } });
    await record(t, { attempts: 2, stages: { prose: 2_000, save: 40 } });
    const rows = await t.run((ctx) => ctx.db.query('briefEditionTelemetry').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].stages).toEqual({ queued: 500, prose: 3_000, save: 40 });
    expect(rows[0].attempts).toBe(2);
  });

  test('a row with no stage map stays valid, and an unknown stage is rejected', async () => {
    const t = harness();
    await record(t, {});
    const rows = await t.run((ctx) => ctx.db.query('briefEditionTelemetry').collect());
    expect(rows[0].stages).toBeUndefined();
    await expect(record(t, { stages: { guessed: 1 } })).rejects.toThrow();
  });

  test('the summary gives each stage its percentiles, and skips a row with no map', () => {
    const base = {
      userId: 'u',
      kind: 'morning',
      timeMs: 1,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      fallback: false,
    };
    const summary = summarizeEditionTelemetry([
      { ...base, stages: { prose: 100, save: 5 } },
      { ...base, stages: { prose: 300 } },
      { ...base },
    ]);
    expect(summary.stages.prose).toEqual({ editions: 2, p50: 100, p90: 300 });
    expect(summary.stages.save).toEqual({ editions: 1, p50: 5, p90: 5 });
    expect(summary.stages.queued).toEqual({ editions: 0, p50: 0, p90: 0 });
  });
});
