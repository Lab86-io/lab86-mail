import { afterEach, expect, spyOn, test } from 'bun:test';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { __setIntentPlanDepsForTest, generateIntentPlan } from '../lib/albatross/intent-plan';
import { emptyNarrativeContext } from '../lib/narrative/context';

const restores: Array<() => void> = [];
afterEach(() => {
  __setIntentPlanDepsForTest();
  for (const restore of restores.splice(0).reverse()) restore();
});

function replay(
  options: {
    researchMs?: number;
    stuckTool?: boolean;
    providerError?: boolean;
    stuckWriter?: boolean;
    earlyAnswer?: boolean;
    reasoningSensitive?: boolean;
  } = {},
) {
  // Six seconds of context, then successive successful research rounds.
  // Scale wall timers so the production 144s failure takes milliseconds.
  const realSetTimeout = globalThis.setTimeout;
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: number, ...args: any[]) =>
    realSetTimeout(fn, ms >= 1000 ? ms / 1000 : ms, ...args)) as typeof setTimeout);
  restores.push(
    () => clock.mockRestore(),
    () => timers.mockRestore(),
  );
  const mutations: Array<{ fn: string; args: any }> = [];
  const generations: any[] = [];
  const toolSignals: AbortSignal[] = [];
  let researchCalls = 0;
  const plan = {
    title: 'Submit the application',
    kind: 'task',
    shape: 'quick',
    outcome: 'The application is submitted.',
    digitalActions: [{ kind: 'task', title: 'Submit the application', sourceRefIds: ['ref1', 'ref2'] }],
    sourceRefIds: ['ref1', 'ref2'],
  };
  const model = new MockLanguageModelV3({
    doGenerate: async (call) => {
      if (options.providerError) throw new Error('Provider authentication failed');
      const finish = options.earlyAnswer || !call.tools?.length || call.toolChoice?.type === 'none';
      const delay =
        options.reasoningSensitive && call.providerOptions?.openai?.reasoningEffort !== 'low'
          ? 200
          : finish
            ? 10
            : (options.researchMs ?? 35);
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(call.abortSignal?.reason);
        };
        const timer = realSetTimeout(
          () => {
            call.abortSignal?.removeEventListener('abort', abort);
            resolve();
          },
          finish && options.stuckWriter ? 200 : delay,
        );
        call.abortSignal?.addEventListener('abort', abort, { once: true });
      });
      now += delay * 1000;
      return {
        content: finish
          ? [{ type: 'text', text: JSON.stringify(plan) }]
          : [
              {
                type: 'tool-call',
                toolCallId: `search-${researchCalls++}`,
                toolName: 'corpus_search',
                input: '{"query":"application"}',
              },
            ],
        finishReason: { unified: finish ? 'stop' : 'tool-calls', raw: finish ? 'stop' : 'tool_calls' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  __setIntentPlanDepsForTest({
    api: {
      albatross: { listAreas: 'areas', listVerifiedFacts: 'facts' },
      albatrossIntents: { getIntentWorkbench: 'work', updateIntent: 'update', savePlan: 'save' },
    },
    convexQuery: (async (fn: string) =>
      fn === 'work'
        ? { intent: { rawText: 'Submit the application', questions: [], shape: 'quick' }, plan: null }
        : []) as any,
    convexMutation: (async (fn: string, args: any) => {
      mutations.push({ fn, args });
      return fn === 'save' ? 'plan_1' : null;
    }) as any,
    getNarrativeTaskContext: async () => {
      now += 6000;
      return emptyNarrativeContext('work');
    },
    invokeTool: async (_tool, _args, ctx) => {
      if (ctx.abortSignal) {
        toolSignals.push(ctx.abortSignal);
        if (options.stuckTool) return new Promise(() => {});
      }
      return {
        items: [
          {
            source: 'mail',
            threadId: ctx.abortSignal ? 'research-only' : 'application',
            subject: 'Application instructions',
          },
        ],
      };
    },
    generateTextForCurrentUser: (async (call: any) => {
      // The optional document composer has its own coverage; finish it quickly.
      if (call.feature === 'albatross_plan_artifact') {
        await call.tools.place_region.execute({
          region: {
            id: 'steps',
            summary: 'Application steps',
            tree: {
              kind: 'checklist',
              title: 'Steps',
              items: [{ label: 'Submit the application', stepKey: 'step-1' }],
            },
          },
        });
        return { text: '' };
      }
      generations.push(call);
      return generateText({ ...call, model });
    }) as any,
  });
  return {
    mutations,
    generations,
    model,
    toolSignals,
    run: () => generateIntentPlan({ userId: 'owner', intentId: 'work_1' }),
  };
}

test('slow successful research leaves time to finish and save the plan', async () => {
  const harness = replay();
  expect(await harness.run()).toMatchObject({ planId: 'plan_1' });
  expect(harness.generations).toHaveLength(2);
  expect(harness.generations[0].abortSignal.aborted).toBe(true);
  const writing = harness.generations[1];
  expect(writing.tools).toBeUndefined();
  expect(writing.toolChoice).toBe('none');
  expect(writing.abortSignal.aborted).toBe(false);
  expect(JSON.stringify(writing.messages)).toContain('research-only');
  expect(harness.mutations.find(({ fn }) => fn === 'save')?.args.sourceRefs).toEqual([
    expect.objectContaining({ id: 'application' }),
    expect.objectContaining({ id: 'research-only' }),
  ]);
  expect(harness.mutations.some(({ args }) => args.planError)).toBe(false);
});

test('fast repeated research is forced to write before the step limit', async () => {
  const harness = replay({ researchMs: 1 });
  expect(await harness.run()).toMatchObject({ planId: 'plan_1' });
  expect(harness.generations).toHaveLength(1);
  expect(harness.model.doGenerateCalls).toHaveLength(5);
  expect(harness.model.doGenerateCalls.at(-1)?.toolChoice?.type).toBe('none');
});

test('a stalled research tool is cancelled and the plan uses only available sources', async () => {
  const harness = replay({ researchMs: 1, stuckTool: true });
  expect(await harness.run()).toMatchObject({ planId: 'plan_1' });
  expect(harness.toolSignals.length).toBeGreaterThan(0);
  expect(harness.toolSignals.every((signal) => signal.aborted)).toBe(true);
  expect(harness.mutations.find(({ fn }) => fn === 'save')?.args.sourceRefs).toEqual([
    expect.objectContaining({ id: 'application' }),
  ]);
});

test('a complete early plan is saved without another model call', async () => {
  const harness = replay({ earlyAnswer: true });
  expect(await harness.run()).toMatchObject({ planId: 'plan_1' });
  expect(harness.generations).toHaveLength(1);
  expect(harness.model.doGenerateCalls).toHaveLength(1);
});

test('planning bounds model reasoning effort as well as research time', async () => {
  const harness = replay({ earlyAnswer: true, reasoningSensitive: true });
  expect(await harness.run()).toMatchObject({ planId: 'plan_1' });
  expect(harness.generations).toHaveLength(1);
  expect(harness.model.doGenerateCalls[0].providerOptions?.openai?.reasoningEffort).toBe('low');
});

test('provider failures are preserved and do not start a second generation', async () => {
  const harness = replay({ providerError: true });
  await expect(harness.run()).rejects.toThrow('Provider authentication failed');
  expect(harness.generations).toHaveLength(1);
  expect(harness.mutations.some(({ fn }) => fn === 'save')).toBe(false);
  expect(harness.mutations.at(-1)?.args).toMatchObject({
    status: 'captured',
    planError: 'Provider authentication failed',
  });
});

test('a stuck final writer still fails at the original overall deadline without saving', async () => {
  const harness = replay({ stuckWriter: true });
  await expect(harness.run()).rejects.toThrow('Plan generation timed out after 144s');
  expect(harness.mutations.some(({ fn }) => fn === 'save')).toBe(false);
  expect(harness.mutations.at(-1)?.args).toMatchObject({
    status: 'captured',
    planError: 'Plan generation timed out after 144s',
  });
});
