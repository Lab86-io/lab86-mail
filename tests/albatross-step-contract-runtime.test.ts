import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/boards.ts': () => import('../convex/boards'),
  '../convex/mobile.ts': () => import('../convex/mobile'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
};

const SECRET = 'step-contract-runtime-secret';
const userId = 'step_contract_user';
const caller = { internalSecret: SECRET, userId };
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

describe('digital step contract in Convex', () => {
  test('savePlan drops an unknown mode and the projection reads only known values', async () => {
    const t = convexTest(schema, modules);
    const intentId = await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'Send the proposal',
        title: 'Proposal',
        source: 'text',
        status: 'ready',
        workState: 'active',
        agentState: 'idle',
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    await t.mutation(api.albatrossIntents.savePlan, {
      ...caller,
      intentId,
      digitalActions: [
        {
          actionKey: 'draft',
          kind: 'document',
          title: 'Draft the proposal',
          stepMode: 'robot_does',
          doneWhen: 'The proposal document exists.',
          evidence: { kind: 'telepathy' },
        },
        { actionKey: 'research', kind: 'task', title: 'Find three venues', stepMode: 'agent_does' },
      ],
      physicalActions: [],
      assumptions: [],
      sourceRefs: [],
    });
    const stored = await t.run(async (ctx) => {
      const work = await ctx.db.get(intentId);
      return work?.latestPlanId ? ctx.db.get(work.latestPlanId) : null;
    });
    expect(stored?.digitalActions[0]).not.toHaveProperty('stepMode');
    expect(stored?.digitalActions[0]).not.toHaveProperty('evidence');
    expect(stored?.digitalActions[0]).toMatchObject({ doneWhen: 'The proposal document exists.' });
    expect(stored?.digitalActions[1]).toMatchObject({ stepMode: 'agent_does' });

    // A row written before the check still reads safely.
    await t.run((ctx) =>
      ctx.db.patch(stored!._id, {
        digitalActions: [
          {
            actionKey: 'legacy',
            kind: 'task',
            title: 'Old step',
            stepMode: 'whatever',
            evidence: { kind: 'x' },
          },
        ],
      }),
    );
    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId: intentId });
    const legacy = detail?.execution.guideSteps.find((step: any) => step.title === 'Old step');
    expect(legacy).toMatchObject({ stepMode: null, evidenceKind: null });
  });
});
