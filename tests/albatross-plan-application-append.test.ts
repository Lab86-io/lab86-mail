import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
};

const SECRET = 'plan-application-append-secret';

async function withSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  }
}

const caller = (userId: string) => ({ internalSecret: SECRET, userId });

describe('appendPlanApplicationArtifacts', () => {
  test('appends deduped artifacts to the newest application row', async () => {
    await withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const first = await t.mutation(api.albatrossWork.recordPlanApplication, {
        ...caller('user_1'),
        intentId: 'intent_1',
        operationBatchId: 'batch_1',
        status: 'applied',
        artifacts: [{ kind: 'task', id: 'card_1', title: 'Existing task' }],
        operationIds: ['op_1'],
        pendingApprovalIds: [],
        unresolvedArtifacts: [],
      });
      const appended = await t.mutation(api.albatrossWork.appendPlanApplicationArtifacts, {
        ...caller('user_1'),
        intentId: 'intent_1',
        artifacts: [
          { kind: 'task', id: 'card_1', title: 'Existing task', operationId: 'op_1' },
          { kind: 'calendarEvent', id: 'evt_1', title: 'Chat hold', operationId: 'op_2' },
        ],
        operationIds: ['op_1', 'op_2', '', '   '],
      });
      expect(String(appended)).toBe(String(first));
      const rows = await t.query(api.albatrossWork.listPlanApplications, {
        ...caller('user_1'),
        intentId: 'intent_1',
      });
      expect(rows).toHaveLength(1);
      // The duplicate card_1 folded away; only the new event landed.
      expect(rows[0].artifacts.map((artifact: any) => `${artifact.kind}:${artifact.id}`)).toEqual([
        'task:card_1',
        'calendarEvent:evt_1',
      ]);
      // Empty operation ids never enter the ledger.
      expect(rows[0].operationIds.sort()).toEqual(['op_1', 'op_2']);
    });
  });

  test('inserts a fallback row that carries the Work primary project', async () => {
    await withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      const { workId, projectId } = await t.run(async (ctx) => {
        const projectId = await ctx.db.insert('albatrossProjects', {
          userId: 'user_1',
          title: 'Keuka trip',
          status: 'active',
          createdAt: ts,
          updatedAt: ts,
        });
        const workId = await ctx.db.insert('albatrossIntents', {
          userId: 'user_1',
          rawText: 'Recover the furniture from the lake house.',
          source: 'chat',
          status: 'ready',
          primaryProjectId: projectId,
          createdAt: ts,
          updatedAt: ts,
        });
        return { workId, projectId };
      });
      await t.mutation(api.albatrossWork.appendPlanApplicationArtifacts, {
        ...caller('user_1'),
        intentId: String(workId),
        artifacts: [{ kind: 'calendarEvent', id: 'evt_9', title: 'Trip hold', operationId: 'op_9' }],
        operationIds: ['op_9'],
      });
      const rows = await t.query(api.albatrossWork.listPlanApplications, {
        ...caller('user_1'),
        intentId: String(workId),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('applied');
      expect(String(rows[0].projectId)).toBe(String(projectId));
      expect(rows[0].operationBatchId.startsWith('chat-turn:')).toBe(true);
    });
  });

  test('rejects empty intent ids and ignores artifacts without ids', async () => {
    await withSecret(async () => {
      const t = convexTest(schema, convexModules);
      await expect(
        t.mutation(api.albatrossWork.appendPlanApplicationArtifacts, {
          ...caller('user_1'),
          intentId: '   ',
          artifacts: [{ kind: 'task', id: 'card_1', title: 'T' }],
          operationIds: [],
        }),
      ).rejects.toThrow('intentId required');
      const noop = await t.mutation(api.albatrossWork.appendPlanApplicationArtifacts, {
        ...caller('user_1'),
        intentId: 'intent_2',
        artifacts: [{ kind: 'task', title: 'No id' }, null],
        operationIds: [],
      });
      expect(noop).toBeNull();
      const rows = await t.query(api.albatrossWork.listPlanApplications, {
        ...caller('user_1'),
        intentId: 'intent_2',
      });
      expect(rows).toHaveLength(0);
    });
  });

  test('never touches another user’s application rows', async () => {
    await withSecret(async () => {
      const t = convexTest(schema, convexModules);
      await t.mutation(api.albatrossWork.recordPlanApplication, {
        ...caller('user_1'),
        intentId: 'intent_shared',
        operationBatchId: 'batch_1',
        status: 'applied',
        artifacts: [{ kind: 'task', id: 'card_1', title: 'Owner task' }],
        operationIds: [],
        pendingApprovalIds: [],
        unresolvedArtifacts: [],
      });
      await t.mutation(api.albatrossWork.appendPlanApplicationArtifacts, {
        ...caller('user_2'),
        intentId: 'intent_shared',
        artifacts: [{ kind: 'task', id: 'card_intruder', title: 'Intruder task' }],
        operationIds: [],
      });
      const ownerRows = await t.query(api.albatrossWork.listPlanApplications, {
        ...caller('user_1'),
        intentId: 'intent_shared',
      });
      expect(ownerRows).toHaveLength(1);
      expect(ownerRows[0].artifacts).toHaveLength(1);
      expect(ownerRows[0].artifacts[0].id).toBe('card_1');
    });
  });
});
