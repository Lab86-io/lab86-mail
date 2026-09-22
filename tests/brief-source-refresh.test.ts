import { describe, expect, test } from 'bun:test';
import { maxOutputTokensForFeature } from '../lib/ai/gateway';
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
    timeoutMs: 20,
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

  test('overlapping editions share actual provider work after a waiter times out, then retry failed work', async () => {
    let complete!: (value: { ok: boolean }) => void;
    let attempts = 0;
    const { refresh } = harness({
      mcp: () => {
        attempts++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
      timeoutMs: 5,
    });
    const [first, second] = await Promise.all([
      refresh('owner', ['mcp:granola']),
      refresh('owner', ['mcp:granola']),
    ]);
    expect(first[0].status).toBe('unavailable');
    expect(second).toEqual(first);
    await refresh('owner', ['mcp:granola']);
    expect(attempts).toBe(1);
    complete({ ok: false });
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

test('every brief writer is uncapped while unrelated gateway budgets remain intact', () => {
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
    expect(maxOutputTokensForFeature(feature)).toBeUndefined();
    expect(maxOutputTokensForFeature(feature, 1800)).toBeUndefined();
  }
  expect(maxOutputTokensForFeature('agent')).toBe(12000);
  expect(maxOutputTokensForFeature('summarize_thread')).toBe(1500);
  expect(maxOutputTokensForFeature('other', 50)).toBe(50);
  expect(maxOutputTokensForFeature('other')).toBe(24000);
});
