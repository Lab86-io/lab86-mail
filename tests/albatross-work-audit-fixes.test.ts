import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { isPersonalFallbackReason, isWeakAutomaticAreaLink } from '../lib/albatross/area-home';
import { planErrorStatus } from '../lib/albatross/intent-plan';
import { ownedDefaultBoardId, tasksCreateCard } from '../lib/tools/tasks';

// Regression tests for the 2026-09-26 audit findings in Work, Areas, and
// task boards (WRK-1, WRK-9, WRK-10, WRK-11, WRK-16, WRK-17, TSK-1).

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/boards.ts': () => import('../convex/boards'),
  '../convex/mobile.ts': () => import('../convex/mobile'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
};

const SECRET = 'work-audit-fixes-secret';
const userId = 'work_audit_user';
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

const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

async function seedWork(t: Harness, overrides: Record<string, unknown> = {}) {
  return t.run((ctx) =>
    ctx.db.insert('albatrossIntents', {
      userId,
      rawText: 'Renew the passport',
      title: 'Passport',
      source: 'text',
      status: 'ready',
      workState: 'active',
      agentState: 'idle',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    } as any),
  );
}

async function seedBoard(t: Harness, ownerUserId = userId, extra: Record<string, unknown> = {}) {
  return t.run(async (ctx) => {
    const boardId = await ctx.db.insert('boards', {
      ownerUserId,
      title: 'Board',
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    } as any);
    const columnId = await ctx.db.insert('boardColumns', {
      boardId,
      name: 'Todo',
      order: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    return { boardId, columnId };
  });
}

async function seedCard(t: Harness, source: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { boardId, columnId } = await seedBoard(t);
  return t.run((ctx) =>
    ctx.db.insert('cards', {
      boardId,
      columnId,
      userId,
      title: 'Plan card',
      order: 1,
      source,
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    } as any),
  );
}

async function seedMailPlan(t: Harness, workId: Id<'albatrossIntents'>) {
  return t.run(async (ctx) => {
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
          evidence: { kind: 'mail_confirmation', hint: 'Acknowledgement' },
        },
        { title: 'Pick up the passport' },
      ],
      assumptions: [],
      sourceRefs: [],
      createdAt: 1,
      updatedAt: 1,
    } as any);
    await ctx.db.patch(workId, { latestPlanId: planId });
    return planId;
  });
}

describe('WRK-1 plan card provenance', () => {
  test('the task tool keeps intentId, areaId, and projectId in source', () => {
    const parsed = tasksCreateCard.input.parse({
      title: 'Book the appointment',
      source: { kind: 'chat', externalId: 'work_1', intentId: 'work_1', areaId: 'area_1', projectId: 'p_1' },
    });
    expect(parsed.source).toMatchObject({ intentId: 'work_1', areaId: 'area_1', projectId: 'p_1' });
  });

  test('the backfill links plan cards from externalId and retires open cards of closed Work', async () => {
    const t = harness();
    const openWork = await seedWork(t);
    const doneWork = await seedWork(t, { workState: 'done', status: 'done' });
    const released = await seedWork(t, { workState: 'released', status: 'archived' });
    const openCard = await seedCard(t, { kind: 'chat', externalId: String(openWork) });
    const doneCard = await seedCard(t, { kind: 'chat', externalId: String(doneWork) });
    const doneCompleted = await seedCard(
      t,
      { kind: 'chat', externalId: String(doneWork) },
      { completedAt: 5 },
    );
    const releasedLinked = await seedCard(t, { kind: 'chat', intentId: String(released) });
    const foreign = await seedWork(t, { userId: 'someone_else' });
    const foreignCard = await seedCard(t, { kind: 'chat', externalId: String(foreign) });
    const mailCard = await seedCard(t, { kind: 'email', externalId: String(openWork) });

    const dry = await t.mutation(internal.albatrossWorkV2.backfillPlanCardIntentLinks, { dryRun: true });
    expect(dry).toMatchObject({ linked: 3, retired: 2, done: true });
    expect((await t.run((ctx) => ctx.db.get(openCard)))?.source.intentId).toBeUndefined();

    const first = await t.mutation(internal.albatrossWorkV2.backfillPlanCardIntentLinks, {});
    expect(first).toMatchObject({ linked: 3, retired: 2 });
    const read = (id: Id<'cards'>) => t.run((ctx) => ctx.db.get(id));
    expect((await read(openCard))?.source.intentId).toBe(String(openWork));
    expect(await read(openCard)).not.toHaveProperty('retiredAt');
    expect(await read(doneCard)).toMatchObject({
      source: { intentId: String(doneWork) },
      retiredByWorkId: String(doneWork),
    });
    expect((await read(doneCompleted))?.retiredAt).toBeUndefined();
    expect((await read(releasedLinked))?.retiredByWorkId).toBe(String(released));
    expect((await read(foreignCard))?.source.intentId).toBeUndefined();
    expect((await read(mailCard))?.source.intentId).toBeUndefined();

    // Idempotent: a second run changes nothing.
    expect(await t.mutation(internal.albatrossWorkV2.backfillPlanCardIntentLinks, {})).toMatchObject({
      linked: 0,
      retired: 0,
    });
  });

  test('the backfill pages through the table', async () => {
    const t = harness();
    const work = await seedWork(t);
    for (let index = 0; index < 3; index += 1) await seedCard(t, { kind: 'chat', externalId: String(work) });
    const first = await t.mutation(internal.albatrossWorkV2.backfillPlanCardIntentLinks, { limit: 2 });
    expect(first).toMatchObject({ scanned: 2, done: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => {});
    const cards = await t.run((ctx) => ctx.db.query('cards').collect());
    expect(cards.every((card) => card.source.intentId === String(work))).toBe(true);
  });

  test('releasing Work retires its open cards, and reopening restores them', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const cardId = await seedCard(t, { kind: 'chat', intentId: String(workId) });
    await t.mutation(api.albatrossWorkV2.releaseWork, { ...caller, workId });
    expect((await t.run((ctx) => ctx.db.get(cardId)))?.retiredByWorkId).toBe(String(workId));
    await t.mutation(api.albatrossWorkV2.updateWorkState, { ...caller, workId, state: 'active' });
    expect((await t.run((ctx) => ctx.db.get(cardId)))?.retiredAt).toBeUndefined();
  });
});

describe('WRK-9 conductor flags on closed Work', () => {
  test('release, unstarted release, and archive clear every conductor flag', async () => {
    const t = harness();
    const flags = {
      mailWatchAt: 5,
      horizonWakeAt: 5,
      pendingStepEvidenceAt: 5,
      pendingStepEvidence: { planId: 'p', stepIdentity: 's', stepTitle: 'Step', requestedAt: 5 },
      planRetryAt: 5,
    };
    const released = await seedWork(t, flags);
    const unstarted = await seedWork(t, flags);
    const archived = await seedWork(t, flags);
    await t.mutation(api.albatrossWorkV2.releaseWork, { ...caller, workId: released });
    await t.mutation(api.albatrossWorkV2.releaseUnstartedWork, { ...caller, workId: unstarted });
    await t.mutation(api.albatrossWorkV2.updateWorkState, { ...caller, workId: archived, state: 'archived' });
    for (const id of [released, unstarted, archived]) {
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row?.mailWatchAt).toBeUndefined();
      expect(row?.horizonWakeAt).toBeUndefined();
      expect(row?.pendingStepEvidenceAt).toBeUndefined();
      expect(row?.planRetryAt).toBeUndefined();
    }
  });

  test('the sweep clears flags that closed or stale rows keep, and keeps live ones', async () => {
    const t = harness();
    const past = Date.now() - 60_000;
    const closedWatch = await seedWork(t, { workState: 'done', status: 'done', mailWatchAt: 5 });
    const noStepWatch = await seedWork(t, { mailWatchAt: 5 });
    const liveWatch = await seedWork(t, { mailWatchAt: 6 });
    await seedMailPlan(t, liveWatch);
    const replyWatch = await seedWork(t, {
      workState: 'waiting',
      mailWatchAt: 7,
      replyWatch: {
        id: 'w',
        accountId: 'a',
        threadId: 't',
        senderEmails: [],
        requirement: 'reply',
        after: 1,
        startedAt: 1,
      },
    });
    const closedWake = await seedWork(t, {
      workState: 'released',
      status: 'archived',
      horizonWakeAt: past,
      horizon: { kind: 'later', notBefore: past },
    });
    const wokenWake = await seedWork(t, {
      horizonWakeAt: past,
      horizon: { kind: 'now', notBefore: past, wokeAt: past },
    });
    const dueWake = await seedWork(t, { horizonWakeAt: past, horizon: { kind: 'later', notBefore: past } });
    const closedEvidence = await seedWork(t, {
      workState: 'done',
      status: 'done',
      pendingStepEvidenceAt: 5,
      pendingStepEvidence: { planId: 'p', stepIdentity: 's', stepTitle: 'Step', requestedAt: 5 },
    });

    const swept = await t.mutation(internal.albatrossWorkV2.sweepStaleConductorFlags, {});
    expect(swept).toEqual({ mailWatch: 2, horizonWake: 2, pendingEvidence: 1 });
    const read = (id: Id<'albatrossIntents'>) => t.run((ctx) => ctx.db.get(id));
    expect((await read(closedWatch))?.mailWatchAt).toBeUndefined();
    expect((await read(noStepWatch))?.mailWatchAt).toBeUndefined();
    expect((await read(liveWatch))?.mailWatchAt).toBe(6);
    expect((await read(replyWatch))?.mailWatchAt).toBe(7);
    expect((await read(closedWake))?.horizonWakeAt).toBeUndefined();
    expect((await read(wokenWake))?.horizonWakeAt).toBeUndefined();
    expect((await read(dueWake))?.horizonWakeAt).toBe(past);
    expect((await read(closedEvidence))?.pendingStepEvidenceAt).toBeUndefined();
  });
});

describe('WRK-10 reply watch and step checks', () => {
  test('checking a step keeps an armed reply watch on', async () => {
    const t = harness();
    const workId = await seedWork(t, {
      workState: 'waiting',
      mailWatchAt: 5,
      replyWatch: {
        id: 'w',
        accountId: 'a',
        threadId: 't',
        senderEmails: [],
        requirement: 'reply',
        after: 1,
        startedAt: 1,
      },
    });
    await t.run(async (ctx) => {
      const planId = await ctx.db.insert('albatrossIntentPlans', {
        userId,
        intentId: workId,
        status: 'applied',
        outcome: 'Done',
        digitalActions: [],
        physicalActions: [{ title: 'Call the office' }, { title: 'Send the form' }],
        assumptions: [],
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      } as any);
      await ctx.db.patch(workId, { latestPlanId: planId });
    });
    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId });
    const stepKey = detail.execution.guideSteps[0].key;
    await t.mutation(api.albatrossWorkV2.completeStep, { ...caller, workId, stepKey });
    expect((await t.run((ctx) => ctx.db.get(workId)))?.mailWatchAt).toBe(5);
  });

  test('resume after pause and reopen after release arm the watch again', async () => {
    const t = harness();
    const workId = await seedWork(t, { mailWatchAt: 5 });
    await seedMailPlan(t, workId);
    await t.mutation(api.albatrossWorkV2.updateWorkState, { ...caller, workId, state: 'paused' });
    expect((await t.run((ctx) => ctx.db.get(workId)))?.mailWatchAt).toBeUndefined();
    await t.mutation(api.albatrossWorkV2.updateWorkState, { ...caller, workId, state: 'active' });
    expect((await t.run((ctx) => ctx.db.get(workId)))?.mailWatchAt).toBeNumber();

    await t.mutation(api.albatrossWorkV2.releaseWork, { ...caller, workId });
    expect((await t.run((ctx) => ctx.db.get(workId)))?.mailWatchAt).toBeUndefined();
    await t.mutation(api.albatrossWorkV2.updateWorkState, { ...caller, workId, state: 'active' });
    expect((await t.run((ctx) => ctx.db.get(workId)))?.mailWatchAt).toBeNumber();
  });
});

describe('WRK-11 questions for closed Work', () => {
  test('release closes pending questions, and a late answer leaves the Work closed', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const questionId = await t.mutation(api.albatrossWorkV2.upsertQuestion, {
      ...caller,
      workId,
      kind: 'clarification',
      prompt: 'Which office?',
    });
    // A question that survived an older release, before this fix.
    const legacyId = await t.run((ctx) =>
      ctx.db.insert('albatrossWorkQuestions', {
        userId,
        workId,
        dedupeKey: 'legacy',
        kind: 'clarification',
        prompt: 'Old question',
        status: 'pending',
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    expect(await t.query(api.albatrossWorkV2.livePendingQuestions, caller)).toHaveLength(2);
    await t.mutation(api.albatrossWorkV2.releaseWork, { ...caller, workId });
    expect((await t.run((ctx) => ctx.db.get(questionId as Id<'albatrossWorkQuestions'>)))?.status).toBe(
      'superseded',
    );
    await t.run((ctx) => ctx.db.patch(legacyId, { status: 'pending' }));
    expect(await t.query(api.albatrossWorkV2.livePendingQuestions, caller)).toHaveLength(0);

    const answered = await t.mutation(api.albatrossWorkV2.answerQuestion, {
      ...caller,
      questionId: legacyId,
      answer: 'The downtown office',
    });
    expect(answered.shouldAdvance).toBe(false);
    const after = await t.run((ctx) => ctx.db.get(workId));
    expect(after).toMatchObject({ workState: 'released', status: 'archived' });
    expect(after?.agentState).not.toBe('researching');
  });
});

describe('WRK-16 one proof for several steps', () => {
  test('a second step with the same thread keeps its own evidence link', async () => {
    const t = harness();
    const workId = await seedWork(t);
    for (const stepIdentity of ['step:one', 'step:two']) {
      await t.mutation(api.albatrossWorkV2.attachProof, {
        ...caller,
        workId,
        claim: 'Confirmed',
        title: 'Receipt',
        sourceKind: 'manual',
        sourceId: 'receipt-1',
        stepIdentity,
        trust: 'observed',
        settleContract: false,
      });
    }
    const evidence = await t.run((ctx) => ctx.db.query('albatrossEvidence').collect());
    expect(evidence.map((row) => row.stepIdentity).sort()).toEqual(['step:one', 'step:two']);
  });
});

describe('WRK-17 Area lists hide released Work', () => {
  test('areaWork and the mobile area catalog use the terminal rule', async () => {
    const t = harness();
    const areaId = await t.run((ctx) =>
      ctx.db.insert('areas', {
        userId,
        name: 'Home',
        kind: 'life',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    await seedWork(t, { title: 'Open', primaryAreaId: areaId });
    await seedWork(t, {
      title: 'Released',
      primaryAreaId: areaId,
      workState: 'released',
      status: 'archived',
    });
    const rows = await t.query(api.albatrossWorkV2.areaWork, { ...caller, areaId });
    expect(rows.map((row: any) => row.title)).toEqual(['Open']);
    const catalog = await t.query(api.mobile.queryBriefCatalog, {
      internalSecret: SECRET,
      userId,
      name: 'area_open_work',
      areaId: String(areaId),
      startAt: 0,
      endAt: Date.now(),
      limit: 10,
    } as any);
    expect(catalog.map((row: any) => row.title)).toEqual(['Open']);
  });
});

describe('TSK-1 default board ownership', () => {
  test('the default board is an owned board marked default', () => {
    expect(
      ownedDefaultBoardId([
        { boardId: 'shared', isDefault: true, owned: false },
        { boardId: 'area', owned: true },
      ]),
    ).toBeUndefined();
    expect(
      ownedDefaultBoardId([
        { boardId: 'shared', isDefault: true, owned: false },
        { boardId: 'mine', isDefault: true, owned: true },
      ]),
    ).toBe('mine');
  });

  test('ensureDefaultBoard creates an owned default when owned boards are not default', async () => {
    const t = harness();
    const { boardId: areaBoard } = await seedBoard(t);
    const created = await t.mutation(api.boards.ensureDefaultBoard, caller);
    expect(created).not.toBe(areaBoard);
    expect(await t.run((ctx) => ctx.db.get(created))).toMatchObject({
      ownerUserId: userId,
      isDefault: true,
      title: 'Personal',
    });
    expect(await t.mutation(api.boards.ensureDefaultBoard, caller)).toBe(created);
  });

  test('listMyBoards marks only the caller’s own board as default', async () => {
    const t = harness();
    const { boardId: shared } = await seedBoard(t, 'owner_user', { isDefault: true });
    await t.run((ctx) =>
      ctx.db.insert('boardMembers', {
        boardId: shared,
        userId,
        email: 'member@example.test',
        role: 'member',
        invitedBy: 'owner_user',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    const boards = await t.query(api.boards.listMyBoards, caller);
    expect(boards).toHaveLength(1);
    expect(boards[0]).toMatchObject({ boardId: shared, owned: false });
    expect(boards[0].isDefault).toBeUndefined();
    expect(ownedDefaultBoardId(boards as any)).toBeUndefined();
  });
});

describe('WRK-4 and WRK-5 applied steps', () => {
  test('markPlanApplied accepts a document step and keeps steps an earlier attempt recorded', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const planId = await t.run((ctx) =>
      ctx.db.insert('albatrossIntentPlans', {
        userId,
        intentId: workId,
        status: 'ready',
        outcome: 'Moved in',
        digitalActions: [],
        physicalActions: [],
        assumptions: [],
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    await t.mutation(api.albatrossWork.recordPlanApplication, {
      ...caller,
      intentId: String(workId),
      planId: String(planId),
      operationBatchId: 'batch_1',
      status: 'partially_applied',
      artifacts: [
        { kind: 'task', id: 'card_1', actionKey: 'a1', stepKey: 'step-1' },
        { kind: 'approval', id: 'approval_1', actionKey: 'a4', stepKey: 'step-4', stepKind: 'email_send' },
      ],
      operationIds: [],
      pendingApprovalIds: [],
      unresolvedArtifacts: [],
    });
    await t.mutation(api.albatrossIntents.markPlanApplied, {
      ...caller,
      planId,
      applicationId: 'app_2',
      appliedSteps: [{ stepKey: 'step-3', kind: 'document', documentId: 'doc_1' }],
    });
    const plan = await t.run((ctx) => ctx.db.get(planId));
    expect(plan?.status).toBe('applied');
    expect(plan?.appliedSteps).toEqual([
      { stepKey: 'step-1', kind: 'task', cardId: 'card_1' },
      { stepKey: 'step-4', kind: 'email_send' },
      { stepKey: 'step-3', kind: 'document', documentId: 'doc_1' },
    ]);
  });
});

describe('WRK-7 legacy Personal area', () => {
  test('both old reason strings mark an automatic Personal link', () => {
    expect(isPersonalFallbackReason('legacy mail fallback to Personal')).toBe(true);
    expect(isPersonalFallbackReason('No confident area match — filed to Personal')).toBe(true);
    expect(isPersonalFallbackReason('Verified email match')).toBe(false);
    expect(
      isWeakAutomaticAreaLink({
        status: 'verified',
        reason: 'No confident area match — filed to Personal',
        sourceRefs: [],
        confirmationRefs: [],
      }),
    ).toBe(true);
  });

  test('the migration deletes weak links and retires each legacy area once', async () => {
    const t = harness();
    const link = (areaId: Id<'areas'>, owner: string, extra: Record<string, unknown>) =>
      t.run((ctx) =>
        ctx.db.insert('areaArtifactLinks', {
          userId: owner,
          areaId,
          artifactKind: 'mailThread',
          artifactId: `thread-${Math.random()}`,
          role: 'supporting',
          status: 'candidate',
          sourceRefs: [],
          confirmationRefs: [],
          createdAt: 1,
          updatedAt: 1,
          ...extra,
        } as any),
      );
    const area = (owner: string) =>
      t.run((ctx) =>
        ctx.db.insert('areas', {
          userId: owner,
          externalId: 'system:personal',
          name: 'Personal',
          kind: 'life',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        } as any),
      );
    const plain = await area(userId);
    const adopted = await area('adopting_user');
    await link(plain, userId, { reason: 'No confident area match — filed to Personal', status: 'verified' });
    await link(plain, userId, { reason: 'legacy mail fallback to Personal' });
    await link(adopted, 'adopting_user', { reason: 'legacy mail fallback to Personal' });
    await link(adopted, 'adopting_user', {
      status: 'verified',
      reason: 'Moved by you',
      confirmationRefs: [
        { kind: 'userConfirmation', id: 'c1', prompt: 'Moved here by the user', confirmedAt: 1 },
      ],
    });

    const result = await t.mutation(internal.albatross.migrateLegacyPersonalAreas, {});
    expect(result).toEqual({ retiredAreas: 2, deletedLinks: 3, done: true });
    expect(await t.run((ctx) => ctx.db.get(plain))).toMatchObject({ status: 'archived' });
    const kept = await t.run((ctx) => ctx.db.get(adopted));
    expect(kept?.status).toBe('active');
    expect(kept?.externalId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect())).toHaveLength(1);

    expect(await t.mutation(internal.albatross.migrateLegacyPersonalAreas, {})).toEqual({
      retiredAreas: 0,
      deletedLinks: 0,
      done: true,
    });
  });
});

describe('WRK-12 plan timeouts retry with a backoff', () => {
  test('a failed run keeps the status the Work had before planning', () => {
    expect(planErrorStatus('applied', true)).toBe('applied');
    expect(planErrorStatus('needs_answers', false)).toBe('needs_answers');
    expect(planErrorStatus('planning', true)).toBe('ready');
    expect(planErrorStatus(undefined, false)).toBe('captured');
  });

  test('a timeout schedules retries with a growing delay, and a success clears them', async () => {
    const t = harness();
    const intentId = await seedWork(t, { status: 'captured' });
    const before = Date.now();
    await t.mutation(api.albatrossIntents.updateIntent, {
      ...caller,
      intentId,
      planError: 'Plan generation timed out after 150s',
      planRetryable: true,
    });
    const first = await t.run((ctx) => ctx.db.get(intentId));
    expect(first?.planTimeoutRetries).toBe(1);
    expect(first!.planRetryAt! - before).toBeGreaterThanOrEqual(10 * 60_000);
    expect(await t.query(internal.albatrossIntents.planRetryCandidates, {})).toEqual([]);

    await t.run((ctx) => ctx.db.patch(intentId, { planRetryAt: Date.now() - 1 }));
    expect(await t.query(internal.albatrossIntents.planRetryCandidates, {})).toEqual([{ intentId, userId }]);
    expect(await t.mutation(internal.albatrossIntents.beginPlanRetry, { intentId })).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(intentId)))?.planRetryAt).toBeUndefined();

    const second = Date.now();
    await t.mutation(api.albatrossIntents.updateIntent, {
      ...caller,
      intentId,
      planError: 'Plan generation timed out after 150s',
      planRetryable: true,
    });
    const next = await t.run((ctx) => ctx.db.get(intentId));
    expect(next?.planTimeoutRetries).toBe(2);
    expect(next!.planRetryAt! - second).toBeGreaterThanOrEqual(20 * 60_000);

    // A non-timeout error never schedules a retry.
    await t.mutation(api.albatrossIntents.updateIntent, { ...caller, intentId, planError: 'Bad JSON' });
    expect((await t.run((ctx) => ctx.db.get(intentId)))?.planRetryAt).toBeUndefined();
  });

  test('retries stop after the limit, and closed Work does not retry', async () => {
    const t = harness();
    const intentId = await seedWork(t, { planTimeoutRetries: 3 });
    await t.mutation(api.albatrossIntents.updateIntent, {
      ...caller,
      intentId,
      planError: 'Plan generation timed out after 150s',
      planRetryable: true,
    });
    expect((await t.run((ctx) => ctx.db.get(intentId)))?.planRetryAt).toBeUndefined();
    const closed = await seedWork(t, {
      workState: 'released',
      status: 'archived',
      planError: 'timed out',
      planRetryAt: Date.now() - 1,
    });
    expect(await t.mutation(internal.albatrossIntents.beginPlanRetry, { intentId: closed })).toBe(false);
  });
});

describe('WRK-18 one helper writes both Area fields', () => {
  test('savePlan and updateIntent keep areaId and primaryAreaId the same', async () => {
    const t = harness();
    const area = (name: string) =>
      t.run((ctx) =>
        ctx.db.insert('areas', {
          userId,
          name,
          kind: 'life',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        } as any),
      );
    const home = await area('Home');
    const work = await area('Work');
    const intentId = await seedWork(t, { areaId: String(home), primaryAreaId: home });
    await t.mutation(api.albatrossIntents.savePlan, {
      ...caller,
      intentId,
      areaId: String(work),
      digitalActions: [],
      physicalActions: [],
      assumptions: [],
      sourceRefs: [],
    });
    expect(await t.run((ctx) => ctx.db.get(intentId))).toMatchObject({
      areaId: String(work),
      primaryAreaId: work,
    });
    await t.mutation(api.albatrossIntents.updateIntent, { ...caller, intentId, areaId: String(home) });
    expect(await t.run((ctx) => ctx.db.get(intentId))).toMatchObject({
      areaId: String(home),
      primaryAreaId: home,
    });
    const created = await t.mutation(api.albatrossIntents.createIntent, {
      ...caller,
      rawText: 'Fix the gutter',
      source: 'text',
      areaId: String(home),
    });
    expect(await t.run((ctx) => ctx.db.get(created as Id<'albatrossIntents'>))).toMatchObject({
      areaId: String(home),
      primaryAreaId: home,
    });
  });
});
