import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
};

const SECRET = 'albatross-shape-runtime-secret';
const userId = 'shape_runtime_user';
const caller = { internalSecret: SECRET, userId };
const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
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

async function seedWork(t: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
  return t.run(async (ctx) => {
    const ts = Date.now();
    return ctx.db.insert('albatrossIntents', {
      userId,
      rawText: 'Movie list: Heat, Alien',
      source: 'text',
      title: 'Movie list',
      status: 'ready',
      workState: 'active',
      agentState: 'idle',
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    } as any);
  });
}

async function seedMailPlan(t: ReturnType<typeof harness>, workId: Id<'albatrossIntents'>) {
  return t.run(async (ctx) => {
    const ts = Date.now();
    const planId = await ctx.db.insert('albatrossIntentPlans', {
      userId,
      intentId: workId,
      status: 'applied',
      outcome: 'The form is acknowledged.',
      digitalActions: [],
      physicalActions: [
        {
          title: 'Submit the form',
          doneWhen: 'The acknowledgement arrives.',
          evidence: { kind: 'mail_confirmation', hint: 'Acknowledgement' },
        },
      ],
      assumptions: [],
      sourceRefs: [],
      createdAt: ts,
      updatedAt: ts,
    } as any);
    await ctx.db.patch(workId, { latestPlanId: planId, mailWatchAt: ts, updatedAt: ts });
    return planId;
  });
}

describe('list items', () => {
  test('add, toggle, and remove, each as a user touch', async () => {
    const t = harness();
    const workId = await seedWork(t, { shape: 'list' });
    const added = await t.mutation(api.albatrossWorkV2.addListItem, { ...caller, workId, text: '  Heat  ' });
    expect(added.item).toEqual({
      id: expect.any(String),
      text: 'Heat',
      done: false,
      addedAt: expect.any(Number),
    });
    expect(added.listItems).toHaveLength(1);
    const second = await t.mutation(api.albatrossWorkV2.addListItem, { ...caller, workId, text: 'Alien' });
    expect(second.listItems.map((item) => item.text)).toEqual(['Heat', 'Alien']);

    const toggled = await t.mutation(api.albatrossWorkV2.toggleListItem, {
      ...caller,
      workId,
      itemId: added.item.id,
    });
    expect(toggled.item.done).toBe(true);
    expect(toggled.item.doneAt).toEqual(expect.any(Number));

    // Items keep their add order; the clients settle done items to the bottom.
    const third = await t.mutation(api.albatrossWorkV2.addListItem, {
      ...caller,
      workId,
      text: 'Dune part two',
    });
    expect(third.listItems.map((item) => item.text)).toEqual(['Heat', 'Alien', 'Dune part two']);

    const untoggled = await t.mutation(api.albatrossWorkV2.toggleListItem, {
      ...caller,
      workId,
      itemId: added.item.id,
    });
    expect(untoggled.item.done).toBe(false);
    expect(untoggled.item.doneAt).toBeUndefined();

    const removed = await t.mutation(api.albatrossWorkV2.removeListItem, {
      ...caller,
      workId,
      itemId: second.item.id,
    });
    expect(removed.listItems.map((item) => item.text)).toEqual(['Heat', 'Dune part two']);

    const row = await t.run((ctx) => ctx.db.get(workId));
    expect(row?.listItems).toHaveLength(2);
    expect(row?.lastUserTouchAt).toBeGreaterThan(0);
  });

  test('rejects empty text, unknown items, and other users', async () => {
    const t = harness();
    const workId = await seedWork(t, { shape: 'list' });
    await expect(
      t.mutation(api.albatrossWorkV2.addListItem, { ...caller, workId, text: '   ' }),
    ).rejects.toThrow(/needs text/);
    await expect(
      t.mutation(api.albatrossWorkV2.toggleListItem, { ...caller, workId, itemId: 'nope' }),
    ).rejects.toThrow(/not found/);
    await expect(
      t.mutation(api.albatrossWorkV2.removeListItem, { ...caller, workId, itemId: 'nope' }),
    ).rejects.toThrow(/not found/);
    await expect(
      t.mutation(api.albatrossWorkV2.addListItem, {
        internalSecret: SECRET,
        userId: 'someone_else',
        workId,
        text: 'Heat',
      }),
    ).rejects.toThrow(/Work not found/);
  });
});

describe('metric logs', () => {
  test('logMetric writes an entry, keeps the metric, and returns the summary', async () => {
    const t = harness();
    const workId = await seedWork(t, {
      shape: 'practice',
      title: 'Weight',
      metric: { name: 'weight', unit: 'lb', direction: 'down' },
    });
    const first = await t.mutation(api.albatrossWorkV2.logMetric, {
      ...caller,
      workId,
      value: 186,
      at: Date.now() - 2 * WEEK,
      note: '  after the trip ',
    });
    expect(first.entry.note).toBe('after the trip');
    expect(first.metric).toEqual({ name: 'weight', unit: 'lb', direction: 'down' });
    const second = await t.mutation(api.albatrossWorkV2.logMetric, { ...caller, workId, value: 183.6 });
    expect(second.summary).toEqual({
      latest: 183.6,
      latestAt: expect.any(Number),
      count: 2,
      weeksWithEntry: 2,
    });
    const entries = await t.query(api.albatrossWorkV2.metricEntries, { ...caller, workId });
    expect(entries.map((entry) => entry.value)).toEqual([183.6, 186]);
    expect(entries[1].note).toBe('after the trip');
    const limited = await t.query(api.albatrossWorkV2.metricEntries, { ...caller, workId, limit: 1 });
    expect(limited).toHaveLength(1);
    const row = await t.run((ctx) => ctx.db.get(workId));
    expect(row?.lastUserTouchAt).toBeGreaterThan(0);
  });

  test('a Work without a metric gets a plain one on the first log; a future date is clamped to now', async () => {
    const t = harness();
    const workId = await seedWork(t, { shape: 'practice' });
    const before = Date.now();
    const result = await t.mutation(api.albatrossWorkV2.logMetric, {
      ...caller,
      workId,
      value: 5,
      at: Date.now() + 10 * DAY,
    });
    expect(result.metric).toEqual({ name: 'value', unit: '' });
    expect(result.entry.at).toBeGreaterThanOrEqual(before);
    expect(result.entry.at).toBeLessThanOrEqual(Date.now());
  });

  test('another user cannot read the entries', async () => {
    const t = harness();
    const workId = await seedWork(t, { shape: 'practice' });
    await expect(
      t.query(api.albatrossWorkV2.metricEntries, { internalSecret: SECRET, userId: 'someone_else', workId }),
    ).rejects.toThrow(/Work not found/);
  });
});

describe('milestones', () => {
  test('setMilestones keeps ids and done state by id or title; toggleMilestone flips one', async () => {
    const t = harness();
    const workId = await seedWork(t, { shape: 'project', title: 'Ship the Mac app' });
    const first = await t.mutation(api.albatrossWorkV2.setMilestones, {
      ...caller,
      workId,
      milestones: [{ title: 'Build passes' }, { title: 'TestFlight' }, { title: '  ' }],
    });
    expect(first.milestones.map((entry) => [entry.title, entry.order, entry.done])).toEqual([
      ['Build passes', 0, false],
      ['TestFlight', 1, false],
    ]);
    const buildId = first.milestones[0].id;

    const toggled = await t.mutation(api.albatrossWorkV2.toggleMilestone, {
      ...caller,
      workId,
      milestoneId: buildId,
    });
    expect(toggled.milestone.done).toBe(true);
    expect(toggled.milestone.doneAt).toEqual(expect.any(Number));

    // Re-ordered by id and renamed by title: both keep their done state.
    const edited = await t.mutation(api.albatrossWorkV2.setMilestones, {
      ...caller,
      workId,
      milestones: [
        { title: 'testflight' },
        { id: buildId, title: 'Build passes on CI' },
        { title: 'App Store' },
      ],
    });
    expect(edited.milestones.map((entry) => [entry.title, entry.order, entry.done])).toEqual([
      ['testflight', 0, false],
      ['Build passes on CI', 1, true],
      ['App Store', 2, false],
    ]);
    expect(edited.milestones[1].id).toBe(buildId);
    expect(edited.milestones[0].id).toBe(first.milestones[1].id);

    const reopened = await t.mutation(api.albatrossWorkV2.toggleMilestone, {
      ...caller,
      workId,
      milestoneId: buildId,
    });
    expect(reopened.milestone.done).toBe(false);
    await expect(
      t.mutation(api.albatrossWorkV2.toggleMilestone, { ...caller, workId, milestoneId: 'nope' }),
    ).rejects.toThrow(/not found/);
  });
});

describe('setShape', () => {
  test('changes the shape, keeps shape data, and counts as a touch', async () => {
    const t = harness();
    const workId = await seedWork(t, {
      shape: 'list',
      listItems: [{ id: 'li_1', text: 'Heat', done: false, addedAt: 1 }],
    });
    const result = await t.mutation(api.albatrossWorkV2.setShape, { ...caller, workId, shape: 'project' });
    expect(result).toEqual({ shape: 'project', previous: 'list' });
    const row = await t.run((ctx) => ctx.db.get(workId));
    expect(row?.shape).toBe('project');
    expect(row?.listItems).toHaveLength(1);
    expect(row?.lastUserTouchAt).toBeGreaterThan(0);
  });
});

describe('the Work payload', () => {
  test('allWork carries shape, items, metric, milestones, and the metric summary', async () => {
    const t = harness();
    const list = await seedWork(t, {
      shape: 'list',
      listItems: [{ id: 'li_1', text: 'Heat', done: false, addedAt: 1 }],
    });
    const practice = await seedWork(t, {
      title: 'Weight',
      shape: 'practice',
      metric: { name: 'weight', unit: 'lb', target: 170, direction: 'down' },
    });
    await t.mutation(api.albatrossWorkV2.logMetric, { ...caller, workId: practice, value: 184 });
    const rows = await t.query(api.albatrossWorkV2.allWork, { ...caller });
    const listRow = rows.find((row) => row._id === String(list))!;
    expect(listRow.shape).toBe('list');
    expect(listRow.listItems).toEqual([{ id: 'li_1', text: 'Heat', done: false, addedAt: 1 }]);
    expect(listRow.metric).toBeNull();
    expect(listRow.milestones).toBeNull();
    expect(listRow.metricSummary).toBeNull();
    const practiceRow = rows.find((row) => row._id === String(practice))!;
    expect(practiceRow.metric).toEqual({ name: 'weight', unit: 'lb', target: 170, direction: 'down' });
    expect(practiceRow.metricSummary).toEqual({
      latest: 184,
      latestAt: expect.any(Number),
      count: 1,
      weeksWithEntry: 1,
    });
  });

  test('workDetail carries the entries newest first and the summary', async () => {
    const t = harness();
    const workId = await seedWork(t, { shape: 'practice', metric: { name: 'weight', unit: 'lb' } });
    await t.mutation(api.albatrossWorkV2.logMetric, { ...caller, workId, value: 186, at: Date.now() - DAY });
    await t.mutation(api.albatrossWorkV2.logMetric, { ...caller, workId, value: 185 });
    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    expect(detail.metricEntries.map((entry) => entry.value)).toEqual([185, 186]);
    expect(detail.metricSummary?.count).toBe(2);
    const plain = await seedWork(t, { title: 'Plain' });
    const plainDetail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId: plain });
    expect(plainDetail.metricEntries).toEqual([]);
    expect(plainDetail.metricSummary).toBeNull();
  });
});

describe('finishCapture with shape data', () => {
  test('stores list items for a list and the metric for a practice', async () => {
    const t = harness();
    const captureId = await t.mutation(api.albatrossWorkV2.beginCapture, {
      ...caller,
      rawText: 'Movie list: Heat, Alien. Lose fifteen pounds by spring.',
      source: 'text',
    });
    const workIds = await t.mutation(api.albatrossWorkV2.finishCapture, {
      ...caller,
      captureId,
      items: [
        {
          title: 'Movie list',
          rawText: 'Movie list: Heat, Alien',
          shape: 'list',
          listItems: ['Heat', ' Alien', ''],
        },
        {
          title: 'Lose fifteen pounds',
          rawText: 'Lose fifteen pounds by spring',
          shape: 'practice',
          metric: { name: 'weight', unit: 'lb', direction: 'down' },
        },
        // Items on a non-list shape are ignored: the shape owns the data.
        { title: 'Passport', rawText: 'Renew the passport', shape: 'quick', listItems: ['a', 'b'] },
      ],
    });
    const rows = await Promise.all(workIds.map((id) => t.run((ctx) => ctx.db.get(id))));
    expect(rows[0]?.shape).toBe('list');
    expect(rows[0]?.listItems?.map((item) => item.text)).toEqual(['Heat', 'Alien']);
    expect(rows[0]?.listItems?.[0]).toEqual({
      id: expect.any(String),
      text: 'Heat',
      done: false,
      addedAt: expect.any(Number),
    });
    expect(rows[1]?.shape).toBe('practice');
    expect(rows[1]?.metric).toEqual({ name: 'weight', unit: 'lb', direction: 'down' });
    expect(rows[2]?.listItems).toBeUndefined();
  });
});

describe('conductor candidates read the shape policy', () => {
  test('mailWatchCandidates skips shapes with mailWatch: false', async () => {
    const t = harness();
    const quick = await seedWork(t, { title: 'Quick', shape: 'quick' });
    await seedMailPlan(t, quick);
    const monitor = await seedWork(t, { title: 'Monitor', shape: 'monitor' });
    await seedMailPlan(t, monitor);
    for (const shape of ['list', 'project', 'practice', 'decision', 'recurring'] as const) {
      const id = await seedWork(t, { title: shape, shape });
      await seedMailPlan(t, id);
    }
    const candidates = await t.query(internal.albatrossWorkV2.mailWatchCandidates, {});
    expect(candidates.map((row) => row.workId).sort()).toEqual([String(quick), String(monitor)].sort());
  });

  test('stalenessReviewCandidates skips shapes with staleness: false', async () => {
    const t = harness();
    const old = Date.now() - 400 * DAY;
    for (const shape of [
      'quick',
      'list',
      'project',
      'practice',
      'decision',
      'monitor',
      'recurring',
    ] as const) {
      await seedWork(t, { title: shape, shape, createdAt: old, updatedAt: old, lastUserTouchAt: Date.now() });
    }
    const stale = await t.query(internal.albatrossWorkV2.stalenessReviewCandidates, {});
    expect(stale.map((row) => row.workTitle).sort()).toEqual(['decision', 'project', 'quick']);
  });

  test('conductorCandidates skips shapes with plans: no', async () => {
    const t = harness();
    for (const shape of [
      'quick',
      'list',
      'project',
      'practice',
      'decision',
      'monitor',
      'recurring',
    ] as const) {
      await seedWork(t, { title: shape, shape, status: 'ready', lastUserTouchAt: Date.now() });
    }
    const candidates = await t.query(internal.albatrossIntents.conductorCandidates, {});
    const titles = await Promise.all(
      candidates.map(async (row) => (await t.run((ctx) => ctx.db.get(row.workId)))?.title),
    );
    expect(titles.sort()).toEqual(['decision', 'project', 'quick']);
  });

  test('missedRecoveryCandidates skips shapes with missedMove: false', async () => {
    const t = harness();
    const start = Date.now() - 3 * DAY;
    const end = start + 3_600_000;
    const seedScheduled = async (title: string, shape: string) => {
      const workId = await seedWork(t, { title, shape, lastUserTouchAt: Date.now() });
      await t.run(async (ctx) => {
        const ts = Date.now();
        const planId = await ctx.db.insert('albatrossIntentPlans', {
          userId,
          intentId: workId,
          status: 'applied',
          digitalActions: [
            { key: 'step', kind: 'task', title: 'Do the thing' },
            {
              key: 'block',
              kind: 'calendar_event',
              title: 'Hold for the thing',
              startIso: new Date(start).toISOString(),
              endIso: new Date(end).toISOString(),
            },
          ],
          physicalActions: [],
          assumptions: [],
          sourceRefs: [],
          createdAt: ts,
          updatedAt: ts,
        } as any);
        await ctx.db.patch(workId, { latestPlanId: planId });
      });
      return workId;
    };
    const quick = await seedScheduled('Quick', 'quick');
    await seedScheduled('Project', 'project');
    await seedScheduled('Practice', 'practice');
    const candidates = await t.query(internal.albatrossWorkV2.missedRecoveryCandidates, {});
    expect(candidates.map((row) => row.workId)).toEqual([String(quick)]);
  });
});
