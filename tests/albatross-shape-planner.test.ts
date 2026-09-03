import { afterEach, describe, expect, test } from 'bun:test';
import { __setIntentPlanDepsForTest, generateIntentPlan } from '../lib/albatross/intent-plan';
import { advanceWork, setWorkOrchestratorDependenciesForTest } from '../lib/albatross/work-orchestrator';
import * as albatross from '../lib/tools/albatross';
import { runTool } from './tools/harness';

const fakeApi = {
  albatross: { listAreas: 'q:listAreas', listVerifiedFacts: 'q:listVerifiedFacts', areaHome: 'q:areaHome' },
  albatrossIntents: {
    getIntentWorkbench: 'q:getIntentWorkbench',
    updateIntent: 'm:updateIntent',
    savePlan: 'm:savePlan',
  },
  albatrossWorkV2: { workDetail: 'q:workDetail', setAgentState: 'm:setAgentState' },
  userData: { listDocs: 'q:memoryDocs' },
};

afterEach(() => {
  __setIntentPlanDepsForTest();
  albatross.__setAlbatrossToolDepsForTest();
});

describe('the planner and shapes without plans', () => {
  for (const shape of ['list', 'practice', 'monitor', 'recurring'] as const) {
    test(`a ${shape} is marked ready without a model call or a plan`, async () => {
      const mutations: Array<{ fn: string; args: any }> = [];
      let generations = 0;
      __setIntentPlanDepsForTest({
        api: fakeApi as any,
        convexQuery: (async (fn: string) => {
          if (fn === 'q:getIntentWorkbench') {
            return {
              intent: { _id: 'intent_1', rawText: 'Movie list: Heat, Alien', title: 'Movie list', shape },
              plan: null,
            };
          }
          throw new Error(`unexpected query ${fn}`);
        }) as any,
        convexMutation: (async (fn: string, args: any) => {
          mutations.push({ fn, args });
          return null;
        }) as any,
        generateTextForCurrentUser: (async () => {
          generations += 1;
          return { text: '{}' } as any;
        }) as any,
      });
      const result = await generateIntentPlan({ userId: 'user_1', intentId: 'intent_1' });
      expect(result).toEqual({ planId: null, skipped: 'shape', title: 'Movie list', outcome: undefined });
      expect(generations).toBe(0);
      expect(mutations.map((entry) => entry.fn)).toEqual(['m:updateIntent', 'm:setAgentState']);
      expect(mutations[0].args).toMatchObject({ intentId: 'intent_1', status: 'ready', planError: '' });
      expect(mutations[1].args).toMatchObject({ workId: 'intent_1', agentState: 'idle' });
      expect(mutations.some((entry) => entry.fn === 'm:savePlan')).toBe(false);
    });
  }

  test('advanceWork returns ready and applies nothing for a skipped plan', async () => {
    const mutations: any[] = [];
    let invoked = 0;
    const restore = setWorkOrchestratorDependenciesForTest({
      convexMutation: (async (_ref: unknown, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      convexQuery: (async () => ({ intent: { shape: 'list' }, plan: null })) as any,
      generateIntentPlan: (async () => ({ planId: null, skipped: 'shape' as const })) as any,
      invokeTool: (async () => {
        invoked += 1;
        return {};
      }) as any,
      newOperationBatchId: () => 'batch_1',
      generateAreaLivingBrief: (async () => ({}) as any) as any,
    });
    try {
      const result = await advanceWork({ userId: 'user_1', workId: 'work_1' });
      expect(result).toEqual({ status: 'ready', workId: 'work_1', planId: undefined });
      expect(invoked).toBe(0);
      // Only the "researching" state write happened before the planner answered.
      expect(mutations).toEqual([{ userId: 'user_1', workId: 'work_1', agentState: 'researching' }]);
    } finally {
      restore();
    }
  });

  test('albatross_replan_work says so before any state change', async () => {
    const mutations: any[] = [];
    albatross.__setAlbatrossToolDepsForTest({
      api: fakeApi as any,
      convexQuery: (async () => ({
        work: { _id: 'work_1', shape: 'practice', rawText: 'Lose fifteen pounds' },
      })) as any,
      convexMutation: (async (fn: string, args: any) => {
        mutations.push({ fn, args });
        return null;
      }) as any,
      generateIntentPlan: (async () => {
        throw new Error('must not plan');
      }) as any,
    });
    await expect(
      runTool(albatross.albatrossReplanWork.handler, { workId: 'work_1', summary: 'It moved.' }),
    ).rejects.toThrow(/This Work is a practice\. It keeps no plan and no steps/);
    expect(mutations).toEqual([]);
  });
});
