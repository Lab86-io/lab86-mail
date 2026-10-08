import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';

// The step-run queue and handoff record (convex/albatrossStepRuns.ts):
// enqueue rules, the lease, settle and retry, cancel and dismiss, the reads
// every client uses, recovery of lost leases, saved sign-ins, and the Work
// detail fields.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossStepRuns.ts': () => import('../convex/albatrossStepRuns'),
  '../convex/albatrossBrowserSessions.ts': () => import('../convex/albatrossBrowserSessions'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/boards.ts': () => import('../convex/boards'),
  '../convex/mobile.ts': () => import('../convex/mobile'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
};

const SECRET = 'step-runs-convex-secret';
const userId = 'step_runs_user';
const caller = { internalSecret: SECRET, userId };
let previousSecret: string | undefined;
let previousRuns: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  previousRuns = process.env.LAB86_STEP_RUNS;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});
afterEach(() => {
  if (previousRuns === undefined) delete process.env.LAB86_STEP_RUNS;
  else process.env.LAB86_STEP_RUNS = previousRuns;
});

const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

async function seedWork(t: Harness, overrides: Record<string, unknown> = {}, owner = userId) {
  return t.run((ctx) =>
    ctx.db.insert('albatrossIntents', {
      userId: owner,
      rawText: 'Send the proposal to Dana',
      title: 'Proposal',
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

async function seedPlannedWork(t: Harness, overrides: Record<string, unknown> = {}) {
  const intentId = await seedWork(t, overrides);
  await t.mutation(api.albatrossIntents.savePlan, {
    ...caller,
    intentId,
    digitalActions: [
      {
        actionKey: 'draft',
        kind: 'document',
        title: 'Write the proposal',
        stepMode: 'agent_does',
        doneWhen: 'The proposal document exists.',
      },
      { actionKey: 'call', kind: 'task', title: 'Call the venue', stepMode: 'you_do_offline' },
    ],
    physicalActions: [],
    assumptions: [],
    sourceRefs: [],
  });
  const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId: intentId });
  return { intentId, steps: detail!.execution.guideSteps as any[] };
}

function enqueueArgs(workId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...caller,
    workId,
    stepKey: 'step-1',
    stepIdentity: 'step:document:write the proposal',
    stepTitle: 'Write the proposal',
    trigger: 'user' as const,
    ...overrides,
  };
}

async function claimRun(t: Harness, runId: string, token = 'token-1') {
  return t.mutation(api.albatrossStepRuns.claim, {
    ...caller,
    id: runId as Id<'albatrossStepRuns'>,
    token,
  });
}

describe('enqueue', () => {
  test('one open run for each Work, and automatic triggers run a step once', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const first = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    expect(first).toMatchObject({ created: true, reason: null });
    const again = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    expect(again as unknown).toEqual({ runId: first.runId, created: false, reason: 'active' });

    await t.mutation(api.albatrossStepRuns.cancel, { ...caller, id: first.runId as Id<'albatrossStepRuns'> });
    const auto = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(workId, { trigger: 'conductor' }),
    );
    expect(auto as unknown).toEqual({ runId: first.runId, created: false, reason: 'already_ran' });
    const user = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    expect(user.created).toBe(true);
  });

  test('user runs queue past three; automatic runs open one at a time (docs/albatross-threads.md)', async () => {
    const t = harness();
    const works = await Promise.all([1, 2, 3, 4, 5].map(() => seedWork(t)));
    for (const work of works.slice(0, 4)) {
      const run = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(String(work)));
      expect(run.created).toBe(true);
    }
    // A user run does not block the Brief; one open automatic run does.
    const auto = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(String(works[4]), { trigger: 'brief', stepIdentity: 'other' }),
    );
    expect(auto.created).toBe(true);
    const secondAuto = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(String(await seedWork(t)), { trigger: 'conductor', stepIdentity: 'third' }),
    );
    expect(secondAuto).toEqual({ runId: null, created: false, reason: 'busy' });
  });

  test('refuses closed Work, other users, and a parent run from another Work', async () => {
    const t = harness();
    const closed = String(await seedWork(t, { workState: 'done', status: 'done' }));
    expect(await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(closed))).toEqual({
      runId: null,
      created: false,
      reason: 'closed',
    });
    const foreign = String(await seedWork(t, {}, 'someone_else'));
    await expect(t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(foreign))).rejects.toThrow(
      'Work not found',
    );
    const a = String(await seedWork(t));
    const b = String(await seedWork(t));
    const parent = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(a));
    await t.mutation(api.albatrossStepRuns.cancel, {
      ...caller,
      id: parent.runId as Id<'albatrossStepRuns'>,
    });
    await expect(
      t.mutation(
        api.albatrossStepRuns.enqueue,
        enqueueArgs(b, { trigger: 'resume', parentRunId: parent.runId as Id<'albatrossStepRuns'> }),
      ),
    ).rejects.toThrow('Run not found');
  });

  test('a resume keeps its note and the shared browser', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const parent = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    await t.mutation(api.albatrossStepRuns.cancel, {
      ...caller,
      id: parent.runId as Id<'albatrossStepRuns'>,
    });
    const resumed = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(workId, {
        trigger: 'resume',
        parentRunId: parent.runId as Id<'albatrossStepRuns'>,
        resumeNote: '  I signed in.  ',
        browserSessionId: 'bb-1',
      }),
    );
    const row = await t.query(api.albatrossStepRuns.get, {
      ...caller,
      id: resumed.runId as Id<'albatrossStepRuns'>,
    });
    expect(row).toMatchObject({
      trigger: 'resume',
      resumeNote: 'I signed in.',
      browserSessionId: 'bb-1',
      parentRunId: parent.runId,
      state: 'queued',
    });
  });
});

describe('the lease', () => {
  test('claim, heartbeat, progress, and settle keep one owner', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    const claimed = await claimRun(t, runId!);
    expect(claimed).toMatchObject({ state: 'running', attempts: 1, token: 'token-1' });
    // The lease is held: a second claim gets nothing.
    expect(await claimRun(t, runId!, 'token-2')).toBeNull();
    const fence = { ...caller, id: runId as Id<'albatrossStepRuns'>, token: 'token-1' };
    expect(await t.mutation(api.albatrossStepRuns.heartbeat, { ...fence, token: 'wrong' })).toBe(false);
    expect(await t.mutation(api.albatrossStepRuns.heartbeat, fence)).toBe(true);

    for (let index = 0; index < 32; index += 1)
      await t.mutation(api.albatrossStepRuns.progress, { ...fence, line: `Line ${index}` });
    await t.mutation(api.albatrossStepRuns.progress, {
      ...fence,
      artifact: { kind: 'draft', id: 'd1', title: 'First title' },
      browserSessionId: 'bb-7',
    });
    await t.mutation(api.albatrossStepRuns.progress, {
      ...fence,
      artifact: { kind: 'draft', id: 'd1', title: 'Second title' },
    });
    const view = await t.query(api.albatrossStepRuns.get, {
      ...caller,
      id: runId as Id<'albatrossStepRuns'>,
    });
    expect(view!.log).toHaveLength(30);
    expect(view!.log[0].text).toBe('Line 2');
    expect(view!.artifacts).toEqual([{ kind: 'draft', id: 'd1', title: 'Second title' }]);
    expect(view!.browserSessionId).toBe('bb-7');
    expect(await t.mutation(api.albatrossStepRuns.progress, { ...fence, token: 'wrong', line: 'x' })).toBe(
      false,
    );

    const settled = await t.mutation(api.albatrossStepRuns.settle, {
      ...fence,
      outcome: 'ready_for_you',
      summary: '  I wrote the proposal.  ',
      next: {
        kind: 'review_draft',
        label: 'Read and send this draft now please, it is ready for you to look at',
        detail: 'Read the draft.',
        target: { kind: 'draft', id: 'd1', accountId: 'acct-1' },
      },
      budget: { timeMs: 1000, costUsd: 0.2, inputTokens: 10, outputTokens: 5, calls: 2 },
    });
    expect(settled).toEqual({ state: 'handed_off' });
    const done = await t.query(api.albatrossStepRuns.get, {
      ...caller,
      id: runId as Id<'albatrossStepRuns'>,
    });
    expect(done).toMatchObject({
      state: 'handed_off',
      outcome: 'ready_for_you',
      summary: 'I wrote the proposal.',
      next: { kind: 'review_draft', target: { kind: 'draft', id: 'd1', accountId: 'acct-1' } },
      budget: { costUsd: 0.2 },
    });
    expect(done!.next!.label.length).toBeLessThanOrEqual(48);
    // A settled run has no owner left.
    expect(await t.mutation(api.albatrossStepRuns.settle, { ...fence, outcome: 'done' })).toEqual({
      state: null,
    });
  });

  test('a retryable error queues the run once, then it fails', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    const id = runId as Id<'albatrossStepRuns'>;
    await claimRun(t, runId!, 'a');
    expect(
      await t.mutation(api.albatrossStepRuns.settle, {
        ...caller,
        id,
        token: 'a',
        error: 'socket hang up',
        retryable: true,
      }),
    ).toEqual({ state: 'queued' });
    await t.run((ctx) => ctx.db.patch(id, { availableAt: 0 }));
    expect(await claimRun(t, runId!, 'b')).toMatchObject({ attempts: 2 });
    expect(
      await t.mutation(api.albatrossStepRuns.settle, {
        ...caller,
        id,
        token: 'b',
        error: 'socket hang up',
        retryable: true,
      }),
    ).toEqual({ state: 'failed' });
    expect(await t.query(api.albatrossStepRuns.get, { ...caller, id })).toMatchObject({
      state: 'failed',
      error: 'socket hang up',
    });
  });

  test('done settles as done; a claim on closed Work cancels the run', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(String(workId)));
    await claimRun(t, runId!);
    expect(
      await t.mutation(api.albatrossStepRuns.settle, {
        ...caller,
        id: runId as Id<'albatrossStepRuns'>,
        token: 'token-1',
        outcome: 'done',
        summary: 'Done.',
      }),
    ).toEqual({ state: 'done' });

    const other = await seedWork(t);
    const queued = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(String(other)));
    await t.run((ctx) => ctx.db.patch(other, { workState: 'archived', status: 'archived' }));
    expect(await claimRun(t, queued.runId!)).toBeNull();
    expect(
      await t.query(api.albatrossStepRuns.get, { ...caller, id: queued.runId as Id<'albatrossStepRuns'> }),
    ).toMatchObject({ state: 'cancelled', error: 'The Albatross is closed.' });
  });

  test('a lost lease is queued again, then failed after its attempts', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    const id = runId as Id<'albatrossStepRuns'>;
    await claimRun(t, runId!);
    await t.run((ctx) => ctx.db.patch(id, { availableAt: 1 }));
    await t.mutation(internal.albatrossStepRuns.expireLost, {});
    expect(await t.query(api.albatrossStepRuns.get, { ...caller, id })).toMatchObject({ state: 'queued' });
    await claimRun(t, runId!, 'second');
    await t.run((ctx) => ctx.db.patch(id, { availableAt: 1 }));
    await t.mutation(internal.albatrossStepRuns.expireLost, {});
    expect(await t.query(api.albatrossStepRuns.get, { ...caller, id })).toMatchObject({
      state: 'failed',
      error: 'The run stopped before it finished. Start it again.',
    });
    const due = await t.query(internal.albatrossStepRuns.due, {});
    expect(due.some((row) => row._id === id)).toBe(false);
  });

  test('targets returns only active runs that are due', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    const id = runId as Id<'albatrossStepRuns'>;
    expect(await t.query(internal.albatrossStepRuns.targets, { ids: [id] })).toEqual([
      { id: runId!, userId },
    ]);
    await claimRun(t, runId!);
    expect(await t.query(internal.albatrossStepRuns.targets, { ids: [id] })).toEqual([]);
  });
});

describe('the user controls', () => {
  test('cancel stops the run and the runner sees it at its heartbeat', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(workId, { browserSessionId: 'bb-2' }),
    );
    const id = runId as Id<'albatrossStepRuns'>;
    await claimRun(t, runId!);
    const asUser = t.withIdentity({ subject: userId });
    expect(await asUser.mutation(api.albatrossStepRuns.cancel, { id })).toEqual({
      cancelled: true,
      browserSessionId: 'bb-2',
    });
    expect(await asUser.mutation(api.albatrossStepRuns.cancel, { id })).toEqual({
      cancelled: false,
      browserSessionId: 'bb-2',
    });
    expect(await t.mutation(api.albatrossStepRuns.heartbeat, { ...caller, id, token: 'token-1' })).toBe(
      false,
    );
    await expect(
      t.withIdentity({ subject: 'intruder' }).mutation(api.albatrossStepRuns.cancel, { id }),
    ).rejects.toThrow('Run not found');
  });

  test('dismiss closes only a handoff', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    const id = runId as Id<'albatrossStepRuns'>;
    expect(await t.mutation(api.albatrossStepRuns.dismissHandoff, { ...caller, id })).toEqual({
      dismissed: false,
    });
    await claimRun(t, runId!);
    await t.mutation(api.albatrossStepRuns.settle, {
      ...caller,
      id,
      token: 'token-1',
      outcome: 'your_turn',
      summary: 'I opened the page.',
      next: { kind: 'sign_in', label: 'Sign in', detail: 'Sign in, then press Continue.' },
    });
    expect(await t.mutation(api.albatrossStepRuns.dismissHandoff, { ...caller, id })).toEqual({
      dismissed: true,
    });
    expect(await t.query(api.albatrossStepRuns.get, { ...caller, id })).toMatchObject({ state: 'closed' });
    await expect(
      t.withIdentity({ subject: 'intruder' }).mutation(api.albatrossStepRuns.dismissHandoff, { id }),
    ).rejects.toThrow('Run not found');
  });
});

describe('reads', () => {
  test('runsForWork keeps the newest run of each step; openHandoffs lists one row for each open Work', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const first = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    await claimRun(t, first.runId!);
    await t.mutation(api.albatrossStepRuns.settle, {
      ...caller,
      id: first.runId as Id<'albatrossStepRuns'>,
      token: 'token-1',
      outcome: 'ready_for_you',
      summary: 'Old.',
      next: { kind: 'review', label: 'Open', detail: 'Open it.' },
    });
    const second = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(workId));
    const runs = await t.query(api.albatrossStepRuns.runsForWork, { ...caller, workId });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: second.runId, state: 'queued' });
    expect(runs[0]).not.toHaveProperty('token');

    const handoffs = await t.query(api.albatrossStepRuns.openHandoffs, { ...caller });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ workId, workTitle: 'Proposal', run: { id: second.runId } });

    // A closed Work leaves the list.
    await t.run((ctx) =>
      ctx.db.patch(workId as Id<'albatrossIntents'>, { workState: 'done', status: 'done' }),
    );
    expect(await t.query(api.albatrossStepRuns.openHandoffs, { ...caller, limit: 50 })).toEqual([]);
    expect(
      await t.query(api.albatrossStepRuns.get, { ...caller, id: 'x' as any }).catch(() => 'invalid'),
    ).toBe('invalid');
  });

  test('Work detail carries the run fields and the switch', async () => {
    const t = harness();
    const { intentId, steps } = await seedPlannedWork(t);
    const write = steps.find((step) => step.title === 'Write the proposal');
    const call = steps.find((step) => step.title === 'Call the venue');
    expect(write).toMatchObject({ run: null, runnable: true });
    expect(call).toMatchObject({ runnable: false });

    const { runId } = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(String(intentId), { stepKey: write.key, stepIdentity: write.identity }),
    );
    const detail = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId: intentId });
    expect(detail!.execution.activeRun).toMatchObject({ id: runId, state: 'queued' });
    expect(detail!.execution.runner).toEqual({ enabled: true });
    const after = detail!.execution.guideSteps.find((step: any) => step.key === write.key);
    expect(after).toMatchObject({ run: { id: runId }, runnable: false });

    process.env.LAB86_STEP_RUNS = 'off';
    const off = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId: intentId });
    expect(off!.execution.runner).toEqual({ enabled: false });
  });

  test('a checked step closes its open handoff', async () => {
    const t = harness();
    const { intentId, steps } = await seedPlannedWork(t);
    const write = steps.find((step) => step.title === 'Write the proposal');
    const { runId } = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(String(intentId), { stepKey: write.key, stepIdentity: write.identity }),
    );
    const id = runId as Id<'albatrossStepRuns'>;
    await claimRun(t, runId!);
    await t.mutation(api.albatrossStepRuns.settle, {
      ...caller,
      id,
      token: 'token-1',
      outcome: 'ready_for_you',
      summary: 'I wrote it.',
      next: { kind: 'review_document', label: 'Open the document', detail: 'Check it.' },
    });
    await t.mutation(api.albatrossWorkV2.completeStep, { ...caller, workId: intentId, stepKey: write.key });
    expect(await t.query(api.albatrossStepRuns.get, { ...caller, id })).toMatchObject({ state: 'closed' });
  });
});

describe('the conductor set', () => {
  test('autoCandidates picks touched, planned Work without an open run, then rotates', async () => {
    const t = harness();
    const now = Date.now();
    const { intentId } = await seedPlannedWork(t, { lastUserTouchAt: now, createdAt: now });
    await seedWork(t, { lastUserTouchAt: now - 3 * 24 * 60 * 60_000, createdAt: 1 });
    const picked = await t.query(internal.albatrossStepRuns.autoCandidates, {});
    expect(picked).toEqual([{ userId, workId: String(intentId) }]);
    await t.mutation(internal.albatrossStepRuns.markAutoChecked, { workIds: [intentId] });
    expect(await t.query(internal.albatrossStepRuns.autoCandidates, {})).toEqual([]);
    await t.run((ctx) => ctx.db.patch(intentId, { lastStepRunCheckAt: undefined }));
    await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(String(intentId)));
    expect(await t.query(internal.albatrossStepRuns.autoCandidates, {})).toEqual([]);
  });
});

describe('saved sign-ins', () => {
  test('only the server saves a context; the user reads and forgets it', async () => {
    const t = harness();
    const asUser = t.withIdentity({ subject: userId });
    await expect(
      asUser.mutation(api.albatrossStepRuns.saveBrowserContext, { contextId: 'ctx-1' }),
    ).rejects.toThrow('Only the server');
    expect(
      await t.mutation(api.albatrossStepRuns.saveBrowserContext, { ...caller, contextId: 'ctx-1' }),
    ).toEqual({
      contextId: 'ctx-1',
      created: true,
    });
    expect(
      await t.mutation(api.albatrossStepRuns.saveBrowserContext, { ...caller, contextId: 'ctx-2' }),
    ).toEqual({
      // Two first sessions raced: the first saved context stays, and the
      // other is recorded for deletion so no cookies stay without a record.
      contextId: 'ctx-1',
      created: false,
    });
    expect(await t.query(internal.albatrossStepRuns.pendingContextDeletions, {})).toEqual(['ctx-2']);
    expect(await asUser.query(api.albatrossStepRuns.browserContext, {})).toMatchObject({
      contextId: 'ctx-1',
    });
    expect(await asUser.mutation(api.albatrossStepRuns.forgetBrowserContext, {})).toEqual({
      contextIds: ['ctx-1'],
    });
    expect(await t.query(internal.albatrossStepRuns.pendingContextDeletions, {})).toEqual(['ctx-2', 'ctx-1']);
    expect(await asUser.query(api.albatrossStepRuns.browserContext, {})).toBeNull();
    await expect(t.query(api.albatrossStepRuns.browserContext, {})).rejects.toThrow('Not authenticated');
  });

  test('one writer at a time; an ended session frees the place', async () => {
    const t = harness();
    await t.mutation(api.albatrossStepRuns.saveBrowserContext, { ...caller, contextId: 'ctx-1' });
    const first = await t.mutation(api.albatrossStepRuns.claimContextWriter, { ...caller, token: 'a' });
    expect(first).toEqual({ contextId: 'ctx-1', persist: true });
    expect(await t.mutation(api.albatrossStepRuns.claimContextWriter, { ...caller, token: 'b' })).toEqual({
      contextId: 'ctx-1',
      persist: false,
    });
    expect(
      await t.mutation(api.albatrossStepRuns.bindContextWriter, { ...caller, token: 'b', sessionId: 'x' }),
    ).toBe(false);
    expect(
      await t.mutation(api.albatrossStepRuns.bindContextWriter, { ...caller, token: 'a', sessionId: 'bb-1' }),
    ).toBe(true);
    // The writer's session ends: the place is free for the next session.
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert('albatrossBrowserSessions', {
        userId,
        workId: 'w',
        sessionId: 'bb-1',
        liveViewUrl: 'l',
        replayUrl: 'r',
        status: 'user',
        createdAt: now,
        updatedAt: now,
      }),
    );
    await t.mutation(api.albatrossBrowserSessions.setSessionStatus, {
      ...caller,
      sessionId: 'bb-1',
      status: 'ended',
    });
    expect(await t.mutation(api.albatrossStepRuns.claimContextWriter, { ...caller, token: 'c' })).toEqual({
      contextId: 'ctx-1',
      persist: true,
    });
    // A session that did not start gives the place back.
    expect(await t.mutation(api.albatrossStepRuns.releaseContextWriter, { ...caller, token: 'wrong' })).toBe(
      false,
    );
    expect(await t.mutation(api.albatrossStepRuns.releaseContextWriter, { ...caller, token: 'c' })).toBe(
      true,
    );
    // A new session for the same Work supersedes the old row and frees its place.
    await t.mutation(api.albatrossStepRuns.claimContextWriter, { ...caller, token: 'd' });
    await t.mutation(api.albatrossStepRuns.bindContextWriter, { ...caller, token: 'd', sessionId: 'bb-2' });
    await t.mutation(api.albatrossBrowserSessions.openSession, {
      ...caller,
      workId: 'w2',
      sessionId: 'bb-2',
      liveViewUrl: 'l',
      replayUrl: 'r',
    });
    await t.mutation(api.albatrossBrowserSessions.openSession, {
      ...caller,
      workId: 'w2',
      sessionId: 'bb-3',
      liveViewUrl: 'l',
      replayUrl: 'r',
    });
    expect(
      await t.mutation(api.albatrossStepRuns.claimContextWriter, { ...caller, token: 'e' }),
    ).toMatchObject({
      persist: true,
    });
    // An expired lease frees the place too.
    await t.run(async (ctx) => {
      const row = await ctx.db.query('albatrossBrowserContexts').first();
      await ctx.db.patch(row!._id, { writerUntil: 1 });
    });
    expect(
      await t.mutation(api.albatrossStepRuns.claimContextWriter, { ...caller, token: 'f' }),
    ).toMatchObject({
      persist: true,
    });
    // No context: nothing to claim. Clients never claim, bind, or release.
    const other = { internalSecret: SECRET, userId: 'nobody' };
    expect(await t.mutation(api.albatrossStepRuns.claimContextWriter, { ...other, token: 'z' })).toBeNull();
    expect(
      await t.mutation(api.albatrossStepRuns.bindContextWriter, { ...other, token: 'z', sessionId: 's' }),
    ).toBe(false);
    expect(await t.mutation(api.albatrossStepRuns.releaseContextWriter, { ...other, token: 'z' })).toBe(
      false,
    );
    const asUser = t.withIdentity({ subject: userId });
    await expect(asUser.mutation(api.albatrossStepRuns.claimContextWriter, { token: 'x' })).rejects.toThrow(
      'Only the server',
    );
    await expect(
      asUser.mutation(api.albatrossStepRuns.bindContextWriter, { token: 'x', sessionId: 's' }),
    ).rejects.toThrow('Only the server');
    await expect(asUser.mutation(api.albatrossStepRuns.releaseContextWriter, { token: 'x' })).rejects.toThrow(
      'Only the server',
    );
  });

  test('forgotten contexts stay recorded for deletion until Browserbase confirms', async () => {
    const t = harness();
    await t.mutation(api.albatrossStepRuns.saveBrowserContext, { ...caller, contextId: 'ctx-1' });
    expect(await t.mutation(api.albatrossStepRuns.forgetBrowserContext, { ...caller })).toEqual({
      contextIds: ['ctx-1'],
    });
    expect(await t.query(internal.albatrossStepRuns.pendingContextDeletions, {})).toEqual(['ctx-1']);
    // The record has no userId: the account cascade cannot drop it.
    const record = await t.run((ctx) => ctx.db.query('albatrossContextDeletions').first());
    expect(record).not.toHaveProperty('userId');
    await t.mutation(api.albatrossStepRuns.failContextDeletion, {
      internalSecret: SECRET,
      contextId: 'ctx-1',
      error: 'Browserbase is down',
    });
    expect(await t.run((ctx) => ctx.db.query('albatrossContextDeletions').first())).toMatchObject({
      attempts: 1,
      lastError: 'Browserbase is down',
    });
    // Forgetting again does not add a second record for the same context.
    await t.mutation(api.albatrossStepRuns.saveBrowserContext, { ...caller, contextId: 'ctx-1' });
    await t.mutation(api.albatrossStepRuns.forgetBrowserContext, { ...caller });
    expect(await t.query(internal.albatrossStepRuns.pendingContextDeletions, {})).toEqual(['ctx-1']);
    expect(
      await t.mutation(api.albatrossStepRuns.completeContextDeletion, {
        internalSecret: SECRET,
        contextId: 'ctx-1',
      }),
    ).toBe(1);
    expect(await t.query(internal.albatrossStepRuns.pendingContextDeletions, {})).toEqual([]);
    await t.mutation(api.albatrossStepRuns.failContextDeletion, {
      internalSecret: SECRET,
      contextId: 'gone',
      error: 'x',
    });
  });

  test('only the server queues a run', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { internalSecret: _secret, ...asClient } = enqueueArgs(workId);
    await expect(
      t.withIdentity({ subject: userId }).mutation(api.albatrossStepRuns.enqueue, asClient as any),
    ).rejects.toThrow('Only the server queues a step run.');
  });
});

describe('the handoff notice', () => {
  test('one notice for each run', async () => {
    const t = harness();
    const args = {
      ...caller,
      workId: 'work-1',
      runId: 'run-1',
      title: 'Read and send: Proposal',
      body: 'Read it.',
    };
    const first = await t.mutation(api.albatrossNotifications.queueStepRunHandoff, args);
    expect(first.created).toBe(true);
    const again = await t.mutation(api.albatrossNotifications.queueStepRunHandoff, args);
    expect(again).toEqual({ created: false, notificationId: first.notificationId });
    const row = await t.run((ctx) => ctx.db.get(first.notificationId));
    expect(row).toMatchObject({
      type: 'work_question',
      entityKind: 'work',
      deepLink: '/?view=albatrosses&work=work-1',
    });
  });
});

describe('approval dedupe', () => {
  test('a retried writer gets the same approval back', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const args = {
      ...caller,
      kind: 'calendar_invite' as const,
      title: 'Send the invite: Review',
      intentId: workId,
      operationBatchId: 'run-1',
      artifactKind: 'step_run',
      artifactId: 'run-1:abcd1234',
      toolName: 'calendar_create_event',
      toolArgs: { title: 'Review' },
      dedupe: true,
    };
    const first = await t.mutation(api.albatrossWork.enqueueApproval, args);
    const again = await t.mutation(api.albatrossWork.enqueueApproval, args);
    expect(again).toBe(first);
    const other = await t.mutation(api.albatrossWork.enqueueApproval, {
      ...args,
      artifactId: 'run-1:ffff0000',
    });
    expect(other).not.toBe(first);
    const plain = await t.mutation(api.albatrossWork.enqueueApproval, { ...args, dedupe: undefined });
    expect(plain).not.toBe(first);
  });
});
