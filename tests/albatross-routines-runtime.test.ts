import { describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossRoutines.ts': () => import('../convex/albatrossRoutines'),
};

const userId = 'routine_user';

async function seed(t: TestConvex<typeof schema>) {
  return t.run(async (ctx) => {
    const projectId = await ctx.db.insert('albatrossProjects', {
      userId,
      title: 'Health',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    } as any);
    const base = {
      userId,
      projectId,
      status: 'active',
      consent: 'enabled',
      cadence: 'daily',
      localTime: '08:00',
      timezone: 'UTC',
      notification: { enabled: false, channel: 'in_app' },
      nextRunAt: Date.now() - 60_000,
      createdAt: 1,
      updatedAt: 1,
    };
    // No Area board, so its task cannot be created and the run fails.
    const failing = await ctx.db.insert('albatrossRoutines', {
      ...base,
      title: 'Broken routine',
      kind: 'task',
      taskTemplate: { title: 'Stretch' },
    } as any);
    const healthy = await ctx.db.insert('albatrossRoutines', {
      ...base,
      title: 'Evening review',
      kind: 'checkin',
      questionTemplate: { prompt: 'How did today go?' },
    } as any);
    return { failing, healthy };
  });
}

describe('WRK-13 routine tick', () => {
  test('one failing routine records its error and does not block the others', async () => {
    const t = convexTest(schema, modules);
    const { failing, healthy } = await seed(t);
    const before = await t.run((ctx) => ctx.db.get(failing));
    expect(await t.mutation(internal.albatrossRoutines.tick, {})).toEqual({ due: 2, scheduled: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => {});

    const runs = await t.run((ctx) => ctx.db.query('albatrossRoutineRuns').collect());
    const failedRun = runs.find((run) => run.routineId === failing);
    const healthyRun = runs.find((run) => run.routineId === healthy);
    expect(failedRun).toMatchObject({ status: 'error' });
    expect(failedRun?.error).toContain('task board is unavailable');
    expect(healthyRun?.status).toBe('completed');
    const after = await t.run((ctx) => ctx.db.get(failing));
    expect(after!.nextRunAt).toBeGreaterThan(before!.nextRunAt);

    // The next tick does not pick the failed routine again at once.
    expect(await t.mutation(internal.albatrossRoutines.tick, {})).toEqual({ due: 0, scheduled: 0 });
  });

  test('a forced run that fails records the error and keeps the schedule', async () => {
    const t = convexTest(schema, modules);
    const { failing } = await seed(t);
    const before = await t.run((ctx) => ctx.db.get(failing));
    await t.action(internal.albatrossRoutines.runOne, { routineId: failing, force: true });
    const runs = await t.run((ctx) => ctx.db.query('albatrossRoutineRuns').collect());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('error');
    expect((await t.run((ctx) => ctx.db.get(failing)))?.nextRunAt).toBe(before!.nextRunAt);
  });
});
