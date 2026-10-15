import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createStepRunPost } from '../app/api/albatross/work/[workId]/run/route';
import { createWorkStepPost } from '../app/api/albatross/work/[workId]/step/route';
import { localDateKey } from '../lib/albatross/local-time';
import {
  completeStepAndContinue,
  continueGoalRun,
  handleStepFromThread,
  resumeStepRun,
  StepRunStartError,
  startAutomaticRuns,
  startStepRun,
} from '../lib/albatross/step-run-start';
import { runHandleStep } from '../lib/tools/albatross-runs';

// Starting goal runs (docs/albatross-goal-runs.md, G1 Start): "Handle it"
// with no step, automatic runs once a day and never while a handoff waits,
// and "Done, continue" on a goal handoff. Invented data only.

const ENV_KEYS = ['LAB86_STEP_RUNS', 'LAB86_STEP_RUNS_AUTO', 'LAB86_GOAL_RUNS'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.LAB86_GOAL_RUNS = 'user-1';
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const nameOf = (fn: any) => getFunctionName(fn);

const steps = [
  { key: 'step-1', title: 'Find the July hours', done: true, stepMode: 'agent_does' },
  { key: 'step-2', title: 'Write the invoice', done: false, stepMode: 'agent_does' },
  { key: 'step-3', title: 'Sign the W-9', done: false, stepMode: 'you_do_offline' },
];

const detail = {
  work: { _id: 'work-1', title: 'July invoice', rawText: 'Send the July invoice' },
  execution: { guideSteps: steps, currentStep: steps[1] },
  questions: [],
};

type Enqueue = { runId: string | null; created: boolean; reason: string | null };

function makeDeps(
  options: {
    detail?: any;
    runs?: any[];
    enqueue?: Enqueue;
    timezone?: string | Error;
    steered?: boolean;
    completed?: { stepKey: string; allStepsComplete: boolean; closed?: boolean };
  } = {},
) {
  const mutations: Array<[string, any]> = [];
  const deps = {
    convexQuery: mock(async (fn: any, args: any) => {
      const name = nameOf(fn);
      if (name === 'albatrossWorkV2:workDetail')
        return options.detail === undefined ? detail : options.detail;
      if (name === 'albatrossStepRuns:runsForWorkHistory') return options.runs ?? [];
      if (name === 'albatrossStepRuns:get')
        return (options.runs || []).find((run) => run.id === args.id) ?? null;
      throw new Error(`unexpected query ${name}`);
    }) as any,
    convexMutation: mock(async (fn: any, args: any) => {
      const name = nameOf(fn);
      mutations.push([name, args]);
      if (name === 'albatrossStepRuns:enqueue')
        return options.enqueue ?? { runId: 'run-new', created: true, reason: null };
      if (name === 'albatrossStepRuns:steer') return options.steered ?? true;
      if (name === 'albatrossStepRuns:dismissHandoff') return { dismissed: true };
      return true;
    }) as any,
    runsPaused: mock(async () => false),
    completeWorkStep: mock(
      async () => options.completed ?? { stepKey: 'step-2', allStepsComplete: false },
    ) as any,
    timezone: mock(async () => {
      if (options.timezone instanceof Error) throw options.timezone;
      return options.timezone ?? 'America/New_York';
    }),
  };
  const calls = (name: string) => mutations.filter(([fn]) => fn === name).map(([, args]) => args);
  return { deps, mutations, calls };
}

async function startError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StepRunStartError);
    return { status: (error as StepRunStartError).status, message: (error as Error).message };
  }
  throw new Error('expected a StepRunStartError');
}

const handoff = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  workId: 'work-1',
  goal: true,
  stepKey: 'goal',
  state: 'handed_off',
  outcome: 'ready_for_you',
  stoppedBy: null,
  browserSessionId: 'bb-1',
  checklist: [{ id: 'c1', text: 'Write the invoice', state: 'done' }],
  next: { label: 'Read and send', target: { kind: 'draft', id: 'd1' } },
  ...overrides,
});

describe('a user start in goal mode', () => {
  test('needs no step: the run is a goal run with the open steps as its first checklist', async () => {
    const { deps, calls } = makeDeps();
    expect(
      await startStepRun(
        { userId: 'user-1', workId: 'work-1', stepKey: 'step-9', trigger: 'user', note: ' Go ' },
        deps,
      ),
    ).toEqual({ runId: 'run-new', created: true, reason: null });
    expect(calls('albatrossStepRuns:enqueue')).toEqual([
      {
        userId: 'user-1',
        workId: 'work-1',
        stepKey: 'goal',
        stepIdentity: 'goal:work-1',
        stepTitle: 'July invoice',
        trigger: 'user',
        goal: true,
        checklist: [
          { id: 'c1', text: 'Write the invoice', state: 'todo' },
          { id: 'c2', text: 'Sign the W-9', state: 'yours' },
        ],
        resumeNote: 'Go',
      },
    ]);
  });

  test('the newest earlier checklist wins; a missing Work is a 404; a refused queue explains itself', async () => {
    const { deps, calls } = makeDeps({ runs: [handoff({ state: 'done' })] });
    await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'user' }, deps);
    expect(calls('albatrossStepRuns:enqueue')[0].checklist).toEqual([
      { id: 'c1', text: 'Write the invoice', state: 'done' },
    ]);
    const gone = makeDeps({ detail: null });
    expect(
      await startError(startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'user' }, gone.deps)),
    ).toEqual({ status: 404, message: 'Albatross Work not found.' });
    for (const [reason, message] of [
      ['active', 'Albatross is already working on this.'],
      ['busy', 'Albatross has 30 steps open or waiting now. Try again when one ends.'],
      ['closed', 'This Albatross is closed.'],
      ['other', 'The run did not start. Try again.'],
    ] as const) {
      const refused = makeDeps({ enqueue: { runId: null, created: false, reason } });
      expect(
        await startError(startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'user' }, refused.deps)),
      ).toEqual({ status: 409, message });
    }
  });

  test('outside the switch the old step start stays', async () => {
    process.env.LAB86_GOAL_RUNS = 'someone-else';
    const { deps, calls } = makeDeps();
    await startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'step-2', trigger: 'user' }, deps);
    expect(calls('albatrossStepRuns:enqueue')[0]).toMatchObject({ stepKey: 'step-2' });
    expect(calls('albatrossStepRuns:enqueue')[0]).not.toHaveProperty('goal');
  });
});

describe('automatic goal runs', () => {
  beforeEach(() => {
    process.env.LAB86_STEP_RUNS_AUTO = 'user-1';
  });

  test('a Work with no run gets one, keyed by the local day', async () => {
    const { deps, calls } = makeDeps();
    const result = await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'brief' }, deps);
    expect(result.created).toBe(true);
    const args = calls('albatrossStepRuns:enqueue')[0];
    expect(args).toMatchObject({ stepKey: 'goal', goal: true, trigger: 'brief' });
    expect(args.stepIdentity).toBe(`goal:work-1:${localDateKey('America/New_York')}`);
    expect(args).not.toHaveProperty('resumeNote');
    expect(args).not.toHaveProperty('parentRunId');
  });

  test('a run stopped at its limit continues; a bad time zone counts as UTC', async () => {
    const { deps, calls } = makeDeps({
      runs: [handoff({ outcome: 'stopped', stoppedBy: 'cost' })],
      timezone: 'Not/AZone',
    });
    await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'conductor' }, deps);
    expect(calls('albatrossStepRuns:enqueue')[0]).toMatchObject({
      parentRunId: 'run-1',
      browserSessionId: 'bb-1',
      stepIdentity: `goal:work-1:${localDateKey('UTC')}`,
    });
    const failed = makeDeps({ timezone: new Error('down') });
    await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'conductor' }, failed.deps);
    expect(failed.calls('albatrossStepRuns:enqueue')[0].stepIdentity).toBe(
      `goal:work-1:${localDateKey('UTC')}`,
    );
  });

  test('never while a handoff or a question waits, after another run, or for a missing Work', async () => {
    for (const [runs, extra, reason] of [
      [[handoff()], {}, 'waiting'],
      [[], { questions: [{ status: 'pending' }] }, 'waiting'],
      [[handoff({ state: 'done' })], {}, 'ran'],
      [[handoff({ state: 'running' })], {}, 'active'],
    ] as const) {
      const { deps, calls } = makeDeps({ runs: [...runs], detail: { ...detail, ...extra } });
      expect(await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'brief' }, deps)).toEqual({
        runId: null,
        created: false,
        reason,
      });
      expect(calls('albatrossStepRuns:enqueue')).toEqual([]);
    }
    const gone = makeDeps({ detail: null });
    expect(await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'brief' }, gone.deps)).toEqual({
      runId: null,
      created: false,
      reason: 'no_work',
    });
  });

  test('the automatic loop starts the first goal Work that may run', async () => {
    const { deps } = makeDeps();
    const runsFor: Record<string, any[]> = { 'work-a': [handoff()], 'work-b': [] };
    deps.convexQuery = mock(async (fn: any, args: any) => {
      const name = nameOf(fn);
      if (name === 'albatrossWorkV2:workDetail')
        return { ...detail, work: { ...detail.work, _id: args.workId } };
      if (name === 'albatrossStepRuns:runsForWorkHistory') return runsFor[args.workId] ?? [];
      return null;
    }) as any;
    expect(
      await startAutomaticRuns(
        { userId: 'user-1', workIds: ['work-a', 'work-b'], trigger: 'conductor' },
        deps,
      ),
    ).toEqual({ started: ['run-new'], reasons: { 'work-a': 'waiting' } });
  });
});

describe('continuing in goal mode', () => {
  test('a goal handoff continues as a goal run with its checklist and its page', async () => {
    process.env.LAB86_GOAL_RUNS = '';
    const { deps, calls } = makeDeps({ runs: [handoff()] });
    await resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1', note: 'I signed in' }, deps);
    expect(calls('albatrossStepRuns:enqueue')[0]).toEqual({
      userId: 'user-1',
      workId: 'work-1',
      stepKey: 'goal',
      stepIdentity: 'goal:work-1',
      stepTitle: 'July invoice',
      trigger: 'resume',
      goal: true,
      checklist: [{ id: 'c1', text: 'Write the invoice', state: 'done' }],
      parentRunId: 'run-1',
      resumeNote: 'I signed in',
      browserSessionId: 'bb-1',
    });
  });

  test('in goal mode an old step handoff continues as a goal run too', async () => {
    const stepRun = {
      id: 'run-0',
      stepKey: 'step-2',
      state: 'handed_off',
      workId: 'work-1',
      outcome: 'your_turn',
    };
    const { deps, calls } = makeDeps({ runs: [stepRun] });
    await resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-0' }, deps);
    expect(calls('albatrossStepRuns:enqueue')[0]).toMatchObject({
      stepKey: 'goal',
      goal: true,
      parentRunId: 'run-0',
      checklist: [
        { id: 'c1', text: 'Write the invoice', state: 'todo' },
        { id: 'c2', text: 'Sign the W-9', state: 'yours' },
      ],
    });
    const refused = makeDeps({ runs: [stepRun], enqueue: { runId: null, created: false, reason: 'active' } });
    expect(
      await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-0' }, refused.deps)),
    ).toEqual({ status: 409, message: 'Albatross is already working on this.' });
    const gone = makeDeps({ runs: [stepRun], detail: null });
    expect(
      await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-0' }, gone.deps)),
    ).toEqual({ status: 404, message: 'Albatross Work not found.' });
  });
});

describe('"Done, continue" on a goal handoff', () => {
  test('notes the part the user did, starts a run that checks the goal, and closes the handoff', async () => {
    const { deps, calls, mutations } = makeDeps({ runs: [handoff()] });
    expect(await continueGoalRun({ userId: 'user-1', workId: 'work-1', note: 'Sent it.' }, deps)).toEqual({
      stepKey: 'goal',
      allStepsComplete: false,
      nextRunId: 'run-new',
      nextStepKey: 'goal',
    });
    expect(calls('albatrossStepRuns:enqueue')[0]).toMatchObject({
      trigger: 'resume',
      goal: true,
      parentRunId: 'run-1',
      resumeNote: 'The user did their part: Read and send. Sent it.',
    });
    expect(calls('albatrossStepRuns:dismissHandoff')).toEqual([{ userId: 'user-1', id: 'run-1' }]);
    // The run is queued first; the handoff closes only after.
    expect(mutations.map(([fn]) => fn)).toEqual([
      'albatrossStepRuns:enqueue',
      'albatrossStepRuns:dismissHandoff',
    ]);
  });

  test('nothing to continue is a 409; runs off is a 403', async () => {
    for (const runs of [
      [],
      [handoff({ state: 'done' })],
      [handoff({ outcome: 'needs_answer' })],
      [handoff({ goal: false, stepKey: 'step-2' })],
    ]) {
      const { deps, calls } = makeDeps({ runs });
      expect(await startError(continueGoalRun({ userId: 'user-1', workId: 'work-1' }, deps))).toEqual({
        status: 409,
        message: 'Nothing waits for you on this Albatross.',
      });
      expect(calls('albatrossStepRuns:dismissHandoff')).toEqual([]);
    }
    process.env.LAB86_STEP_RUNS = 'off';
    const { deps } = makeDeps({ runs: [handoff()] });
    expect(await startError(continueGoalRun({ userId: 'user-1', workId: 'work-1' }, deps))).toEqual({
      status: 403,
      message: 'Step runs are off.',
    });
  });

  test('a refused queue keeps the handoff open', async () => {
    const { deps, calls } = makeDeps({
      runs: [handoff({ outcome: 'your_turn' })],
      enqueue: { runId: null, created: false, reason: 'busy' },
    });
    expect((await startError(continueGoalRun({ userId: 'user-1', workId: 'work-1' }, deps))).status).toBe(
      409,
    );
    expect(calls('albatrossStepRuns:dismissHandoff')).toEqual([]);
  });
});

describe('the thread in goal mode', () => {
  test('a note steers the open run; no note says it works; "done" tells the open run', async () => {
    const open = handoff({ id: 'run-2', state: 'running' });
    const steer = makeDeps({ runs: [handoff(), open] });
    expect(
      await handleStepFromThread({ userId: 'user-1', workId: 'work-1', note: 'Use 80 hours' }, steer.deps),
    ).toEqual({ action: 'steered', runId: 'run-2', goal: true });
    expect(await handleStepFromThread({ userId: 'user-1', workId: 'work-1' }, steer.deps)).toEqual({
      action: 'working',
      runId: 'run-2',
      goal: true,
    });
    await handleStepFromThread({ userId: 'user-1', workId: 'work-1', done: true, note: 'Sent.' }, steer.deps);
    expect(steer.calls('albatrossStepRuns:steer').at(-1)).toMatchObject({
      text: 'The user says this part is done. Sent.',
    });
    // A run that ended between the read and the note: the note continues the goal.
    const late = makeDeps({ runs: [open], steered: false });
    expect(
      await handleStepFromThread({ userId: 'user-1', workId: 'work-1', note: 'x' }, late.deps),
    ).toMatchObject({ action: 'started' });
  });

  test('a waiting handoff continues with the note, and its question counts as answered', async () => {
    const asked = handoff({
      outcome: 'needs_answer',
      next: { label: 'Answer', target: { kind: 'question', id: 'q1' } },
      question: { status: 'pending' },
    });
    const { deps, calls } = makeDeps({ runs: [asked] });
    expect(
      await handleStepFromThread({ userId: 'user-1', workId: 'work-1', note: '$90 an hour' }, deps),
    ).toEqual({
      action: 'resumed',
      runId: 'run-new',
      goal: true,
    });
    expect(calls('albatrossWorkV2:answerQuestion')[0]).toMatchObject({
      questionId: 'q1',
      expectedWorkId: 'work-1',
    });
    expect(calls('albatrossStepRuns:enqueue')[0]).toMatchObject({
      parentRunId: 'run-1',
      resumeNote: '$90 an hour',
    });
  });

  test('"done" on a goal handoff is "Done, continue"; with nothing waiting a goal run starts', async () => {
    const done = makeDeps({ runs: [handoff()] });
    const result = await handleStepFromThread({ userId: 'user-1', workId: 'work-1', done: true }, done.deps);
    expect(result).toMatchObject({
      action: 'resumed',
      runId: 'run-new',
      goal: true,
      check: { stepKey: 'goal' },
    });
    expect(done.calls('albatrossStepRuns:dismissHandoff')).toHaveLength(1);

    const fresh = makeDeps({ runs: [] });
    expect(
      await handleStepFromThread({ userId: 'user-1', workId: 'work-1', note: 'Do it' }, fresh.deps),
    ).toEqual({
      action: 'started',
      runId: 'run-new',
      goal: true,
    });
  });

  test('"done" with no goal handoff checks the old step, then the goal goes on', async () => {
    const { deps, calls } = makeDeps({ runs: [] });
    const result = await handleStepFromThread({ userId: 'user-1', workId: 'work-1', done: true }, deps);
    expect(result).toMatchObject({ action: 'checked', runId: 'run-new' });
    expect(deps.completeWorkStep).toHaveBeenCalled();
    expect(calls('albatrossStepRuns:enqueue')[0]).toMatchObject({ stepKey: 'goal', trigger: 'user' });
  });

  test('a step marked done in goal mode starts a goal run, unless the Work closed', async () => {
    const { deps } = makeDeps({ completed: { stepKey: 'step-2', allStepsComplete: true } });
    expect(await completeStepAndContinue({ userId: 'user-1', workId: 'work-1' }, deps)).toEqual({
      stepKey: 'step-2',
      allStepsComplete: true,
      nextRunId: 'run-new',
      nextStepKey: 'goal',
    });
    const closed = makeDeps({ completed: { stepKey: 'step-2', allStepsComplete: true, closed: true } });
    expect(
      (await completeStepAndContinue({ userId: 'user-1', workId: 'work-1' }, closed.deps)).nextRunId,
    ).toBeNull();
    const refused = makeDeps({ enqueue: { runId: null, created: false, reason: 'active' } });
    expect(await completeStepAndContinue({ userId: 'user-1', workId: 'work-1' }, refused.deps)).toMatchObject(
      {
        nextRunId: null,
        nextStepKey: null,
      },
    );
  });

  test('the chat tool reports goal words', async () => {
    const result = await runHandleStep({ workId: 'work-1', note: 'Go' }, { userId: 'user-1' } as any, {
      handleStepFromThread: async () => ({ action: 'started', runId: 'run-9', goal: true }),
      stopStepFromThread: async () => null,
    });
    expect(result.message).toBe(
      'Albatross started on the goal. The run writes its progress in this conversation.',
    );
  });
});

describe('the routes', () => {
  const context = { params: Promise.resolve({ workId: 'work-1' }) };
  const user = { userId: 'user-1', email: 'u@example.com', name: 'U' };
  const post = (path: string, body: unknown) =>
    new NextRequest(`http://localhost/api/albatross/work/work-1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('start: a goal Work starts with no step key or with "goal"; another Work still needs a step', async () => {
    const startStepRun = mock(async () => ({ runId: 'run-1', created: true }));
    const deps = {
      requireCurrentUser: mock(async () => user) as any,
      enforceUserRateLimit: mock(async () => undefined) as any,
      startStepRun: startStepRun as any,
      goalRunsEnabled: () => true,
    };
    for (const body of [{ action: 'start' }, { action: 'start', stepKey: 'goal' }]) {
      const response = await createStepRunPost(deps)(post('run', body), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, runId: 'run-1' });
    }
    expect(startStepRun.mock.calls.map((call: any[]) => call[0])).toEqual([
      { userId: 'user-1', workId: 'work-1', trigger: 'user' },
      { userId: 'user-1', workId: 'work-1', trigger: 'user' },
    ]);
    const off = await createStepRunPost({ ...deps, goalRunsEnabled: () => false })(
      post('run', { action: 'start' }),
      context,
    );
    expect(off.status).toBe(400);
  });

  test('step: "goal" with continue runs "Done, continue"; without continue it is refused', async () => {
    const continueGoalRun = mock(async () => ({
      stepKey: 'goal',
      allStepsComplete: false,
      nextRunId: 'run-2',
      nextStepKey: 'goal',
    }));
    const deps = {
      requireCurrentUser: mock(async () => user) as any,
      enforceUserRateLimit: mock(async () => ({ ok: true })) as any,
      completeWorkStep: mock(async () => ({})) as any,
      completeStepAndContinue: mock(async () => ({})) as any,
      continueGoalRun: continueGoalRun as any,
    };
    const response = await createWorkStepPost(deps)(
      post('step', { stepKey: 'goal', continue: true, note: 'I sent it.' }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      stepKey: 'goal',
      allStepsComplete: false,
      nextRunId: 'run-2',
      nextStepKey: 'goal',
    });
    expect(continueGoalRun).toHaveBeenCalledWith({ userId: 'user-1', workId: 'work-1', note: 'I sent it.' });
    expect(deps.completeWorkStep).not.toHaveBeenCalled();

    const refused = await createWorkStepPost(deps)(post('step', { stepKey: 'goal' }), context);
    expect(refused.status).toBe(400);

    continueGoalRun.mockImplementation(async () => {
      throw new StepRunStartError('Nothing waits for you on this Albatross.', 409);
    });
    const nothing = await createWorkStepPost(deps)(
      post('step', { stepKey: 'goal', continue: true }),
      context,
    );
    expect(nothing.status).toBe(409);
    expect(await nothing.json()).toEqual({ ok: false, error: 'Nothing waits for you on this Albatross.' });
  });
});
