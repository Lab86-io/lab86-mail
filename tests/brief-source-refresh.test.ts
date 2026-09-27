import { describe, expect, test } from 'bun:test';
import { resolveAiBudgetPolicy } from '../lib/ai/budget';
import {
  BRIEF_MAX_OUTPUT_TOKENS,
  generateTextForCurrentUser,
  maxOutputTokensForFeature,
} from '../lib/ai/gateway';
import { briefSourceCoverage, createBriefSourceRefresher } from '../lib/mail/brief-source-refresh';

function harness(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const run = async (source: string) => {
    calls.push(source);
    return { ok: true };
  };
  const deps = {
    accounts: async () => [
      { accountId: 'mail', status: 'connected' },
      { accountId: 'gone', status: 'disconnected' },
    ],
    connections: async () =>
      [
        { connectionId: 'granola', status: 'connected', includeInBrief: true },
        { connectionId: 'github', status: 'error', includeInBrief: true },
        { connectionId: 'slack', status: 'connected', includeInBrief: false },
        { connectionId: 'removed', status: 'disconnected', includeInBrief: true },
      ] as any,
    files: async () => [{ connectionId: 'drive', status: 'connected' }] as any,
    mail: async ({ accountId }: any) => run(`mail:${accountId}`) as any,
    calendar: async ({ accountId }: any) => run(`calendar:${accountId}`) as any,
    mcp: async (_user: string, id: string) => run(`mcp:${id}`) as any,
    cloud: async (_user: string, id: string) =>
      [await run(`files:${id}`)].map((row) => ({ ...row, pending: false })),
    now: () => 1000,
    ...overrides,
  };
  return { refresh: createBriefSourceRefresher(deps as any), calls, deps };
}

describe('brief source preflight', () => {
  test('checks every included connector and isolates consent, disconnection and users', async () => {
    const { refresh, calls } = harness();
    expect((await refresh('owner')).every((check) => check.status === 'checked')).toBe(true);
    expect(calls.sort()).toEqual(['calendar:mail', 'files:drive', 'mail:mail', 'mcp:github', 'mcp:granola']);
    await refresh('owner');
    expect(calls).toHaveLength(5);
    await refresh('owner', ['mcp:slack']);
    expect(calls.at(-1)).toBe('mcp:slack');
    await refresh('other', ['mcp:granola']);
    expect(calls.filter((source) => source === 'mcp:granola')).toHaveLength(2);
    await refresh('owner', []);
    expect(calls).toHaveLength(7);
  });

  test('narrative opt-ins never refresh an unselected source and cached permission is rechecked', async () => {
    const { refresh, calls, deps } = harness();
    await refresh('owner', ['mcp:granola', 'files:missing']);
    expect(calls).toEqual(['mcp:granola']);
    deps.connections = async () => [];
    expect(await refresh('owner', ['mcp:granola'])).toEqual([]);
  });

  test('failed discoveries, partial indexing and rejected providers remain explicit partial coverage', async () => {
    const { refresh } = harness({
      accounts: async () => {
        throw new Error('unavailable');
      },
      mcp: async (_user: string, id: string) => {
        if (id === 'github') throw new Error('rate limit');
        return { ok: false };
      },
      cloud: async () => [{ ok: true, pending: true }],
    });
    const checks = await refresh('owner');
    expect(checks).toHaveLength(4);
    expect(checks.every((check) => check.status === 'unavailable')).toBe(true);
    expect(briefSourceCoverage(checks)).toContain('4 source checks could not establish freshness');
    expect(briefSourceCoverage([])).toContain('missing records do not establish');
  });

  test('overlapping editions await the same source work without a deadline, then retry failed work', async () => {
    let complete!: (value: { ok: boolean }) => void;
    let attempts = 0;
    const { refresh } = harness({
      mcp: () => {
        attempts++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const first = refresh('owner', ['mcp:granola']);
    const second = refresh('owner', ['mcp:granola']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(1);
    complete({ ok: false });
    expect((await first)[0].status).toBe('unavailable');
    expect(await second).toEqual(await first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retry = refresh('owner', ['mcp:granola']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    complete({ ok: true });
    expect((await retry)[0].status).toBe('checked');
    expect(attempts).toBe(2);
  });

  test('successful checks expire after five minutes', async () => {
    let now = 1000;
    const { refresh, calls } = harness({ now: () => now });
    await refresh('owner', ['mcp:granola']);
    now += 300_000;
    await refresh('owner', ['mcp:granola']);
    expect(calls).toHaveLength(2);
  });
});

test('every brief writer gets one high explicit cap while unrelated gateway budgets remain intact', () => {
  // An uncapped call lets OpenRouter reserve credits for the model maximum and answer 402.
  expect(BRIEF_MAX_OUTPUT_TOKENS).toBe(32_000);
  for (const feature of [
    'daily_report_insight',
    'daily_report_narrative',
    'daily_report_artifact',
    'daily_brief_prose',
    'daily_brief_layout',
    'albatross_area_pulse',
    'albatross_area_artifact',
    'narrative_workspace',
    'narrative_retrieval',
    'narrative_research',
    'narrative_write',
    'narrative_meeting_prep',
  ]) {
    expect(maxOutputTokensForFeature(feature)).toBe(BRIEF_MAX_OUTPUT_TOKENS);
    expect(maxOutputTokensForFeature(feature, 1800)).toBe(BRIEF_MAX_OUTPUT_TOKENS);
    expect(resolveAiBudgetPolicy({ feature, monthlyCredits: 10, creditsUsed: 20 }).forceFastModel).toBe(
      false,
    );
    expect(resolveAiBudgetPolicy({ feature, monthlyCredits: 10, creditsUsed: 20 }).hardStopped).toBe(false);
  }
  expect(maxOutputTokensForFeature('agent')).toBe(12000);
  expect(maxOutputTokensForFeature('summarize_thread')).toBe(1500);
  expect(maxOutputTokensForFeature('other', 50)).toBe(50);
  expect(maxOutputTokensForFeature('other')).toBe(24000);
});

test('brief writers recover from provider rate limits and exhausted provider output through another model', async () => {
  for (const feature of [
    'narrative_workspace',
    'daily_brief_prose',
    'daily_brief_layout',
    'albatross_area_pulse',
  ]) {
    const requests: any[] = [];
    const runtime = {
      userId: 'owner',
      source: 'lab86',
      provider: 'openrouter',
      modelName: 'z-ai/glm-5.3-flash',
      model: 'glm',
    } as any;
    const result = await generateTextForCurrentUser(
      { feature, maxOutputTokens: 1800, maxRetries: 0 },
      {
        resolveAiRuntime: async () => runtime,
        fallbackRuntimes: () => [{ ...runtime, modelName: 'fallback', model: 'fallback' }],
        recordUsage: async () => undefined,
        generateText: (async (request: any) => {
          requests.push(request);
          if (requests.length === 1) throw Object.assign(new Error('Rate limited'), { statusCode: 429 });
          return request.model === 'glm'
            ? { text: '', finishReason: 'length', usage: {} }
            : { text: 'Finished editorial', finishReason: 'stop', usage: {} };
        }) as any,
      },
    );
    expect(result.text).toBe('Finished editorial');
    expect(requests.map((request) => request.model)).toEqual(['glm', 'glm', 'fallback']);
    expect(requests.every((request) => request.maxOutputTokens === BRIEF_MAX_OUTPUT_TOKENS)).toBe(true);
  }
});
