import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createAlbatrossApplyPost } from '../app/api/albatross/apply/route';

function applyRequest(body: unknown) {
  return new NextRequest('http://localhost/api/albatross/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const plan = {
  _id: 'plan_1',
  status: 'ready',
  outcome: 'Moved in',
  digitalActions: [
    { kind: 'task', key: 'step-1', actionKey: 'a1', title: 'Book the truck' },
    { kind: 'task', key: 'step-2', actionKey: 'a2', title: 'Pack the kitchen' },
  ],
};

function setup(applications: any[]) {
  const invocations: any[] = [];
  const mutations: Array<{ name: string; args: any }> = [];
  const post = createAlbatrossApplyPost({
    requireCurrentUser: (async () => ({ userId: 'user_1', email: 'a@example.test', name: 'A' })) as any,
    enforceUserRateLimit: (async () => undefined) as any,
    newOperationBatchId: () => 'batch_1',
    convexQuery: (async (fn: any) => {
      const name = getFunctionName(fn);
      if (name.endsWith('getPlanArtifact')) return { status: 'ready', intentId: 'work_1' };
      if (name.endsWith('getIntentWorkbench'))
        return { intent: { _id: 'work_1', rawText: 'Move', questions: [] }, plan };
      if (name.endsWith('listPlanApplications')) return applications;
      return null;
    }) as any,
    convexMutation: (async (fn: any, args: any) => {
      mutations.push({ name: getFunctionName(fn), args });
      return null;
    }) as any,
    invokeTool: (async (_tool: any, args: any) => {
      invocations.push(args);
      return { applicationId: 'app_2', operations: [], approvals: [], unresolved: [] };
    }) as any,
  });
  return { post, invocations, mutations };
}

describe('POST /api/albatross/apply', () => {
  test('a retry applies only the actions that earlier attempts did not record (WRK-4)', async () => {
    const { post, invocations, mutations } = setup([
      {
        status: 'partially_applied',
        artifacts: [{ kind: 'task', id: 'card_1', actionKey: 'a1', stepKey: 'step-1' }],
      },
    ]);
    const response = await post(applyRequest({ planId: 'plan_1' }));
    expect(response.status).toBe(200);
    expect(invocations[0].plan.digitalActions.map((action: any) => action.actionKey)).toEqual(['a2']);
    expect(mutations.find((call) => call.name.endsWith('markPlanApplied'))?.args.planId).toBe('plan_1');
  });

  test('an undone application does not count as applied', async () => {
    const { post, invocations } = setup([
      { status: 'undone', artifacts: [{ kind: 'task', id: 'card_1', actionKey: 'a1' }] },
    ]);
    await post(applyRequest({ planId: 'plan_1' }));
    expect(invocations[0].plan.digitalActions).toHaveLength(2);
  });

  test('a failed apply does not mark the plan applied', async () => {
    const { post, mutations } = setup([]);
    const failing = createAlbatrossApplyPost({
      requireCurrentUser: (async () => ({ userId: 'user_1' })) as any,
      enforceUserRateLimit: (async () => undefined) as any,
      newOperationBatchId: () => 'batch_1',
      convexQuery: (async (fn: any) => {
        const name = getFunctionName(fn);
        if (name.endsWith('getPlanArtifact')) return { status: 'ready', intentId: 'work_1' };
        if (name.endsWith('getIntentWorkbench'))
          return { intent: { _id: 'work_1', rawText: 'Move', questions: [] }, plan };
        throw new Error('applications unavailable');
      }) as any,
      convexMutation: (async (fn: any, args: any) => {
        mutations.push({ name: getFunctionName(fn), args });
      }) as any,
      invokeTool: (async () => {
        throw new Error('Applied 1 of the plan actions. 1 failed');
      }) as any,
    });
    expect(post).toBeDefined();
    const response = await failing(applyRequest({ planId: 'plan_1' }));
    expect(response.status).toBe(500);
    expect(mutations.some((call) => call.name.endsWith('markPlanApplied'))).toBe(false);
  });
});
