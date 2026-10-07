import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  resumeRunForAnswer,
  resumeStepRun,
  StepRunStartError,
  startAutomaticRuns,
  startStepRun,
} from '../lib/albatross/step-run-start';

const ENV_KEYS = ['LAB86_STEP_RUNS', 'LAB86_STEP_RUNS_AUTO'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const nameOf = (fn: any) => getFunctionName(fn);

type Step = {
  key: string;
  identity?: string;
  title: string;
  done: boolean;
  stepMode?: string;
  kind?: string;
};

const agentStep: Step = {
  key: 'step-1',
  identity: 'step:draft the letter',
  title: 'Draft the letter',
  done: false,
  stepMode: 'agent_does',
};

function detailFor(steps: Step[], currentStep: Step | null = steps.find((step) => !step.done) || null) {
  return { work: { _id: 'work-1' }, execution: { guideSteps: steps, currentStep } };
}

type Enqueue = { runId: string | null; created: boolean; reason: string | null };

function makeDeps(
  options: {
    details?: Record<string, unknown>;
    enqueue?: Enqueue | ((args: any) => Enqueue);
    run?: unknown;
    runs?: unknown;
    paused?: boolean | Error;
    queryError?: unknown;
  } = {},
) {
  const enqueued: any[] = [];
  const queried: Array<[string, any]> = [];
  const deps = {
    convexQuery: mock(async (fn: any, args: any) => {
      const name = nameOf(fn);
      queried.push([name, args]);
      if (options.queryError !== undefined) throw options.queryError;
      if (name === 'albatrossWorkV2:workDetail') {
        const details = options.details ?? { 'work-1': detailFor([agentStep]) };
        return details[args.workId] ?? null;
      }
      if (name === 'albatrossStepRuns:get') return options.run ?? null;
      if (name === 'albatrossStepRuns:runsForWork') {
        if (options.runs instanceof Error) throw options.runs;
        return options.runs;
      }
      throw new Error(`unexpected query ${name}`);
    }) as any,
    convexMutation: mock(async (fn: any, args: any) => {
      const name = nameOf(fn);
      if (name !== 'albatrossStepRuns:enqueue') throw new Error(`unexpected mutation ${name}`);
      enqueued.push(args);
      const result = options.enqueue ?? { runId: 'run-1', created: true, reason: null };
      return typeof result === 'function' ? result(args) : result;
    }) as any,
    runsPaused: mock(async () => {
      if (options.paused instanceof Error) throw options.paused;
      return options.paused ?? false;
    }),
  };
  return { deps, enqueued, queried };
}

async function startError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StepRunStartError);
    expect((error as StepRunStartError).name).toBe('StepRunStartError');
    return { status: (error as StepRunStartError).status, message: (error as Error).message };
  }
  throw new Error('expected a StepRunStartError');
}

describe('startStepRun', () => {
  test('off: a user start is refused with 403 and an automatic start returns a reason', async () => {
    process.env.LAB86_STEP_RUNS = 'off';
    const { deps, queried } = makeDeps();
    expect(
      await startError(
        startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1', trigger: 'user' }, deps),
      ),
    ).toEqual({ status: 403, message: 'Step runs are off.' });
    expect(await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'brief' }, deps)).toEqual({
      runId: null,
      created: false,
      reason: 'off',
    });
    expect(queried).toEqual([]);
  });

  test('an automatic start needs LAB86_STEP_RUNS_AUTO', async () => {
    const { deps } = makeDeps();
    expect(await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'conductor' }, deps)).toEqual({
      runId: null,
      created: false,
      reason: 'auto_off',
    });
    process.env.LAB86_STEP_RUNS_AUTO = 'user-2';
    expect((await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'brief' }, deps)).reason).toBe(
      'auto_off',
    );
    expect(deps.runsPaused).not.toHaveBeenCalled();
  });

  test('an automatic start needs the standing order unpaused', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const { deps, enqueued } = makeDeps({ paused: true });
    expect(await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'brief' }, deps)).toEqual({
      runId: null,
      created: false,
      reason: 'paused',
    });
    expect(deps.runsPaused).toHaveBeenCalledWith('user-1');
    expect(enqueued).toEqual([]);
  });

  test('a failed pause read does not block an automatic start', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'user-1';
    const { deps, enqueued } = makeDeps({ paused: new Error('read failed') });
    expect(await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'conductor' }, deps)).toEqual({
      runId: 'run-1',
      created: true,
      reason: null,
    });
    expect(enqueued[0]).toMatchObject({ stepKey: 'step-1', trigger: 'conductor' });
  });

  test('a user start does not read the standing order', async () => {
    const { deps } = makeDeps({ paused: true });
    expect(
      (await startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1', trigger: 'user' }, deps))
        .created,
    ).toBe(true);
    expect(deps.runsPaused).not.toHaveBeenCalled();
  });

  test('missing Work is 404', async () => {
    const { deps } = makeDeps({ details: {} });
    expect(
      await startError(
        startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1', trigger: 'user' }, deps),
      ),
    ).toEqual({ status: 404, message: 'Albatross Work not found.' });
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    expect(await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'conductor' }, deps)).toEqual({
      runId: null,
      created: false,
      reason: 'no_work',
    });
  });

  test('a missing step is 404 for the user and a reason for an automatic start', async () => {
    const { deps } = makeDeps({ details: { 'work-1': detailFor([agentStep], null) } });
    expect(
      await startError(
        startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'nope', trigger: 'user' }, deps),
      ),
    ).toEqual({ status: 404, message: 'There is no such step.' });
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    expect((await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'brief' }, deps)).reason).toBe(
      'no_step',
    );
  });

  test('a Work without execution has no step', async () => {
    const { deps } = makeDeps({ details: { 'work-1': { work: { _id: 'work-1' } } } });
    expect(
      (
        await startError(
          startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1', trigger: 'user' }, deps),
        )
      ).status,
    ).toBe(404);
  });

  test('a step that is not runnable: done is 409, offline is 403, automatic gets a reason', async () => {
    const done = { ...agentStep, key: 'done', done: true };
    const offline = { ...agentStep, key: 'offline', stepMode: 'you_do_offline' };
    const observed = { ...agentStep, key: 'observed', stepMode: 'you_do_observed' };
    const { deps, enqueued } = makeDeps({
      details: { 'work-1': detailFor([done, offline, observed], observed) },
    });
    expect(
      await startError(
        startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'done', trigger: 'user' }, deps),
      ),
    ).toEqual({ status: 409, message: 'This step is already done.' });
    expect(
      await startError(
        startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'offline', trigger: 'user' }, deps),
      ),
    ).toEqual({ status: 403, message: 'This step stays with you.' });
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    expect(
      (await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'conductor' }, deps)).reason,
    ).toBe('not_runnable');
    expect(enqueued).toEqual([]);
  });

  test('enqueues the step with its identity, title, and trigger', async () => {
    const { deps, enqueued } = makeDeps();
    expect(
      await startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1', trigger: 'user' }, deps),
    ).toEqual({ runId: 'run-1', created: true, reason: null });
    expect(enqueued).toEqual([
      {
        userId: 'user-1',
        workId: 'work-1',
        stepKey: 'step-1',
        stepIdentity: 'step:draft the letter',
        stepTitle: 'Draft the letter',
        trigger: 'user',
      },
    ]);
  });

  test('a step without an identity uses its key, and an automatic start uses the current step', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const plain = { key: 'step-9', title: 'Compare prices', done: false, stepMode: 'agent_drafts' };
    const { deps, enqueued } = makeDeps({ details: { 'work-1': detailFor([agentStep, plain], plain) } });
    await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'brief' }, deps);
    expect(enqueued[0]).toMatchObject({ stepKey: 'step-9', stepIdentity: 'step-9', trigger: 'brief' });
  });

  test('queue refusals become 409 for the user', async () => {
    for (const [reason, message] of [
      ['active', 'Albatross is already working on this.'],
      ['busy', 'Albatross is working on three steps now. Try again when one ends.'],
      ['closed', 'This Albatross is closed.'],
    ]) {
      const { deps } = makeDeps({ enqueue: { runId: null, created: false, reason } });
      expect(
        await startError(
          startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1', trigger: 'user' }, deps),
        ),
      ).toEqual({ status: 409, message });
    }
  });

  test('another refusal reason passes through for the user, and every reason for an automatic start', async () => {
    const { deps } = makeDeps({ enqueue: { runId: 'run-0', created: false, reason: 'once' } });
    expect(
      await startStepRun({ userId: 'user-1', workId: 'work-1', stepKey: 'step-1', trigger: 'user' }, deps),
    ).toEqual({ runId: 'run-0', created: false, reason: 'once' });
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const busy = makeDeps({ enqueue: { runId: null, created: false, reason: 'busy' } });
    expect(
      await startStepRun({ userId: 'user-1', workId: 'work-1', trigger: 'conductor' }, busy.deps),
    ).toEqual({
      runId: null,
      created: false,
      reason: 'busy',
    });
  });
});

describe('resumeStepRun', () => {
  const parent = { id: 'run-1', workId: 'work-1', stepKey: 'step-1', browserSessionId: 'bb-1' };

  test('off is 403', async () => {
    process.env.LAB86_STEP_RUNS = 'off';
    const { deps } = makeDeps({ run: parent });
    expect(
      await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1' }, deps)),
    ).toEqual({ status: 403, message: 'Step runs are off.' });
  });

  test('a missing parent run or a run of another Work is 404', async () => {
    const missing = makeDeps({ run: null });
    expect(
      await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1' }, missing.deps)),
    ).toEqual({ status: 404, message: 'Run not found.' });
    const other = makeDeps({ run: { ...parent, workId: 'work-2' } });
    expect(
      (await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1' }, other.deps)))
        .status,
    ).toBe(404);
    expect(missing.queried[0]).toEqual(['albatrossStepRuns:get', { userId: 'user-1', id: 'run-1' }]);
  });

  test('a step that left the plan is 404 and a done step is 409', async () => {
    const gone = makeDeps({
      run: parent,
      details: { 'work-1': detailFor([{ ...agentStep, key: 'other' }]) },
    });
    expect(
      await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1' }, gone.deps)),
    ).toEqual({ status: 404, message: 'This step is no longer in the plan.' });
    const done = makeDeps({ run: parent, details: { 'work-1': detailFor([{ ...agentStep, done: true }]) } });
    expect(
      await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1' }, done.deps)),
    ).toEqual({ status: 409, message: 'This step is already done.' });
  });

  test('passes the parent run, the trimmed note, and the browser session', async () => {
    const { deps, enqueued } = makeDeps({
      run: parent,
      enqueue: { runId: 'run-2', created: true, reason: null },
    });
    expect(
      await resumeStepRun(
        { userId: 'user-1', workId: 'work-1', runId: 'run-1', note: '  I signed in.  ' },
        deps,
      ),
    ).toEqual({ runId: 'run-2', created: true, reason: null });
    expect(enqueued).toEqual([
      {
        userId: 'user-1',
        workId: 'work-1',
        stepKey: 'step-1',
        stepIdentity: 'step:draft the letter',
        stepTitle: 'Draft the letter',
        trigger: 'resume',
        parentRunId: 'run-1',
        resumeNote: 'I signed in.',
        browserSessionId: 'bb-1',
      },
    ]);
  });

  test('leaves out an empty note and a missing browser session', async () => {
    const plain = { key: 'step-1', title: 'Draft the letter', done: false };
    const { deps, enqueued } = makeDeps({
      run: { ...parent, browserSessionId: null },
      details: { 'work-1': detailFor([plain]) },
    });
    await resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1', note: '   ' }, deps);
    expect(enqueued[0]).toEqual({
      userId: 'user-1',
      workId: 'work-1',
      stepKey: 'step-1',
      stepIdentity: 'step-1',
      stepTitle: 'Draft the letter',
      trigger: 'resume',
      parentRunId: 'run-1',
    });
  });

  test('a run that is not created is 409', async () => {
    const active = makeDeps({ run: parent, enqueue: { runId: null, created: false, reason: 'active' } });
    expect(
      await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1' }, active.deps)),
    ).toEqual({ status: 409, message: 'Albatross is already working on this.' });
    const busy = makeDeps({ run: parent, enqueue: { runId: null, created: false, reason: 'busy' } });
    expect(
      await startError(resumeStepRun({ userId: 'user-1', workId: 'work-1', runId: 'run-1' }, busy.deps)),
    ).toEqual({ status: 409, message: 'The run could not continue now. Try again.' });
  });
});

describe('resumeRunForAnswer', () => {
  const waiting = {
    id: 'run-1',
    workId: 'work-1',
    stepKey: 'step-1',
    state: 'handed_off',
    next: { kind: 'answer', target: { kind: 'question', id: 'question-1' } },
  };
  const answer = { userId: 'user-1', workId: 'work-1', questionId: 'question-1', answer: 'Monday' };

  test('resumes the handed-off run that asked the question', async () => {
    const { deps, enqueued } = makeDeps({
      runs: [{ ...waiting, id: 'run-0', next: { target: { kind: 'question', id: 'question-0' } } }, waiting],
      run: waiting,
      enqueue: { runId: 'run-2', created: true, reason: null },
    });
    expect(await resumeRunForAnswer(answer, deps)).toBe('run-2');
    expect(enqueued[0]).toMatchObject({ parentRunId: 'run-1', resumeNote: 'The user answered: Monday' });
  });

  test('is null when no run waits on this question', async () => {
    for (const runs of [
      [],
      null,
      [{ ...waiting, state: 'running' }],
      [{ ...waiting, next: { target: { kind: 'url', id: 'question-1' } } }],
      [{ ...waiting, next: null }],
    ]) {
      const { deps, enqueued } = makeDeps({ runs });
      expect(await resumeRunForAnswer(answer, deps)).toBeNull();
      expect(enqueued).toEqual([]);
    }
  });

  test('is null when the run list fails or the resume fails', async () => {
    const failed = makeDeps({ runs: new Error('Convex down') });
    expect(await resumeRunForAnswer(answer, failed.deps)).toBeNull();
    const refused = makeDeps({
      runs: [waiting],
      run: waiting,
      enqueue: { runId: null, created: false, reason: 'active' },
    });
    expect(await resumeRunForAnswer(answer, refused.deps)).toBeNull();
  });

  test('is null when step runs are off, without a read', async () => {
    process.env.LAB86_STEP_RUNS = 'off';
    const { deps, queried } = makeDeps({ runs: [waiting] });
    expect(await resumeRunForAnswer(answer, deps)).toBeNull();
    expect(queried).toEqual([]);
  });
});

describe('startAutomaticRuns', () => {
  const runnable = (key: string): Step => ({ key, title: key, done: false, stepMode: 'agent_does' });
  const userOnly = (key: string): Step => ({ key, title: key, done: false, stepMode: 'you_do_observed' });

  test('records auto_off for every Work when the switch is off', async () => {
    const { deps, queried } = makeDeps();
    expect(
      await startAutomaticRuns({ userId: 'user-1', workIds: ['w1', 'w2'], trigger: 'brief' }, deps),
    ).toEqual({
      started: [],
      reasons: { w1: 'auto_off', w2: 'auto_off' },
    });
    expect(queried).toEqual([]);
  });

  test('stops after the first created run and records the reasons before it', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const { deps, queried } = makeDeps({
      details: {
        w1: detailFor([userOnly('a')]),
        w2: detailFor([runnable('b')]),
        w3: detailFor([runnable('c')]),
      },
      enqueue: (args) => ({ runId: `run-${args.workId}`, created: true, reason: null }),
    });
    expect(
      await startAutomaticRuns({ userId: 'user-1', workIds: ['w1', 'w2', 'w3'], trigger: 'conductor' }, deps),
    ).toEqual({ started: ['run-w2'], reasons: { w1: 'not_runnable' } });
    expect(queried.map(([, args]) => args.workId)).toEqual(['w1', 'w2']);
  });

  test('stops when the user is busy', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const { deps, enqueued } = makeDeps({
      details: { w1: detailFor([runnable('a')]), w2: detailFor([runnable('b')]) },
      enqueue: { runId: null, created: false, reason: 'busy' },
    });
    expect(
      await startAutomaticRuns({ userId: 'user-1', workIds: ['w1', 'w2'], trigger: 'brief' }, deps),
    ).toEqual({
      started: [],
      reasons: { w1: 'busy' },
    });
    expect(enqueued).toHaveLength(1);
  });

  test('stops when the standing order is paused', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const { deps } = makeDeps({ paused: true });
    expect(
      await startAutomaticRuns({ userId: 'user-1', workIds: ['w1', 'w2'], trigger: 'brief' }, deps),
    ).toEqual({
      started: [],
      reasons: { w1: 'paused' },
    });
    expect(deps.runsPaused).toHaveBeenCalledTimes(1);
  });

  test('dedupes the ids, keeps going past other reasons, and caps at 12', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const ids = Array.from({ length: 15 }, (_, index) => `w${index}`);
    const details = Object.fromEntries(ids.map((id) => [id, detailFor([userOnly(id)])]));
    const { deps, queried } = makeDeps({ details });
    const result = await startAutomaticRuns(
      { userId: 'user-1', workIds: ['w0', 'w0', ...ids], trigger: 'brief' },
      deps,
    );
    expect(result.started).toEqual([]);
    expect(Object.keys(result.reasons)).toEqual(ids.slice(0, 12));
    expect(queried.filter(([, args]) => args.workId === 'w0')).toHaveLength(1);
  });

  test('a created flag without a run id, or no reason, records not_started', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const { deps } = makeDeps({
      details: { w1: detailFor([runnable('a')]) },
      enqueue: { runId: null, created: true, reason: null },
    });
    expect(await startAutomaticRuns({ userId: 'user-1', workIds: ['w1'], trigger: 'brief' }, deps)).toEqual({
      started: [],
      reasons: { w1: 'not_started' },
    });
  });

  test('a missing Work is a reason, and a thrown start records the error name and moves on', async () => {
    process.env.LAB86_STEP_RUNS_AUTO = 'all';
    const missing = makeDeps({ details: { w2: detailFor([runnable('b')]) } });
    expect(
      await startAutomaticRuns({ userId: 'user-1', workIds: ['w1', 'w2'], trigger: 'brief' }, missing.deps),
    ).toEqual({ started: ['run-1'], reasons: { w1: 'no_work' } });

    const thrown = makeDeps({ queryError: 'not an error' });
    expect(
      await startAutomaticRuns({ userId: 'user-1', workIds: ['w1'], trigger: 'brief' }, thrown.deps),
    ).toEqual({
      started: [],
      reasons: { w1: 'error' },
    });
  });
});
