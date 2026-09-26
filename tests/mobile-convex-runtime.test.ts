import { describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mobile.ts': () => import('../convex/mobile'),
};

type MobileDomain = 'mail' | 'tasks' | 'calendar';

// Production no longer writes tombstones through a mutation, but listSync
// and the stale-revision check still read them. Seed one the way the old
// writer did: advance the domain head, then store the tombstone.
async function seedTombstone(
  t: TestConvex<typeof schema>,
  input: { userId: string; domain: MobileDomain; entityKind: string; entityId: string },
) {
  return t.run(async (ctx) => {
    const head = await ctx.db
      .query('mobileSyncHeads')
      .withIndex('by_user_domain', (q) => q.eq('userId', input.userId).eq('domain', input.domain))
      .unique();
    const revision = (head?.revision ?? 0) + 1;
    if (head) await ctx.db.patch(head._id, { revision, updatedAt: Date.now() });
    else
      await ctx.db.insert('mobileSyncHeads', {
        userId: input.userId,
        domain: input.domain,
        revision,
        updatedAt: Date.now(),
      });
    await ctx.db.insert('mobileSyncTombstones', {
      userId: input.userId,
      domain: input.domain,
      revision,
      entityKind: input.entityKind,
      entityId: input.entityId,
      createdAt: Date.now(),
    });
    return revision;
  });
}

describe('mobile Convex runtime', () => {
  test('bootstrapState rejects a wrong secret and scopes state to the requested user', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'mobile-bootstrap-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      await t.run(async (ctx) => {
        for (const userId of ['mobile_user', 'other_user']) {
          await ctx.db.insert('connectedAccounts', {
            userId,
            accountId: `account_${userId}`,
            email: `${userId}@example.com`,
            provider: 'google',
            status: 'connected',
            scopes: ['mail'],
            grantId: `grant_${userId}`,
            createdAt: ts,
            updatedAt: ts,
          });
        }
        await ctx.db.insert('mailSyncStates', {
          userId: 'mobile_user',
          accountId: 'account_mobile_user',
          grantId: 'grant_mobile_user',
          provider: 'google',
          status: 'ready',
          corpusReady: true,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('albatrossNotificationPreferences', {
          userId: 'mobile_user',
          timezone: 'America/New_York',
          eveningCheckinEnabled: true,
          eveningCheckinLocalTime: '18:30',
          inAppEnabled: true,
          webPushEnabled: false,
          emailFallbackEnabled: false,
          emailFallbackDelayMinutes: 30,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('mobileSyncHeads', {
          userId: 'mobile_user',
          domain: 'tasks',
          revision: 7,
          updatedAt: ts,
        });
      });

      await expect(
        t.query(api.mobile.bootstrapState, { internalSecret: 'wrong-secret', userId: 'mobile_user' }),
      ).rejects.toThrow('Invalid Convex internal secret.');

      const state = await t.query(api.mobile.bootstrapState, {
        internalSecret: 'mobile-bootstrap-secret',
        userId: 'mobile_user',
      });
      expect(state.accounts).toHaveLength(1);
      expect(state.accounts[0]).toMatchObject({ accountId: 'account_mobile_user' });
      expect(state.mailSync).toHaveLength(1);
      expect(state.mailSync[0]).toMatchObject({ status: 'ready', corpusReady: true });
      expect(state.preferences).toMatchObject({ timezone: 'America/New_York' });
      expect(state.heads).toHaveLength(1);
      expect(state.heads[0]).toMatchObject({ domain: 'tasks', revision: 7 });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('beginCommand queues once, replays idempotently, and flags a reused key', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'mobile-begin-secret';
    try {
      const t = convexTest(schema, convexModules);
      const baseArgs = {
        internalSecret: 'mobile-begin-secret',
        userId: 'begin_user',
        idempotencyKey: 'key_1',
        payloadHash: 'hash_1',
        domain: 'tasks' as const,
        kind: 'card.create',
        payload: { title: 'Buy milk' },
        clientCreatedAt: '2026-07-20T12:00:00Z',
      };
      const first = await t.mutation(api.mobile.beginCommand, baseArgs);
      expect(first.created).toBe(true);
      expect(first.keyReused).toBe(false);
      expect(first.command).toMatchObject({ status: 'queued', kind: 'card.create' });
      expect(first.command?.errorCode).toBeUndefined();

      const replay = await t.mutation(api.mobile.beginCommand, baseArgs);
      expect(replay.created).toBe(false);
      expect(replay.keyReused).toBe(false);
      expect(replay.command?._id).toBe(first.command?._id);

      const reused = await t.mutation(api.mobile.beginCommand, { ...baseArgs, payloadHash: 'hash_2' });
      expect(reused.created).toBe(false);
      expect(reused.keyReused).toBe(true);
      expect(reused.command?._id).toBe(first.command?._id);

      const commands = await t.run((ctx) => ctx.db.query('mobileCommands').collect());
      expect(commands).toHaveLength(1);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('beginCommand conflicts a stale base revision against the domain head', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'mobile-conflict-secret';
    try {
      const t = convexTest(schema, convexModules);
      const deletionArgs = {
        internalSecret: 'mobile-conflict-secret',
        userId: 'conflict_user',
        domain: 'tasks' as const,
        entityKind: 'card',
      };
      expect(await seedTombstone(t, { ...deletionArgs, entityId: 'card_1' })).toBe(1);
      expect(await seedTombstone(t, { ...deletionArgs, entityId: 'card_2' })).toBe(2);

      const begin = (idempotencyKey: string, baseRevision?: number) =>
        t.mutation(api.mobile.beginCommand, {
          internalSecret: 'mobile-conflict-secret',
          userId: 'conflict_user',
          idempotencyKey,
          payloadHash: 'hash',
          domain: 'tasks',
          kind: 'card.update',
          payload: {},
          baseRevision,
          clientCreatedAt: '2026-07-20T12:00:00Z',
        });

      const stale = await begin('stale_key', 1);
      expect(stale.command).toMatchObject({
        status: 'conflicted',
        errorCode: 'STALE_REVISION',
        errorMessage: 'The tasks domain advanced from revision 1 to 2.',
        errorRetryable: false,
      });

      const current = await begin('current_key', 2);
      expect(current.command?.status).toBe('queued');

      const unversioned = await begin('unversioned_key');
      expect(unversioned.command?.status).toBe('queued');
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('claimCommand leases queued commands and refuses live or spent leases', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'mobile-claim-secret';
    try {
      const t = convexTest(schema, convexModules);
      const begun = await t.mutation(api.mobile.beginCommand, {
        internalSecret: 'mobile-claim-secret',
        userId: 'claim_user',
        idempotencyKey: 'claim_key',
        payloadHash: 'hash',
        domain: 'mail',
        kind: 'thread.archive',
        payload: {},
        clientCreatedAt: '2026-07-20T12:00:00Z',
      });
      const commandId = begun.command?._id;
      if (!commandId) throw new Error('expected a queued command');

      const claimArgs = { internalSecret: 'mobile-claim-secret', userId: 'claim_user', commandId };
      const first = await t.mutation(api.mobile.claimCommand, {
        ...claimArgs,
        claimToken: 'token_a',
        leaseMs: 5_000,
      });
      expect(first.claimed).toBe(true);
      expect(first.command).toMatchObject({ claimToken: 'token_a', attemptCount: 1 });

      const contested = await t.mutation(api.mobile.claimCommand, {
        ...claimArgs,
        claimToken: 'token_b',
        leaseMs: 5_000,
      });
      expect(contested.claimed).toBe(false);
      expect(contested.command?.claimToken).toBe('token_a');

      await t.run((ctx) => ctx.db.patch(commandId, { claimedAt: Date.now() - 60_000 }));
      const reclaimed = await t.mutation(api.mobile.claimCommand, {
        ...claimArgs,
        claimToken: 'token_b',
        leaseMs: 5_000,
      });
      expect(reclaimed.claimed).toBe(true);
      expect(reclaimed.command).toMatchObject({ claimToken: 'token_b', attemptCount: 2 });

      await t.run((ctx) => ctx.db.patch(commandId, { status: 'applied' }));
      const settled = await t.mutation(api.mobile.claimCommand, {
        ...claimArgs,
        claimToken: 'token_c',
        leaseMs: 5_000,
      });
      expect(settled.claimed).toBe(false);

      await expect(
        t.mutation(api.mobile.claimCommand, {
          ...claimArgs,
          userId: 'someone_else',
          claimToken: 'token_d',
          leaseMs: 5_000,
        }),
      ).rejects.toThrow('Mobile command not found.');
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('completeCommand enforces the lease, records sync changes, and skips them on failure', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'mobile-complete-secret';
    try {
      const t = convexTest(schema, convexModules);
      const begin = async (idempotencyKey: string) => {
        const begun = await t.mutation(api.mobile.beginCommand, {
          internalSecret: 'mobile-complete-secret',
          userId: 'complete_user',
          idempotencyKey,
          payloadHash: 'hash',
          domain: 'tasks',
          kind: 'card.create',
          payload: {},
          clientCreatedAt: '2026-07-20T12:00:00Z',
        });
        const commandId = begun.command?._id;
        if (!commandId) throw new Error('expected a queued command');
        await t.mutation(api.mobile.claimCommand, {
          internalSecret: 'mobile-complete-secret',
          userId: 'complete_user',
          commandId,
          claimToken: `lease_${idempotencyKey}`,
          leaseMs: 5_000,
        });
        return commandId;
      };

      const appliedId = await begin('apply_key');
      await expect(
        t.mutation(api.mobile.completeCommand, {
          internalSecret: 'mobile-complete-secret',
          userId: 'complete_user',
          commandId: appliedId,
          claimToken: 'stolen-token',
          status: 'applied',
        }),
      ).rejects.toThrow('Mobile command execution lease was lost.');

      const applied = await t.mutation(api.mobile.completeCommand, {
        internalSecret: 'mobile-complete-secret',
        userId: 'complete_user',
        commandId: appliedId,
        claimToken: 'lease_apply_key',
        status: 'applied',
        syncDomain: 'today',
        entityKind: 'card',
        entityId: 'card_1',
        syncPayload: { title: 'Synced card' },
        operationId: 'op_1',
        undoExpiresAt: Date.now() + 60_000,
      });
      expect(applied).toMatchObject({ status: 'applied', entityRevision: 1, operationId: 'op_1' });
      expect(applied?.claimToken).toBeUndefined();
      expect(applied?.claimedAt).toBeUndefined();

      const changes = await t.run((ctx) => ctx.db.query('mobileSyncChanges').collect());
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        domain: 'today',
        entityKind: 'card',
        entityId: 'card_1',
        revision: 1,
        payload: { title: 'Synced card' },
      });

      // Re-completing a settled command is a no-op replay of the stored row.
      const replay = await t.mutation(api.mobile.completeCommand, {
        internalSecret: 'mobile-complete-secret',
        userId: 'complete_user',
        commandId: appliedId,
        claimToken: 'irrelevant',
        status: 'failed',
      });
      expect(replay).toMatchObject({ status: 'applied', entityRevision: 1 });

      const failedId = await begin('fail_key');
      const failed = await t.mutation(api.mobile.completeCommand, {
        internalSecret: 'mobile-complete-secret',
        userId: 'complete_user',
        commandId: failedId,
        claimToken: 'lease_fail_key',
        status: 'failed',
        entityKind: 'card',
        entityId: 'card_2',
        syncPayload: { title: 'Never synced' },
        errorCode: 'PROVIDER_DOWN',
        errorMessage: 'Upstream 503',
        errorRetryable: true,
      });
      expect(failed).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_DOWN',
        errorRetryable: true,
      });
      expect(failed?.entityRevision).toBeUndefined();
      expect(await t.run((ctx) => ctx.db.query('mobileSyncChanges').collect())).toHaveLength(1);

      await expect(
        t.mutation(api.mobile.completeCommand, {
          internalSecret: 'mobile-complete-secret',
          userId: 'someone_else',
          commandId: failedId,
          claimToken: 'lease_fail_key',
          status: 'applied',
        }),
      ).rejects.toThrow('Mobile command not found.');
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('getCommand returns the owner view and null for other users', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'mobile-get-secret';
    try {
      const t = convexTest(schema, convexModules);
      const begun = await t.mutation(api.mobile.beginCommand, {
        internalSecret: 'mobile-get-secret',
        userId: 'get_user',
        idempotencyKey: 'get_key',
        payloadHash: 'hash',
        domain: 'assistant',
        kind: 'chat.send',
        payload: { text: 'hi' },
        clientCreatedAt: '2026-07-20T12:00:00Z',
      });
      const commandId = begun.command?._id;
      if (!commandId) throw new Error('expected a queued command');

      const mine = await t.query(api.mobile.getCommand, {
        internalSecret: 'mobile-get-secret',
        userId: 'get_user',
        commandId,
      });
      expect(mine).toMatchObject({ kind: 'chat.send', status: 'queued' });

      const theirs = await t.query(api.mobile.getCommand, {
        internalSecret: 'mobile-get-secret',
        userId: 'other_user',
        commandId,
      });
      expect(theirs).toBeNull();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('listSync interleaves changes and tombstones by revision with pagination', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'mobile-sync-secret';
    try {
      const t = convexTest(schema, convexModules);
      const caller = { internalSecret: 'mobile-sync-secret', userId: 'sync_user' };
      const applyChange = async (idempotencyKey: string, entityId: string) => {
        const begun = await t.mutation(api.mobile.beginCommand, {
          ...caller,
          idempotencyKey,
          payloadHash: 'hash',
          domain: 'mail',
          kind: 'thread.update',
          payload: {},
          clientCreatedAt: '2026-07-20T12:00:00Z',
        });
        const commandId = begun.command?._id;
        if (!commandId) throw new Error('expected a queued command');
        await t.mutation(api.mobile.claimCommand, {
          ...caller,
          commandId,
          claimToken: 'lease',
          leaseMs: 5_000,
        });
        const completed = await t.mutation(api.mobile.completeCommand, {
          ...caller,
          commandId,
          claimToken: 'lease',
          status: 'applied',
          entityKind: 'thread',
          entityId,
          syncPayload: { entityId },
        });
        return completed?.entityRevision;
      };

      const rev1 = await applyChange('sync_key_1', 'thread_a');
      const rev2 = await seedTombstone(t, {
        ...caller,
        domain: 'mail',
        entityKind: 'thread',
        entityId: 'thread_b',
      });
      const rev3 = await applyChange('sync_key_2', 'thread_c');
      expect([rev1, rev2, rev3]).toEqual([1, 2, 3]);
      // A different domain keeps its own revision counter.
      expect(
        await seedTombstone(t, {
          ...caller,
          domain: 'tasks',
          entityKind: 'card',
          entityId: 'card_a',
        }),
      ).toBe(1);

      const full = await t.query(api.mobile.listSync, {
        ...caller,
        domain: 'mail',
        afterRevision: 0,
        limit: 10,
      });
      expect(full.serverRevision).toBe(3);
      expect(full.hasMore).toBe(false);
      expect(full.page.map((entry) => [entry.type, entry.revision])).toEqual([
        ['change', 1],
        ['tombstone', 2],
        ['change', 3],
      ]);
      expect(full.page[1]?.row).toMatchObject({ entityId: 'thread_b' });

      const paged = await t.query(api.mobile.listSync, {
        ...caller,
        domain: 'mail',
        afterRevision: 0,
        limit: 2,
      });
      expect(paged.page.map((entry) => entry.revision)).toEqual([1, 2]);
      expect(paged.hasMore).toBe(true);

      const resumed = await t.query(api.mobile.listSync, {
        ...caller,
        domain: 'mail',
        afterRevision: 2,
        limit: 10,
      });
      expect(resumed.page.map((entry) => entry.revision)).toEqual([3]);
      expect(resumed.hasMore).toBe(false);

      // limit is clamped to at least one entry.
      const clamped = await t.query(api.mobile.listSync, {
        ...caller,
        domain: 'mail',
        afterRevision: 0,
        limit: 0,
      });
      expect(clamped.page).toHaveLength(1);
      expect(clamped.hasMore).toBe(true);

      const untouched = await t.query(api.mobile.listSync, {
        ...caller,
        domain: 'calendar',
        afterRevision: 0,
        limit: 10,
      });
      expect(untouched).toMatchObject({ page: [], hasMore: false, serverRevision: 0 });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('undo claims serialize concurrent requests and enforce the server expiry window', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'mobile-undo-claim-secret';
    try {
      const t = convexTest(schema, convexModules);
      const begin = async (idempotencyKey: string, undoExpiresAt?: number) => {
        const operationId = await t.run((ctx) =>
          ctx.db.insert('aiOperations', {
            userId: 'undo_claim_user',
            agent: 'user',
            tool: 'test_create',
            surface: 'tasks',
            summary: `Created ${idempotencyKey}`,
            target: { id: idempotencyKey },
            inverse: { kind: 'test.delete', payload: { id: idempotencyKey } },
            status: 'applied',
            createdAt: Date.now(),
          }),
        );
        const begun = await t.mutation(api.mobile.beginCommand, {
          internalSecret: 'mobile-undo-claim-secret',
          userId: 'undo_claim_user',
          idempotencyKey,
          payloadHash: 'hash',
          domain: 'tasks',
          kind: 'card.create',
          payload: {},
          clientCreatedAt: '2026-07-23T12:00:00Z',
        });
        const commandId = begun.command?._id;
        if (!commandId) throw new Error('expected a queued command');
        await t.mutation(api.mobile.claimCommand, {
          internalSecret: 'mobile-undo-claim-secret',
          userId: 'undo_claim_user',
          commandId,
          claimToken: 'execute-lease',
          leaseMs: 5_000,
        });
        await t.mutation(api.mobile.completeCommand, {
          internalSecret: 'mobile-undo-claim-secret',
          userId: 'undo_claim_user',
          commandId,
          claimToken: 'execute-lease',
          status: 'applied',
          operationId: String(operationId),
          undoExpiresAt,
        });
        return { commandId, operationId };
      };

      const { commandId: expiredId } = await begin('expired', Date.now() - 1);
      const expired = await t.mutation(api.mobile.claimCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId: expiredId,
        claimToken: 'undo-expired',
        leaseMs: 60_000,
      });
      expect(expired).toMatchObject({ claimed: false, reason: 'expired' });

      const { commandId, operationId } = await begin('valid', Date.now() + 60_000);
      const first = await t.mutation(api.mobile.claimCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId,
        claimToken: 'undo-1',
        leaseMs: 60_000,
      });
      expect(first).toMatchObject({ claimed: true, reason: 'claimed' });
      const concurrent = await t.mutation(api.mobile.claimCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId,
        claimToken: 'undo-2',
        leaseMs: 1_000,
      });
      expect(concurrent).toMatchObject({ claimed: false, reason: 'in_progress' });

      await t.run(async (ctx) => {
        await ctx.db.patch(commandId, { undoClaimExpiresAt: Date.now() - 1 });
        await ctx.db.patch(operationId, {
          status: 'undoing',
          undoClaimToken: 'provider-undo',
          undoClaimExpiresAt: Date.now() + 60_000,
        });
      });
      const blockedByProvider = await t.mutation(api.mobile.claimCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId,
        claimToken: 'undo-reclaimed',
        leaseMs: 60_000,
      });
      expect(blockedByProvider).toMatchObject({ claimed: false, reason: 'in_progress' });

      await t.run(async (ctx) => {
        await ctx.db.patch(operationId, {
          status: 'undo_failed',
          undoClaimToken: undefined,
          undoClaimExpiresAt: undefined,
        });
      });
      const reclaimed = await t.mutation(api.mobile.claimCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId,
        claimToken: 'undo-reclaimed',
        leaseMs: 60_000,
      });
      expect(reclaimed).toMatchObject({ claimed: true, reason: 'claimed' });

      await t.mutation(api.mobile.releaseCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId,
        claimToken: 'undo-reclaimed',
      });
      const retry = await t.mutation(api.mobile.claimCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId,
        claimToken: 'undo-3',
        leaseMs: 60_000,
      });
      expect(retry.claimed).toBe(true);
      await t.run(async (ctx) => {
        await ctx.db.patch(commandId, { undoClaimExpiresAt: Date.now() - 1 });
        await ctx.db.patch(operationId, {
          status: 'undone',
          undoneAt: Date.now(),
          undoClaimToken: undefined,
          undoClaimExpiresAt: undefined,
        });
      });
      const completed = await t.mutation(api.mobile.completeCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId,
        claimToken: 'undo-3',
      });
      expect(completed?.undoneAt).toBeGreaterThan(0);

      const repeated = await t.mutation(api.mobile.claimCommandUndo, {
        internalSecret: 'mobile-undo-claim-secret',
        userId: 'undo_claim_user',
        commandId,
        claimToken: 'undo-5',
        leaseMs: 60_000,
      });
      expect(repeated).toMatchObject({ claimed: false, reason: 'already_undone' });
      const changes = await t.run((ctx) => ctx.db.query('mobileSyncChanges').collect());
      expect(changes.filter((row) => row.entityId === String(operationId))).toHaveLength(1);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
