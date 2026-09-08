import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { estimateAiUsageCost } from '../lib/ai/budget';
import {
  __setNarrativeDepsForTest,
  narrativeEnabled,
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
  overrides: { price?: string; generate?: (request: any) => Promise<any>; revoked?: boolean } = {},
) {
  const writes: Array<{ name: string; args: any }> = [],
    requests: any[] = [];
  __setNarrativeDepsForTest({
    query: (async (fn: any) =>
      getFunctionName(fn) === 'narrative:read'
        ? { entry: chapter, sources: [observation], revision: 4 }
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
      if (request.toolChoice !== 'none')
        await request.tools.narrative_start.execute({}, { toolCallId: 'test-start', messages: [] });
      return overrides.generate
        ? overrides.generate(request)
        : {
            text: JSON.stringify({
              text: 'You planned to finish the review. Completion is not yet established by the available evidence. Check QA before deployment.',
              sourceIds: ['evidence1'],
            }),
            totalUsage: { inputTokens: 30, outputTokens: 20 },
          };
    }) as any,
  });
  return { writes, requests };
}
describe('narrative agent run', () => {
  test('feature and pilot gates reject all unapproved users', async () => {
    const state = setup();
    expect(narrativeEnabled('pilot')).toBe(true);
    expect(narrativeEnabled('someone-else')).toBe(false);
    expect(await refreshNarrative('someone-else')).toEqual({ status: 'disabled' });
    expect(state.writes).toEqual([]);
  });
  test('research uses read-only tools, cancellation, explicit model, and bounded generation', async () => {
    const { writes, requests } = setup();
    expect((await refreshNarrative('pilot', 'brief')).status).toBe('ready');
    expect(requests).toHaveLength(2);
    expect(requests[1].toolChoice).toBe('none');
    expect(requests[1].feature).toBe('narrative_write');
    expect(Object.keys(requests[0].tools).sort()).toEqual([
      'narrative_changes_since',
      'narrative_read',
      'narrative_search',
      'narrative_sources',
      'narrative_start',
    ]);
    expect(requests[0].narrativeModel).toBe('z-ai/glm-5.3-flash');
    expect(requests[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(requests[0].maxOutputTokens).toBe(4000);
    expect(requests[0].maxRetries).toBe(0);
    expect(requests[0].prepareStep({ messages: [], stepNumber: 4 })).toEqual({ toolChoice: 'none' });
    expect(requests[0].prepareStep({ messages: [], stepNumber: 0 })).toEqual({
      toolChoice: { type: 'tool', toolName: 'narrative_start' },
    });
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
      generate: async (request) =>
        request.feature === 'narrative_research'
          ? {
              text: 'Checking for more records...',
              response: { messages: [{ role: 'assistant', content: 'Checking for more records...' }] },
            }
          : {
              text: JSON.stringify({
                text: 'You planned to finish QA before deployment. Preparing for the review remains your stated priority; completion is not established by the evidence.',
                sourceIds: ['evidence1'],
              }),
            },
    });
    expect((await refreshNarrative('pilot')).status).toBe('ready');
    expect(requests[1].toolChoice).toBe('none');
    expect(writes.find((w) => w.name === 'narrative:publish')?.args.text).toContain('finish QA');
    expect(writes.find((w) => w.name === 'narrative:publish')?.args.text).not.toContain('Checking');
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
      generate: async () => ({ text: '{"text":"You finished everything","sourceIds":["invented"]}' }),
    });
    expect((await refreshNarrative('pilot')).status).toBe('partial');
    expect(writes.some((w) => w.name === 'narrative:publish')).toBe(false);
    expect(writes.at(-1)?.name).toBe('narrative:finish');
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
