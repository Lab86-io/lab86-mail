import { describe, expect, test } from 'bun:test';
import { completeWorkStep, StepExecutionError } from '../lib/albatross/step-execution';

const detail = (over: Record<string, unknown> = {}) => ({
  work: { _id: 'work-1', workState: 'active' },
  plan: { _id: 'plan-1' },
  execution: {
    currentStep: { key: 'step-1' },
    guideSteps: [{ key: 'step-1', title: 'Submit the form', cardId: 'card-1' }],
  },
  contract: { proofs: [{ id: 'confirmation', what: 'Confirmation arrived' }] },
  ...over,
});

describe('completeWorkStep', () => {
  test('syncs the task card and records the exact plan step', async () => {
    const mutations: any[] = [];
    const toolCalls: any[] = [];
    const advances: any[] = [];
    const result = await completeWorkStep({ userId: 'user-1', workId: 'work-1' }, {
      convexQuery: async () => detail(),
      convexMutation: async (_fn: unknown, args: any) => {
        mutations.push(args);
        return { stepKey: 'step-1', cardId: 'card-1', allStepsComplete: false, transitioned: true };
      },
      invokeTool: async (_tool: unknown, args: any) => {
        toolCalls.push(args);
        return {};
      },
      advanceWork: async (args: any) => {
        advances.push(args);
        return { status: 'ready' as const, workId: 'work-1', planId: 'plan-2' };
      },
      newOperationBatchId: () => 'batch-1',
    } as any);
    expect(toolCalls).toEqual([{ cardId: 'card-1', completed: true }]);
    expect(mutations[0]).toMatchObject({ workId: 'work-1', stepKey: 'step-1', source: 'task' });
    expect(advances).toHaveLength(1);
    expect(result).toMatchObject({ allStepsComplete: false, closed: false, replanned: true });
  });

  test('final completion records proof and replans only when the outcome still needs proof', async () => {
    let queryCount = 0;
    const mutations: any[] = [];
    const advances: any[] = [];
    const result = await completeWorkStep(
      { userId: 'user-1', workId: 'work-1', timezone: 'America/New_York' },
      {
        convexQuery: async () => {
          queryCount += 1;
          return queryCount === 1
            ? detail({
                execution: {
                  currentStep: { key: 'physical-1' },
                  guideSteps: [{ key: 'physical-1', title: 'Mail the packet', cardId: null }],
                },
              })
            : detail({ work: { _id: 'work-1', workState: 'active' } });
        },
        convexMutation: async (_fn: unknown, args: any) => {
          mutations.push(args);
          return mutations.length === 1
            ? { stepKey: 'physical-1', cardId: null, allStepsComplete: true, transitioned: true }
            : 'evidence-1';
        },
        invokeTool: async () => ({}),
        advanceWork: async (args: any) => {
          advances.push(args);
          return { status: 'ready' as const, workId: 'work-1', planId: 'plan-2' };
        },
        newOperationBatchId: () => 'batch-1',
      } as any,
    );
    expect(mutations[1]).toMatchObject({
      sourceKind: 'manual',
      trust: 'confirmed',
      settleContract: false,
    });
    expect(advances).toHaveLength(1);
    expect(result).toMatchObject({ closed: false, replanned: true });
  });

  test('valid proof closure is the only completion path that does not advance again', async () => {
    let queryCount = 0;
    const advances: any[] = [];
    const result = await completeWorkStep({ userId: 'user-1', workId: 'work-1' }, {
      convexQuery: async () => {
        queryCount += 1;
        return queryCount === 1
          ? detail({
              execution: {
                currentStep: { key: 'step-1' },
                guideSteps: [{ key: 'step-1', title: 'Submit the form', cardId: null }],
              },
            })
          : detail({ work: { _id: 'work-1', workState: 'done' } });
      },
      convexMutation: async (_fn: unknown, args: any) =>
        args.stepKey
          ? { stepKey: 'step-1', cardId: null, allStepsComplete: true, transitioned: true }
          : 'evidence-1',
      invokeTool: async () => ({}),
      advanceWork: async (args: any) => {
        advances.push(args);
        return { status: 'ready' as const, workId: 'work-1', planId: 'plan-2' };
      },
      newOperationBatchId: () => 'batch-1',
    } as any);

    expect(advances).toHaveLength(0);
    expect(result).toMatchObject({ closed: true, replanned: false });
  });

  test('a duplicate completion does not attach proof or replan again', async () => {
    const mutations: any[] = [];
    const advances: any[] = [];
    const toolCalls: any[] = [];
    const result = await completeWorkStep({ userId: 'user-1', workId: 'work-1' }, {
      convexQuery: async () => detail(),
      convexMutation: async (_fn: unknown, args: any) => {
        mutations.push(args);
        return {
          stepKey: 'step-1',
          cardId: 'card-1',
          allStepsComplete: true,
          transitioned: false,
        };
      },
      invokeTool: async (...args: any[]) => {
        toolCalls.push(args);
        return {};
      },
      advanceWork: async (args: any) => {
        advances.push(args);
        return { status: 'ready' as const, workId: 'work-1', planId: 'plan-2' };
      },
      newOperationBatchId: () => 'batch-1',
    } as any);

    expect(mutations).toHaveLength(1);
    expect(toolCalls).toHaveLength(0);
    expect(advances).toHaveLength(0);
    expect(result).toMatchObject({ transitioned: false, replanned: false });
  });

  test('classifies missing Work and missing current steps for the route', async () => {
    const dependencies = {
      convexQuery: async () => null,
      convexMutation: async () => null,
      invokeTool: async () => ({}),
      advanceWork: async () => ({ status: 'ready' as const, workId: 'work-1', planId: 'plan-1' }),
      newOperationBatchId: () => 'batch-1',
    } as any;
    const missing = completeWorkStep({ userId: 'user-1', workId: 'work-1' }, dependencies);
    await expect(missing).rejects.toMatchObject({ name: 'StepExecutionError', status: 404 });

    dependencies.convexQuery = async () =>
      detail({
        execution: { currentStep: null, guideSteps: [] },
      });
    const noStep = completeWorkStep({ userId: 'user-1', workId: 'work-1' }, dependencies);
    await expect(noStep).rejects.toBeInstanceOf(StepExecutionError);
    await expect(noStep).rejects.toMatchObject({ status: 409 });
  });
});
