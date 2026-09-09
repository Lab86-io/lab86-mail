import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { estimateAiUsageCost } from '../lib/ai/budget';
import {
  __setNarrativeDepsForTest,
  getNarrativeTaskContext,
  narrativeEnabled,
  narrativePrompt,
  narrativeResearchTools,
  parseNarrativeGeneration,
  refreshNarrative,
} from '../lib/narrative/service';

const originalFlag = process.env.LAB86_NARRATIVE_ENABLED,
  originalUsers = process.env.LAB86_NARRATIVE_USER_IDS;
beforeEach(() => {
  process.env.LAB86_NARRATIVE_ENABLED = 'true';
  process.env.LAB86_NARRATIVE_USER_IDS = 'pilot';
});
afterEach(() => {
  __setNarrativeDepsForTest();
  if (originalFlag === undefined) delete process.env.LAB86_NARRATIVE_ENABLED;
  else process.env.LAB86_NARRATIVE_ENABLED = originalFlag;
  if (originalUsers === undefined) delete process.env.LAB86_NARRATIVE_USER_IDS;
  else process.env.LAB86_NARRATIVE_USER_IDS = originalUsers;
});
const observation = {
  _id: 'evidence1',
  key: 'turn:one',
  title: 'Your plan',
  text: 'You said: finish review tomorrow',
  trust: 'reported',
  level: 'observation',
  sourceIds: [],
  topics: ['work:review'],
  occurredAt: Date.now(),
  observedAt: Date.now(),
  current: true,
};
const chapter = {
  ...observation,
  _id: 'chapter1',
  key: 'brief:today',
  level: 'day',
  sourceIds: ['evidence1'],
};
function setup(
  overrides: {
    price?: string;
    generate?: (request: any) => Promise<any>;
    revoked?: boolean;
    sources?: number;
    pending?: number;
    skipResearchTools?: boolean;
    alreadyWritten?: boolean;
    limits?: { researchMs: number; writeMs: number };
  } = {},
) {
  const writes: Array<{ name: string; args: any }> = [],
    requests: any[] = [];
  __setNarrativeDepsForTest({
    query: (async (fn: any) =>
      getFunctionName(fn) === 'narrative:read'
        ? {
            entry: { ...chapter, model: overrides.alreadyWritten ? 'previous-model' : undefined },
            sources: Array.from({ length: overrides.sources ?? 1 }, (_, index) => ({
              ...observation,
              _id: `evidence${index + 1}`,
            })),
            revision: 4,
          }
        : getFunctionName(fn) === 'narrative:pending'
          ? {
              entries: Array.from({ length: overrides.pending || 0 }, (_, index) => ({
                ...chapter,
                _id: `past${index}`,
                key: `past:${index}`,
              })),
            }
          : { enabled: true, entries: [], revision: 4 }) as any,
    mutation: (async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      writes.push({ name, args });
      if (name === 'narrative:claim')
        return { model: 'z-ai/glm-5.3-flash', timezone: 'UTC', groups: ['work'] };
      if (name === 'narrative:ingest') return { done: true, changed: 1 };
      if (name === 'narrative:prepareBrief') return 'chapter1';
      return { published: !overrides.revoked };
    }) as any,
    runtime: (async () => ({ modelName: 'z-ai/glm-5.3-flash', provider: 'openrouter' })) as any,
    fetch: (async () =>
      Response.json({
        data: [
          {
            id: 'z-ai/glm-5.3-flash',
            pricing: { prompt: overrides.price || '0.000000075', completion: '0.00000025' },
          },
        ],
      })) as any,
    generate: (async (request) => {
      requests.push(request);
      if (request.toolChoice !== 'none' && !overrides.skipResearchTools)
        await request.tools.narrative_start.execute({}, { toolCallId: 'test-start', messages: [] });
      return overrides.generate
        ? overrides.generate(request)
        : {
            text: '',
            output: {
              text: 'You planned to finish the review. Completion is not yet established by the available evidence. Check QA before deployment.',
              sourceIds: ['E1'],
            },
            totalUsage: { inputTokens: 30, outputTokens: 20 },
          };
    }) as any,
    ...(overrides.limits ? { limits: overrides.limits } : {}),
  });
  return { writes, requests };
}
describe('narrative agent run', () => {
  test('manual refresh rewrites the brief while scheduled runs preserve an unchanged published edition', async () => {
    const manual = setup({ alreadyWritten: true });
    expect((await refreshNarrative('pilot', 'manual')).publishedCount).toBe(1);
    expect(manual.requests[0].feature).toBe('narrative_write');
    const scheduled = setup({ alreadyWritten: true });
    expect((await refreshNarrative('pilot', 'scheduled')).publishedCount).toBe(0);
    expect(scheduled.requests).toEqual([]);
  });
  test('semantic lookup uses a bounded query-only classification call through the user gateway', async () => {
    const requests: any[] = [];
    __setNarrativeDepsForTest({
      query: (async () => ({ enabled: true, revision: 1, model: 'current', entries: [] })) as any,
      generate: (async (request: any) => {
        requests.push(request);
        return { output: { terms: ['delayed'] } };
      }) as any,
    });
    await getNarrativeTaskContext('pilot', { purpose: 'chat', query: 'shipping date slipped' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      userId: 'pilot',
      speed: 'classify',
      feature: 'narrative_retrieval',
      maxOutputTokens: 800,
      maxRetries: 0,
    });
    expect(JSON.parse(requests[0].prompt)).toEqual({ query: 'shipping date slipped' });
    expect(requests[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(requests[0].tools).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    await getNarrativeTaskContext('pilot', { purpose: 'chat', query: 'shipping' }, controller.signal);
    expect(requests[1]?.abortSignal.aborted).toBe(true);
  });
  test('all private consumers share gated task context instead of full-history injection', async () => {
    const inputs: any[] = [];
    __setNarrativeDepsForTest({
      query: (async (_fn: any, input: any) => {
        inputs.push(input);
        return { enabled: true, entries: [], revision: 1 };
      }) as any,
    });
    expect((await getNarrativeTaskContext('not-pilot', { purpose: 'chat' })).enabled).toBe(false);
    expect(await narrativePrompt(undefined, 'Atlas')).toBe('');
    for (const topic of [undefined, 'work:one', 'area:one'])
      expect(await narrativePrompt('pilot', 'Atlas', topic)).toContain('Do not load the entire history');
    expect(inputs.every((input) => input.userId === 'pilot')).toBe(true);
    __setNarrativeDepsForTest({ query: (async () => ({ enabled: false, entries: [], revision: 2 })) as any });
    expect(await narrativePrompt('pilot', 'Atlas')).toBe('');
  });
  test('feature and pilot gates reject all unapproved users', async () => {
    const state = setup();
    expect(narrativeEnabled('pilot')).toBe(true);
    expect(narrativeEnabled('someone-else')).toBe(false);
    expect(await refreshNarrative('someone-else')).toEqual({ status: 'disabled' });
    expect(state.writes).toEqual([]);
  });
  test('research uses read-only tools, cancellation, explicit model, and bounded generation', async () => {
    const { writes, requests } = setup({ sources: 4 });
    expect((await refreshNarrative('pilot', 'brief')).status).toBe('ready');
    expect(requests).toHaveLength(2);
    expect(requests[1].toolChoice).toBe('none');
    expect(requests[1].feature).toBe('narrative_write');
    expect(requests[1].system).not.toContain('80–4000');
    expect(requests[1].system).toContain('2200 characters');
    expect(requests[1].messages[0].content).toContain('"id":"E1"');
    expect(JSON.stringify(requests[1].messages)).not.toContain('evidence1');
    expect(requests[0].stopWhen({ steps: [{}, {}] })).toBe(true);
    expect(Object.keys(requests[0].tools).sort()).toEqual([
      'narrative_changes_since',
      'narrative_read',
      'narrative_search',
      'narrative_sources',
      'narrative_start',
    ]);
    expect(requests[0].narrativeModel).toBe('z-ai/glm-5.3-flash');
    expect(requests[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(requests[0].maxOutputTokens).toBe(2000);
    expect(requests[0].maxRetries).toBe(0);
    expect(requests[0].prepareStep({ messages: [], stepNumber: 4 })).toEqual({ toolChoice: 'none' });
    expect(requests[0].prepareStep({ messages: [], stepNumber: 0 })).toEqual({});
    expect(writes.find((w) => w.name === 'narrative:publish')?.args.sourceIds).toEqual(['evidence1']);
    expect(writes.at(-1)?.name).toBe('narrative:finish');
    expect(writes.at(-1)?.args.inputTokens).toBe(60);
  });
  test('unknown or over-budget pricing prevents a model request but preserves indexed fallback', async () => {
    const { writes, requests } = setup({ price: '0.01' });
    expect((await refreshNarrative('pilot')).status).toBe('partial');
    expect(requests).toEqual([]);
    expect(writes.some((w) => w.name === 'narrative:compile')).toBe(true);
    expect(writes.at(-1)?.args.error).toContain('budget');
  });
  test('research progress is never published; the tool-disabled writing call must finish the account', async () => {
    const { writes, requests } = setup({
      sources: 4,
      generate: async (request) =>
        request.feature === 'narrative_research'
          ? {
              text: 'Checking for more records...',
              response: { messages: [{ role: 'assistant', content: 'Checking for more records...' }] },
            }
          : {
              text: '',
              output: {
                text: 'You planned to finish QA before deployment. Preparing for the review remains your stated priority; completion is not established by the evidence.',
                sourceIds: ['E1'],
              },
            },
    });
    expect((await refreshNarrative('pilot')).status).toBe('ready');
    expect(requests[1].toolChoice).toBe('none');
    expect(writes.find((w) => w.name === 'narrative:publish')?.args.text).toContain('finish QA');
    expect(writes.find((w) => w.name === 'narrative:publish')?.args.text).not.toContain('Checking');
  });
  test('sparse evidence writes directly and defers historical chapters without marking the brief failed', async () => {
    const { writes, requests } = setup({ pending: 2 });
    expect(await refreshNarrative('pilot')).toMatchObject({
      status: 'ready',
      publishedCount: 1,
      deferredCount: 2,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].feature).toBe('narrative_write');
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].messages[0].content).toContain('finish review tomorrow');
    expect(writes.filter((row) => row.name === 'narrative:publish')).toHaveLength(1);
  });
  test('an optional research timeout still writes from host-read evidence and aborts the lookup', async () => {
    let researchSignal: AbortSignal | undefined;
    const { requests } = setup({
      sources: 4,
      limits: { researchMs: 5, writeMs: 1000 },
      generate: async (request) => {
        if (request.feature === 'narrative_research') {
          researchSignal = request.abortSignal;
          return new Promise(() => {});
        }
        return {
          output: {
            text: 'You planned to finish the review. Completion is not established. Confirm the QA result before making the deployment decision.',
            sourceIds: ['E1'],
          },
        };
      },
    });
    expect((await refreshNarrative('pilot')).status).toBe('ready');
    expect(researchSignal?.aborted).toBe(true);
    expect(requests).toHaveLength(2);
  });
  test('a rich research response that skips tools still writes from the host packet, never its claims', async () => {
    const { requests } = setup({
      sources: 4,
      skipResearchTools: true,
      generate: async (request) =>
        request.feature === 'narrative_research'
          ? { text: 'Unverified claim: everything deployed.', response: { messages: [] } }
          : {
              output: {
                text: 'You planned to finish the review. Completion is not established. Confirm the QA result before making the deployment decision.',
                sourceIds: ['E1'],
              },
            },
    });
    expect((await refreshNarrative('pilot')).status).toBe('ready');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain('finish review tomorrow');
    expect(JSON.stringify(requests[1].messages)).not.toContain('everything deployed');
  });
  test('empty provider output gets one bounded retry, while citation validation is never bypassed', async () => {
    let attempts = 0;
    const { requests } = setup({
      generate: async () =>
        ++attempts === 1
          ? { text: '', totalUsage: { inputTokens: 3 } }
          : {
              output: {
                text: 'You planned to finish the review. Completion is not established. Confirm the QA result before making the deployment decision.',
                sourceIds: ['E1'],
              },
            },
    });
    expect((await refreshNarrative('pilot')).status).toBe('ready');
    expect(requests.map((request) => request.maxOutputTokens)).toEqual([4000, 4000]);
    expect(requests[1].messages.at(-1).content).toContain('120–180');
  });
  test('dense accounts get short source codes and a smaller retry without losing exact provenance', async () => {
    let writes = 0;
    const state = setup({
      sources: 30,
      generate: async (request) => {
        if (request.feature === 'narrative_write' && ++writes === 1) throw new Error('Timed out');
        return {
          output: {
            text: 'You planned to finish the review. Completion is not established by the available records. Confirm QA before deciding the next move.',
            sourceIds: ['E1'],
          },
        };
      },
    });
    expect((await refreshNarrative('pilot')).status).toBe('ready');
    const attempts = state.requests.filter((request) => request.feature === 'narrative_write');
    const codes = (request: any) =>
      [...request.messages[0].content.matchAll(/"id":"E\d+"/g)].map((match: any) => match[0]);
    expect(codes(attempts[0]).length).toBeLessThanOrEqual(12);
    expect(codes(attempts[1])).toEqual(codes(attempts[0]).slice(0, 6));
    expect(JSON.stringify(attempts.map((request) => request.messages))).not.toContain('evidence1');
    expect(state.writes.find((write) => write.name === 'narrative:publish')?.args.sourceIds[0]).toMatch(
      /^evidence\d+$/,
    );
  });
  test('failed host evidence reads never start a writer and all research tools forward cancellation', async () => {
    const state = setup({ sources: 0 });
    expect((await refreshNarrative('pilot')).status).toBe('partial');
    expect(state.requests).toHaveLength(0);
    const signals: unknown[] = [];
    const signal = new AbortController().signal;
    __setNarrativeDepsForTest({
      query: (async (_fn: any, _args: any, received: unknown) => {
        signals.push(received);
        return { entries: [] };
      }) as any,
    });
    const research = narrativeResearchTools('pilot', signal);
    for (const [name, tool] of Object.entries(research))
      await (tool.execute as any)(
        name === 'narrative_changes_since'
          ? { since: 1 }
          : name === 'narrative_search'
            ? { query: 'Atlas' }
            : { id: 'one' },
      );
    expect(signals).toEqual([signal, signal, signal, signal]);
  });

  test('retry citations cannot name evidence omitted from the smaller packet', async () => {
    let writes = 0;
    const state = setup({
      sources: 30,
      generate: async (request) => {
        if (request.feature === 'narrative_write' && ++writes === 1) throw new Error('Timed out');
        return {
          output: {
            text: 'You planned to finish the review. Completion is not established by the available records. Confirm QA before deciding the next move.',
            sourceIds: ['E7'],
          },
        };
      },
    });
    expect((await refreshNarrative('pilot')).status).toBe('partial');
    expect(state.writes.some((write) => write.name === 'narrative:publish')).toBe(false);
    expect(state.writes.at(-1)?.args.error).toContain('cited evidence it did not read');
  });
  test('a stuck writing attempt is cancelled and retried once within its own budget', async () => {
    let attempts = 0;
    let firstSignal: AbortSignal | undefined;
    setup({
      limits: { researchMs: 5, writeMs: 10 },
      generate: async (request) => {
        if (++attempts === 1) {
          firstSignal = request.abortSignal;
          return new Promise(() => {});
        }
        return {
          output: {
            text: 'You planned to finish the review. Completion is not established. Confirm the QA result before making the deployment decision.',
            sourceIds: ['E1'],
          },
        };
      },
    });
    expect((await refreshNarrative('pilot')).status).toBe('ready');
    expect(firstSignal?.aborted).toBe(true);
    expect(attempts).toBe(2);
  });
  test('failed evidence reads are recoverable and do not leak server error bodies', async () => {
    __setNarrativeDepsForTest({
      query: (async () => {
        throw new Error('PRIVATE SERVER DETAIL');
      }) as any,
    });
    const result = await narrativeResearchTools('pilot').narrative_read.execute!(
      { id: 'invalid' },
      { toolCallId: 'test', messages: [] },
    );
    expect(JSON.stringify(result)).toContain('exact entry id');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  test('fabricated citations do not publish and lease completion records failure', async () => {
    const { writes } = setup({
      generate: async () => ({
        output: {
          text: 'You planned to finish the review. Completion is not yet established by the available evidence. Check QA before deployment.',
          sourceIds: ['E999'],
        },
      }),
    });
    expect((await refreshNarrative('pilot')).status).toBe('partial');
    expect(writes.some((w) => w.name === 'narrative:publish')).toBe(false);
    expect(writes.at(-1)?.name).toBe('narrative:finish');
    expect(writes.at(-1)?.args.error).toContain('cited evidence it did not read');
  });
  test('revoked publication is partial, and provider errors never persist private response bodies', async () => {
    setup({ revoked: true });
    expect((await refreshNarrative('pilot')).status).toBe('partial');
    const { writes } = setup({
      generate: async () => {
        throw new Error('Provider response contains PRIVATE SOURCE BODY');
      },
    });
    await refreshNarrative('pilot');
    expect(writes.at(-1)?.args.error).not.toContain('PRIVATE');
  });
  test('tool and context budgets cannot be bypassed by a model loop', async () => {
    setup();
    const tools = narrativeResearchTools('pilot');
    let result: any;
    for (let i = 0; i < 13; i++) result = await (tools.narrative_search.execute as any)({ query: 'review' });
    expect(result.error).toContain('budget');
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      (narrativeResearchTools('pilot', aborted.signal).narrative_read.execute as any)({ id: 'evidence1' }),
    ).rejects.toThrow('cancelled');
  });
  test('parsing and accounting retain explicit evidence and actual GLM rates', () => {
    expect(() => parseNarrativeGeneration('{"text":"hello","sourceIds":[]}', new Set())).toThrow();
    expect(() =>
      parseNarrativeGeneration(
        '{"text":"Loading your day context...","sourceIds":["one"]}',
        new Set(['one']),
      ),
    ).toThrow('progress placeholder');
    expect(() =>
      parseNarrativeGeneration(
        '{"text":"Nothing else has changed since yesterday.","sourceIds":["one"]}',
        new Set(['one']),
      ),
    ).toThrow('inactivity');
    expect(
      parseNarrativeGeneration(
        JSON.stringify({
          text: 'Your intention is to finish QA before deployment. Absence of records is not proof that nothing happened; the outcome remains unknown.',
          sourceIds: ['one'],
        }),
        new Set(['one']),
      ).text,
    ).toContain('not proof');
    expect(
      estimateAiUsageCost({
        provider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      }).estimatedCostUsd,
    ).toBeCloseTo(0.325);
  });
});
