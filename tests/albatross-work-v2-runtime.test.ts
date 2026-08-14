import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
};

const SECRET = 'albatross-work-v2-runtime-secret';
const userId = 'area_brief_runtime_user';
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

async function seedAreaWork() {
  const t = convexTest(schema, convexModules);
  const seeded = await t.run(async (ctx) => {
    const ts = Date.now();
    const areaId = await ctx.db.insert('areas', {
      userId,
      name: 'Area Brief Runtime',
      kind: 'general',
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    });
    const workId = await ctx.db.insert('albatrossIntents', {
      userId,
      rawText: 'Verify the live Area Brief data path.',
      source: 'text',
      title: 'Area Brief contract',
      status: 'ready',
      primaryAreaId: areaId,
      workState: 'active',
      agentState: 'idle',
      createdAt: ts,
      updatedAt: ts,
    });
    return { areaId, workId };
  });
  return { t, ...seeded };
}

describe('Albatross Work v2 Area Brief reads', () => {
  test('Railway internal caller can load area Work and Work detail', async () => {
    const { t, areaId, workId } = await seedAreaWork();
    const caller = { internalSecret: SECRET, userId };

    const work = await t.query(api.albatrossWorkV2.areaWork, { ...caller, areaId });
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      _id: workId,
      userId,
      title: 'Area Brief contract',
      primaryAreaId: areaId,
    });

    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    expect(detail.work._id).toBe(workId);
    expect(detail.questions).toEqual([]);
    expect(detail.areaLinks).toEqual([]);
  });

  test('Clerk identity path still works and isolates another user', async () => {
    const { t, areaId, workId } = await seedAreaWork();
    const asUser = t.withIdentity({ subject: userId });

    expect(await asUser.query(api.albatrossWorkV2.areaWork, { areaId })).toHaveLength(1);
    expect((await asUser.query(api.albatrossWorkV2.workDetail, { workId })).work._id).toBe(workId);

    const stranger = t.withIdentity({ subject: 'another_user' });
    await expect(stranger.query(api.albatrossWorkV2.areaWork, { areaId })).rejects.toThrow(/Area not found/);
    await expect(stranger.query(api.albatrossWorkV2.workDetail, { workId })).rejects.toThrow(
      /Work not found/,
    );
  });

  test('internal caller rejects an invalid secret', async () => {
    const { t, areaId, workId } = await seedAreaWork();
    const caller = { internalSecret: 'wrong', userId };

    await expect(t.query(api.albatrossWorkV2.areaWork, { ...caller, areaId })).rejects.toThrow(
      /Invalid Convex internal secret/,
    );
    await expect(t.query(api.albatrossWorkV2.workDetail, { ...caller, workId })).rejects.toThrow(
      /Invalid Convex internal secret/,
    );
  });

  test('provider evidence dedupes within an account and connection, not across them', async () => {
    const { t, workId } = await seedAreaWork();
    const caller = { internalSecret: SECRET, userId };
    const attach = (accountId: string, connectionId: string, title: string) =>
      t.mutation(api.albatrossWorkV2.attachProof, {
        ...caller,
        workId,
        claim: 'The application was purchased.',
        title,
        sourceKind: 'mail_thread' as const,
        sourceId: 'provider-thread-1',
        accountId,
        connectionId,
        trust: 'observed' as const,
      });

    const first = await attach('account-a', 'connection-a', 'First receipt');
    const updated = await attach('account-a', 'connection-a', 'Updated receipt');
    const otherAccount = await attach('account-b', 'connection-a', 'Other account receipt');
    const otherConnection = await attach('account-a', 'connection-b', 'Other connection receipt');

    expect(updated).toBe(first);
    expect(otherAccount).not.toBe(first);
    expect(otherConnection).not.toBe(first);
    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    expect(detail.evidence).toHaveLength(3);
    expect(detail.evidence.find((evidence) => evidence._id === first)?.title).toBe('Updated receipt');
  });

  test('confirmed mail proof satisfies the named contract and closes Work once', async () => {
    const { t, workId } = await seedAreaWork();
    const caller = { internalSecret: SECRET, userId };
    await t.run((ctx) =>
      ctx.db.patch(workId, {
        contract: {
          outcome: 'The passport application is accepted.',
          proofs: [{ id: 'confirmation', what: 'The passport application confirmation arrived' }],
          closeWhen: 'outcome_confirmed',
          updatedAt: Date.now(),
        },
      }),
    );

    await t.mutation(api.albatrossWorkV2.attachProof, {
      ...caller,
      workId,
      claim: 'The passport application confirmation arrived.',
      title: 'Passport application confirmation',
      sourceKind: 'mail_thread',
      sourceId: 'passport-confirmation-thread',
      accountId: 'personal-mail',
      trust: 'confirmed',
      proofId: 'confirmation',
    });

    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    expect(detail.work).toMatchObject({ workState: 'done', status: 'done' });
    expect(detail.contract?.proofs[0]).toMatchObject({
      id: 'confirmation',
      satisfiedBy: 'Passport application confirmation',
    });
    expect(detail.contract?.proofs[0]?.satisfiedAt).toBeNumber();
    const completions = await t.run((ctx) =>
      ctx.db
        .query('completionEvents')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    );
    expect(completions.filter((row) => row.artifactId === String(workId))).toHaveLength(1);
  });

  test('finishing a plan step records progress without impersonating outcome proof', async () => {
    const { t, workId } = await seedAreaWork();
    const caller = { internalSecret: SECRET, userId };
    await t.run((ctx) =>
      ctx.db.patch(workId, {
        contract: {
          outcome: 'The passport application is accepted.',
          proofs: [{ id: 'confirmation', what: 'The passport application confirmation arrived' }],
          closeWhen: 'outcome_confirmed',
          updatedAt: Date.now(),
        },
      }),
    );

    await t.mutation(api.albatrossWorkV2.attachProof, {
      ...caller,
      workId,
      claim: 'Every planned form-filling step is complete.',
      title: 'Completed the application steps',
      sourceKind: 'task',
      sourceId: 'application-task',
      trust: 'confirmed',
      settleContract: false,
    });

    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    expect(detail.work.workState).not.toBe('done');
    expect(detail.contract?.proofs[0]?.satisfiedAt).toBeUndefined();
    expect(detail.evidence).toHaveLength(1);
  });
});
