import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { handleStepFromThread, StepRunStartError, stopStepFromThread } from '../lib/albatross/step-run-start';
import { albatrossHandleStep } from '../lib/tools/albatross-runs';

// The thread's one control for runs (docs/albatross-thread.md): a note goes
// to the run in progress, continues a waiting run (and answers its question),
// or starts a new run.

let savedRuns: string | undefined;
beforeEach(() => {
  savedRuns = process.env.LAB86_STEP_RUNS;
  delete process.env.LAB86_STEP_RUNS;
});
afterEach(() => {
  if (savedRuns === undefined) delete process.env.LAB86_STEP_RUNS;
  else process.env.LAB86_STEP_RUNS = savedRuns;
});

const step = {
  key: 'step-1',
  identity: 'step:register',
  title: 'Register',
  done: false,
  stepMode: 'agent_does',
};
const detail = { work: { _id: 'work-1' }, execution: { guideSteps: [step], currentStep: step } };

function fakeDeps(runs: any[], options: { steer?: boolean } = {}) {
  const mutations: Array<[string, any]> = [];
  const deps = {
    convexQuery: (async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      if (name === 'albatrossStepRuns:runsForWorkHistory') return runs;
      if (name === 'albatrossWorkV2:workDetail') return detail;
      if (name === 'albatrossStepRuns:get') return runs.find((run) => run.id === args.id) || null;
      throw new Error(`unexpected query ${name}`);
    }) as any,
    convexMutation: (async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      mutations.push([name, args]);
      if (name === 'albatrossStepRuns:steer') return options.steer ?? true;
      if (name === 'albatrossStepRuns:enqueue') return { runId: 'run-new', created: true, reason: null };
      if (name === 'albatrossStepRuns:cancel') return { cancelled: true, browserSessionId: 'bb-1' };
      return null;
    }) as any,
    runsPaused: async () => false,
  };
  return { deps, mutations };
}

const base = { userId: 'user-1', workId: 'work-1' };

describe('handleStepFromThread', () => {
  test('a note goes to the run in progress', async () => {
    const { deps, mutations } = fakeDeps([{ id: 'run-1', state: 'running', stepKey: 'step-1' }]);
    expect(await handleStepFromThread({ ...base, note: 'Use the Monday class.' }, deps)).toEqual({
      action: 'steered',
      runId: 'run-1',
    });
    expect(mutations).toEqual([
      ['albatrossStepRuns:steer', expect.objectContaining({ id: 'run-1', text: 'Use the Monday class.' })],
    ]);
  });

  test('no note with a run in progress changes nothing', async () => {
    const { deps, mutations } = fakeDeps([{ id: 'run-1', state: 'queued', stepKey: 'step-1' }]);
    expect(await handleStepFromThread(base, deps)).toEqual({ action: 'working', runId: 'run-1' });
    expect(mutations).toEqual([]);
  });

  test('a waiting run continues with the note, and its pending question counts as answered in the chat', async () => {
    const waiting = {
      id: 'run-1',
      workId: 'work-1',
      state: 'handed_off',
      stepKey: 'step-1',
      next: { kind: 'answer', target: { kind: 'question', id: 'q-1' } },
      question: { id: 'q-1', status: 'pending' },
    };
    const { deps, mutations } = fakeDeps([waiting]);
    expect(await handleStepFromThread({ ...base, note: 'Monday works.' }, deps)).toEqual({
      action: 'resumed',
      runId: 'run-new',
    });
    expect(mutations.map(([name]) => name)).toEqual([
      'albatrossWorkV2:answerQuestion',
      'albatrossStepRuns:enqueue',
    ]);
    expect(mutations[0][1]).toMatchObject({
      questionId: 'q-1',
      answer: 'Answered in the chat: Monday works.',
    });
    expect(mutations[1][1]).toMatchObject({
      trigger: 'resume',
      parentRunId: 'run-1',
      resumeNote: 'Monday works.',
    });
  });

  test('a closed run on another step does not stop a new start', async () => {
    const { deps, mutations } = fakeDeps([{ id: 'run-0', state: 'done', stepKey: 'step-0' }]);
    expect(await handleStepFromThread({ ...base, note: 'Go ahead and register me.' }, deps)).toEqual({
      action: 'started',
      runId: 'run-new',
    });
    expect(mutations[0][1]).toMatchObject({
      trigger: 'user',
      stepKey: 'step-1',
      resumeNote: 'Go ahead and register me.',
    });
  });

  test('a run that stopped working before the note arrived falls back to a start', async () => {
    const { deps } = fakeDeps([{ id: 'run-1', state: 'running', stepKey: 'step-1' }], { steer: false });
    expect((await handleStepFromThread({ ...base, note: 'Now.' }, deps)).action).toBe('started');
  });

  test('the feature switch is honored', async () => {
    process.env.LAB86_STEP_RUNS = 'off';
    const { deps } = fakeDeps([]);
    await expect(handleStepFromThread(base, deps)).rejects.toBeInstanceOf(StepRunStartError);
  });
});

describe('stopStepFromThread', () => {
  test('it stops the open run and gives the page to the user', async () => {
    const { deps, mutations } = fakeDeps([{ id: 'run-1', state: 'running', stepKey: 'step-1' }]);
    expect(await stopStepFromThread(base, deps)).toBe('run-1');
    expect(mutations.map(([name]) => name)).toEqual([
      'albatrossStepRuns:cancel',
      'albatrossBrowserSessions:setSessionStatus',
    ]);
    expect(mutations[1][1]).toMatchObject({ sessionId: 'bb-1', status: 'user' });
  });

  test('nothing open, nothing stopped', async () => {
    const { deps } = fakeDeps([{ id: 'run-1', state: 'handed_off', stepKey: 'step-1' }]);
    expect(await stopStepFromThread(base, deps)).toBeNull();
  });
});

describe('the chat tools', () => {
  test('albatross_handle_step explains a refusal instead of throwing', async () => {
    process.env.LAB86_STEP_RUNS = 'off';
    const result = await albatrossHandleStep.handler(
      { workId: 'work-1', note: 'Go' },
      { agent: 'ai', userId: 'user-1' },
    );
    expect(result).toEqual({ ok: false, workId: 'work-1', message: 'Step runs are off.' });
  });

  test('the tools need a signed-in user', async () => {
    await expect(albatrossHandleStep.handler({ workId: 'work-1' }, { agent: 'ai' })).rejects.toThrow(
      /signed-in/,
    );
    await expect(
      albatrossHandleStep.handler({ workId: 'work-1', stop: true }, { agent: 'ai' }),
    ).rejects.toThrow(/signed-in/);
  });
});

describe('handleStepFromThread picks the newest run of the step', () => {
  test('an old handoff whose continuation already finished is not resumed', async () => {
    const { deps, mutations } = fakeDeps([
      { id: 'run-old', workId: 'work-1', state: 'handed_off', stepKey: 'step-1', next: { kind: 'sign_in' } },
      { id: 'run-new', workId: 'work-1', state: 'failed', stepKey: 'step-1', parentRunId: 'run-old' },
    ]);
    expect((await handleStepFromThread({ ...base, note: 'Go' }, deps)).action).toBe('started');
    expect(mutations[0][1]).toMatchObject({ trigger: 'user' });
  });

  test('without a stepKey, a handoff on another step is not resumed', async () => {
    const { deps } = fakeDeps([{ id: 'run-x', workId: 'work-1', state: 'handed_off', stepKey: 'step-0' }]);
    expect((await handleStepFromThread({ ...base, note: 'Go' }, deps)).action).toBe('started');
  });
});
