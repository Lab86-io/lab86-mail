import { describe, expect, test } from 'bun:test';
import { completeWorkStep, StepExecutionError } from '../lib/albatross/step-execution';

const completion = (over: Record<string, unknown> = {}) => ({
  stepKey: 'step-1',
  stepIdentity: 'action:submit',
  stepTitle: 'Submit the form',
  planId: 'plan-1',
  cardId: 'card-1',
  allStepsComplete: false,
  workState: 'active',
  transitioned: true,
  ...over,
});

describe('completeWorkStep', () => {
  test('an ordinary named step is one mutation and never replans', async () => {
    const mutations: any[] = [];
    let queryCount = 0;
    const result = await completeWorkStep({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1' }, {
      convexQuery: async () => {
        queryCount += 1;
        return null;
      },
      convexMutation: async (_fn: unknown, args: any) => {
        mutations.push(args);
        return completion();
      },
    } as any);

    expect(queryCount).toBe(0);
    expect(mutations).toEqual([
      expect.objectContaining({
        workId: 'work-1',
        stepKey: 'step-1',
        source: 'user',
      }),
    ]);
    expect(result).toMatchObject({
      transitioned: true,
      closed: false,
      replanned: false,
    });
  });

  test('the final step records proof and queues follow-up without plan generation', async () => {
    const mutations: any[] = [];
    const result = await completeWorkStep({ userId: 'user-1', workId: 'work-1', stepKey: 'physical-1' }, {
      convexQuery: async () => ({ work: { workState: 'active' } }),
      convexMutation: async (_fn: unknown, args: any) => {
        mutations.push(args);
        return mutations.length === 1
          ? completion({
              stepKey: 'physical-1',
              stepIdentity: 'step:physical:mail the packet',
              stepTitle: 'Mail the packet',
              cardId: null,
              allStepsComplete: true,
            })
          : 'evidence-1';
      },
    } as any);

    expect(mutations[1]).toMatchObject({
      sourceKind: 'manual',
      sourceId: 'plan:plan-1:steps-complete',
      trust: 'confirmed',
      settleContract: false,
    });
    expect(result).toMatchObject({
      closed: false,
      replanned: false,
      followUp: 'queued',
    });
  });

  test('a final proof closure returns done without a queued replan', async () => {
    const result = await completeWorkStep({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1' }, {
      convexQuery: async () => ({ work: { workState: 'done' } }),
      convexMutation: async (_fn: unknown, args: any) =>
        args.stepKey ? completion({ allStepsComplete: true, cardId: null }) : 'evidence-1',
    } as any);

    expect(result).toMatchObject({
      closed: true,
      replanned: false,
      followUp: 'not_needed',
    });
  });

  test('a duplicate completion does not attach proof again', async () => {
    let mutationCount = 0;
    let queryCount = 0;
    const result = await completeWorkStep({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1' }, {
      convexQuery: async () => {
        queryCount += 1;
        return null;
      },
      convexMutation: async () => {
        mutationCount += 1;
        return completion({ allStepsComplete: true, transitioned: false });
      },
    } as any);

    expect(mutationCount).toBe(1);
    expect(queryCount).toBe(0);
    expect(result).toMatchObject({
      transitioned: false,
      replanned: false,
      followUp: 'not_needed',
    });
  });

  test('a caller without a key resolves the current step once', async () => {
    let queryCount = 0;
    const result = await completeWorkStep({ userId: 'user-1', workId: 'work-1' }, {
      convexQuery: async () => {
        queryCount += 1;
        return {
          work: { _id: 'work-1' },
          plan: { _id: 'plan-1' },
          execution: { currentStep: { key: 'step-1' } },
        };
      },
      convexMutation: async () => completion(),
    } as any);

    expect(queryCount).toBe(1);
    expect(result.stepKey).toBe('step-1');
  });

  test('classifies missing Work and missing current steps for the route', async () => {
    const missing = completeWorkStep({ userId: 'user-1', workId: 'work-1' }, {
      convexQuery: async () => null,
      convexMutation: async () => null,
    } as any);
    await expect(missing).rejects.toMatchObject({
      name: 'StepExecutionError',
      status: 404,
    });

    const noStep = completeWorkStep({ userId: 'user-1', workId: 'work-1' }, {
      convexQuery: async () => ({
        work: {},
        plan: {},
        execution: { currentStep: null },
      }),
      convexMutation: async () => null,
    } as any);
    await expect(noStep).rejects.toBeInstanceOf(StepExecutionError);
    await expect(noStep).rejects.toMatchObject({ status: 409 });
  });

  test('translates mutation validation into typed route errors', async () => {
    const missing = completeWorkStep({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1' }, {
      convexQuery: async () => null,
      convexMutation: async () => {
        throw new Error('Work not found.');
      },
    } as any);
    await expect(missing).rejects.toMatchObject({ status: 404 });

    const missingStep = completeWorkStep({ userId: 'user-1', workId: 'work-1', stepKey: 'missing' }, {
      convexQuery: async () => null,
      convexMutation: async () => {
        throw new Error('Plan step not found.');
      },
    } as any);
    await expect(missingStep).rejects.toMatchObject({ status: 409 });
  });
});
