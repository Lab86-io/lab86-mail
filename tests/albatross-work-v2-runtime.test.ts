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
});
