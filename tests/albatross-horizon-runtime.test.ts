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

const SECRET = 'albatross-horizon-runtime-secret';
const userId = 'horizon_runtime_user';
const caller = { internalSecret: SECRET, userId };
const DAY = 24 * 60 * 60_000;
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
      rawText: 'Renew the passport',
      source: 'text',
      title: 'Passport renewal',
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
      outcome: 'The passport is renewed.',
      digitalActions: [],
      physicalActions: [
        {
          title: 'Submit the renewal form',
          doneWhen: 'The acknowledgement arrives.',
          evidence: { kind: 'mail_confirmation', hint: 'Acknowledgement from the passport office' },
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

describe('setHorizon', () => {
  test('stores the horizon, arms the wake, and counts as a user touch', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const notBefore = Date.now() + 30 * DAY;
    const result = await t.mutation(api.albatrossWorkV2.setHorizon, {
      ...caller,
      workId,
      horizon: { kind: 'later', notBefore, label: '  not before November  ' },
    });
    expect(result).toEqual({
      horizon: { kind: 'later', notBefore, by: undefined, label: 'not before November', wokeAt: undefined },
      dormant: true,
    });
    const row = await t.run((ctx) => ctx.db.get(workId));
    expect(row?.horizon?.notBefore).toBe(notBefore);
    expect(row?.horizonWakeAt).toBe(notBefore);
    expect(row?.lastUserTouchAt).toBeGreaterThan(0);
  });

  test('null clears the horizon and the pending wake', async () => {
    const t = harness();
    const workId = await seedWork(t, {
      horizon: { kind: 'later', notBefore: Date.now() + DAY },
      horizonWakeAt: Date.now() + DAY,
    });
    const result = await t.mutation(api.albatrossWorkV2.setHorizon, { ...caller, workId, horizon: null });
    expect(result).toEqual({ horizon: null, dormant: false });
    const row = await t.run((ctx) => ctx.db.get(workId));
    expect(row?.horizon).toBeUndefined();
    expect(row?.horizonWakeAt).toBeUndefined();
  });

  test('a changed sleep date drops the old wake so the Work can wake again', async () => {
    const t = harness();
    const past = Date.now() - DAY;
    const workId = await seedWork(t, { horizon: { kind: 'now', notBefore: past, wokeAt: past } });
    const later = Date.now() + 5 * DAY;
    const same = await t.mutation(api.albatrossWorkV2.setHorizon, {
      ...caller,
      workId,
      horizon: { kind: 'later', notBefore: past },
    });
    expect(same.horizon?.wokeAt).toBe(past);
    const changed = await t.mutation(api.albatrossWorkV2.setHorizon, {
      ...caller,
      workId,
      horizon: { kind: 'later', notBefore: later },
    });
    expect(changed.horizon?.wokeAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(workId)))?.horizonWakeAt).toBe(later);
  });

  test('another user cannot set a horizon on this Work', async () => {
    const t = harness();
    const workId = await seedWork(t);
    await expect(
      t.mutation(api.albatrossWorkV2.setHorizon, {
        internalSecret: SECRET,
        userId: 'someone_else',
        workId,
        horizon: { kind: 'someday' },
      }),
    ).rejects.toThrow(/Work not found/);
  });
});

describe('the Work payload', () => {
  test('allWork carries the horizon and the last user touch', async () => {
    const t = harness();
    const notBefore = Date.now() + 3 * DAY;
    await seedWork(t, { horizon: { kind: 'later', notBefore }, lastUserTouchAt: 42 });
    const rows = await t.query(api.albatrossWorkV2.allWork, { ...caller });
    expect(rows).toHaveLength(1);
    expect(rows[0].horizon).toEqual({ kind: 'later', notBefore });
    expect(rows[0].lastUserTouchAt).toBe(42);
  });

  test('executionSnapshot names no move for dormant Work', async () => {
    const t = harness();
    const workId = await seedWork(t, { horizon: { kind: 'someday' } });
    await t.run(async (ctx) => {
      const ts = Date.now();
      const planId = await ctx.db.insert('albatrossIntentPlans', {
        userId,
        intentId: workId,
        status: 'applied',
        digitalActions: [{ key: 'form', kind: 'task', title: 'Open the renewal form' }],
        physicalActions: [],
        assumptions: [],
        sourceRefs: [],
        createdAt: ts,
        updatedAt: ts,
      } as any);
      await ctx.db.patch(workId, { latestPlanId: planId });
    });
    const snapshot = await t.query(api.albatrossWorkV2.executionSnapshot, { ...caller, nowMs: Date.now() });
    expect(snapshot.currentMove).toBeNull();
  });
});

describe('the horizon wake', () => {
  test('finds due Work, wakes it once, and writes the exact line', async () => {
    const t = harness();
    const notBefore = Date.now() - 60_000;
    const due = await seedWork(t, { horizon: { kind: 'later', notBefore }, horizonWakeAt: notBefore });
    const future = Date.now() + 10 * DAY;
    await seedWork(t, {
      title: 'Later',
      horizon: { kind: 'later', notBefore: future },
      horizonWakeAt: future,
    });

    const candidates = await t.query(internal.albatrossWorkV2.horizonWakeCandidates, {});
    expect(candidates).toEqual([{ userId, workId: String(due), title: 'Passport renewal', notBefore }]);

    await t.action(internal.albatrossWorkV2.horizonWakeTick, {});

    const row = await t.run((ctx) => ctx.db.get(due));
    expect(row?.horizon).toEqual({ kind: 'now', notBefore, wokeAt: expect.any(Number) });
    expect(row?.horizonWakeAt).toBeUndefined();
    // A wake is not a user touch.
    expect(row?.lastUserTouchAt).toBeUndefined();

    const notifications = await t.run((ctx) =>
      ctx.db
        .query('albatrossNotifications')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('work_wake');
    expect(notifications[0].title).toBe('Passport renewal is back. Ready when you are.');
    expect(notifications[0].entityId).toBe(String(due));

    // A second pass finds nothing and writes nothing.
    expect(await t.query(internal.albatrossWorkV2.horizonWakeCandidates, {})).toEqual([]);
    await t.action(internal.albatrossWorkV2.horizonWakeTick, {});
    expect(await t.run((ctx) => ctx.db.query('albatrossNotifications').collect())).toHaveLength(1);
  });

  test('finished Work is not woken', async () => {
    const t = harness();
    const notBefore = Date.now() - 60_000;
    await seedWork(t, {
      workState: 'done',
      status: 'done',
      horizon: { kind: 'later', notBefore },
      horizonWakeAt: notBefore,
    });
    expect(await t.query(internal.albatrossWorkV2.horizonWakeCandidates, {})).toEqual([]);
  });
});

describe('dormant Work stays out of every conductor pass', () => {
  test('staleness review, evidence reconcile, and the scheduling conductor skip it', async () => {
    const t = harness();
    const old = Date.now() - 200 * DAY;
    await seedWork(t, {
      title: 'Sleeping',
      shape: 'quick',
      horizon: { kind: 'later', notBefore: Date.now() + DAY },
      lastEvidenceAt: Date.now(),
      createdAt: old,
      updatedAt: old,
      lastUserTouchAt: Date.now(),
    });
    await seedWork(t, {
      title: 'Awake',
      shape: 'quick',
      lastEvidenceAt: Date.now(),
      createdAt: old,
      updatedAt: old,
      lastUserTouchAt: Date.now(),
    });
    const stale = await t.query(internal.albatrossWorkV2.stalenessReviewCandidates, {});
    expect(stale.map((row) => row.workTitle)).toEqual(['Awake']);
    const evidence = await t.query(internal.albatrossWorkV2.evidenceReconcileCandidates, {});
    expect(evidence.map((row) => row.title)).toEqual(['Awake']);
    const conductor = await t.query(internal.albatrossIntents.conductorCandidates, {});
    const titles = await Promise.all(
      conductor.map(async (row) => (await t.run((ctx) => ctx.db.get(row.workId)))?.title),
    );
    expect(titles).toEqual(['Awake']);
  });

  test('the scheduling conductor leaves untouched Work alone', async () => {
    const t = harness();
    const old = Date.now() - 30 * DAY;
    await seedWork(t, { title: 'Untouched', createdAt: old, updatedAt: old });
    await seedWork(t, { title: 'Touched', createdAt: old, updatedAt: old, lastUserTouchAt: Date.now() });
    const woke = Date.now() - 60_000;
    await seedWork(t, {
      title: 'Woken',
      createdAt: old,
      updatedAt: old,
      horizon: { kind: 'now', notBefore: woke, wokeAt: woke },
    });
    const conductor = await t.query(internal.albatrossIntents.conductorCandidates, {});
    const titles = await Promise.all(
      conductor.map(async (row) => (await t.run((ctx) => ctx.db.get(row.workId)))?.title),
    );
    expect(titles.sort()).toEqual(['Touched', 'Woken']);
  });
});

describe('mailWatchCandidates and terminal verification', () => {
  test('an open mail step is watched; a dormant Work is not', async () => {
    const t = harness();
    const awake = await seedWork(t, { title: 'Awake' });
    await seedMailPlan(t, awake);
    const sleeping = await seedWork(t, { title: 'Sleeping', horizon: { kind: 'someday' } });
    await seedMailPlan(t, sleeping);
    const candidates = await t.query(internal.albatrossWorkV2.mailWatchCandidates, {});
    expect(candidates).toEqual([{ userId, workId: String(awake) }]);
  });

  test('a step with a confirmed receipt is final: it reads as done and is not watched', async () => {
    const t = harness();
    const workId = await seedWork(t);
    await seedMailPlan(t, workId);
    const before = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    const step = before.execution.guideSteps[0];
    expect(step.done).toBe(false);
    expect(await t.query(internal.albatrossWorkV2.mailWatchCandidates, {})).toHaveLength(1);

    await t.run((ctx) => {
      const ts = Date.now();
      return ctx.db.insert('mailCorpusThreads', {
        userId,
        accountId: 'personal',
        grantId: 'grant:personal',
        provider: 'google',
        providerThreadId: 'thread-ack',
        subject: 'Acknowledgement of receipt',
        fromAddress: 'office@example.test',
        lastDate: ts,
        snippet: 'We received your form.',
        labels: ['INBOX'],
        unread: false,
        yearMonth: '2026-09',
        createdAt: ts,
        updatedAt: ts,
      } as any);
    });
    await t.mutation(api.albatrossWorkV2.attachProof, {
      ...caller,
      workId,
      claim: 'The passport office acknowledged the form.',
      title: 'Acknowledgement of receipt',
      sourceKind: 'mail_thread',
      sourceId: 'thread-ack',
      accountId: 'personal',
      stepIdentity: step.identity,
      trust: 'confirmed',
      settleContract: false,
    });

    const after = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    expect(after.execution.guideSteps[0].done).toBe(true);
    expect(after.execution.guideSteps[0].verification?.level).toBe('confirmed');
    expect(after.execution.remainingSteps).toBe(0);
    expect(await t.query(internal.albatrossWorkV2.mailWatchCandidates, {})).toEqual([]);
  });
});
