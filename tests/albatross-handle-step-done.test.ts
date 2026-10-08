import { describe, expect, mock, test } from 'bun:test';
import { StepExecutionError } from '../lib/albatross/step-execution';
import { StepRunStartError } from '../lib/albatross/step-run-start';
import { runHandleStep } from '../lib/tools/albatross-runs';

// albatross_handle_step with done: true (docs/albatross-document-handoff.md, D4):
// the chat checks a step off with the user's word.
let reply: (input: any) => Promise<any> = async () => ({ action: 'started', runId: 'run-1' });
const handleStepFromThread = mock((input: any) => reply(input));
const stopStepFromThread = mock(async () => null as string | null);
const deps = { handleStepFromThread, stopStepFromThread } as any;

const ctx = { agent: 'ai' as const, userId: 'user-1' };
const checked =
  (check: { allStepsComplete: boolean; nextRunId: string | null; nextStepKey: string | null }) =>
  async () => ({ action: 'checked', runId: check.nextRunId, check: { stepKey: 'step-1', ...check } });

describe('albatross_handle_step with done: true', () => {
  test('passes done to the thread control', async () => {
    reply = checked({ allStepsComplete: false, nextRunId: null, nextStepKey: 'step-2' });
    await runHandleStep(
      { workId: 'work-1', stepKey: 'step-1', note: 'I filled in the hours.', done: true },
      ctx,
      deps,
    );
    expect(handleStepFromThread.mock.calls.at(-1)?.[0]).toEqual({
      userId: 'user-1',
      workId: 'work-1',
      stepKey: 'step-1',
      note: 'I filled in the hours.',
      done: true,
    });
    await runHandleStep({ workId: 'work-1', note: 'Go ahead.' }, ctx, deps);
    expect(handleStepFromThread.mock.calls.at(-1)?.[0].done).toBe(false);
  });

  test('the last step of the plan', async () => {
    reply = checked({ allStepsComplete: true, nextRunId: null, nextStepKey: null });
    expect(await runHandleStep({ workId: 'work-1', done: true }, ctx, deps)).toEqual({
      ok: true,
      action: 'checked',
      workId: 'work-1',
      message: 'Checked the step off. That was the last step of the plan.',
    });
  });

  test('the next run started', async () => {
    reply = checked({ allStepsComplete: false, nextRunId: 'run-2', nextStepKey: 'step-2' });
    expect(await runHandleStep({ workId: 'work-1', done: true }, ctx, deps)).toEqual({
      ok: true,
      action: 'checked',
      runId: 'run-2',
      workId: 'work-1',
      message: 'Checked the step off. Albatross started on the next step.',
    });
  });

  test('the next step is with the user', async () => {
    reply = checked({ allStepsComplete: false, nextRunId: null, nextStepKey: 'step-2' });
    const result = await runHandleStep({ workId: 'work-1', done: true }, ctx, deps);
    expect(result).toEqual({
      ok: true,
      action: 'checked',
      workId: 'work-1',
      message: 'Checked the step off. The next step is with the user.',
    });
    expect('runId' in result).toBe(false);
  });

  test('a StepExecutionError becomes ok: false with its message', async () => {
    reply = async () => {
      throw new StepExecutionError('There is no current step to complete.', 409);
    };
    expect(await runHandleStep({ workId: 'work-1', done: true }, ctx, deps)).toEqual({
      ok: false,
      workId: 'work-1',
      message: 'There is no current step to complete.',
    });
  });

  test('a StepRunStartError still becomes ok: false; another error throws', async () => {
    reply = async () => {
      throw new StepRunStartError('This step stays with you.', 403);
    };
    expect(await runHandleStep({ workId: 'work-1' }, ctx, deps)).toEqual({
      ok: false,
      workId: 'work-1',
      message: 'This step stays with you.',
    });
    reply = async () => {
      throw new Error('Convex blinked');
    };
    await expect(runHandleStep({ workId: 'work-1', done: true }, ctx, deps)).rejects.toThrow(
      'Convex blinked',
    );
  });

  test('the other actions keep their messages', async () => {
    reply = async () => ({ action: 'started', runId: 'run-3' });
    expect(await runHandleStep({ workId: 'work-1' }, ctx, deps)).toEqual({
      ok: true,
      action: 'started',
      runId: 'run-3',
      workId: 'work-1',
      message: 'Albatross started on the step. The run shows its progress in this conversation.',
    });
  });
});

describe('albatross_handle_step with stop: true', () => {
  test('a stopped run gives the page to the user; no run says so', async () => {
    stopStepFromThread.mockImplementationOnce(async () => 'run-9');
    expect(await runHandleStep({ workId: 'work-1', stop: true }, ctx, deps)).toEqual({
      ok: true,
      action: 'stopped',
      runId: 'run-9',
      workId: 'work-1',
      message: 'Stopped the run. You have the page.',
    });
    expect(await runHandleStep({ workId: 'work-1', stop: true }, ctx, deps)).toEqual({
      ok: false,
      workId: 'work-1',
      message: 'No run works on this Albatross now.',
    });
  });
});
