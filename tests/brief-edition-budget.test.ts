import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { createBriefTelemetryGet } from '../app/api/brief/telemetry/route';
import { api } from '../convex/_generated/api';
import { summarizeEditionTelemetry } from '../convex/dailyReports';
import schema from '../convex/schema';
import { generateTextForCurrentUser } from '../lib/ai/gateway';
import { AuthRequiredError } from '../lib/auth/current-user';
import {
  BriefBudgetExhaustedError,
  BriefEditionMeter,
  briefBudgetLimits,
  currentBriefMeter,
  DEFAULT_BRIEF_COST_BUDGET_USD,
  DEFAULT_BRIEF_TIME_BUDGET_MS,
  isBriefBudgetExhausted,
  meterGenerateOptions,
  parseBriefEditionBudget,
  runWithBriefMeter,
} from '../lib/brief/budget';
import { withEditionBudget } from '../lib/mail/agent-report';
import { runBriefJob } from '../lib/mail/brief-jobs';
import { migrateDailyReport } from '../lib/store/daily-reports';

const SECRET = 'budget-secret';
const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

// gpt-4o-mini style prices are not assumed: the tests read the meter's own
// count, and a million output tokens costs more than any budget here.
const runtime = { provider: 'openrouter', modelName: 'openai/gpt-5.5' };

describe('the edition meter', () => {
  test('reads the limits from the environment, with the defaults', () => {
    expect(briefBudgetLimits({})).toEqual({
      timeBudgetMs: DEFAULT_BRIEF_TIME_BUDGET_MS,
      costBudgetUsd: DEFAULT_BRIEF_COST_BUDGET_USD,
    });
    expect(
      briefBudgetLimits({ LAB86_BRIEF_TIME_BUDGET_MS: '60000', LAB86_BRIEF_COST_BUDGET_USD: '0.1' }),
    ).toEqual({ timeBudgetMs: 60_000, costBudgetUsd: 0.1 });
    expect(briefBudgetLimits({ LAB86_BRIEF_TIME_BUDGET_MS: '-1', LAB86_BRIEF_COST_BUDGET_USD: 'x' })).toEqual(
      {
        timeBudgetMs: DEFAULT_BRIEF_TIME_BUDGET_MS,
        costBudgetUsd: DEFAULT_BRIEF_COST_BUDGET_USD,
      },
    );
  });

  test('counts steps, stops at the cost budget, and refuses new calls', () => {
    let now = 1_000;
    const meter = new BriefEditionMeter({ costBudgetUsd: 0.4, timeBudgetMs: 60_000, now: () => now });
    meter.addStep(runtime, { inputTokens: 1000, outputTokens: 500 });
    now += 2_000;
    expect(meter.exhausted).toBeNull();
    expect(meter.record(false)).toMatchObject({
      timeMs: 2_000,
      inputTokens: 1000,
      outputTokens: 500,
      calls: 1,
    });
    expect(meter.record(false).costUsd).toBeGreaterThan(0);
    meter.addStep(runtime, { outputTokens: 10_000_000 });
    expect(meter.exhausted).toBe('cost');
    expect(meter.signal.aborted).toBe(true);
    expect(isBriefBudgetExhausted(meter.signal.reason)).toBe(true);
    expect(() => meter.assertOpen()).toThrow(BriefBudgetExhaustedError);
    expect(meter.record(true)).toMatchObject({ exhausted: 'cost', fallback: true, costBudgetUsd: 0.4 });
    meter.addStep(runtime, undefined);
    expect(meter.record(true).calls).toBe(3);
  });

  test('a spent budget from an earlier attempt stops the next one at once', () => {
    const spentTime = new BriefEditionMeter({ prior: { timeMs: 700_000 }, timeBudgetMs: 600_000 });
    expect(spentTime.exhausted).toBe('time');
    expect(new BriefEditionMeter({ prior: { costUsd: 0.5 }, costBudgetUsd: 0.4 }).exhausted).toBe('cost');
    const carried = new BriefEditionMeter({ prior: { timeMs: 1_000, costUsd: 0.1, calls: 2 } });
    expect(carried.record(false)).toMatchObject({ calls: 2, costUsd: 0.1 });
    expect(carried.record(false).timeMs).toBeGreaterThanOrEqual(1_000);
  });

  test('the time budget stops a running edition', async () => {
    const meter = new BriefEditionMeter({ timeBudgetMs: 20 });
    await runWithBriefMeter(meter, async () => {
      expect(currentBriefMeter()).toBe(meter);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(meter.exhausted).toBe('time');
    expect(currentBriefMeter()).toBeUndefined();
    // The clock also stops a caller that asks after the budget, before the timer.
    let now = 0;
    const late = new BriefEditionMeter({ timeBudgetMs: 10, now: () => now });
    now = 50;
    expect(() => late.assertOpen()).toThrow('writer time');
    expect(new BriefBudgetExhaustedError('cost').message).toContain('model budget');
  });

  test('model options gain the edition signal and the step counter only inside an edition', async () => {
    const options = { prompt: 'x' };
    expect(meterGenerateOptions(options, runtime)).toBe(options);
    const meter = new BriefEditionMeter({ timeBudgetMs: 60_000, costBudgetUsd: 10 });
    const seen: unknown[] = [];
    const caller = new AbortController();
    await runWithBriefMeter(meter, async () => {
      const metered: any = meterGenerateOptions(
        { prompt: 'x', abortSignal: caller.signal, onStepFinish: (step: unknown) => seen.push(step) },
        runtime,
      );
      await metered.onStepFinish({ usage: { inputTokens: 10, outputTokens: 5 } });
      expect(seen).toHaveLength(1);
      caller.abort();
      expect(metered.abortSignal.aborted).toBe(true);
      const alone: any = meterGenerateOptions({ prompt: 'y' }, runtime);
      expect(alone.abortSignal).toBe(meter.signal);
      await alone.onStepFinish({});
    });
    expect(meter.record(false)).toMatchObject({ calls: 2, inputTokens: 10, outputTokens: 5 });
  });

  test('the gateway counts every step and refuses a call after the budget', async () => {
    const meter = new BriefEditionMeter({ timeBudgetMs: 60_000, costBudgetUsd: 0.4 });
    const generateText = mock(async (request: any) => {
      await request.onStepFinish?.({ usage: { inputTokens: 100, outputTokens: 10_000_000 } });
      return { text: 'ok', finishReason: 'stop', usage: {} };
    });
    const deps = {
      resolveAiRuntime: async () => ({ ...runtime, userId: null, source: 'byok', model: 'm' }),
      fallbackRuntimes: () => [],
      recordUsage: async () => undefined,
      generateText,
    } as any;
    await runWithBriefMeter(meter, async () => {
      expect((await generateTextForCurrentUser({ feature: 'daily_brief_prose' }, deps)).text).toBe('ok');
      expect(meter.exhausted).toBe('cost');
      await expect(
        generateTextForCurrentUser({ feature: 'daily_brief_layout' }, deps),
      ).rejects.toBeInstanceOf(BriefBudgetExhaustedError);
    });
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

describe('the budget on the edition', () => {
  const report = { _id: 'r', editorial: { mode: 'fallback' } } as any;

  test('the edition carries the budget, and a spent budget is named in its errors', async () => {
    expect(withEditionBudget(report)).toBe(report);
    const meter = new BriefEditionMeter({ timeBudgetMs: 60_000, costBudgetUsd: 0.4 });
    await runWithBriefMeter(meter, async () => {
      expect(withEditionBudget({ ...report, editorial: { mode: 'generated' } }).budget).toMatchObject({
        fallback: false,
        exhausted: null,
      });
      meter.addStep(runtime, { outputTokens: 10_000_000 });
      const spent = withEditionBudget(report);
      expect(spent.budget).toMatchObject({ fallback: true, exhausted: 'cost' });
      expect(spent.artifactErrors?.at(-1)?.message).toContain('model budget');
    });
  });

  test('a stored budget survives the read migration', () => {
    const migrated = migrateDailyReport({
      _id: 'r',
      kind: 'morning',
      generatedAt: 1,
      accounts: [],
      title: 'Brief',
      narrative: '',
      sections: {},
      stats: {},
      budget: { timeMs: 5, costUsd: '0.2', exhausted: 'time', fallback: true, calls: -1 },
    } as any);
    expect(migrated.budget).toMatchObject({
      timeMs: 5,
      costUsd: 0.2,
      exhausted: 'time',
      fallback: true,
      calls: 0,
    });
    expect(parseBriefEditionBudget(null)).toBeUndefined();
    expect(parseBriefEditionBudget({ exhausted: 'other' })).toMatchObject({
      exhausted: null,
      timeBudgetMs: DEFAULT_BRIEF_TIME_BUDGET_MS,
    });
  });
});

describe('the budget in the brief job', () => {
  function worker(daily: (input: any) => Promise<any>, saved: any = null) {
    const calls: Array<{ name: string; args: any }> = [];
    const telemetry: any[] = [];
    const deps = {
      mutation: (async (fn: any, args: any) => {
        const name = getFunctionName(fn);
        calls.push({ name, args });
        if (name === 'briefJobs:claim')
          return { kind: 'daily', edition: 'morning', reportId: 'r1', createdAt: 10, attempts: 1 };
        return true;
      }) as any,
      query: (async () => null) as any,
      telemetry: mock(async (_userId: string, _job: unknown, budget: unknown) => {
        telemetry.push(budget);
      }),
      daily: mock(daily),
      area: mock(async () => ({})),
      narrative: mock(async () => ({})),
      readDaily: mock(async () => saved),
      notify: mock(async () => {}),
      noAccess: mock(async () => false),
      now: () => 100,
    };
    return { deps, calls, telemetry };
  }

  test('a spent budget publishes the edition without another attempt', async () => {
    const { deps, calls, telemetry } = worker(async () => {
      const meter = currentBriefMeter();
      meter?.addStep(runtime, { outputTokens: 10_000_000 });
      return withEditionBudget({ _id: 'r1', editorial: { mode: 'fallback' } } as any);
    });
    await runBriefJob('owner', 'job', deps as any);
    expect(calls.at(-1)?.name).toBe('briefJobs:settle');
    expect(calls.at(-1)?.args.error).toBeUndefined();
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(telemetry[0]).toMatchObject({ exhausted: 'cost', fallback: true });
  });

  test('each attempt starts from the saved budget, and a failed attempt is still recorded', async () => {
    const { deps, calls, telemetry } = worker(
      async () => {
        expect(currentBriefMeter()?.record(false).calls).toBe(4);
        throw new Error('socket hang up');
      },
      { _id: 'r1', status: 'ready', document: {}, budget: { timeMs: 1_000, calls: 4 } },
    );
    await runBriefJob('owner', 'job', deps as any);
    expect(calls.at(-1)?.args.error).toBe('The writer will retry automatically.');
    expect(telemetry[0]).toMatchObject({ fallback: true, calls: 4 });
    expect(telemetry[0].timeMs).toBeGreaterThanOrEqual(1_000);
  });

  test('an edition without a stored budget records the meter', async () => {
    const { deps, telemetry } = worker(async () => ({ _id: 'r1', editorial: { mode: 'generated' } }));
    await runBriefJob('owner', 'job', deps as any);
    expect(telemetry[0]).toMatchObject({ fallback: false, exhausted: null });
  });
});

describe('edition telemetry', () => {
  const rows = [
    {
      userId: 'a',
      kind: 'morning',
      timeMs: 60_000,
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 5,
      fallback: false,
    },
    {
      userId: 'a',
      kind: 'weekly',
      timeMs: 600_000,
      costUsd: 0.4,
      inputTokens: 20,
      outputTokens: 5,
      fallback: true,
      exhausted: 'time' as const,
    },
    {
      userId: 'b',
      kind: 'morning',
      timeMs: 120_000,
      costUsd: 0.2,
      inputTokens: 30,
      outputTokens: 5,
      fallback: false,
    },
  ];

  test('summarizes time, cost, tokens, fallbacks, and spent budgets', () => {
    expect(summarizeEditionTelemetry(rows)).toEqual({
      editions: 3,
      users: 2,
      byKind: { morning: 2, weekly: 1 },
      timeMs: { average: 260_000, p50: 120_000, p90: 600_000, max: 600_000 },
      costUsd: { total: 0.7, average: 0.2333, p50: 0.2, p90: 0.4, max: 0.4, perUserMonthAtDaily: 7 },
      tokens: { input: 60, output: 15 },
      fallbackRate: 0.3333,
      exhausted: { time: 1, cost: 0 },
    });
    expect(summarizeEditionTelemetry([])).toMatchObject({ editions: 0, timeMs: { average: 0, p50: 0 } });
  });

  test('one row per edition, updated on each attempt, and read back as a summary', async () => {
    const t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
    });
    const record = (extra: Record<string, unknown>) =>
      t.mutation((api as any).dailyReports.recordEditionTelemetry, {
        internalSecret: SECRET,
        userId: 'u1',
        reportId: 'r1',
        kind: 'morning',
        timeMs: 1_000,
        costUsd: 0.01,
        inputTokens: 1,
        outputTokens: 1,
        calls: 1,
        fallback: true,
        attempts: 1,
        ...extra,
      });
    await record({});
    await record({ timeMs: 2_000, fallback: false, attempts: 2, exhausted: 'cost' });
    const all = await t.run((ctx) => ctx.db.query('briefEditionTelemetry').collect());
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ timeMs: 2_000, attempts: 2, exhausted: 'cost' });
    const summary = await t.query((api as any).dailyReports.editionTelemetrySummary, {
      internalSecret: SECRET,
      since: 0,
    });
    expect(summary).toMatchObject({
      since: 0,
      truncated: false,
      editions: 1,
      exhausted: { cost: 1, time: 0 },
    });
    await expect(
      t.query((api as any).dailyReports.editionTelemetrySummary, { internalSecret: 'wrong', since: 0 }),
    ).rejects.toThrow();
  });
});

describe('the admin telemetry route', () => {
  const request = (query = '') => new Request(`https://mail.example.com/api/brief/telemetry${query}`);
  function route(overrides: Record<string, unknown> = {}) {
    const asked: number[] = [];
    const get = createBriefTelemetryGet({
      requireCurrentUser: async () => ({ userId: 'op' }) as any,
      isOperator: async () => true,
      summary: async (since: number) => {
        asked.push(since);
        return { editions: 1 };
      },
      now: () => 100 * 86_400_000,
      ...overrides,
    } as any);
    return { get, asked };
  }

  test('only an operator reads it, over 1 to 30 days', async () => {
    const { get, asked } = route();
    const ok = await get(request('?days=90'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, days: 30, summary: { editions: 1 } });
    expect(asked[0]).toBe(70 * 86_400_000);
    expect(await (await get(request('?days=abc'))).json()).toMatchObject({ days: 7 });
    expect((await route({ isOperator: async () => false }).get(request())).status).toBe(403);
    expect(
      (
        await route({
          requireCurrentUser: async () => {
            throw new AuthRequiredError('Sign in required.');
          },
        }).get(request())
      ).status,
    ).toBe(401);
    expect(
      (
        await route({
          requireCurrentUser: async () => {
            throw new Error('clerk down');
          },
        }).get(request())
      ).status,
    ).toBe(500);
    expect(
      (
        await route({
          summary: async () => {
            throw new Error('convex down');
          },
        }).get(request())
      ).status,
    ).toBe(500);
  });
});
