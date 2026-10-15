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

describe('goal runs (docs/albatross-goal-runs.md)', () => {
  function goalArgs(workId: string, overrides: Record<string, unknown> = {}) {
    return enqueueArgs(workId, {
      stepKey: 'goal',
      stepIdentity: `goal:${workId}`,
      stepTitle: 'Proposal',
      goal: true,
      checklist: [
        { id: 'x', text: '  Write the proposal ', state: 'todo' },
        { id: 'y', text: 'Call the venue', state: 'yours' },
      ],
      ...overrides,
    });
  }

  test('enqueue marks a goal run and keeps its first checklist; a step run gets neither', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, goalArgs(workId));
    const view = await t.query(api.albatrossStepRuns.get, {
      ...caller,
      id: runId as Id<'albatrossStepRuns'>,
    });
    expect(view).toMatchObject({
      stepKey: 'goal',
      goal: true,
      checklist: [
        { id: 'c1', text: 'Write the proposal', state: 'todo' },
        { id: 'c2', text: 'Call the venue', state: 'yours' },
      ],
      messages: [],
      items: [],
      unsure: [],
    });
    await t.mutation(api.albatrossStepRuns.cancel, { ...caller, id: runId as Id<'albatrossStepRuns'> });
    const step = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(workId, { checklist: [{ id: 'z', text: 'Ignored', state: 'todo' }] }),
    );
    const stepView = await t.query(api.albatrossStepRuns.get, {
      ...caller,
      id: step.runId as Id<'albatrossStepRuns'>,
    });
    expect(stepView).toMatchObject({ goal: false, checklist: [] });
  });

  test('automatic goal runs dedupe by the day key; a user run on the goal key is not blocked', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const day = `goal:${workId}:2026-10-15`;
    const first = await t.mutation(
      api.albatrossStepRuns.enqueue,
      goalArgs(workId, { trigger: 'brief', stepIdentity: day }),
    );
    expect(first.created).toBe(true);
    await t.mutation(api.albatrossStepRuns.cancel, { ...caller, id: first.runId as Id<'albatrossStepRuns'> });
    const again = await t.mutation(
      api.albatrossStepRuns.enqueue,
      goalArgs(workId, { trigger: 'conductor', stepIdentity: day }),
    );
    expect(again as unknown).toEqual({ runId: first.runId, created: false, reason: 'already_ran' });
    const nextDay = await t.mutation(
      api.albatrossStepRuns.enqueue,
      goalArgs(workId, { trigger: 'conductor', stepIdentity: `goal:${workId}:2026-10-16` }),
    );
    expect(nextDay.created).toBe(true);
  });

  test('progress keeps the newest 40 messages and the newest checklist; settle keeps the package', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, goalArgs(workId));
    await claimRun(t, runId!);
    const fence = { ...caller, id: runId as Id<'albatrossStepRuns'>, token: 'token-1' };
    for (let index = 0; index < 42; index += 1)
      await t.mutation(api.albatrossStepRuns.progress, {
        ...fence,
        message: {
          id: `m${index}`,
          at: index,
          text: `Message ${index}`,
          sources: [
            { kind: 'web', title: 'Form', url: 'https://www.irs.gov/w9' },
            { kind: 'web', title: 'Form again', url: 'https://www.irs.gov/w9' },
          ],
        },
      });
    await t.mutation(api.albatrossStepRuns.progress, {
      ...fence,
      message: { id: 'empty', at: 99, text: '   ', sources: [] },
      checklist: [{ id: 'a', text: 'Write the proposal', state: 'done' }],
    });
    const settled = await t.mutation(api.albatrossStepRuns.settle, {
      ...fence,
      outcome: 'ready_for_you',
      summary: 'I wrote it.',
      next: { kind: 'review_draft', label: 'Read and send', detail: 'Read it.' },
      items: [
        {
          kind: 'draft',
          id: 'd1',
          title: 'Proposal',
          state: 'ready',
          blanks: ['rate'],
          url: '/?view=mail&draft=d1',
        },
        { kind: 'draft', id: 'd1', title: 'Same draft', state: 'check' },
      ],
      unsure: ['Check the rate.', 'Check the rate.', '  '],
    });
    expect(settled).toEqual({ state: 'handed_off' });
    const view = await t.query(api.albatrossStepRuns.get, {
      ...caller,
      id: runId as Id<'albatrossStepRuns'>,
    });
    expect(view!.messages).toHaveLength(40);
    expect(view!.messages[0].text).toBe('Message 2');
    expect(view!.messages[0].sources).toEqual([
      { kind: 'web', title: 'Form', url: 'https://www.irs.gov/w9' },
    ]);
    expect(view!.checklist).toEqual([{ id: 'c1', text: 'Write the proposal', state: 'done' }]);
    expect(view!.items).toEqual([
      {
        kind: 'draft',
        title: 'Proposal',
        state: 'blanks',
        id: 'd1',
        url: '/?view=mail&draft=d1',
        blanks: ['rate'],
      },
    ]);
    expect(view!.unsure).toEqual(['Check the rate.']);
  });

  test('updateGoal changes the contract of its own Work only while the goal run holds the lease', async () => {
    const t = harness();
    const intentId = await seedWork(t, {
      contract: {
        outcome: 'Dana has the proposal',
        proofs: [{ id: 'p1', what: 'The message left your account', satisfiedAt: 5, satisfiedBy: 'Sent' }],
        closeWhen: 'outcome_likely',
        updatedAt: 1,
      },
    });
    const workId = String(intentId);
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, goalArgs(workId));
    await claimRun(t, runId!);
    const fence = { ...caller, id: runId as Id<'albatrossStepRuns'>, token: 'token-1' };
    expect(await t.mutation(api.albatrossStepRuns.updateGoal, { ...fence, outcome: '  ' })).toEqual({
      ok: false,
      message: 'Send outcome, proofs, or both.',
    });
    expect(
      await t.mutation(api.albatrossStepRuns.updateGoal, {
        ...fence,
        outcome: 'Dana has the proposal and the budget',
        proofs: ['The message left your account', 'Dana replied'],
      }),
    ).toEqual({
      ok: true,
      outcome: 'Dana has the proposal and the budget',
      proofs: [
        { what: 'The message left your account', settled: true },
        { what: 'Dana replied', settled: false },
      ],
    });
    const work = await t.run((ctx) => ctx.db.get(intentId));
    expect(work!.contract).toMatchObject({
      outcome: 'Dana has the proposal and the budget',
      proofs: [
        { id: 'p1', what: 'The message left your account', satisfiedAt: 5, satisfiedBy: 'Sent' },
        { id: 'goal-2', what: 'Dana replied' },
      ],
      closeWhen: 'outcome_likely',
    });
    // A lost lease, a step run, and a closed Work change nothing.
    expect(
      await t.mutation(api.albatrossStepRuns.updateGoal, { ...fence, token: 'wrong', outcome: 'x' }),
    ).toEqual({
      ok: false,
      message: 'The run is not open.',
    });
    await t.run((ctx) => ctx.db.patch(intentId, { workState: 'done' }));
    expect(await t.mutation(api.albatrossStepRuns.updateGoal, { ...fence, outcome: 'x' })).toEqual({
      ok: false,
      message: 'This Albatross is closed.',
    });
    const other = String(await seedWork(t));
    const stepRun = await t.mutation(api.albatrossStepRuns.enqueue, enqueueArgs(other));
    await claimRun(t, stepRun.runId!, 'step-token');
    expect(
      await t.mutation(api.albatrossStepRuns.updateGoal, {
        ...caller,
        id: stepRun.runId as Id<'albatrossStepRuns'>,
        token: 'step-token',
        outcome: 'x',
      }),
    ).toEqual({ ok: false, message: 'The run is not open.' });
  });

  test('a Work with no contract gets its first contract from the update', async () => {
    const t = harness();
    const intentId = await seedWork(t);
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, goalArgs(String(intentId)));
    await claimRun(t, runId!);
    await t.mutation(api.albatrossStepRuns.updateGoal, {
      ...caller,
      id: runId as Id<'albatrossStepRuns'>,
      token: 'token-1',
      proofs: ['Dana replied'],
    });
    const work = await t.run((ctx) => ctx.db.get(intentId));
    expect(work!.contract).toMatchObject({
      outcome: 'Proposal',
      proofs: [{ id: 'goal-1', what: 'Dana replied' }],
      closeWhen: 'outcome_likely',
    });
  });

  test('workDetail shows the goal switch, the newest goal run, and the newest checklist', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const before = await t.query(api.albatrossWorkV2.workDetail, {
      ...caller,
      workId: workId as Id<'albatrossIntents'>,
    });
    expect(before).toMatchObject({ goalRuns: false, checklist: [], execution: { goalRun: null } });

    const first = await t.mutation(api.albatrossStepRuns.enqueue, goalArgs(workId));
    await t.mutation(api.albatrossStepRuns.cancel, { ...caller, id: first.runId as Id<'albatrossStepRuns'> });
    const second = await t.mutation(api.albatrossStepRuns.enqueue, goalArgs(workId, { checklist: [] }));
    const detail = await t.query(api.albatrossWorkV2.workDetail, {
      ...caller,
      workId: workId as Id<'albatrossIntents'>,
    });
    expect(detail!.goalRuns).toBe(true);
    expect(detail!.execution.goalRun?.id).toBe(second.runId!);
    // The newest run has no list yet: the newest list of an earlier run shows.
    expect(detail!.checklist.map((item) => item.text)).toEqual(['Write the proposal', 'Call the venue']);

    const previous = process.env.LAB86_GOAL_RUNS;
    process.env.LAB86_GOAL_RUNS = userId;
    try {
      const other = String(await seedWork(t));
      const switched = await t.query(api.albatrossWorkV2.workDetail, {
        ...caller,
        workId: other as Id<'albatrossIntents'>,
      });
      expect(switched!.goalRuns).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LAB86_GOAL_RUNS;
      else process.env.LAB86_GOAL_RUNS = previous;
    }
  });

  test('autoCandidates takes a goal Work whose plan has no steps', async () => {
    const t = harness();
    const now = Date.now();
    const intentId = await seedWork(t, { lastUserTouchAt: now, createdAt: now });
    const planId = await t.mutation(api.albatrossIntents.savePlan, {
      ...caller,
      intentId,
      outcome: 'Proposal',
      digitalActions: [],
      physicalActions: [],
      assumptions: [],
      sourceRefs: [],
    });
    await t.mutation(api.albatrossIntents.markPlanApplied, { ...caller, planId, appliedSteps: [] });
    expect(await t.query(internal.albatrossStepRuns.autoCandidates, {})).toEqual([
      { userId, workId: String(intentId) },
    ]);
  });
});

describe('a goal Work closes by its contract (docs/albatross-goal-runs.md)', () => {
  const contract = {
    outcome: 'Dana has the proposal',
    proofs: [
      { id: 'send-0', what: 'The message left your account' },
      { id: 'send-1', what: 'The person acknowledged it' },
    ],
    closeWhen: 'outcome_likely' as const,
    updatedAt: 1,
  };
  let previousGoal: string | undefined;
  beforeAll(() => {
    previousGoal = process.env.LAB86_GOAL_RUNS;
  });
  afterEach(() => {
    if (previousGoal === undefined) delete process.env.LAB86_GOAL_RUNS;
    else process.env.LAB86_GOAL_RUNS = previousGoal;
  });

  async function seedThread(t: Harness, threadId: string) {
    await t.run((ctx) =>
      ctx.db.insert('mailCorpusThreads', {
        userId,
        accountId: 'acct-1',
        grantId: 'grant-1',
        provider: 'google',
        providerThreadId: threadId,
        subject: 'The proposal',
        fromAddress: 'me@example.com',
        lastDate: 10,
        snippet: 'Attached.',
        labels: ['SENT'],
        unread: false,
        yearMonth: '2026-10',
        createdAt: 10,
        updatedAt: 10,
      } as any),
    );
  }

  function mailProof(workId: Id<'albatrossIntents'>, threadId: string, proofId: string) {
    return {
      ...caller,
      workId,
      claim: 'Shown by mail.',
      title: 'The proposal',
      sourceKind: 'mail_thread' as const,
      sourceId: threadId,
      accountId: 'acct-1',
      trust: 'inferred' as const,
      proofId,
      settleContract: true,
    };
  }

  test('the server watch records gate-judged mail as inferred; the Work closes when every proof holds', async () => {
    const t = harness();
    const workId = await seedWork(t, { contract });
    await seedThread(t, 'sent-1');
    await seedThread(t, 'reply-1');
    await t.mutation(api.albatrossWorkV2.attachProof, mailProof(workId, 'sent-1', 'send-0'));
    let work = await t.run((ctx) => ctx.db.get(workId));
    expect(work!.workState).toBe('active');
    expect(work!.contract!.proofs[0].satisfiedAt).toBeNumber();
    await t.mutation(api.albatrossWorkV2.attachProof, mailProof(workId, 'reply-1', 'send-1'));
    work = await t.run((ctx) => ctx.db.get(workId));
    expect(work!.workState).toBe('done');
    const evidence = await t.run((ctx) => ctx.db.query('albatrossEvidence').collect());
    expect(evidence.map((row) => row.trust)).toEqual(['inferred', 'inferred']);
  });

  test('a user cannot raise mail proof above observed, and observed mail alone does not close', async () => {
    const t = harness();
    const workId = await seedWork(t, { contract });
    await seedThread(t, 'sent-1');
    await seedThread(t, 'reply-1');
    const asUser = t.withIdentity({ subject: userId });
    const { internalSecret: _secret, userId: _user, ...userArgs } = mailProof(workId, 'sent-1', 'send-0');
    await asUser.mutation(api.albatrossWorkV2.attachProof, userArgs);
    await t.mutation(api.albatrossWorkV2.attachProof, {
      ...mailProof(workId, 'reply-1', 'send-1'),
      trust: 'observed',
    });
    const work = await t.run((ctx) => ctx.db.get(workId));
    // Both proofs hold, but observed mail is "something happened", not "looks done".
    expect(work!.contract!.proofs.every((proof) => proof.satisfiedAt)).toBe(true);
    expect(work!.workState).toBe('active');
    const evidence = await t.run((ctx) => ctx.db.query('albatrossEvidence').collect());
    expect(evidence.map((row) => row.trust)).toEqual(['observed', 'observed']);
  });

  test('a goal run proof from observed results settles its named proof', async () => {
    const t = harness();
    const workId = await seedWork(t, { contract });
    await t.mutation(api.albatrossWorkV2.attachProof, {
      ...caller,
      workId,
      claim: 'The message left your account: the sent folder has it.',
      title: 'The proposal',
      sourceKind: 'step_run',
      sourceId: 'run-1:send-0',
      trust: 'inferred',
      proofId: 'send-0',
      settleContract: true,
    });
    const work = await t.run((ctx) => ctx.db.get(workId));
    expect(work!.contract!.proofs.map((proof) => Boolean(proof.satisfiedAt))).toEqual([true, false]);
  });

  test('the mail watch arms for a goal Work at its plan row and at a goal handoff, and stays while proofs are open', async () => {
    process.env.LAB86_GOAL_RUNS = userId;
    const t = harness();
    const now = Date.now();
    const planned = await seedWork(t, { lastUserTouchAt: now, createdAt: now });
    await t.mutation(api.albatrossIntents.savePlan, {
      ...caller,
      intentId: planned,
      outcome: 'Proposal',
      digitalActions: [],
      physicalActions: [],
      assumptions: [],
      sourceRefs: [],
      contract: {
        outcome: 'Proposal',
        proofs: [{ id: 'p', what: 'Dana replied' }],
        closeWhen: 'outcome_likely',
      },
    });
    expect((await t.run((ctx) => ctx.db.get(planned)))!.mailWatchAt).toBeNumber();
    expect(await t.query(internal.albatrossWorkV2.mailWatchCandidates, {})).toEqual([
      { userId, workId: String(planned) },
    ]);
    const kept = await t.mutation(api.albatrossWorkV2.completeMailWatch, {
      ...caller,
      workId: planned,
      stillWatching: true,
    });
    expect(kept).toEqual({ stillWatching: true });

    // An older Work with no watch: a goal handoff arms it.
    const older = await seedWork(t, { contract });
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, {
      ...enqueueArgs(String(older)),
      stepKey: 'goal',
      stepIdentity: `goal:${older}`,
      goal: true,
    });
    await claimRun(t, runId!);
    await t.mutation(api.albatrossStepRuns.settle, {
      ...caller,
      id: runId as Id<'albatrossStepRuns'>,
      token: 'token-1',
      outcome: 'ready_for_you',
      summary: 'I saved the draft.',
      next: { kind: 'review_draft', label: 'Read and send', detail: 'Read it.' },
    });
    expect((await t.run((ctx) => ctx.db.get(older)))!.mailWatchAt).toBeNumber();

    // Outside the switch, nothing arms.
    process.env.LAB86_GOAL_RUNS = 'someone-else';
    const other = await seedWork(t);
    await t.mutation(api.albatrossIntents.savePlan, {
      ...caller,
      intentId: other,
      outcome: 'Proposal',
      digitalActions: [],
      physicalActions: [],
      assumptions: [],
      sourceRefs: [],
      contract: {
        outcome: 'Proposal',
        proofs: [{ id: 'p', what: 'Dana replied' }],
        closeWhen: 'outcome_likely',
      },
    });
    expect((await t.run((ctx) => ctx.db.get(other)))!.mailWatchAt).toBeUndefined();
  });
});

describe('a run source keeps its detail (docs/albatross-goal-runs.md)', () => {
  test('progress stores the muted detail of a source', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(
      api.albatrossStepRuns.enqueue,
      enqueueArgs(workId, { stepKey: 'goal', stepIdentity: `goal:${workId}`, goal: true }),
    );
    await claimRun(t, runId!);
    await t.mutation(api.albatrossStepRuns.progress, {
      ...caller,
      id: runId as Id<'albatrossStepRuns'>,
      token: 'token-1',
      message: {
        id: 'm1',
        at: 1,
        text: 'The lead wrote the hours.',
        sources: [{ kind: 'mail', title: 'July hours', id: 't1', detail: 'Priya, Jul 30' }],
      },
    });
    const view = await t.query(api.albatrossStepRuns.get, {
      ...caller,
      id: runId as Id<'albatrossStepRuns'>,
    });
    expect(view!.messages[0].sources).toEqual([
      { kind: 'mail', title: 'July hours', id: 't1', detail: 'Priya, Jul 30' },
    ]);
  });
});
