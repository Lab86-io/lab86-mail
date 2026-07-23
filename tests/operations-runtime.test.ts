import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/operations.ts': () => import('../convex/operations'),
};

describe('operation undo leases', () => {
  test('serializes provider inverses and makes completed undo reconciliation idempotent', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'operations-runtime-secret';
    try {
      const t = convexTest(schema, convexModules);
      const operationId = await t.run((ctx) =>
        ctx.db.insert('aiOperations', {
          userId: 'operation_user',
          agent: 'user',
          tool: 'calendar_create_event',
          surface: 'calendar',
          summary: 'Created planning',
          target: { eventId: 'event_1' },
          inverse: { kind: 'calendar.delete_event', payload: { eventId: 'event_1' } },
          status: 'applied',
          createdAt: Date.now(),
        }),
      );
      const caller = {
        internalSecret: 'operations-runtime-secret',
        userId: 'operation_user',
        operationId,
      };

      const first = await t.mutation(api.operations.claimUndo, {
        ...caller,
        claimToken: 'claim_1',
        leaseMs: 60_000,
      });
      expect(first).toMatchObject({ state: 'claimed', summary: 'Created planning' });

      const concurrent = await t.mutation(api.operations.claimUndo, {
        ...caller,
        claimToken: 'claim_2',
        leaseMs: 1_000,
      });
      expect(concurrent).toMatchObject({ state: 'in_progress' });

      await t.mutation(api.operations.completeUndo, { ...caller, claimToken: 'claim_1' });
      const replay = await t.mutation(api.operations.claimUndo, {
        ...caller,
        claimToken: 'claim_3',
        leaseMs: 60_000,
      });
      expect(replay).toMatchObject({ state: 'already_undone', summary: 'Created planning' });
      const row = await t.run((ctx) => ctx.db.get(operationId));
      expect(row).toMatchObject({ status: 'undone' });
      expect(row?.undoClaimToken).toBeUndefined();
      expect(row?.undoClaimExpiresAt).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('retries only after a claimed inverse records failure', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'operations-failure-secret';
    try {
      const t = convexTest(schema, convexModules);
      const operationId = await t.run((ctx) =>
        ctx.db.insert('aiOperations', {
          userId: 'operation_user',
          agent: 'user',
          tool: 'task_create',
          surface: 'tasks',
          summary: 'Created task',
          target: { cardId: 'card_1' },
          inverse: { kind: 'task.delete', payload: { cardId: 'card_1' } },
          status: 'applied',
          createdAt: Date.now(),
        }),
      );
      const caller = {
        internalSecret: 'operations-failure-secret',
        userId: 'operation_user',
        operationId,
      };

      await t.mutation(api.operations.claimUndo, {
        ...caller,
        claimToken: 'claim_failed',
        leaseMs: 60_000,
      });
      await t.mutation(api.operations.markUndoFailed, {
        ...caller,
        claimToken: 'claim_failed',
        error: 'provider unavailable',
      });
      expect(await t.run((ctx) => ctx.db.get(operationId))).toMatchObject({
        status: 'undo_failed',
        error: 'provider unavailable',
      });

      const retry = await t.mutation(api.operations.claimUndo, {
        ...caller,
        claimToken: 'claim_retry',
        leaseMs: 60_000,
      });
      expect(retry).toMatchObject({ state: 'claimed' });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
