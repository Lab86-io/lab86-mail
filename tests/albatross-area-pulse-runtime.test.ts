import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossAreaPulse.ts': () => import('../convex/albatrossAreaPulse'),
};

const SECRET = 'area-pulse-runtime-secret';
const userId = 'area_pulse_user';
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

function harness() {
  return convexTest(schema, convexModules);
}

async function seedArea(t: ReturnType<typeof harness>, owner = userId) {
  return t.run(async (ctx) => {
    const ts = Date.now();
    return ctx.db.insert('areas', {
      userId: owner,
      name: 'Studio',
      kind: 'project',
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    } as any);
  });
}

const pulse = {
  lastChange: 'Maya sent the venue list.',
  nextMove: 'Pick a venue.',
  openQuestion: 'Which venue?',
  prose: 'The studio is waiting on a venue.',
  model: 'fast',
};

describe('albatrossAreaPulse', () => {
  test('inserts a brief row with the pulse when none exists, then patches it', async () => {
    const t = harness();
    const areaId = await seedArea(t);

    await t.mutation(api.albatrossAreaPulse.saveAreaPulse, { ...caller, areaId, pulse });
    const first = await t.query(api.albatrossAreaPulse.listAreaPulses, { ...caller });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ areaId, pulse });
    expect(typeof first[0].pulseUpdatedAt).toBe('number');

    await t.mutation(api.albatrossAreaPulse.saveAreaPulse, {
      ...caller,
      areaId,
      pulse: { ...pulse, nextMove: 'x'.repeat(500), model: undefined },
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('albatrossAreaBriefs')
        .withIndex('by_user_area', (q) => q.eq('userId', userId).eq('areaId', areaId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pulse?.nextMove).toHaveLength(400);
    expect(rows[0].pulse?.model).toBeUndefined();
    expect(rows[0].status).toBe('ready');
  });

  test('rejects an area the caller does not own and hides rows without a pulse', async () => {
    const t = harness();
    const foreign = await seedArea(t, 'someone_else');
    await expect(
      t.mutation(api.albatrossAreaPulse.saveAreaPulse, { ...caller, areaId: foreign, pulse }),
    ).rejects.toThrow('Area not found.');

    const own = await seedArea(t);
    await t.run(async (ctx) => {
      const ts = Date.now();
      await ctx.db.insert('albatrossAreaBriefs', {
        userId,
        areaId: own,
        status: 'ready',
        lede: 'old',
        summary: 'old',
        sourceRefs: [],
        basedOnRevision: 'r1',
        createdAt: ts,
        updatedAt: ts,
      });
    });
    expect(await t.query(api.albatrossAreaPulse.listAreaPulses, { ...caller, limit: 5 })).toEqual([]);
  });

  test('lists only active areas, newest pulse first, within the limit', async () => {
    const t = harness();
    const ids = [] as any[];
    for (let i = 0; i < 4; i++) ids.push(await seedArea(t));
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[3], { status: 'archived' });
      for (const [index, areaId] of ids.entries())
        await ctx.db.insert('albatrossAreaBriefs', {
          userId,
          areaId,
          status: 'ready',
          lede: '',
          summary: '',
          sourceRefs: [],
          basedOnRevision: 'r',
          pulse: { ...pulse, prose: `pulse ${index}` },
          // Insertion order is not recency order.
          pulseUpdatedAt: [300, 100, 200, 999][index],
          createdAt: 1,
          updatedAt: 1,
        });
    });
    const rows = await t.query(api.albatrossAreaPulse.listAreaPulses, { ...caller, limit: 2 });
    expect(rows.map((row: any) => row.pulse.prose)).toEqual(['pulse 0', 'pulse 2']);
    const all = await t.query(api.albatrossAreaPulse.listAreaPulses, { ...caller });
    expect(all.map((row: any) => row.areaId)).not.toContain(ids[3]);
  });

  test('requires the internal secret or an identity', async () => {
    const t = harness();
    await expect(t.query(api.albatrossAreaPulse.listAreaPulses, {})).rejects.toThrow('Not authenticated');
    await expect(t.query(api.albatrossAreaPulse.listAreaPulses, { internalSecret: SECRET })).rejects.toThrow(
      'userId required',
    );
  });
});
