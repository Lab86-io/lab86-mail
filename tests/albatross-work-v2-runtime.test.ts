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

async function seedMailThread(t: any, accountId: string, providerThreadId: string) {
  await t.run((ctx) => {
    const ts = Date.now();
    return ctx.db.insert('mailCorpusThreads', {
      userId,
      accountId,
      grantId: `grant:${accountId}`,
      provider: 'google',
      providerThreadId,
      subject: 'Confirmation',
      fromAddress: 'service@example.test',
      lastDate: ts,
      snippet: 'Confirmed',
      labels: ['INBOX'],
      unread: false,
      yearMonth: '2026-08',
      createdAt: ts,
      updatedAt: ts,
    });
  });
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
        sourceKind: 'mcp_item' as const,
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

  test('validated mail proof is observed and cannot auto-close a confirmed outcome', async () => {
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
    await seedMailThread(t, 'personal-mail', 'passport-confirmation-thread');

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
    expect(detail.work).toMatchObject({ workState: 'active', status: 'ready' });
    expect(detail.contract?.proofs[0]).toMatchObject({
      id: 'confirmation',
      satisfiedBy: 'Passport application confirmation',
    });
    expect(detail.contract?.proofs[0]?.satisfiedAt).toBeNumber();
    expect(detail.evidence[0]?.trust).toBe('observed');
  });

  test('proof never auto-closes Work the user paused or left waiting', async () => {
    for (const workState of ['paused', 'waiting'] as const) {
      const { t, workId } = await seedAreaWork();
      const caller = { internalSecret: SECRET, userId };
      await t.run((ctx) =>
        ctx.db.patch(workId, {
          workState,
          contract: {
            outcome: 'The passport application is accepted.',
            proofs: [{ id: 'confirmation', what: 'The acceptance was confirmed' }],
            closeWhen: 'outcome_confirmed',
            updatedAt: Date.now(),
          },
        }),
      );

      await t.mutation(api.albatrossWorkV2.attachProof, {
        ...caller,
        workId,
        claim: 'The acceptance was confirmed.',
        title: 'Acceptance confirmation',
        sourceKind: 'manual',
        sourceId: `manual-${workState}`,
        trust: 'confirmed',
        proofId: 'confirmation',
      });

      const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
      expect(detail.work.workState).toBe(workState);
      expect(detail.contract?.proofs[0]?.satisfiedAt).toBeNumber();
    }
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

  test('execution projection and step completion share one live plan state', async () => {
    const { t, workId } = await seedAreaWork();
    const caller = { internalSecret: SECRET, userId };
    const nowMs = Date.now();
    const planId = await t.run(async (ctx) => {
      const id = await ctx.db.insert('albatrossIntentPlans', {
        userId,
        intentId: workId,
        status: 'applied',
        outcome: 'The application is submitted.',
        summary: 'Submit it online, save the receipt, then mail the original.',
        digitalActions: [
          {
            key: 'focus-block',
            kind: 'calendar_event',
            title: 'Submit the application online',
            startIso: new Date(nowMs - 5 * 60_000).toISOString(),
            endIso: new Date(nowMs + 25 * 60_000).toISOString(),
          },
          {
            key: 'submit',
            kind: 'task',
            title: 'Submit the application online',
            description: 'Use the official portal and stop before any unexpected charge.',
            url: 'https://example.test/official-portal',
          },
          { key: 'save', kind: 'task', title: 'Save the confirmation receipt' },
        ],
        physicalActions: [{ title: 'Mail the original document', detail: 'Use tracked mail.' }],
        assumptions: [],
        sourceRefs: [],
        createdAt: nowMs,
        updatedAt: nowMs,
      });
      await ctx.db.patch(workId, { latestPlanId: id, priority: 1, updatedAt: nowMs });
      return id;
    });

    const snapshot = await t.query(api.albatrossWorkV2.executionSnapshot, {
      ...caller,
      nowMs,
    });
    expect(snapshot.currentMove).toMatchObject({
      workId: String(workId),
      stepKey: 'submit',
      stepTitle: 'Submit the application online',
      phase: 'active',
      url: 'https://example.test/official-portal',
      remainingSteps: 3,
      totalSteps: 3,
    });

    expect(
      await t.mutation(api.albatrossWorkV2.completeStep, {
        ...caller,
        workId,
        stepKey: 'submit',
        source: 'user',
      }),
    ).toMatchObject({ stepKey: 'submit', allStepsComplete: false, transitioned: true });
    expect(
      await t.mutation(api.albatrossWorkV2.completeStep, {
        ...caller,
        workId,
        stepKey: 'submit',
        source: 'user',
      }),
    ).toMatchObject({ stepKey: 'submit', allStepsComplete: false, transitioned: false });
    expect(
      await t.mutation(api.albatrossWorkV2.completeStep, {
        ...caller,
        workId,
        stepKey: 'save',
        source: 'evidence',
      }),
    ).toMatchObject({ stepKey: 'save', allStepsComplete: false, transitioned: true });
    expect(
      await t.mutation(api.albatrossWorkV2.completeStep, {
        ...caller,
        workId,
        stepKey: 'physical-1',
        source: 'user',
      }),
    ).toMatchObject({ stepKey: 'physical-1', allStepsComplete: true, transitioned: true });

    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    expect(detail.plan?._id).toBe(planId);
    expect(detail.execution).toMatchObject({ currentStep: null, remainingSteps: 0, totalSteps: 3 });
    expect(detail.execution.guideSteps.every((step) => step.done)).toBe(true);
  });

  test('step completion atomically checks the bound task and moves it to Done', async () => {
    const { t, workId } = await seedAreaWork();
    const caller = { internalSecret: SECRET, userId };
    const seeded = await t.run(async (ctx) => {
      const ts = Date.now();
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: userId,
        title: 'Personal',
        createdAt: ts,
        updatedAt: ts,
      });
      const todayId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Today',
        order: 0,
        createdAt: ts,
        updatedAt: ts,
      });
      const doneId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Done',
        order: 1,
        createdAt: ts,
        updatedAt: ts,
      });
      const cardId = await ctx.db.insert('cards', {
        boardId,
        columnId: todayId,
        userId,
        title: 'Book the appointment',
        order: 0,
        createdAt: ts,
        updatedAt: ts,
      });
      const planId = await ctx.db.insert('albatrossIntentPlans', {
        userId,
        intentId: workId,
        status: 'applied',
        digitalActions: [
          {
            key: 'book',
            actionKey: 'book_appointment',
            kind: 'task',
            title: 'Book the appointment',
          },
        ],
        physicalActions: [],
        assumptions: [],
        sourceRefs: [],
        appliedSteps: [{ stepKey: 'book', kind: 'task', cardId: String(cardId) }],
        createdAt: ts,
        updatedAt: ts,
      });
      await ctx.db.patch(workId, { latestPlanId: planId, updatedAt: ts });
      return { cardId, doneId };
    });

    await t.mutation(api.albatrossWorkV2.completeStep, {
      ...caller,
      workId,
      stepKey: 'book',
      source: 'user',
    });
    const [card, work] = await t.run((ctx) => Promise.all([ctx.db.get(seeded.cardId), ctx.db.get(workId)]));
    expect(card?.completedAt).toBeNumber();
    expect(card?.columnId).toBe(seeded.doneId);
    expect(work?.stepProgress).toEqual([
      expect.objectContaining({ identity: 'action:book_appointment', cardId: String(seeded.cardId) }),
    ]);
  });

  test('execution projection keeps completion after more than one thousand applied card ids', async () => {
    const t = convexTest(schema, convexModules);
    const caller = { internalSecret: SECRET, userId };
    const nowMs = Date.now();
    const targetWorkId = await t.run(async (ctx) => {
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: userId,
        title: 'Projection regression',
        createdAt: nowMs,
        updatedAt: nowMs,
      });
      const columnId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Done',
        order: 0,
        createdAt: nowMs,
        updatedAt: nowMs,
      });
      const completedCardId = await ctx.db.insert('cards', {
        boardId,
        columnId,
        userId,
        title: 'Final projected step',
        order: 0,
        completedAt: nowMs,
        createdAt: nowMs,
        updatedAt: nowMs,
      });

      // These paused plans contribute 1,008 distinct applied card ids before
      // the active target plan. They do not compete for the current move.
      for (let workIndex = 0; workIndex < 84; workIndex += 1) {
        const updatedAt = nowMs - workIndex;
        const workId = await ctx.db.insert('albatrossIntents', {
          userId,
          rawText: `Paused projection ${workIndex}`,
          source: 'text',
          title: `Paused projection ${workIndex}`,
          status: 'ready',
          workState: 'paused',
          agentState: 'idle',
          createdAt: updatedAt,
          updatedAt,
        });
        const actions = Array.from({ length: 12 }, (_, stepIndex) => ({
          key: `step-${stepIndex}`,
          kind: 'task',
          title: `Step ${stepIndex}`,
        }));
        const planId = await ctx.db.insert('albatrossIntentPlans', {
          userId,
          intentId: workId,
          status: 'applied',
          outcome: `Paused outcome ${workIndex}`,
          digitalActions: actions,
          physicalActions: [],
          assumptions: [],
          sourceRefs: [],
          appliedSteps: actions.map((action, stepIndex) => ({
            stepKey: action.key,
            kind: 'task',
            cardId: `missing-card-${workIndex}-${stepIndex}`,
          })),
          createdAt: updatedAt,
          updatedAt,
        });
        await ctx.db.patch(workId, { latestPlanId: planId });
      }

      const targetUpdatedAt = nowMs - 10_000;
      const workId = await ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'Completed target projection',
        source: 'text',
        title: 'Completed target projection',
        status: 'applied',
        workState: 'active',
        agentState: 'idle',
        createdAt: targetUpdatedAt,
        updatedAt: targetUpdatedAt,
      });
      const planId = await ctx.db.insert('albatrossIntentPlans', {
        userId,
        intentId: workId,
        status: 'applied',
        outcome: 'The target projection is complete.',
        digitalActions: [{ key: 'final-step', kind: 'task', title: 'Final projected step' }],
        physicalActions: [],
        assumptions: [],
        sourceRefs: [],
        appliedSteps: [{ stepKey: 'final-step', kind: 'task', cardId: String(completedCardId) }],
        createdAt: targetUpdatedAt,
        updatedAt: targetUpdatedAt,
      });
      await ctx.db.patch(workId, { latestPlanId: planId });
      return workId;
    });

    const rows = await t.query(api.albatrossWorkV2.allWork, { ...caller, limit: 100 });
    const target = rows.find((row) => row._id === String(targetWorkId));
    expect(target?.guideSteps).toMatchObject([{ key: 'final-step', done: true }]);
    expect(target?.nextStep).toBeNull();

    const snapshot = await t.query(api.albatrossWorkV2.executionSnapshot, {
      ...caller,
      limit: 100,
      nowMs,
    });
    expect(snapshot.currentMove).toBeNull();
    expect(snapshot.missedMoves).toEqual([]);
  });
});
