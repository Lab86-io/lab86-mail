import { describe, expect, test } from 'bun:test';
import {
  GOAL_DRAFT_ID,
  GOAL_INVOICE_DOCUMENT_ID,
  goalDetailFixture,
  goalDetailWithEarlierSteps,
  goalItemsFixture,
  goalRunFixtures,
  threadDetailFixture,
  threadRunFixtures,
} from '../lib/albatross/thread-fixtures';
import {
  planLine,
  RUN_STATE_COPY,
  runBlockAction,
  runBlockDismisses,
  runBlockDoneContinue,
  runBlockMarksDone,
  stoppedReason,
  threadState,
  threadStateInput,
} from '../lib/albatross/thread-view';

/* The thread rules for a goal run (lead review, 2026-10-15): the buttons of
 * a goal handoff, the header word of a goal Work, and the state input. Step
 * runs keep their rules. */

const NOW = Date.UTC(2026, 9, 15, 18, 44, 0);
const runs = goalRunFixtures(NOW);
const steps = threadRunFixtures(NOW);

describe('the buttons of a goal handoff', () => {
  test('a package opens document mode on the next.target tab', () => {
    const action = runBlockAction(runs.goalPackage);
    expect(action).toEqual({
      kind: 'package',
      label: 'Open the package',
      activeKey: `document:${GOAL_INVOICE_DOCUMENT_ID}`,
    });
    expect(runBlockDoneContinue(runs.goalPackage)).toBe(true);
    expect(runBlockMarksDone(runs.goalPackage)).toBe(false);
    expect(runBlockDismisses(runs.goalPackage)).toBe(true);
  });

  test('the label comes from the run; the fallback is Open the package', () => {
    const run = { ...runs.goalPackage, next: { ...runs.goalPackage.next!, label: 'Read and send' } };
    expect(runBlockAction(run)).toMatchObject({ kind: 'package', label: 'Read and send' });
    const noNext = { ...runs.goalPackage, next: null };
    expect(runBlockAction(noNext)).toMatchObject({ kind: 'package', label: 'Open the package', activeKey: `draft:${GOAL_DRAFT_ID}` });
  });

  test('with no items and no next, the run continues', () => {
    const run = { ...runs.goalPackage, items: [], next: null };
    expect(runBlockAction(run)).toEqual({ kind: 'resume', label: 'Continue' });
    expect(runBlockDoneContinue(run)).toBe(false);
  });

  test('a page handoff keeps its done label, with no second button', () => {
    expect(runBlockAction(runs.goalYourTurn)).toEqual({ kind: 'resume', label: 'I signed in' });
    expect(runBlockDoneContinue(runs.goalYourTurn)).toBe(false);
  });

  test('a result with nothing to open offers Done, continue as the primary button', () => {
    const run = {
      ...runs.goalPackage,
      items: [{ kind: 'event' as const, id: 'evt_1', title: 'Call Priya', state: 'ready' as const }],
      next: { ...runs.goalPackage.next!, kind: 'do_offline' as const, target: null },
    };
    expect(runBlockAction(run)).toEqual({ kind: 'done_continue', label: 'Done, continue' });
    expect(runBlockDoneContinue(run)).toBe(false);
  });

  test('a result that opens a page offers the page and Done, continue', () => {
    const run = {
      ...runs.goalPackage,
      items: [{ kind: 'page' as const, url: 'https://example.com/portal', title: 'Vendor portal', state: 'check' as const }],
      next: {
        ...runs.goalPackage.next!,
        kind: 'review' as const,
        label: 'Open the portal',
        target: { kind: 'url' as const, url: 'https://example.com/portal' },
      },
    };
    expect(runBlockAction(run)).toMatchObject({ kind: 'next', label: 'Open the portal' });
    expect(runBlockDoneContinue(run)).toBe(true);
  });

  test('a stopped goal run continues, and says the next run starts from the checklist', () => {
    expect(runBlockAction(runs.goalStoppedTime)).toEqual({ kind: 'resume', label: 'Continue' });
    expect(stoppedReason(runs.goalStoppedTime, { goal: true })).toBe(
      'Albatross stopped at its time limit. The next run starts from the checklist.',
    );
    expect(stoppedReason(runs.goalStoppedTime)).toBe(RUN_STATE_COPY.stoppedTime);
    expect(stoppedReason({ ...runs.goalStoppedTime, stoppedBy: 'cost' }, { goal: true })).toContain('cost limit');
  });

  test('a question, a failure, and a done run keep their rules', () => {
    expect(runBlockAction(runs.goalNeedsAnswer)).toEqual({ kind: 'none' });
    expect(runBlockAction(runs.goalFailed, { startable: true })).toEqual({ kind: 'start', label: 'Try again' });
    expect(runBlockAction(runs.goalDone)).toEqual({ kind: 'none' });
    expect(runBlockDoneContinue(runs.goalDone)).toBe(false);
  });

  test('a step run is unchanged: Read and send with Mark step done', () => {
    expect(runBlockAction(steps.readyDraft)).toMatchObject({ kind: 'next', label: 'Read and send' });
    expect(runBlockMarksDone(steps.readyDraft)).toBe(true);
    expect(runBlockDoneContinue(steps.readyDraft)).toBe(false);
    expect(runBlockAction(steps.finalPage)).toEqual({ kind: 'resume', label: 'I paid' });
  });
});

describe('the header word of a goal Work', () => {
  test('the state alone, no step count', () => {
    const detail = goalDetailFixture(NOW);
    expect(planLine(threadStateInput(detail, [runs.goalRunning]))).toEqual({ text: 'In progress', state: 'running' });
    expect(planLine(threadStateInput(detail, [runs.goalQueued]))).toEqual({ text: 'Starts soon', state: 'running' });
    expect(planLine(threadStateInput(detail, [runs.goalPackage]))).toEqual({ text: 'Ready for you', state: 'waiting' });
    expect(planLine(threadStateInput(detail, [runs.goalYourTurn]))).toEqual({ text: 'Your turn', state: 'waiting' });
    expect(planLine(threadStateInput(detail, [runs.goalStoppedTime]))).toEqual({ text: 'Stopped', state: 'waiting' });
    expect(planLine(threadStateInput(detail, [runs.goalNeedsAnswer]))).toEqual({
      text: 'Needs your answer',
      state: 'needs_answer',
    });
    expect(planLine(threadStateInput(detail, [runs.goalFailed]))).toEqual({ text: 'Your move', state: 'ready' });
    expect(planLine(threadStateInput(detail, []))).toEqual({ text: 'Your move', state: 'ready' });
  });

  test('a done or put-down Work keeps its words', () => {
    expect(planLine(threadStateInput(goalDetailFixture(NOW, { workState: 'done' }), [runs.goalDone]))).toEqual({
      text: 'Done',
      state: 'done',
    });
  });

  test('a goal handoff counts even when old steps are open', () => {
    const detail = goalDetailWithEarlierSteps(NOW);
    detail.execution.guideSteps[1].done = false;
    const input = threadStateInput(detail, [runs.goalPackage]);
    expect(input.goal).toBe(true);
    expect(input.handoff?.id).toBe('run_goal_package');
    expect(threadState(input)).toBe('waiting');
  });

  test('a step Work keeps the step count', () => {
    const input = threadStateInput(threadDetailFixture(NOW), [steps.running]);
    expect(input.goal).toBe(false);
    expect(planLine(input).text).toBe('Step 1 of 2 · In progress');
  });

  test('items alone make a goal run count for the Work', () => {
    const detail = threadDetailFixture(NOW);
    const run = { ...steps.readyDraft, items: goalItemsFixture() };
    expect(threadStateInput(detail, [run]).goal).toBe(true);
  });
});
